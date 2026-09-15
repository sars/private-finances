import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFilters, filterTransactions } from '../src/filters.js';
import type { Transaction } from '../src/repository.js';
import { expenseSummary } from '../src/domain.js';
const base: Transaction = {
  id: 'one',
  source: 'synthetic',
  sourceId: 'one',
  accountId: 'test',
  owner: 'rodion',
  bookedAt: '2024-02-29T21:59:59.999Z',
  currency: 'EUR',
  amountMinor: '-123',
  description: 'Synthetic',
  kind: 'personal_expense',
  category: 'Food / Groceries',
  categoryId: 'food',
  provisional: false,
  classificationSource: 'human' as const,
  revision: 0,
  status: 'booked',
};
test('filters include the full Riga end day and summary matches visible records', () => {
  const rows = [
    base,
    { ...base, id: 'two', bookedAt: '2024-02-29T22:00:00.000Z' },
    { ...base, id: 'three', currency: 'UAH' },
    { ...base, id: 'four', category: 'Transport' },
  ];
  const filtered = filterTransactions(
    rows,
    parseFilters(
      new URLSearchParams(
        'from=2024-02-29&to=2024-02-29&currency=EUR&category=Food',
      ),
    ),
  );
  assert.deepEqual(filtered, [base]);
  assert.equal(
    expenseSummary(filtered).byCurrency[0]!.personalExpenseMinor,
    '123',
  );
  assert.equal(
    filterTransactions(rows, parseFilters(new URLSearchParams())).length,
    4,
  );
});
test('filters reject impossible dates, reversed windows and malformed fields', () => {
  for (const query of [
    'from=2025-02-29',
    'to=2024-04-31',
    'from=invalid',
    'from=2024-03-02&to=2024-03-01',
    'currency=eur',
    'category=' + 'a'.repeat(251),
  ])
    assert.throws(() => parseFilters(new URLSearchParams(query)));
});

test('parent category includes its subtree but not a similar name', () => {
  const rows = [
    { category: 'Food / Groceries', bookedAt: '2026-09-01T00:00:00Z' },
    { category: 'Foodstuff', bookedAt: '2026-09-01T00:00:00Z' },
  ] as Parameters<typeof filterTransactions>[0];
  assert.equal(
    filterTransactions(rows, { category: 'Food / Groceries' }).length,
    1,
  );
});

test('spending pattern and exclusion filters preserve categories and exact totals', () => {
  const annotation = {
    transactionId: 'one',
    owner: 'rodion' as const,
    pattern: 'exceptional' as const,
    revision: 1,
    sourceRevision: 0,
    currentTransactionRevision: 0,
    explicit: true,
    needsReview: false,
    reason: 'Car repair',
    updatedAt: null,
  };
  const rows: Transaction[] = [
    { ...base, category: 'Transport', spendingPattern: annotation },
    { ...base, id: 'two' },
    { ...base, id: 'three', kind: 'investment', category: null },
  ];
  const exceptional = filterTransactions(
    rows,
    parseFilters(new URLSearchParams('pattern=exceptional&scope=spending')),
  );
  assert.equal(exceptional.length, 1);
  assert.equal(exceptional[0]!.category, 'Transport');
  assert.equal(
    expenseSummary(exceptional).byCurrency[0]!.personalExpenseMinor,
    '123',
  );
  const excluded = filterTransactions(
    rows,
    parseFilters(new URLSearchParams('scope=excluded')),
  );
  assert.equal(excluded.length, 1);
  assert.equal(
    expenseSummary(excluded).byCurrency[0]!.personalExpenseMinor,
    '0',
  );
  assert.equal(filterTransactions(rows, { pattern: 'unreviewed' }).length, 2);
  for (const invalid of ['pattern=weekly', 'scope=everything'])
    assert.throws(() => parseFilters(new URLSearchParams(invalid)));
});

test('Riga summer date includes the prior UTC evening and excludes the next local day', () => {
  const start = { ...base, bookedAt: '2026-08-31T21:00:00Z' };
  const end = { ...base, bookedAt: '2026-09-01T20:59:59Z' };
  const next = { ...base, bookedAt: '2026-09-01T21:00:00Z' };
  assert.deepEqual(
    filterTransactions([start, end, next], {
      from: '2026-09-01',
      to: '2026-09-01',
    }),
    [start, end],
  );
});
