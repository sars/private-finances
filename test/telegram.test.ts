import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Reports, previousReportPeriod } from '../src/reports.js';
import { synthetic } from '../src/synthetic.js';
import {
  initializeTelegram,
  TelegramClarifications,
  telegramTransport,
  TelegramError,
} from '../src/telegram.js';

const settings = { chatId: '-123', userIds: { rodion: '101', katya: '102' } };
const update = (id: number, user = 101, chat = -123, reply = 42) => ({
  update_id: id,
  message: {
    chat: { id: chat },
    from: { id: user, is_bot: false },
    reply_to_message: { message_id: reply },
    text: 'This was groceries, not a transfer.',
  },
});

test('owner-bound question, reply mapping, strict identity, dedup and pending natural text', async () => {
  const db = memoryDatabase();
  let sends = 0;
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    await db.transaction(initializeTelegram);
    const repo = new Repository(db);
    await repo.importBatch(synthetic);
    const transaction = (await repo.list('rodion'))[0]!;
    const bot = new TelegramClarifications(db, settings, {
      async send(chat, text) {
        assert.equal(chat, '-123');
        assert.equal(text, 'What was this?');
        sends++;
        return { messageId: 42 };
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    });
    await assert.rejects(
      bot.queue(transaction.id, 0, 'What was this?', 'katya'),
      /not_found/,
    );
    await assert.rejects(
      bot.queue(transaction.id, 1, 'What was this?', 'rodion'),
      /stale_revision/,
    );
    const id = await bot.queue(transaction.id, 0, 'What was this?', 'rodion');
    assert.equal(
      await bot.queue(transaction.id, 0, 'What was this?', 'rodion'),
      id,
    );
    assert.equal(await bot.dispatchOne(), 'sent');
    assert.equal(await bot.dispatchOne(), 'idle');
    assert.equal(sends, 1);
    assert.equal(await bot.receive(update(1, 999)), 'ignored');
    assert.equal(await bot.receive(update(2, 101, -999)), 'ignored');
    assert.equal(await bot.receive(update(3, 102)), 'ignored');
    assert.equal(await bot.receive(update(4, 101, -123, 999)), 'ignored');
    assert.equal(await bot.receive(update(5)), 'accepted');
    assert.equal(await bot.receive(update(5)), 'duplicate');
    assert.equal((await bot.pending('rodion')).length, 1);
    assert.deepEqual(await bot.pending('katya'), []);
    assert.equal(
      (await bot.pending('rodion'))[0]!.input_text,
      update(5).message.text,
    );
    const unchanged = (await repo.list('rodion')).find(
      (t) => t.id === transaction.id,
    )!;
    assert.equal(unchanged.kind, 'unresolved');
    assert.equal(unchanged.revision, 0);
    await repo.classify(
      transaction.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Owner reviewed' },
      'rodion',
    );
    assert.equal(await bot.receive(update(6)), 'stale');
    assert.equal((await bot.pending('rodion')).length, 1);
  } finally {
    await db.close();
  }
});

test('send failures and expired crash leases are uncertain and never blindly retried', async () => {
  const db = memoryDatabase();
  let sends = 0;
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    const repo = new Repository(db);
    await repo.importBatch(synthetic);
    const transaction = (await repo.list('rodion'))[0]!;
    const bot = new TelegramClarifications(db, settings, {
      async send() {
        sends++;
        throw new Error('SECRET transport URL and token');
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    });
    await bot.queue(transaction.id, 0, 'Question', 'rodion');
    assert.equal(await bot.dispatchOne(), 'uncertain');
    assert.equal(await bot.dispatchOne(), 'idle');
    assert.equal(sends, 1);
    assert.equal(
      (await db.query('SELECT state FROM telegram_outbox')).rows[0]!.state,
      'uncertain',
    );
    await db.query(
      "UPDATE telegram_outbox SET state='sending',lease_until=now()-interval '1 second'",
    );
    await bot.recoverExpired();
    assert.equal(await bot.dispatchOne(), 'idle');
    assert.equal(sends, 1);
    assert.equal(await bot.receive(update(1)), 'ignored');
  } finally {
    await db.close();
  }
});

test('changed transactions are not sent and config is validated', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    const repo = new Repository(db);
    await repo.importBatch(synthetic);
    const transaction = (await repo.list('rodion'))[0]!;
    const transport = {
      async send() {
        throw new Error('must not send');
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    };
    assert.throws(
      () =>
        new TelegramClarifications(
          db,
          { ...settings, userIds: { rodion: '101', katya: '101' } },
          transport,
        ),
      TelegramError,
    );
    const bot = new TelegramClarifications(db, settings, transport);
    await bot.queue(transaction.id, 0, 'Question', 'rodion');
    await repo.classify(
      transaction.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Reviewed' },
      'rodion',
    );
    assert.equal(await bot.dispatchOne(), 'idle');
    assert.equal(
      (await db.query('SELECT state FROM telegram_outbox')).rows[0]!.state,
      'uncertain',
    );
  } finally {
    await db.close();
  }
});

test('fixed-origin HTTP transport sanitizes failures and validates message receipts without network', async () => {
  const token = '123456:synthetic_fake_token_123456789';
  let calls = 0;
  const good = telegramTransport(token, async (input, init) => {
    calls++;
    assert.equal(
      String(input),
      `https://api.telegram.org/bot${token}/sendMessage`,
    );
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.signal);
    assert.equal(JSON.parse(String(init?.body)).text, 'Hello');
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 42, chat: { id: -123 } },
      }),
    );
  });
  assert.deepEqual(await good.send('-123', 'Hello'), { messageId: 42 });
  assert.equal(calls, 1);
  for (const fetcher of [
    async () => {
      throw new Error(token);
    },
    async () => new Response('bad', { status: 500 }),
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 42, chat: { id: 999 } },
        }),
      ),
    async () => new Response('x'.repeat(65537)),
  ]) {
    await assert.rejects(
      telegramTransport(token, fetcher).send('-123', 'Hello'),
      (error) =>
        error instanceof TelegramError &&
        error.message === 'telegram_uncertain',
    );
  }
  assert.throws(() => telegramTransport('bad'), TelegramError);
});

test('report delivery is idempotent, owner-checked and renders exact incomplete currency totals', async () => {
  const db = memoryDatabase();
  let sends = 0;
  let sentText = '';
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    await db.transaction(initializeTelegram);
    const repo = new Repository(db);
    await repo.importBatch([
      {
        ...synthetic[0],
        sourceId: 'report-1',
        owner: 'rodion',
        bookedAt: '2026-08-15T00:00:00Z',
        currency: 'EUR',
        amountMinor: '-1234',
      },
      {
        ...synthetic[0],
        sourceId: 'report-2',
        owner: 'rodion',
        bookedAt: '2026-08-15T00:00:00Z',
        currency: 'EUR',
        amountMinor: '-567',
        status: 'pending',
      },
    ]);
    const reports = new Reports(db);
    const period = previousReportPeriod(
      'month',
      new Date('2026-09-11T00:00:00Z'),
    );
    const snapshot = await reports.save(await repo.list(), {
      owner: 'all',
      period,
    });
    const privateReport = await reports.save(await repo.list(), {
      owner: 'katya',
      period,
    });
    const bot = new TelegramClarifications(db, settings, {
      async send(chat, text, options) {
        assert.equal(chat, '-123');
        assert.equal(options?.forceReply, false);
        sends++;
        sentText = text;
        return { messageId: 900 };
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    });
    await assert.rejects(
      bot.queueReport(privateReport.id, 'rodion'),
      /not_found/,
    );
    const id = await bot.queueReport(snapshot.id, 'rodion');
    assert.equal(await bot.queueReport(snapshot.id, 'katya'), id);
    assert.equal(await bot.dispatchReportOne(), 'sent');
    assert.equal(await bot.dispatchReportOne(), 'idle');
    assert.equal(sends, 1);
    assert.match(sentText, /Family/);
    assert.match(
      sentText,
      // The held payment is money already gone that nobody has explained, so it
      // is inside the unresolved figure and declared again as pending.
      /EUR: personal 0.00; unresolved 18.01 \(2\); pending 5.67 \(1\)/,
    );
    assert.match(sentText, /unverified/);
    assert.match(sentText, /no conversion/);
    assert.match(sentText, /revision 1/);
    assert.equal(await bot.queueReport(snapshot.id, 'rodion'), id);
    assert.equal(await bot.dispatchReportOne(), 'idle');
    assert.equal(
      (await db.query('SELECT * FROM report_delivery')).rows.length,
      1,
    );
    assert.equal(
      (await db.query('SELECT * FROM telegram_outbox')).rows.length,
      0,
    );
    const first = (await repo.list()).find(
      (row) => row.sourceId === 'report-1',
    )!;
    await repo.classify(
      first.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Confirmed',
      },
      'rodion',
    );
    const corrected = await reports.save(await repo.list(), {
      owner: 'all',
      period,
    });
    assert.notEqual(await bot.queueReport(corrected.id, 'rodion'), id);
    assert.equal(
      (await db.query('SELECT * FROM report_delivery')).rows.length,
      2,
    );
  } finally {
    await db.close();
  }
});

test('failed and expired report sends become uncertain and are never retried', async () => {
  const db = memoryDatabase();
  let sends = 0;
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    const report = await new Reports(db).save([], {
      owner: 'all',
      period: previousReportPeriod('week', new Date('2026-09-11T00:00:00Z')),
    });
    const bot = new TelegramClarifications(db, settings, {
      async send() {
        sends++;
        throw new Error('sensitive transport failure');
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    });
    await bot.queueReport(report.id, 'rodion');
    assert.equal(await bot.dispatchReportOne(), 'uncertain');
    assert.equal(await bot.dispatchReportOne(), 'idle');
    await bot.queueReport(report.id, 'rodion');
    assert.equal(await bot.dispatchReportOne(), 'idle');
    assert.equal(sends, 1);
    assert.equal(
      (await db.query('SELECT state FROM report_delivery')).rows[0]!.state,
      'uncertain',
    );
    await db.query(
      "UPDATE report_delivery SET state='sending',lease_until=now()-interval '1 second'",
    );
    await bot.recoverExpired();
    assert.equal(await bot.dispatchReportOne(), 'idle');
    assert.equal(sends, 1);
    assert.equal(
      (await db.query('SELECT state FROM report_delivery')).rows[0]!.state,
      'uncertain',
    );
  } finally {
    await db.close();
  }
});

test('pending question accepts reply after exact settlement but rejects changed payment evidence', async () => {
  for (const change of [
    'settlement',
    'amount',
    'merchant',
    'hold-other',
    'human',
  ] as const) {
    const db = memoryDatabase();
    try {
      await migrate(db);
      const repo = new Repository(db);
      const payment = {
        source: 'monobank',
        sourceId: 'one',
        accountId: 'a',
        owner: 'rodion',
        bookedAt: '2026-09-11T00:00:00Z',
        currency: 'EUR',
        amountMinor: '-100',
        description: 'Synthetic restaurant',
        status: 'pending',
        sourceDetails: { hold: true, mcc: 5812 },
      };
      await repo.importBatch([payment]);
      const row = (await repo.list())[0]!;
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
      await bot.queue(row.id, 0, 'What was it?', 'rodion');
      await bot.dispatchOne();
      await repo.importBatch([
        {
          ...payment,
          status: 'booked',
          amountMinor: change === 'amount' ? '-200' : '-100',
          description:
            change === 'merchant' ? 'Other merchant' : payment.description,
          sourceDetails: {
            hold: false,
            mcc: change === 'hold-other' ? 5411 : 5812,
          },
        },
      ]);
      if (change === 'human')
        await repo.classify(
          row.id,
          1,
          { kind: 'unresolved', category: null, reason: 'Keep for review' },
          'rodion',
        );
      assert.equal(
        await bot.receive(update(1)),
        change === 'settlement' ? 'accepted' : 'stale',
        change,
      );
      assert.equal(
        (await db.query('SELECT * FROM telegram_outbox')).rows.length,
        1,
      );
    } finally {
      await db.close();
    }
  }
});

test('reaction and plain reply share the bounded fixed-origin transport', async () => {
  const token = '123456:synthetic_fake_token_123456789';
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const transport = telegramTransport(token, async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.signal);
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify(
        String(input).endsWith('/setMessageReaction')
          ? { ok: true, result: true }
          : { ok: true, result: { message_id: 77, chat: { id: -123 } } },
      ),
    );
  });
  await transport.react('-123', 5, '👍');
  assert.equal(
    urls[0],
    `https://api.telegram.org/bot${token}/setMessageReaction`,
  );
  assert.deepEqual(bodies[0], {
    chat_id: '-123',
    message_id: 5,
    reaction: [{ type: 'emoji', emoji: '👍' }],
  });
  await transport.react('-123', 5, null);
  assert.deepEqual(bodies[1]?.reaction, []);
  assert.deepEqual(await transport.reply('-123', 5, 'Plain text'), {
    messageId: 77,
  });
  assert.equal(urls[2], `https://api.telegram.org/bot${token}/sendMessage`);
  assert.deepEqual(bodies[2], {
    chat_id: '-123',
    text: 'Plain text',
    reply_parameters: { message_id: 5, allow_sending_without_reply: true },
  });
  assert.equal('reply_markup' in bodies[2]!, false);
  const uncertain = (error: unknown) =>
    error instanceof TelegramError && error.code === 'uncertain';
  for (const result of [false, 'true', null, { message_id: 1 }]) {
    const bad = telegramTransport(
      token,
      async () => new Response(JSON.stringify({ ok: true, result })),
    );
    await assert.rejects(bad.react('-123', 5, '👍'), uncertain);
  }
  const wrongChat = telegramTransport(
    token,
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 77, chat: { id: 999 } },
        }),
      ),
  );
  await assert.rejects(wrongChat.reply('-123', 5, 'Plain text'), uncertain);
  const failing = telegramTransport(token, async () => {
    throw new Error(token);
  });
  await assert.rejects(failing.react('-123', 5, null), uncertain);
  await assert.rejects(failing.reply('-123', 5, 'Plain text'), uncertain);
});
