import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Refunds } from '../src/refunds.js';
import { RefundMatcher } from '../src/refund-automation.js';
import {
  parseRefundAnswer,
  RefundQuestions,
  type RefundQuestionOption,
} from '../src/refund-questions.js';

const settings = { chatId: '-123', userIds: { rodion: '101', katya: '102' } };
const ride = (over: Record<string, unknown>) => ({
  source: 'monobank',
  accountId: 'card-eur',
  owner: 'rodion',
  currency: 'EUR',
  description: 'BOLT RIGA',
  ...over,
});
const liveFrom = new Date('2026-09-01T00:00:00Z');
const now = new Date('2026-09-03T09:00:00Z');

function fakeTransport() {
  const sent: Array<{ chat: string; text: string }> = [];
  const replies: Array<{ messageId: number; text: string }> = [];
  return {
    sent,
    replies,
    transport: {
      async send(chat: string, text: string) {
        sent.push({ chat, text });
        return { messageId: 42 };
      },
      async react() {},
      async reply(_chat: string, messageId: number, text: string) {
        replies.push({ messageId, text });
        return { messageId: messageId + 1 };
      },
    },
  };
}
const answer = (text: string, id = 1, user = 101) => ({
  update_id: id,
  message: {
    chat: { id: -123 },
    from: { id: user, is_bot: false },
    reply_to_message: { message_id: 42 },
    text,
  },
});

/** Two rides that differ by category: the choice changes a category total. */
async function twoRides() {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  // Two rides the same whisker from the refund, hailed at the same moment:
  // nothing in the data says which one it belongs to, so the matcher asks.
  await repo.importBatch([
    ride({
      sourceId: 'first',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-1001',
    }),
    ride({
      sourceId: 'second',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-999',
    }),
    ride({
      sourceId: 'reversal',
      bookedAt: '2026-09-02T10:00:00Z',
      amountMinor: '1000',
    }),
  ]);
  const rows = await repo.list('rodion');
  await new RefundMatcher(db).matchPending(25, now);
  const fake = fakeTransport();
  return {
    db,
    repo,
    fake,
    questions: new RefundQuestions(db, settings, fake.transport),
    id: (sourceId: string) => rows.find((r) => r.sourceId === sourceId)!.id,
  };
}

test('an answer is a number or an explicit refusal, never free text', () => {
  const options: RefundQuestionOption[] = [
    { index: 1, debitId: 'a', debitRevision: 0, label: 'one' },
    { index: 2, debitId: 'b', debitRevision: 0, label: 'two' },
  ];
  assert.deepEqual(parseRefundAnswer('2', options), {
    kind: 'option',
    option: options[1],
  });
  assert.deepEqual(parseRefundAnswer(' #1 please', options), {
    kind: 'option',
    option: options[0],
  });
  assert.equal(parseRefundAnswer('3', options).kind, 'unclear');
  assert.equal(parseRefundAnswer('none', options).kind, 'none');
  assert.equal(parseRefundAnswer('немає', options).kind, 'none');
  assert.equal(
    parseRefundAnswer('the one from the airport', options).kind,
    'unclear',
  );
});

test('the numbering is decided by the payments, never by their identifiers', async () => {
  // The two rides in this question share a moment exactly, which is what makes
  // it a question at all. Ordering only by that moment left the numbering to
  // `gen_random_uuid()`, so this assertion passed and failed on the same
  // machine — measured at six of twelve runs before the order was pinned.
  // Repeating it here is the point: identical input must number identically
  // every time, and a regression in the query's ordering would show up as a
  // different first option on one of these runs.
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { db, fake, questions } = await twoRides();
    try {
      assert.equal(await questions.queue({ liveFrom }), 1);
      assert.equal(await questions.dispatchOne(), 'sent');
      const lines = fake.sent[0]!.text.split('\n').filter((line) =>
        /^[0-9] — /.test(line),
      );
      assert.equal(lines.length, 2);
      seen.add(lines.join(' | '));
    } finally {
      await db.close();
    }
  }
  assert.equal(
    seen.size,
    1,
    'the same question must number its options the same way',
  );
  // And the order is the stated rule: at one moment, the larger charge first.
  assert.match([...seen][0]!, /^1 — 2026-09-01 · 10\.01 EUR/);
});

test('a question offers the candidate purchases and the chosen one is reduced', async () => {
  const { db, repo, fake, questions, id } = await twoRides();
  try {
    assert.equal(await questions.queue({ liveFrom }), 1);
    assert.equal(await questions.dispatchOne(), 'sent');
    assert.equal(fake.sent.length, 1);
    const prompt = fake.sent[0]!.text;
    assert.match(prompt, /Rodion/);
    assert.match(prompt, /1 — 2026-09-01 · 10.01 EUR · BOLT RIGA/);
    assert.match(prompt, /2 — 2026-09-01 · 9.99 EUR · BOLT RIGA/);
    assert.match(prompt, /“none”/);
    // Sending is not repeated, and nothing is linked before an answer.
    assert.equal(await questions.dispatchOne(), 'idle');
    assert.equal((await new Refunds(db).list('rodion')).length, 0);
    assert.equal(await questions.receive(answer('2')), true);
    const rows = await repo.list('rodion');
    assert.equal(
      rows.find((r) => r.id === id('second'))!.refund!.fullyReduced,
      true,
    );
    assert.equal(rows.find((r) => r.id === id('first'))!.refund, undefined);
    // The credit is explained by the link and hidden from browsing; nobody is
    // asked to classify money that is already counted through the purchase.
    assert.equal(rows.find((r) => r.id === id('reversal'))!.kind, 'unresolved');
    assert.equal(
      rows.find((r) => r.id === id('reversal'))!.refund!.role,
      'refund',
    );
    assert.match(fake.replies[0]!.text, /^Linked\./);
    const link = (await new Refunds(db).list('rodion'))[0]!;
    assert.equal(link.origin, 'manual');
    assert.equal(link.evidence.rule, 'owner_confirmed');
    // The same update is never applied twice.
    assert.equal(await questions.receive(answer('1')), false);
  } finally {
    await db.close();
  }
});

test('an unclear reply is answered with guidance and the question stays open', async () => {
  const { db, fake, questions } = await twoRides();
  try {
    await questions.queue({ liveFrom });
    await questions.dispatchOne();
    assert.equal(await questions.receive(answer('the airport one', 7)), true);
    assert.match(fake.replies[0]!.text, /Reply with the number/);
    assert.equal((await new Refunds(db).list('rodion')).length, 0);
    assert.equal((await questions.pending('rodion')).length, 1);
    // A later, clear answer still works.
    assert.equal(await questions.receive(answer('1', 8)), true);
    assert.equal((await new Refunds(db).list('rodion')).length, 1);
    assert.equal((await questions.pending('rodion')).length, 0);
  } finally {
    await db.close();
  }
});

test('“none” leaves the money visible instead of attaching it to something', async () => {
  const { db, repo, fake, questions } = await twoRides();
  try {
    await questions.queue({ liveFrom });
    await questions.dispatchOne();
    assert.equal(await questions.receive(answer('none')), true);
    assert.equal((await new Refunds(db).list('rodion')).length, 0);
    assert.match(fake.replies[0]!.text, /stays visible/);
    assert.ok(
      (await repo.list('rodion')).every((row) => row.refund === undefined),
    );
    // The matcher does not ask again about money the owner has answered.
    assert.deepEqual(await new RefundMatcher(db).matchPending(25, now), {
      linked: 0,
      asked: 0,
      unmatched: 0,
    });
    assert.equal(await questions.queue({ liveFrom }), 0);
  } finally {
    await db.close();
  }
});

test('a reply from anyone else, or to another message, changes nothing', async () => {
  const { db, questions } = await twoRides();
  try {
    await questions.queue({ liveFrom });
    await questions.dispatchOne();
    assert.equal(await questions.receive(answer('1', 3, 102)), false);
    assert.equal(await questions.receive(answer('1', 4, 999)), false);
    assert.equal(
      await questions.receive({
        update_id: 5,
        message: {
          chat: { id: -123 },
          from: { id: 101, is_bot: false },
          reply_to_message: { message_id: 7 },
          text: '1',
        },
      }),
      false,
    );
    assert.equal((await new Refunds(db).list('rodion')).length, 0);
    // Declining a message must leave its update number untouched, or the
    // consumer it is passed on to sees a duplicate and drops the answer.
    assert.equal(
      (await db.query('SELECT 1 FROM telegram_updates')).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});

test('money that arrived before the rollout boundary is never asked about', async () => {
  const { db, questions } = await twoRides();
  try {
    assert.equal(
      await questions.queue({ liveFrom: new Date('2026-09-03T00:00:00Z') }),
      0,
    );
    assert.equal(await questions.dispatchOne(), 'idle');
    assert.equal((await questions.pending('rodion')).length, 0);
  } finally {
    await db.close();
  }
});

test('a question is dropped rather than sent when the payment changed underneath it', async () => {
  const { db, repo, questions, id } = await twoRides();
  try {
    await questions.queue({ liveFrom });
    await repo.importBatch([
      ride({
        sourceId: 'reversal',
        bookedAt: '2026-09-02T10:00:00Z',
        amountMinor: '1000',
        description: 'BOLT RIGA corrected',
      }),
    ]);
    assert.equal(await questions.dispatchOne(), 'idle');
    assert.equal((await questions.pending('rodion')).length, 0);
    assert.equal(
      (await repo.list('rodion')).find((r) => r.id === id('reversal'))!.kind,
      'unresolved',
    );
  } finally {
    await db.close();
  }
});

test('money from a person is asked about without options and only the owner can attach it', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  try {
    await repo.importBatch([
      ride({
        sourceId: 'transfer',
        bookedAt: '2026-09-02T10:00:00Z',
        amountMinor: '15000',
        description: 'Vasyl Petrenko',
        sourceDetails: { counterName: 'Vasyl Petrenko', mcc: 4829 },
      }),
    ]);
    await new RefundMatcher(db).matchPending(25, now);
    const fake = fakeTransport();
    const questions = new RefundQuestions(db, settings, fake.transport);
    assert.equal(await questions.queue({ liveFrom }), 1);
    assert.equal(await questions.dispatchOne(), 'sent');
    assert.match(fake.sent[0]!.text, /money arrived that I cannot explain/);
    assert.match(fake.sent[0]!.text, /150.00 EUR/);
    assert.doesNotMatch(fake.sent[0]!.text, /^1 — /m);
    // A number means nothing without options; the app is where it is attached.
    assert.equal(await questions.receive(answer('1')), true);
    assert.match(fake.replies[0]!.text, /Private Finances/);
    assert.equal((await new Refunds(db).list('rodion')).length, 0);
  } finally {
    await db.close();
  }
});
