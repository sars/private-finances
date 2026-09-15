import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { convertedSpending } from '../src/analytics.js';
import { FxRates, initializeFxRates } from '../src/fx-rates.js';

test('display conversion uses transaction evidence and exposes missing third-currency rates', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await initializeFxRates(db);
    const repo = new Repository(db);
    await repo.importBatch([
      {
        source: 'monobank',
        sourceId: 'a',
        accountId: 'a',
        owner: 'rodion',
        bookedAt: '2026-09-01T00:00:00Z',
        currency: 'USD',
        amountMinor: '-200',
        description: 'Test',
        sourceDetails: {
          amount: -200,
          operationAmount: -8000,
          currencyCode: 980,
        },
      },
      {
        source: 'enablebanking',
        sourceId: 'b',
        accountId: 'b',
        owner: 'rodion',
        bookedAt: '2026-09-01T00:00:00Z',
        currency: 'EUR',
        amountMinor: '-100',
        description: 'Missing rate',
      },
    ]);
    for (const row of await repo.list())
      await repo.classify(
        row.id,
        row.revision,
        {
          kind: 'personal_expense',
          category: 'Food / Groceries',
          reason: 'Test',
        },
        'rodion',
      );
    const total = await convertedSpending(repo, await repo.list(), 'UAH');
    assert.equal(total.confirmedMinor, '8000');
    assert.equal(total.missing, 1);
    assert.equal(total.converted.length, 1);
    assert.match(total.converted[0]!.source, /fees/);
    const staleRows = await repo.list();
    await db.query('UPDATE transactions SET revision=revision+1');
    assert.equal((await convertedSpending(repo, staleRows, 'USD')).missing, 2);
    const third = await convertedSpending(repo, await repo.list(), 'GBP');
    assert.equal(third.missing, 2);
    assert.equal(third.confirmedMinor, '0');
  } finally {
    await db.close();
  }
});

test('all rows keep stable IDs across target currencies, expose missing coverage and sum exact converted minors', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await initializeFxRates(db);
    const repo = new Repository(db);
    const base = {
      source: 'enablebanking' as const,
      accountId: 'synthetic',
      owner: 'rodion' as const,
      bookedAt: '2026-09-01T00:00:00Z',
      currency: 'USD',
      amountMinor: '-1',
      description: 'Synthetic expense',
    };
    await repo.importBatch([
      { ...base, sourceId: 'a' },
      { ...base, sourceId: 'b' },
      { ...base, sourceId: 'missing', bookedAt: '2026-08-31T00:00:00Z' },
      { ...base, sourceId: 'pending', status: 'pending' },
      { ...base, sourceId: 'income', amountMinor: '100' },
      {
        ...base,
        sourceId: 'actual',
        source: 'monobank',
        amountMinor: '-100',
        sourceDetails: {
          amount: -100,
          operationAmount: -55,
          currencyCode: 978,
        },
      },
    ]);
    for (const row of await repo.list())
      if (['a', 'b', 'missing', 'actual'].includes(row.sourceId))
        await repo.classify(
          row.id,
          row.revision,
          {
            kind: 'personal_expense',
            category: 'Food / Groceries',
            reason: 'Synthetic',
          },
          'rodion',
        );
    const rates = new FxRates(db);
    for (const [currency, rate] of [
      ['USD', '2'],
      ['EUR', '3'],
    ] as const)
      await rates.insert({
        source: 'synthetic-market',
        base: currency,
        target: 'UAH',
        rate,
        asOf: '2026-09-01',
        retrievedAt: '2026-09-02T00:00:00Z',
        version: 1,
        provenance: 'Synthetic quote',
      });
    const rows = await repo.list();
    const before = await db.query(
      'SELECT id,revision,amount_minor,currency,kind FROM transactions ORDER BY id',
    );
    let queries = 0;
    const originalQuery = db.query.bind(db);
    db.query = async (...args) => {
      queries++;
      return originalQuery(...args);
    };
    const eur = await convertedSpending(repo, rows, 'EUR');
    assert.equal(queries, 2);
    const usd = await convertedSpending(repo, rows, 'USD');
    assert.deepEqual(
      eur.rows.map((row) => row.id),
      rows.map((row) => row.id),
    );
    assert.deepEqual(
      usd.rows.map((row) => row.id),
      eur.rows.map((row) => row.id),
    );
    assert.equal(eur.confirmedMinor, '57');
    assert.equal(eur.pendingMinor, '1');
    assert.equal(eur.missing, 1);
    assert.equal(
      eur.rows.filter((row) => row.status === 'missing')[0]!
        .convertedAmountMinor,
      null,
    );
    assert.equal(
      eur.rows.filter((row) => row.status === 'missing')[0]!.missingReason,
      'no_matching_quote',
    );
    assert.deepEqual(eur.coverage.confirmed, { converted: 3, missing: 1 });
    const actualId = rows.find((row) => row.sourceId === 'actual')!.id;
    assert.equal(
      eur.rows.find((row) => row.id === actualId)!.method,
      'actual_bank',
    );
    assert.equal(usd.missing, 0);
    assert.equal(
      usd.rows.every((row) => row.method === 'identity'),
      true,
    );
    assert.equal(
      eur.rows.find((row) => row.originalAmountMinor === '100')!.counted,
      'excluded',
    );
    assert.deepEqual(
      (
        await db.query(
          'SELECT id,revision,amount_minor,currency,kind FROM transactions ORDER BY id',
        )
      ).rows,
      before.rows,
    );
  } finally {
    await db.close();
  }
});

test('monthly converted spending uses Riga boundaries, exact owner sums and confirmed-only missing coverage', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await initializeFxRates(db);
    const repo = new Repository(db);
    const base = {
      source: 'enablebanking' as const,
      accountId: 'synthetic-rodion',
      owner: 'rodion' as const,
      bookedAt: '2026-08-31T21:00:00Z',
      currency: 'USD',
      amountMinor: '-1',
      description: 'Synthetic monthly boundary',
    };
    await repo.importBatch([
      {
        ...base,
        sourceId: 'last-riga-august',
        bookedAt: '2026-08-31T20:59:59Z',
      },
      { ...base, sourceId: 'first-riga-september' },
      {
        ...base,
        sourceId: 'second-riga-september',
        bookedAt: '2026-08-31T21:00:01Z',
      },
      {
        ...base,
        sourceId: 'missing-confirmed',
        bookedAt: '2026-09-02T00:00:00Z',
        amountMinor: '-200',
      },
      { ...base, sourceId: 'internal', amountMinor: '-1000' },
      { ...base, sourceId: 'investment', amountMinor: '-2000' },
      { ...base, sourceId: 'business', amountMinor: '-3000' },
      { ...base, sourceId: 'unresolved', amountMinor: '-4000' },
      { ...base, sourceId: 'pending', status: 'pending', amountMinor: '-5000' },
      { ...base, sourceId: 'income', amountMinor: '6000' },
      {
        ...base,
        sourceId: 'missing-internal',
        bookedAt: '2026-09-02T00:00:00Z',
      },
      {
        ...base,
        sourceId: 'missing-unresolved',
        bookedAt: '2026-09-02T00:00:00Z',
      },
      {
        ...base,
        sourceId: 'missing-pending',
        bookedAt: '2026-09-02T00:00:00Z',
        status: 'pending',
      },
      {
        ...base,
        sourceId: 'katya-large',
        owner: 'katya',
        accountId: 'synthetic-katya',
        amountMinor: '-90071992547409931',
      },
      {
        ...base,
        sourceId: 'katya-actual',
        owner: 'katya',
        accountId: 'synthetic-katya',
        source: 'monobank',
        amountMinor: '-100',
        sourceDetails: {
          amount: -100,
          operationAmount: -55,
          currencyCode: 978,
        },
      },
      {
        ...base,
        sourceId: 'katya-missing',
        owner: 'katya',
        accountId: 'synthetic-katya',
        bookedAt: '2026-09-03T00:00:00Z',
      },
    ]);
    const exclusions = new Map([
      ['internal', 'internal_transfer'],
      ['missing-internal', 'internal_transfer'],
      ['investment', 'investment'],
      ['business', 'non_personal'],
    ]);
    const unchanged = new Set(['unresolved', 'missing-unresolved', 'income']);
    for (const row of await repo.list()) {
      if (unchanged.has(row.sourceId)) continue;
      const kind = exclusions.get(row.sourceId) ?? 'personal_expense';
      await repo.classify(
        row.id,
        row.revision,
        {
          kind,
          category: kind === 'personal_expense' ? 'Food / Groceries' : null,
          reason: 'Synthetic monthly regression',
        },
        row.owner,
      );
    }
    for (const [currency, rate] of [
      ['USD', '2'],
      ['EUR', '3'],
    ] as const) {
      await new FxRates(db).insert({
        source: 'synthetic-market',
        base: currency,
        target: 'UAH',
        rate,
        asOf: '2026-08-31',
        retrievedAt: '2026-09-01T00:00:00Z',
        version: 1,
        provenance: 'Synthetic boundary-day quote',
      });
    }
    const result = await convertedSpending(repo, await repo.list(), 'EUR');
    assert.deepEqual(result.monthly, [
      {
        month: '2026-09',
        owner: 'katya',
        confirmedMinor: '60047995031606676',
        covered: 2,
        missing: 1,
      },
      {
        // A hold is money the bank has already taken, so it is inside the
        // month like any other payment and its conversion counts towards
        // coverage the same way.
        month: '2026-09',
        owner: 'rodion',
        confirmedMinor: '3335',
        covered: 3,
        missing: 2,
      },
      {
        month: '2026-08',
        owner: 'rodion',
        confirmedMinor: '1',
        covered: 1,
        missing: 0,
      },
    ]);
    // Each one-cent USD expense rounds individually to one EUR cent; the month
    // must sum the displayed rows rather than convert their combined original amount.
    // The total includes the held payment, which the bank has already taken.
    assert.equal(result.confirmedMinor, '60047995031610012');
    assert.equal(
      result.monthly
        .reduce((total, month) => total + BigInt(month.confirmedMinor), 0n)
        .toString(),
      result.confirmedMinor,
    );
    // The held payment is confirmed spending now, so it is inside this coverage
    // rather than counted beside it.
    assert.deepEqual(result.coverage.confirmed, { converted: 6, missing: 3 });
    assert.equal(result.missing, 5);
    for (const owner of ['rodion', 'katya'] as const) {
      const rowSum = result.rows
        .filter((row) => row.owner === owner && row.counted === 'confirmed')
        .reduce((total, row) => total - BigInt(row.convertedAmountMinor!), 0n);
      const monthSum = result.monthly
        .filter((month) => month.owner === owner)
        .reduce((total, month) => total + BigInt(month.confirmedMinor), 0n);
      assert.equal(monthSum, rowSum);
    }
  } finally {
    await db.close();
  }
});
