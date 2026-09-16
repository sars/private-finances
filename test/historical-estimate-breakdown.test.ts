import test from 'node:test';
import assert from 'node:assert/strict';
// Vite owns dist/frontend and removes tsc output there. Test the pure source helper with Node 24 type stripping.
const { historicalEstimateBreakdown } = await import(
  new URL(
    '../../frontend/src/lib/historical-estimate-breakdown.ts',
    import.meta.url,
  ).href
);
test('tentative breakdowns aggregate exact converted minor units and Riga months, independently of confirmed spending', () => {
  const ledger = ['a', 'b', 'c', 'confirmed', 'missing', 'stale'].map((id) => ({
    id,
    revision: 2,
    bookedAt: id === 'b' ? '2026-06-30T21:30:00Z' : '2026-06-15T12:00:00Z',
    amountMinor: '-100',
    kind: id === 'confirmed' ? 'personal_expense' : 'unresolved',
    status: 'booked',
  }));
  const projections = ledger.map((row) => ({
    transactionId: row.id,
    transactionRevision: row.id === 'stale' ? 1 : 2,
    status: 'estimated',
    category: row.id === 'c' ? 'Pets' : 'Food / Groceries',
  }));
  const conversions = ledger.map((row) => ({
    id: row.id,
    counted: row.id === 'confirmed' ? 'confirmed' : 'unresolved',
    convertedAmountMinor:
      row.id === 'missing'
        ? null
        : row.id === 'a'
          ? '-90071992547409930001'
          : '-101',
  }));
  const result = historicalEstimateBreakdown(ledger, conversions, [
    ...projections,
    projections[0]!,
  ]);
  assert.deepEqual(result.months, [
    { label: '2026-06', minor: '90071992547409930102', count: 2 },
    { label: '2026-07', minor: '101', count: 1 },
  ]);
  assert.deepEqual(result.categories, [
    { label: 'Food / Groceries', minor: '90071992547409930102', count: 2 },
    { label: 'Pets', minor: '101', count: 1 },
  ]);
  assert.equal(result.missing, 1);
  assert.equal(ledger.find((row) => row.id === 'a')!.kind, 'unresolved');
});

test('a tentative total counts what a payment finally cost, like the figure above it', () => {
  const ledger = ['refunded', 'plain'].map((id) => ({
    id,
    revision: 1,
    bookedAt: '2026-06-15T12:00:00Z',
    amountMinor: '-5000',
    kind: 'unresolved',
    status: 'booked',
  }));
  const projections = ledger.map((row) => ({
    transactionId: row.id,
    transactionRevision: 1,
    status: 'estimated',
    category: 'Food / Groceries',
  }));
  const conversions = [
    // Charged 50.00, all of it came back: it still needs explaining and adds
    // nothing to a total.
    {
      id: 'refunded',
      counted: 'unresolved',
      convertedAmountMinor: '-5000',
      netAmountMinor: '0',
    },
    {
      id: 'plain',
      counted: 'unresolved',
      convertedAmountMinor: '-5000',
      netAmountMinor: '-5000',
    },
  ];
  const result = historicalEstimateBreakdown(ledger, conversions, projections);
  // Both payments still need explaining, so both are counted; only the one the
  // household actually paid for adds to the money, which is how the server
  // reports the same estimates.
  assert.deepEqual(result.categories, [
    { label: 'Food / Groceries', minor: '5000', count: 2 },
  ]);
  assert.deepEqual(result.months, [
    { label: '2026-06', minor: '5000', count: 2 },
  ]);
  assert.equal(result.missing, 0);
});

test('a conversion with no net figure still counts, so nothing disappears', () => {
  const ledger = [
    {
      id: 'legacy',
      revision: 1,
      bookedAt: '2026-06-15T12:00:00Z',
      amountMinor: '-5000',
      kind: 'unresolved',
      status: 'booked',
    },
  ];
  const result = historicalEstimateBreakdown(
    ledger,
    [{ id: 'legacy', counted: 'unresolved', convertedAmountMinor: '-5000' }],
    [
      {
        transactionId: 'legacy',
        transactionRevision: 1,
        status: 'estimated',
        category: 'Pets',
      },
    ],
  );
  assert.deepEqual(result.categories, [
    { label: 'Pets', minor: '5000', count: 1 },
  ]);
});
