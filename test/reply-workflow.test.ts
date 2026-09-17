import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate, type Database } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';
import { Classifier } from '../src/classifier.js';
import { TelegramClarifications } from '../src/telegram.js';
import { initializeTelegramCursor, pollOnce } from '../src/telegram-cli.js';
import {
  hierarchicalCategoryPaths,
  initializeReplyWorkflow,
  TelegramReplyWorkflow,
} from '../src/reply-workflow.js';
import { RefundQuestions } from '../src/refund-questions.js';
import { Receipts } from '../src/receipts.js';
const settings = { chatId: '-123', userIds: { rodion: '101', katya: '102' } };
const update = (
  id: number,
  text: string,
  reply = 42,
  user = 101,
  chat = -123,
) => ({
  update_id: id,
  message: {
    // The owner's own message, which the bot reacts to and answers in place.
    message_id: id,
    chat: { id: chat },
    from: { id: user, is_bot: false },
    reply_to_message: { message_id: reply },
    text,
  },
});
async function setup(
  budget = 50,
  status: 'booked' | 'pending' = 'booked',
  tags: string[] = [],
) {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeReplyWorkflow);
  await db.transaction(initializeTelegramCursor);
  const repo = new Repository(db),
    categories = new Categories(db);
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'one',
      status,
      accountId: 'one',
      owner: 'rodion',
      bookedAt: '2026-09-01T00:00:00Z',
      currency: 'EUR',
      amountMinor: '-100',
      description: 'Synthetic merchant',
    },
  ]);
  await db.query(
    "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','one','rodion','Wise EUR','personal')",
  );
  const row = (await repo.list('rodion'))[0]!;
  const question = new TelegramClarifications(db, settings, {
    send: async () => ({ messageId: 42 }),
    react: async () => {
      throw new Error('unexpected_react');
    },
    reply: async () => {
      throw new Error('unexpected_reply');
    },
  });
  await question.queue(row.id, 0, 'What was this payment for?', 'rodion');
  await question.dispatchOne();
  const requests: unknown[] = [],
    messages: string[] = [];
  const classifierFor = async () =>
    new Classifier(
      db,
      {
        apiKey: 'synthetic-key',
        model: 'gpt-5.4-mini-2026-03-17',
        maxRequestsPerDay: budget,
        maxInputChars: 4000,
        maxOutputTokens: 512,
        timeoutMs: 1000,
        categories: hierarchicalCategoryPaths(await categories.listNodes()),
        tags,
      },
      async (body) => {
        requests.push(body);
        return {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    kind: 'personal_expense',
                    category: 'Food / Restaurants / Dining in',
                    confidence: 0.8,
                    explanation: 'Based on the owner’s clarification',
                    ...(tags.length ? { tags } : {}),
                  }),
                },
              ],
            },
          ],
        };
      },
    );
  const reactions: Array<{ messageId: number; emoji: string | null }> = [];
  const replies: Array<{ to: number; text: string }> = [];
  const transport = {
    send: async (_chat: string, text: string) => {
      messages.push(text);
      return { messageId: 100 + messages.length };
    },
    react: async (_chat: string, messageId: number, emoji: string | null) => {
      reactions.push({ messageId, emoji });
    },
    reply: async (_chat: string, to: number, text: string) => {
      replies.push({ to, text });
      messages.push(text);
      return { messageId: 200 + replies.length };
    },
  };
  const workflow = new TelegramReplyWorkflow(
    db,
    { ...settings, publicOrigin: 'https://finances.example' },
    transport,
    classifierFor,
  );
  return {
    db,
    repo,
    categories,
    row,
    question,
    workflow,
    classifierFor,
    transport,
    requests,
    messages,
    reactions,
    replies,
  };
}

test('an explanation in Telegram is applied, acknowledged and answered with what was saved', async () => {
  const s = await setup();
  try {
    await s.db.transaction(initializeReplyWorkflow);
    // Only leaves are offered: a heading is not something a payment can be
    // filed on, so proposing one could never be applied.
    const offered = hierarchicalCategoryPaths(await s.categories.listNodes());
    assert.ok(offered.includes('Food / Restaurants / Dining in'));
    assert.ok(!offered.includes('Food'));
    assert.deepEqual(
      offered,
      [...offered].sort((a, b) => a.localeCompare(b)),
    );
    // An earlier generic request does not prevent the owner reply supplying context.
    await (await s.classifierFor()).propose(s.row.id, 0, 'rodion');
    assert.equal(
      await s.question.receive(update(1, 'Dinner with family')),
      'accepted',
    );
    assert.deepEqual(
      await Promise.all([s.workflow.processOne(), s.workflow.processOne()]),
      ['ready', 'idle'],
    );
    assert.equal(s.requests.length, 2);
    assert.match(JSON.stringify(s.requests[1]), /Dinner with family/);

    // The owner's own words are the decision: it is saved, not asked about.
    assert.equal(await s.workflow.dispatchOne(), 'applied');
    const changed = (await s.repo.list('rodion'))[0]!;
    assert.equal(changed.kind, 'personal_expense');
    assert.equal(changed.category, 'Food / Restaurants / Dining in');
    assert.equal(changed.revision, 1);
    // 👍, not 🙌: Telegram refuses 🙌 from a bot, and did so silently for days.
    assert.deepEqual(s.reactions, [{ messageId: 1, emoji: '👍' }]);
    assert.equal(await s.workflow.dispatchOne(), 'idle');

    // The answer lands on the owner's own message and says what was saved.
    assert.equal(await s.workflow.dispatchReceiptOne(), 'sent');
    assert.equal(s.replies.length, 1);
    assert.equal(s.replies[0]!.to, 1);
    assert.match(s.replies[0]!.text, /Saved as personal expense/);
    assert.match(s.replies[0]!.text, /Account: Wise EUR/);
    assert.match(s.replies[0]!.text, /Food \/ Restaurants \/ Dining in/);
    assert.match(
      s.replies[0]!.text,
      new RegExp(`https://finances.example/review\\?id=${s.row.id}`),
    );
    assert.equal(await s.workflow.dispatchReceiptOne(), 'idle');

    // Applying once is the whole point: nothing repeats it, and a decision the
    // owner never asked to generalise creates no rule.
    assert.equal(
      (
        await s.db.query(
          "SELECT count(*)::integer AS n FROM audit_events WHERE event='classified'",
        )
      ).rows[0]!.n,
      1,
    );
    assert.deepEqual(await s.categories.listRules('rodion'), []);
    assert.deepEqual(await s.question.pending('rodion'), []);
  } finally {
    await s.db.close();
  }
});

test('a payment a person already decided is never overwritten, and the owner is told why', async () => {
  const s = await setup();
  try {
    await s.question.receive(update(1, 'Dinner'));
    await s.workflow.processOne();
    // A human decision lands between the proposal and its application.
    await s.repo.classify(
      s.row.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Need evidence' },
      'rodion',
    );
    assert.equal(await s.workflow.dispatchOne(), 'stale');
    const row = (await s.repo.list('rodion'))[0]!;
    assert.equal(row.kind, 'unresolved');
    assert.equal(row.revision, 1);
    assert.deepEqual(s.reactions, [{ messageId: 1, emoji: '👀' }]);
    assert.equal(await s.workflow.dispatchReceiptOne(), 'sent');
    assert.match(s.replies[0]!.text, /Nothing was saved/);
    assert.match(
      s.replies[0]!.text,
      new RegExp(`https://finances.example/review\\?id=${s.row.id}`),
    );
  } finally {
    await s.db.close();
  }
});

test('a category the tree no longer has saves nothing and says so', async () => {
  const s = await setup();
  try {
    await s.question.receive(update(1, 'Dinner'));
    await s.workflow.processOne();
    // The proposal was valid when it was made; the tree moved underneath it.
    await s.db.query(
      "UPDATE classifier_proposals SET proposal=jsonb_set(proposal,'{category}','\"Food / Nowhere\"')",
    );
    assert.equal(await s.workflow.dispatchOne(), 'stale');
    assert.equal((await s.repo.list('rodion'))[0]!.kind, 'unresolved');
    assert.equal((await s.repo.list('rodion'))[0]!.revision, 0);
    assert.equal(await s.workflow.dispatchReceiptOne(), 'sent');
    assert.match(s.replies[0]!.text, /Nothing was saved/);
  } finally {
    await s.db.close();
  }
});

test('proposed tags are applied from the owner’s own list and reported back', async () => {
  const s = await setup(50, 'booked', ['Holiday']);
  try {
    const holiday = await s.categories.saveTag('Holiday');
    await s.categories.saveTag('Gift');
    await s.question.receive(update(1, 'Dinner on the trip'));
    await s.workflow.processOne();
    assert.equal(await s.workflow.dispatchOne(), 'applied');
    assert.deepEqual(
      (await s.categories.tags('rodion', s.row.id)).map((tag) => tag.id),
      [holiday.id],
    );
    assert.equal(await s.workflow.dispatchReceiptOne(), 'sent');
    assert.match(s.replies[0]!.text, /Tags: Holiday/);
  } finally {
    await s.db.close();
  }
});

test('the model budget waits durably and a crashed lease never replays automatically', async () => {
  const s = await setup(0);
  try {
    await s.question.receive(update(1, 'Dinner'));
    assert.equal(await s.workflow.processOne(), 'waiting');
    assert.equal(await s.workflow.processOne(), 'idle');
    assert.equal(s.requests.length, 0);
    assert.equal(await s.workflow.dispatchOne(), 'idle');
    await s.db.query(
      "UPDATE telegram_reply_workflows SET state='processing',lease_until=now()-interval '1 second'",
    );
    assert.equal(await s.workflow.processOne(), 'idle');
    assert.equal(
      (await s.db.query('SELECT state FROM telegram_reply_workflows')).rows[0]!
        .state,
      'uncertain',
    );
  } finally {
    await s.db.close();
  }
});

test('an unreachable chat leaves the decision saved and the answer owed, never repeated', async () => {
  const t = await setup();
  try {
    await t.question.receive(update(1, 'Dinner'));
    await t.workflow.processOne();
    let attempts = 0;
    const failing = new TelegramReplyWorkflow(
      t.db,
      settings,
      {
        send: async () => {
          attempts++;
          throw new Error('timeout after sending');
        },
        react: async () => {},
        reply: async () => {
          attempts++;
          throw new Error('timeout after sending');
        },
      },
      t.classifierFor,
    );
    // The decision is committed before anything is sent, so a chat failure
    // cannot undo it; the answer is what stays owed.
    assert.equal(await failing.dispatchOne(), 'applied');
    assert.equal((await t.repo.list('rodion'))[0]!.kind, 'personal_expense');
    assert.equal(await failing.dispatchReceiptOne(), 'uncertain');
    assert.equal(await failing.dispatchReceiptOne(), 'idle');
    assert.equal(attempts, 1);
  } finally {
    await t.db.close();
  }
});

test('a question already awaiting confirmation when this shipped can still be confirmed', async () => {
  const s = await setup();
  try {
    await s.question.receive(update(1, 'Dinner'));
    await s.workflow.processOne();
    // The shape a row left behind by the previous release has: a sent question
    // waiting for the word "confirm".
    await s.db.query(
      "UPDATE telegram_reply_workflows SET state='sent',message_id=555",
    );
    assert.equal(
      await s.workflow.receive(update(2, 'confirm', 555)),
      'confirmed',
    );
    const row = (await s.repo.list('rodion'))[0]!;
    assert.equal(row.kind, 'personal_expense');
    assert.equal(row.revision, 1);
  } finally {
    await s.db.close();
  }
});

test('a pending outflow is decided while the bank status stays pending', async () => {
  const s = await setup(50, 'pending');
  try {
    assert.equal(
      await s.question.receive(update(1, 'Dinner with family')),
      'accepted',
    );
    assert.equal(await s.workflow.processOne(), 'ready');
    assert.equal(await s.workflow.dispatchOne(), 'applied');
    const row = (await s.repo.list('rodion'))[0]!;
    assert.equal(row.kind, 'personal_expense');
    assert.equal(row.category, 'Food / Restaurants / Dining in');
    assert.equal(row.status, 'pending');
  } finally {
    await s.db.close();
  }
});

test('Katya can answer a question about Rodion’s payment, and it says she did', async () => {
  const s = await setup();
  try {
    await s.db.transaction(initializeReplyWorkflow);
    // The question went to Rodion, whose card was used. Katya answers it from
    // the chat they share, which the household treats as an answer like any
    // other — but whose it was must not be lost.
    assert.equal(
      await s.question.receive(update(1, 'Dinner with family', 42, 102)),
      'accepted',
    );
    assert.equal(await s.workflow.processOne(), 'ready');
    assert.equal(await s.workflow.dispatchOne(), 'applied');

    const changed = (await s.repo.list('rodion'))[0]!;
    assert.equal(changed.kind, 'personal_expense');
    assert.equal(changed.category, 'Food / Restaurants / Dining in');

    // The payment is still Rodion's and is decided as him, because that is who
    // may decide it; the history names Katya as the one who explained it.
    const classified = (
      await s.db.query(
        "SELECT actor, reason FROM audit_events WHERE transaction_id=$1 AND event='classified'",
        [s.row.id],
      )
    ).rows[0]!;
    assert.equal(classified.actor, 'rodion');
    assert.match(
      String(classified.reason),
      /Saved from katya’s explanation in Telegram, answering for rodion/,
    );

    // And the reply in the chat says so too.
    assert.equal(await s.workflow.dispatchReceiptOne(), 'sent');
    assert.match(s.replies[0]!.text, /^rodion \(answered by katya\):/);
  } finally {
    await s.db.close();
  }
});

test('the owner’s own answer names nobody else', async () => {
  const s = await setup();
  try {
    await s.db.transaction(initializeReplyWorkflow);
    assert.equal(
      await s.question.receive(update(1, 'Dinner with family')),
      'accepted',
    );
    assert.equal(await s.workflow.processOne(), 'ready');
    assert.equal(await s.workflow.dispatchOne(), 'applied');
    const classified = (
      await s.db.query(
        "SELECT reason FROM audit_events WHERE transaction_id=$1 AND event='classified'",
        [s.row.id],
      )
    ).rows[0]!;
    assert.match(
      String(classified.reason),
      /Saved from the owner’s own explanation in Telegram/,
    );
    assert.equal(await s.workflow.dispatchReceiptOne(), 'sent');
    assert.match(s.replies[0]!.text, /^rodion:/);
  } finally {
    await s.db.close();
  }
});

test('an answer polled through every receiver reaches the question, not the refund flow', async () => {
  const s = await setup();
  try {
    await s.db.transaction(initializeReplyWorkflow);
    // The worker offers each update to the refund questions, the receipts and
    // the suggestion workflow before the clarification consumer sees it. On
    // 17 September 2026 the refund flow took the update number first and then
    // declined the message, so the consumer saw its own insert refused and
    // three of Katya's answers were dropped as duplicates, unlogged.
    const next = await pollOnce(
      s.db,
      settings,
      async () => [update(1, 'Dinner with family', 42, 102)],
      async (scoped, raw) =>
        (await new RefundQuestions(scoped, settings, s.transport).receive(
          raw,
        )) ||
        (await new Receipts(scoped).receive(settings, raw)) ||
        (await new TelegramReplyWorkflow(
          scoped,
          settings,
          s.transport,
          s.classifierFor,
        ).receive(raw)) !== 'unmatched',
    );
    assert.equal(next, 2);
    const recorded = (
      await s.db.query(
        'SELECT outcome, detail FROM telegram_updates WHERE update_id=1',
      )
    ).rows[0]!;
    assert.equal(recorded.outcome, 'accepted');
    assert.match(String(recorded.detail), /katya answered for rodion/);
    assert.equal(
      (await s.db.query('SELECT 1 FROM telegram_proposal_inputs')).rows.length,
      1,
    );
    assert.equal(await s.workflow.processOne(), 'ready');
    assert.equal(await s.workflow.dispatchOne(), 'applied');
    assert.equal((await s.repo.list('rodion'))[0]!.kind, 'personal_expense');
  } finally {
    await s.db.close();
  }
});

test('free text under a suggestion is recorded and answered, not dropped', async () => {
  const s = await setup();
  try {
    await s.db.transaction(initializeReplyWorkflow);
    assert.equal(
      await s.question.receive(update(1, 'Dinner with family')),
      'accepted',
    );
    // A suggestion the bot sent under the old confirm/reject flow, still open.
    await s.db.query(
      `INSERT INTO telegram_reply_workflows(id,input_id,transaction_id,revision,owner,chat_id,state,message_id)
       SELECT '00000000-0000-4000-8000-000000000001',i.id,$1,0,'rodion','-123','sent',77
       FROM telegram_proposal_inputs i LIMIT 1`,
      [s.row.id],
    );
    assert.equal(
      await s.workflow.receive(update(2, 'no, it was the intercom', 77)),
      'ignored',
    );
    const recorded = (
      await s.db.query(
        'SELECT outcome, detail FROM telegram_updates WHERE update_id=2',
      )
    ).rows[0]!;
    assert.equal(recorded.outcome, 'ignored');
    assert.match(String(recorded.detail), /confirm or reject/);
    // The note goes out through the chat, from whichever worker sends next.
    assert.equal(
      await new TelegramClarifications(
        s.db,
        settings,
        s.transport,
      ).dispatchNoteOne(),
      'sent',
    );
    assert.deepEqual(s.reactions, [{ messageId: 2, emoji: '👀' }]);
    assert.equal(s.replies[0]!.to, 2);
    assert.match(s.replies[0]!.text, /reply “confirm” or “reject”/);
  } finally {
    await s.db.close();
  }
});

test('an answer the model step cannot use is logged and answered, not left silent', async () => {
  const s = await setup();
  try {
    await s.db.transaction(initializeReplyWorkflow);
    assert.equal(
      await s.question.receive(update(1, 'Business, for advertising')),
      'accepted',
    );
    const broken = new TelegramReplyWorkflow(
      s.db,
      { ...settings, publicOrigin: 'https://finances.example' },
      s.transport,
      async () =>
        new Classifier(
          s.db,
          {
            apiKey: 'synthetic-key',
            model: 'gpt-5.4-mini-2026-03-17',
            maxRequestsPerDay: 5,
            maxInputChars: 4000,
            maxOutputTokens: 512,
            timeoutMs: 1000,
            categories: hierarchicalCategoryPaths(
              await s.categories.listNodes(),
            ),
          },
          async () => ({ status: 'completed', output: [] }),
        ),
    );
    assert.equal(await broken.processOne(), 'failed');
    assert.equal(
      await new TelegramClarifications(
        s.db,
        settings,
        s.transport,
      ).dispatchNoteOne(),
      'sent',
    );
    assert.equal(s.replies[0]!.to, 1);
    assert.match(
      s.replies[0]!.text,
      /could not turn this answer into a decision/,
    );
    assert.match(
      s.replies[0]!.text,
      new RegExp(`https://finances.example/review\\?id=${s.row.id}`),
    );
  } finally {
    await s.db.close();
  }
});
