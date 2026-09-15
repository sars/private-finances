import test from 'node:test';
import assert from 'node:assert/strict';
import {
  memoryDatabase,
  migrate,
  type Database,
  type Executor,
} from '../src/database.js';
import { Repository } from '../src/repository.js';
import { TelegramClarifications, initializeTelegram } from '../src/telegram.js';
import {
  initializeTelegramCursor,
  pollOnce,
  telegramPoller,
} from '../src/telegram-cli.js';
const settings = { chatId: '-123', userIds: { rodion: '101', katya: '102' } };
const update = (id: number, user = 101) => ({
  update_id: id,
  message: {
    chat: { id: -123 },
    from: { id: user },
    reply_to_message: { message_id: 42 },
    text: 'Food purchase',
  },
});
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeTelegram);
  await db.transaction(initializeTelegramCursor);
  const repo = new Repository(db);
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: '1',
      accountId: 'a',
      owner: 'rodion',
      bookedAt: '2026-09-11T00:00:00Z',
      currency: 'EUR',
      amountMinor: '-100',
      description: 'Test',
    },
  ]);
  const bot = new TelegramClarifications(db, settings, {
    async send() {
      return { messageId: 42 };
    },
    async react() {
      throw new Error('unexpected_react');
    },
    async reply() {
      throw new Error('unexpected_reply');
    },
  });
  const row = (await repo.list())[0]!;
  await bot.queue(row.id, 0, 'Question', 'rodion');
  await bot.dispatchOne();
  return { db, bot };
}

test('cursor advances with safe receipt, ignores stranger, and never replays accepted updates', async () => {
  const { db, bot } = await setup();
  try {
    await db.transaction(initializeTelegramCursor);
    assert.equal(
      await pollOnce(db, settings, async (offset) => {
        assert.equal(offset, 0);
        return [update(4, 999), update(3)];
      }),
      5,
    );
    assert.equal((await bot.pending('rodion')).length, 1);
    assert.equal(
      await pollOnce(db, settings, async (offset) => {
        assert.equal(offset, 5);
        return [update(3), update(4, 999)];
      }),
      5,
    );
    assert.equal((await bot.pending('rodion')).length, 1);
  } finally {
    await db.close();
  }
});

test('cursor failure rolls back received proposal and dedup record atomically', async () => {
  const { db, bot } = await setup();
  try {
    const failing: Database = {
      ...db,
      transaction: (action) =>
        db.transaction((tx) => {
          const wrapped: Executor = {
            query: (sql, params) => {
              if (sql.startsWith('UPDATE telegram_poll_cursor'))
                throw new Error('simulated crash');
              return tx.query(sql, params);
            },
          };
          return action(wrapped);
        }),
    };
    await assert.rejects(
      pollOnce(failing, settings, async () => [update(1)]),
      /simulated crash/,
    );
    assert.equal((await bot.pending('rodion')).length, 0);
    assert.equal(
      (await db.query('SELECT * FROM telegram_updates')).rows.length,
      0,
    );
    assert.equal(
      await pollOnce(db, settings, async (offset) => {
        assert.equal(offset, 0);
        return [update(1)];
      }),
      2,
    );
    assert.equal((await bot.pending('rodion')).length, 1);
  } finally {
    await db.close();
  }
});

test('malformed IDs and polling failure do not advance durable cursor', async () => {
  const { db } = await setup();
  try {
    for (const raw of [
      { update_id: '1' },
      null,
      { update_id: Number.MAX_SAFE_INTEGER },
    ])
      await assert.rejects(
        pollOnce(db, settings, async () => [raw]),
        /telegram_update_invalid/,
      );
    await assert.rejects(
      pollOnce(db, settings, async () => {
        throw new Error('poll stopped');
      }),
      /poll stopped/,
    );
    assert.equal(
      Number(
        (await db.query('SELECT next_update_id FROM telegram_poll_cursor'))
          .rows[0]!.next_update_id,
      ),
      0,
    );
  } finally {
    await db.close();
  }
});

test('polling uses fixed origin, bounded response and sanitized errors with fake HTTP', async () => {
  const token = '123456:synthetic_token_123456789';
  const poll = telegramPoller(token, async (url, init) => {
    assert.equal(url, `https://api.telegram.org/bot${token}/getUpdates`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      offset: 7,
      limit: 50,
      timeout: 10,
      allowed_updates: ['message'],
    });
    return new Response(JSON.stringify({ ok: true, result: [update(7)] }));
  });
  assert.deepEqual(await poll(7), [update(7)]);
  for (const fake of [
    async () => {
      throw new Error(token);
    },
    async () => new Response('x'.repeat(1048577)),
    async () =>
      new Response(
        JSON.stringify({ ok: true, result: Array(51).fill(update(1)) }),
      ),
  ])
    await assert.rejects(
      telegramPoller(token, fake)(0),
      /^Error: telegram_poll_failed$/,
    );
});
