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
    // A stranger, the wrong chat, and a reply to something that is not an open
    // question are all still nothing to us.
    assert.equal(await bot.receive(update(1, 999)), 'ignored');
    assert.equal(await bot.receive(update(2, 101, -999)), 'ignored');
    assert.equal(await bot.receive(update(4, 101, -123, 999)), 'ignored');
    assert.equal(await bot.receive(update(5)), 'accepted');
    assert.equal(await bot.receive(update(5)), 'duplicate');
    // The question was addressed to Rodion, but Katya may answer it: the answer
    // belongs to his payment and records that she wrote it.
    assert.equal(await bot.receive(update(3, 102)), 'accepted');
    assert.deepEqual(await bot.pending('katya'), []);
    const waiting = await bot.pending('rodion');
    assert.equal(waiting.length, 2);
    assert.equal(waiting[0]!.input_text, update(5).message.text);
    const answers = await bot.history('rodion');
    assert.deepEqual(
      answers.map((a) => a.answered_by),
      ['katya', 'rodion'],
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
    assert.equal((await bot.pending('rodion')).length, 2);
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

test('an answer that reaches nothing records why, naming the other member when they replied', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    const repo = new Repository(db);
    await repo.importBatch(synthetic);
    const transaction = (await repo.list('rodion'))[0]!;
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
    await bot.queue(transaction.id, 0, 'What was this?', 'rodion');
    assert.equal(await bot.dispatchOne(), 'sent');

    const outcomeOf = async (id: number) =>
      (
        await db.query(
          'SELECT outcome, detail FROM telegram_updates WHERE update_id=$1',
          [id],
        )
      ).rows[0];

    // Katya answers a question the bot addressed to Rodion. This is the shape
    // that silently lost two of her answers in September; it is now accepted,
    // against his payment, recording that she was the one who wrote it.
    assert.equal(await bot.receive(update(11, 102)), 'accepted');
    assert.equal((await outcomeOf(11))!.outcome, 'accepted');
    assert.match(
      String((await outcomeOf(11))!.detail),
      /katya answered for rodion/,
    );
    const answered = await db.query(
      'SELECT owner, answered_by FROM telegram_proposal_inputs WHERE update_id=$1',
      [11],
    );
    assert.equal(answered.rows[0]!.owner, 'rodion');
    assert.equal(answered.rows[0]!.answered_by, 'katya');

    // A reply aimed at a message that was never a question.
    assert.equal(await bot.receive(update(12, 101, -123, 777)), 'ignored');
    assert.match(String((await outcomeOf(12))!.detail), /not an open question/);

    // The owner's own answer says so rather than naming someone else.
    assert.equal(await bot.receive(update(13)), 'accepted');
    assert.equal((await outcomeOf(13))!.outcome, 'accepted');
    assert.match(
      String((await outcomeOf(13))!.detail),
      new RegExp(
        `rodion answered for rodion; linked to payment ${transaction.id}`,
      ),
    );

    // And one that arrives after the payment has moved on says so too.
    await repo.classify(
      transaction.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Owner reviewed' },
      'rodion',
    );
    assert.equal(await bot.receive(update(14)), 'stale');
    assert.match(String((await outcomeOf(14))!.detail), /revision 0 to 1/);
  } finally {
    await db.close();
  }
});

test('a household message that reaches no question is recorded, and one aimed at the bot is answered', async () => {
  const db = memoryDatabase();
  const reactions: Array<{ messageId: number; emoji: string | null }> = [];
  const replies: Array<{ to: number; text: string }> = [];
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    const repo = new Repository(db);
    await repo.importBatch(synthetic);
    const transaction = (await repo.list('rodion'))[0]!;
    const bot = new TelegramClarifications(
      db,
      { ...settings, publicOrigin: 'https://finances.example' },
      {
        async send() {
          return { messageId: 42 };
        },
        async react(_chat, messageId, emoji) {
          reactions.push({ messageId, emoji });
        },
        async reply(_chat, to, text) {
          replies.push({ to, text });
          return { messageId: 500 + replies.length };
        },
      },
    );
    await bot.queue(transaction.id, 0, 'What was this?', 'rodion');
    assert.equal(await bot.dispatchOne(), 'sent');
    const message = (
      id: number,
      over: Record<string, unknown>,
      reply?: Record<string, unknown>,
    ) => ({
      update_id: id,
      message: {
        message_id: id,
        chat: { id: -123 },
        from: { id: 102, is_bot: false },
        text: 'It was the intercom',
        ...(reply ? { reply_to_message: reply } : {}),
        ...over,
      },
    });
    const recorded = async (id: number) =>
      (
        await db.query(
          'SELECT outcome, detail FROM telegram_updates WHERE update_id=$1',
          [id],
        )
      ).rows[0];
    const notes = async () =>
      (
        await db.query(
          'SELECT message_id, text, state FROM telegram_notes ORDER BY created_at',
        )
      ).rows;

    // A plain message in the chat is theirs, not ours: recorded, never answered.
    assert.deepEqual(await bot.receiveDetailed(message(1, {})), {
      outcome: 'ignored',
      detail: 'the message is not a reply to a question',
    });
    assert.equal((await recorded(1))!.outcome, 'ignored');
    assert.equal((await notes()).length, 0);

    // A reply to the other member is their conversation too.
    assert.equal(
      (
        await bot.receiveDetailed(
          message(2, {}, { message_id: 7, from: { id: 101, is_bot: false } }),
        )
      ).outcome,
      'ignored',
    );
    assert.equal((await notes()).length, 0);

    // A reply to something the bot said that is not an open question is
    // answered with why, under the member's own message.
    assert.equal(
      (
        await bot.receiveDetailed(
          message(3, {}, { message_id: 7, from: { id: 999, is_bot: true } }),
        )
      ).outcome,
      'ignored',
    );
    assert.equal((await notes()).length, 1);
    assert.equal(Number((await notes())[0]!.message_id), 3);
    assert.equal(await bot.dispatchNoteOne(), 'sent');
    assert.deepEqual(reactions, [{ messageId: 3, emoji: '👀' }]);
    assert.equal(replies[0]!.to, 3);
    assert.match(replies[0]!.text, /could not link this to an open question/);
    assert.equal(await bot.dispatchNoteOne(), 'idle');
    assert.equal((await notes())[0]!.state, 'sent');

    // A real answer to the real question still lands, with nothing extra said.
    assert.equal(
      (
        await bot.receiveDetailed(
          message(4, {}, { message_id: 42, from: { id: 999, is_bot: true } }),
        )
      ).outcome,
      'accepted',
    );
    assert.equal((await notes()).length, 1);

    // One that arrives after the payment moved on says so, with a way back.
    await repo.classify(
      transaction.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Owner reviewed' },
      'rodion',
    );
    assert.equal(
      (
        await bot.receiveDetailed(
          message(5, {}, { message_id: 42, from: { id: 999, is_bot: true } }),
        )
      ).outcome,
      'stale',
    );
    assert.equal(await bot.dispatchNoteOne(), 'sent');
    assert.equal(replies[1]!.to, 5);
    assert.match(replies[1]!.text, /changed since I asked/);
    assert.match(
      replies[1]!.text,
      new RegExp(`https://finances.example/review\\?id=${transaction.id}`),
    );

    // A note the chat did not take is kept for review, never repeated.
    assert.equal(
      (
        await bot.receiveDetailed(
          message(6, {}, { message_id: 8, from: { id: 999, is_bot: true } }),
        )
      ).outcome,
      'ignored',
    );
    const failing = new TelegramClarifications(db, settings, {
      async send() {
        return { messageId: 42 };
      },
      async react() {
        throw new TelegramError('uncertain');
      },
      async reply() {
        throw new TelegramError('uncertain');
      },
    });
    assert.equal(await failing.dispatchNoteOne(), 'uncertain');
    assert.equal(await failing.dispatchNoteOne(), 'idle');
    assert.equal((await notes())[2]!.state, 'uncertain');
  } finally {
    await db.close();
  }
});
