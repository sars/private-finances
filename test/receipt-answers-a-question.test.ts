import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { initializeReceipts, Receipts } from '../src/receipts.js';
import { Repository } from '../src/repository.js';
import { randomUUID } from 'node:crypto';

/**
 * Answering the bot's question with a photo of the receipt.
 *
 * A receipt used to reach a payment only through the date, amount, currency and
 * merchant search, and that search deliberately refuses to guess: two payments
 * of the same amount on the same day are an ambiguity it will not resolve. A
 * member replying to the question about one of them has already said which, so
 * the reply is the link, and the search is left for a photo that arrived with
 * nothing said about it.
 */

const settings = { chatId: '-10', userIds: { rodion: '10', katya: '20' } };
const extraction = {
  isReceipt: true,
  merchant: 'TEST MARKET',
  date: '2026-09-10',
  amountMinor: '1234',
  currency: 'EUR',
  items: ['Bread'],
};
const reply = () => ({
  status: 'completed',
  usage: {
    input_tokens: 1000,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
  },
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(extraction) }],
    },
  ],
});
let photoBytes = 0;
const options = {
  model: 'gpt-5.4-mini',
  maxRequestsPerDay: 50,
  download: async () => ({
    bytes: Buffer.from([255, 216, 255, photoBytes++ & 0xff]),
    mime: 'image/jpeg',
  }),
  request: async () => reply(),
  rasterize: async (): Promise<never[]> => {
    throw new Error('rasterizer_must_not_run_for_a_photo');
  },
};
const photo = (messageId: number, repliedTo?: number) => ({
  message: {
    message_id: messageId,
    chat: { id: -10 },
    from: { id: 10 },
    photo: [{ file_id: 'synthetic', file_size: 100 }],
    ...(repliedTo ? { reply_to_message: { message_id: repliedTo } } : {}),
  },
});

/** Two payments the search cannot choose between, and a question about one. */
async function household() {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeReceipts);
  const repo = new Repository(db);
  await repo.importBatch(
    ['one', 'two'].map((sourceId) => ({
      source: 'synthetic',
      sourceId,
      accountId: 'a',
      owner: 'rodion' as const,
      bookedAt: '2026-09-10T09:00:00Z',
      currency: 'EUR',
      amountMinor: '-1234',
      description: `TEST MARKET ${sourceId}`,
    })),
  );
  const asked = (await repo.list()).find((t) => t.sourceId === 'two')!;
  await db.query(
    `INSERT INTO telegram_outbox(id,transaction_id,revision,owner,chat_id,prompt,state,message_id)
     VALUES($1,$2,$3,'rodion','-10','What was this payment for?','sent',500)`,
    [randomUUID(), asked.id, asked.revision],
  );
  return { db, repo, receipts: new Receipts(db), asked };
}

const job = async (db: Awaited<ReturnType<typeof household>>['db']) =>
  (
    await db.query(
      'SELECT state, reason, transaction_id, answers_transaction_id FROM receipt_jobs',
    )
  ).rows[0]!;

test('a receipt replying to a question links to that question’s payment', async () => {
  const { db, receipts, asked } = await household();
  try {
    assert.equal(await receipts.receive(settings, photo(1, 500)), true);
    assert.equal((await job(db)).answers_transaction_id, asked.id);

    await receipts.processOne(options);

    const linked = await job(db);
    assert.equal(linked.state, 'matched');
    assert.equal(linked.transaction_id, asked.id);
    assert.equal(linked.reason, 'owner_answered_question');

    // The member's own act, recorded as theirs rather than as the matcher's.
    const events = (
      await db.query(
        'SELECT actor, transaction_id FROM receipt_attachment_events',
      )
    ).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actor, 'rodion');
    assert.equal(events[0]!.transaction_id, asked.id);
  } finally {
    await db.close();
  }
});

test('the same photo with nothing said about it still refuses to guess', async () => {
  const { db, receipts } = await household();
  try {
    assert.equal(await receipts.receive(settings, photo(2)), true);
    assert.equal((await job(db)).answers_transaction_id, null);

    await receipts.processOne(options);

    // Two payments of the same amount on the same day: the search will not
    // choose, and without a reply there is nothing that could.
    const unlinked = await job(db);
    assert.equal(unlinked.state, 'pending');
    assert.equal(unlinked.transaction_id, null);
  } finally {
    await db.close();
  }
});

test('a reply to the other member’s question is an ordinary receipt', async () => {
  const { db, receipts } = await household();
  try {
    // The question at message 500 is Rodion's. Katya's user id sends this one,
    // and a question addressed to someone else does not say what she meant.
    await db.query("UPDATE telegram_outbox SET owner='katya'");
    assert.equal(await receipts.receive(settings, photo(3, 500)), true);
    assert.equal((await job(db)).answers_transaction_id, null);
  } finally {
    await db.close();
  }
});
