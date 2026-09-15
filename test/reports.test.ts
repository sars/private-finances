import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase } from '../src/database.js';
import type { Transaction } from '../src/repository.js';
import {
  buildReport,
  initializeReports,
  previousReportPeriod,
  Reports,
} from '../src/reports.js';

const period = previousReportPeriod('month', new Date('2026-09-11T12:00:00Z'));
function row(id: string, updates: Partial<Transaction> = {}): Transaction {
  return {
    categoryId: null,
    provisional: false,
    classificationSource: 'none' as const,
    id,
    source: 'synthetic',
    sourceId: id,
    accountId: 'account',
    owner: 'rodion',
    bookedAt: '2026-08-15T12:00:00Z',
    currency: 'EUR',
    amountMinor: '-100',
    description: 'Synthetic',
    status: 'booked',
    kind: 'personal_expense',
    category: 'Food / Groceries',
    revision: 0,
    ...updates,
  };
}

test('PF-008 previous calendar months respect local year, leap day and UTC boundaries', () => {
  assert.deepEqual(
    previousReportPeriod('month', new Date('2025-12-31T22:30:00Z')),
    {
      kind: 'month',
      timeZone: 'Europe/Riga',
      from: '2025-11-30T22:00:00.000Z',
      to: '2025-12-31T22:00:00.000Z',
    },
  );
  assert.deepEqual(
    previousReportPeriod('month', new Date('2024-03-10T12:00:00Z'), 'UTC'),
    {
      kind: 'month',
      timeZone: 'UTC',
      from: '2024-02-01T00:00:00.000Z',
      to: '2024-03-01T00:00:00.000Z',
    },
  );
  assert.throws(() => previousReportPeriod('month', new Date('bad')));
  assert.throws(() => previousReportPeriod('month', new Date(), 'Not/AZone'));
});

test('PF-008 previous Monday-Sunday weeks follow DST, not seven 24-hour durations', () => {
  const spring = previousReportPeriod('week', new Date('2024-04-01T12:00:00Z'));
  assert.equal(spring.from, '2024-03-24T22:00:00.000Z');
  assert.equal(spring.to, '2024-03-31T21:00:00.000Z');
  assert.equal(
    (Date.parse(spring.to) - Date.parse(spring.from)) / 3600000,
    167,
  );
  const autumn = previousReportPeriod('week', new Date('2024-10-28T12:00:00Z'));
  assert.equal(autumn.from, '2024-10-20T21:00:00.000Z');
  assert.equal(autumn.to, '2024-10-27T22:00:00.000Z');
  assert.equal(
    (Date.parse(autumn.to) - Date.parse(autumn.from)) / 3600000,
    169,
  );
  // Sunday UTC is already Monday in Riga, so the just-finished week is selected.
  assert.deepEqual(
    previousReportPeriod('week', new Date('2024-03-31T21:30:00Z')),
    spring,
  );
  const newYear = previousReportPeriod(
    'week',
    new Date('2026-01-05T12:00:00Z'),
    'UTC',
  );
  assert.equal(newYear.from, '2025-12-29T00:00:00.000Z');
  assert.equal(newYear.to, '2026-01-05T00:00:00.000Z');
});

test('PF-008 exact per-owner/currency/category totals show unresolved, pending and unverified coverage', () => {
  const rows = [
    row('a', { amountMinor: '-9007199254740993', bookedAt: period.from }),
    row('b', { amountMinor: '-7', kind: 'unresolved', category: null }),
    row('c', { amountMinor: '-11', status: 'pending' }),
    row('d', {
      amountMinor: '-999',
      kind: 'internal_transfer',
      category: null,
    }),
    row('e', { amountMinor: '-22', owner: 'katya', currency: 'USD' }),
    row('f', { amountMinor: '-333', bookedAt: period.to }),
    row('g', { amountMinor: '90' }),
  ];
  const report = buildReport(rows, { owner: 'all', period });
  assert.deepEqual(report.byCurrency, [
    {
      currency: 'EUR',
      personalExpenseMinor: '9007199254741004',
      unresolvedOutflowMinor: '7',
      unresolvedCount: 1,
      provisionalOutflowMinor: '0',
      provisionalCount: 0,
      pendingOutflowMinor: '11',
      pendingCount: 1,
    },
    {
      currency: 'USD',
      personalExpenseMinor: '22',
      unresolvedOutflowMinor: '0',
      unresolvedCount: 0,
      provisionalOutflowMinor: '0',
      provisionalCount: 0,
      pendingOutflowMinor: '0',
      pendingCount: 0,
    },
  ]);
  assert.equal(report.transactionCount, 6);
  assert.equal(report.byCategory.length, 2);
  assert.equal(
    report.byCategory.find((t) => t.owner === 'rodion')!.personalExpenseMinor,
    '9007199254740993',
  );
  assert.deepEqual(report.incompleteness, {
    importCoverage: 'unverified',
    unresolvedCount: 1,
    pendingCount: 1,
    currencyConversion: 'not_applied',
  });
  const scoped = buildReport(rows, { owner: 'rodion', period });
  assert.equal(scoped.byOwner.length, 1);
  assert.equal(scoped.byCurrency.length, 1);
  assert.equal(scoped.byCategory.length, 1);
  assert.deepEqual(
    buildReport([...rows].reverse(), { owner: 'all', period }),
    report,
  );
  assert.throws(() =>
    buildReport(rows, {
      owner: 'rodion',
      period: { ...period, from: '2026-08-05T00:00:00.000Z' },
    }),
  );
  assert.throws(() =>
    buildReport([rows[0]!, rows[0]!], { owner: 'rodion', period }),
  );
});

test('PF-008 snapshots are idempotent, revisioned, immutable and isolated by owner', async () => {
  const db = memoryDatabase();
  try {
    await initializeReports(db);
    await initializeReports(db);
    const reports = new Reports(db);
    const rows = [row('a'), row('b', { owner: 'katya' })];
    const options = { owner: 'rodion' as const, period };
    const [first, repeated] = await Promise.all([
      reports.save(rows, options),
      reports.save([...rows].reverse(), options),
    ]);
    assert.deepEqual(first, repeated);
    assert.equal(first.version, 1);
    // Same totals but a changed source/human revision still requires a new version.
    const corrected = await reports.save(
      [row('a', { revision: 1 }), rows[1]!],
      options,
    );
    assert.equal(corrected.version, 2);
    assert.notEqual(first.fingerprint, corrected.fingerprint);
    assert.equal(
      (
        await reports.save(
          [
            row('a', { revision: 1 }),
            row('b', { revision: 5, amountMinor: '-9999', owner: 'katya' }),
          ],
          options,
        )
      ).id,
      corrected.id,
    );
    const katya = await reports.save(rows, { owner: 'katya', period });
    assert.equal(katya.version, 1);
    assert.deepEqual(
      (await reports.list('katya')).map((r) => r.id),
      [katya.id],
    );
    assert.deepEqual(
      (await reports.list('rodion')).map((r) => r.version),
      [2, 1],
    );
    assert.deepEqual((await reports.list('rodion'))[1], first);
    assert.deepEqual(await reports.list('all'), []);
  } finally {
    await db.close();
  }
});
