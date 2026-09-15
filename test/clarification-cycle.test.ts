import {
  TransactionTriage,
  initializeTransactionTriage,
} from '../src/transaction-triage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { TelegramClarifications, initializeTelegram } from '../src/telegram.js';
import {
  liveQuestionsFrom,
  queueDailyClarifications,
  type ClarificationBotFactory,
} from '../src/clarification-cycle.js';
const now = new Date('2026-09-11T12:00:00Z');
const settings = { chatId: '-123', userIds: { rodion: '101', katya: '102' } };
const factory: ClarificationBotFactory = (db) =>
  new TelegramClarifications(db, settings, {
    async send() {
      throw new Error('must never send');
    },
    async react() {
      throw new Error('unexpected_react');
    },
    async reply() {
      throw new Error('unexpected_reply');
    },
  });
const base = {
  source: 'synthetic',
  accountId: 'a',
  bookedAt: '2026-09-01T00:00:00Z',
  currency: 'EUR',
  amountMinor: '-1234',
  description: 'Test merchant',
};

test('daily queue caps each owner under concurrency, skips replay, and rolls to next UTC day', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    await db.transaction(initializeTransactionTriage);
    const repo = new Repository(db);
    await repo.importBatch(
      ['rodion', 'katya'].flatMap((owner) =>
        Array.from({ length: 8 }, (_, i) => ({
          ...base,
          sourceId: `${owner}-${i}`,
          owner,
          accountId: owner,
        })),
      ),
    );
    await ready(db);
    const results = await Promise.all([
      queueDailyClarifications(db, factory, now),
      queueDailyClarifications(db, factory, now),
    ]);
    assert.equal(
      results.reduce((n, r) => n + r.rodion, 0),
      5,
    );
    assert.equal(
      results.reduce((n, r) => n + r.katya, 0),
      5,
    );
    assert.equal(
      (await db.query('SELECT * FROM telegram_outbox')).rows.length,
      10,
    );
    assert.deepEqual(await queueDailyClarifications(db, factory, now), {
      rodion: 0,
      katya: 0,
    });
    assert.deepEqual(
      await queueDailyClarifications(
        db,
        factory,
        new Date('2026-09-12T00:00:00Z'),
      ),
      { rodion: 3, katya: 3 },
    );
    assert.equal(
      (await db.query('SELECT * FROM telegram_outbox')).rows.length,
      16,
    );
    assert.ok(
      (await repo.list()).every(
        (row) => row.kind === 'unresolved' && row.revision === 0,
      ),
    );
    const prompt = String(
      (await db.query('SELECT prompt FROM telegram_outbox LIMIT 1')).rows[0]!
        .prompt,
    );
    assert.match(prompt, /12\.34 EUR/);
    assert.match(prompt, /remain unresolved/);
  } finally {
    await db.close();
  }
});

test('ignores pending, incoming, zero, human unresolved overrides and previously queued revisions', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    await db.transaction(initializeTransactionTriage);
    const repo = new Repository(db);
    await repo.importBatch([
      { ...base, sourceId: 'pending', owner: 'rodion', status: 'pending' },
      { ...base, sourceId: 'inflow', owner: 'rodion', amountMinor: '100' },
      { ...base, sourceId: 'zero', owner: 'rodion', amountMinor: '0' },
      { ...base, sourceId: 'human', owner: 'rodion' },
      { ...base, sourceId: 'queued', owner: 'rodion' },
      {
        ...base,
        sourceId: 'eligible',
        owner: 'rodion',
        currency: 'JPY',
        amountMinor: '-1234',
      },
    ]);
    await ready(db);
    const rows = await repo.list();
    const human = rows.find((t) => t.sourceId === 'human')!;
    await repo.classify(
      human.id,
      0,
      {
        kind: 'unresolved',
        category: null,
        reason: 'Human asks to keep unresolved',
      },
      'rodion',
    );
    const queued = rows.find((t) => t.sourceId === 'queued')!;
    await factory(db).queue(queued.id, 0, 'Existing question', 'rodion');
    await db.query(
      "UPDATE telegram_outbox SET state='uncertain',created_at=$1",
      [now.toISOString()],
    );
    assert.deepEqual(await queueDailyClarifications(db, factory, now), {
      rodion: 1,
      katya: 0,
    });
    const outbox = (await db.query('SELECT prompt,state FROM telegram_outbox'))
      .rows;
    assert.equal(outbox.length, 2);
    assert.ok(outbox.some((r) => String(r.prompt).includes('1234 JPY')));
    assert.ok(outbox.some((r) => r.state === 'uncertain'));
  } finally {
    await db.close();
  }
});

test('queue failure rolls back the whole cycle without spending the daily allowance', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    await db.transaction(initializeTransactionTriage);
    const repo = new Repository(db);
    await repo.importBatch([
      { ...base, sourceId: '1', owner: 'rodion' },
      { ...base, sourceId: '2', owner: 'rodion' },
    ]);
    await ready(db);
    let calls = 0;
    await assert.rejects(
      queueDailyClarifications(
        db,
        (scoped) => ({
          async queue(...args) {
            if (++calls === 2) throw new Error('simulated failure');
            return factory(scoped).queue(...args);
          },
        }),
        now,
      ),
      /simulated failure/,
    );
    assert.equal(
      (await db.query('SELECT * FROM telegram_outbox')).rows.length,
      0,
    );
    assert.deepEqual(await queueDailyClarifications(db, factory, now), {
      rodion: 2,
      katya: 0,
    });
  } finally {
    await db.close();
  }
});

async function ready(db: ReturnType<typeof memoryDatabase>) {
  await db.query(
    `INSERT INTO transaction_triage(transaction_id,revision,owner,state,question) SELECT id,revision,owner,'ready','Was this for personal use or business?' FROM transactions`,
  );
}

test('only current ready ambiguity reaches the queue; uninspected and quiet suggestions do not consume caps', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.transaction(initializeTransactionTriage);
    const repo = new Repository(db);
    await repo.importBatch(
      ['uninspected', 'quiet', 'deferred', 'stale', 'question'].map(
        (sourceId) => ({ ...base, sourceId, owner: 'rodion' }),
      ),
    );
    const rows = await repo.list();
    for (const row of rows.filter((r) => r.sourceId !== 'uninspected')) {
      await db.query(
        `INSERT INTO transaction_triage(transaction_id,revision,owner,state,question) VALUES($1,$2,'rodion',$3,$4)`,
        [
          row.id,
          row.sourceId === 'stale' ? 99 : row.revision,
          row.sourceId === 'deferred' ? 'deferred' : 'ready',
          row.sourceId === 'quiet' ? null : 'Was this for business?',
        ],
      );
    }
    assert.deepEqual(await queueDailyClarifications(db, factory, now), {
      rodion: 1,
      katya: 0,
    });
    const prompt = String(
      (await db.query('SELECT prompt FROM telegram_outbox')).rows[0]!.prompt,
    );
    assert.match(prompt, /Was this for business/);
    assert.doesNotMatch(prompt, /what was this transaction for/);
  } finally {
    await db.close();
  }
});

test('historical questions stay in the app and never enter automatic Telegram queue', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    await repo.importBatch([
      {
        ...base,
        sourceId: 'old',
        owner: 'rodion',
        bookedAt: '2026-08-10T12:00:00Z',
      },
    ]);
    await ready(db);
    assert.deepEqual(await queueDailyClarifications(db, factory, now), {
      rodion: 0,
      katya: 0,
    });
  } finally {
    await db.close();
  }
});

test('live cutoff validates UTC dates and rejects accidental backlog configuration', () => {
  assert.equal(liveQuestionsFrom(undefined), undefined);
  assert.equal(
    liveQuestionsFrom('2026-09-12T10:00:00Z')?.toISOString(),
    '2026-09-12T10:00:00.000Z',
  );
  assert.equal(
    liveQuestionsFrom('2026-09-12T10:00:00.123Z')?.toISOString(),
    '2026-09-12T10:00:00.123Z',
  );
  for (const value of [
    '',
    '2026-09-12',
    '2026-02-30T00:00:00Z',
    'bad',
    '2026-09-12T10:00:00+03:00',
  ])
    assert.throws(
      () => liveQuestionsFrom(value),
      /invalid_live_questions_from/,
    );
});

test('live lane bypasses a spent daily cap, deduplicates concurrent cycles and includes late imports across months', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const cutoff = new Date('2026-09-11T10:00:00Z');
    await repo.importBatch(
      Array.from({ length: 5 }, (_, i) => ({
        ...base,
        sourceId: `old-${i}`,
        owner: 'rodion',
      })),
    );
    await ready(db);
    assert.equal((await queueDailyClarifications(db, factory, now)).rodion, 5);
    await repo.importBatch(
      ['rodion', 'katya'].flatMap((owner) =>
        Array.from({ length: 8 }, (_, i) => ({
          ...base,
          sourceId: `new-${owner}-${i}`,
          owner,
          accountId: owner,
          bookedAt: cutoff.toISOString(),
        })),
      ),
    );
    await db.query(
      "INSERT INTO transaction_triage(transaction_id,revision,owner,state,question) SELECT id,revision,owner,'ready','What was this payment for?' FROM transactions ON CONFLICT DO NOTHING",
    );
    const results = await Promise.all([
      queueDailyClarifications(db, factory, now, cutoff),
      queueDailyClarifications(db, factory, now, cutoff),
    ]);
    assert.equal(
      results.reduce((n, r) => n + r.rodion, 0),
      8,
    );
    assert.equal(
      results.reduce((n, r) => n + r.katya, 0),
      8,
    );
    await repo.importBatch([
      {
        ...base,
        sourceId: 'late-new',
        owner: 'rodion',
        bookedAt: '2026-09-20T10:00:00Z',
      },
      {
        ...base,
        sourceId: 'late-old',
        owner: 'rodion',
        bookedAt: '2026-09-11T09:59:59Z',
      },
    ]);
    await db.query(
      "INSERT INTO transaction_triage(transaction_id,revision,owner,state,question) SELECT id,revision,owner,'ready','What was this payment for?' FROM transactions ON CONFLICT DO NOTHING",
    );
    assert.deepEqual(
      await queueDailyClarifications(
        db,
        factory,
        new Date('2026-10-01T10:00:00Z'),
        cutoff,
      ),
      { rodion: 1, katya: 0 },
    );
    assert.deepEqual(
      await queueDailyClarifications(
        db,
        factory,
        new Date('2026-10-01T10:00:00Z'),
        cutoff,
      ),
      { rodion: 0, katya: 0 },
    );
  } finally {
    await db.close();
  }
});

test('live fallback requires completed current triage and preserves eligibility exclusions', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const cutoff = new Date('2026-09-01T00:00:00Z');
    const ids = [
      'ready',
      'deferred',
      'uncertain',
      'uninspected',
      'processing',
      'quiet',
      'stale',
      'pending',
      'incoming',
      'zero',
      'human',
      'business',
      'investment',
      'future',
      'old',
      'queued',
    ];
    await repo.importBatch(
      ids.map((sourceId) => ({
        ...base,
        sourceId,
        owner: 'rodion',
        accountId: sourceId,
        ...(sourceId === 'pending' ? { status: 'pending' } : {}),
        ...(sourceId === 'incoming' ? { amountMinor: '10' } : {}),
        ...(sourceId === 'zero' ? { amountMinor: '0' } : {}),
        ...(sourceId === 'future' ? { bookedAt: '2026-09-12T00:00:00Z' } : {}),
        ...(sourceId === 'old' ? { bookedAt: '2026-08-31T23:59:59Z' } : {}),
      })),
    );
    const rows = await repo.list();
    const human = rows.find((r) => r.sourceId === 'human')!;
    await repo.classify(
      human.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Keep unresolved' },
      'rodion',
    );
    for (const row of await repo.list()) {
      if (row.sourceId === 'uninspected') continue;
      await db.query(
        "INSERT INTO transaction_triage(transaction_id,revision,owner,state,question) VALUES($1,$2,'rodion',$3,$4)",
        [
          row.id,
          row.sourceId === 'stale' ? 99 : row.revision,
          ['deferred', 'uncertain', 'processing'].includes(row.sourceId)
            ? row.sourceId
            : 'ready',
          ['quiet', 'deferred', 'uncertain'].includes(row.sourceId)
            ? null
            : 'Please clarify this payment.',
        ],
      );
    }
    for (const purpose of ['business', 'investment'])
      await db.query(
        "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic',$1,'rodion',$1,$1)",
        [purpose],
      );
    const queued = rows.find((r) => r.sourceId === 'queued')!;
    await factory(db).queue(queued.id, 0, 'Existing question', 'rodion');
    await db.query("UPDATE telegram_outbox SET state='uncertain'");
    assert.deepEqual(await queueDailyClarifications(db, factory, now, cutoff), {
      rodion: 4,
      katya: 0,
    });
    const prompts = (
      await db.query('SELECT prompt FROM telegram_outbox')
    ).rows.map((r) => String(r.prompt));
    assert.equal(
      prompts.filter((p) => p.includes('Automatic review could not determine'))
        .length,
      2,
    );
    assert.equal(prompts.filter((p) => p.includes('Please clarify')).length, 2);
  } finally {
    await db.close();
  }
});

test('live question waits for the normal triage attempt when AI is unavailable', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await new Repository(db).importBatch([
      { ...base, sourceId: 'ai-disabled', owner: 'rodion' },
    ]);
    const cutoff = new Date(base.bookedAt);
    assert.equal(
      (await queueDailyClarifications(db, factory, now, cutoff)).rodion,
      0,
    );
    let attempts = 0;
    const triage = new TransactionTriage(db, async () => {
      attempts++;
      return undefined;
    });
    assert.equal(await triage.processOne(), true);
    assert.equal(attempts, 1);
    assert.equal(
      (await queueDailyClarifications(db, factory, now, cutoff)).rodion,
      1,
    );
    assert.equal(
      (await queueDailyClarifications(db, factory, now, cutoff)).rodion,
      0,
    );
    assert.equal(
      (await db.query('SELECT * FROM classifier_proposals')).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});

test('live pending question survives exact settlement without duplicate and stays explicit about bank processing', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const payment = {
      ...base,
      source: 'monobank',
      sourceId: 'settle',
      owner: 'rodion',
      status: 'pending',
      sourceDetails: { hold: true, mcc: 5812 },
    };
    await repo.importBatch([payment]);
    await ready(db);
    const cutoff = new Date(base.bookedAt);
    assert.deepEqual(await queueDailyClarifications(db, factory, now), {
      rodion: 0,
      katya: 0,
    });
    assert.deepEqual(await queueDailyClarifications(db, factory, now, cutoff), {
      rodion: 1,
      katya: 0,
    });
    assert.match(
      String(
        (await db.query('SELECT prompt FROM telegram_outbox')).rows[0]!.prompt,
      ),
      /Bank processing/,
    );
    await repo.importBatch([
      {
        ...payment,
        status: 'booked',
        sourceDetails: { hold: false, mcc: 5812 },
      },
    ]);
    await ready(db);
    assert.deepEqual(await queueDailyClarifications(db, factory, now, cutoff), {
      rodion: 0,
      katya: 0,
    });
    const rows = (await db.query('SELECT revision FROM telegram_outbox')).rows;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.revision), 1);
  } finally {
    await db.close();
  }
});
