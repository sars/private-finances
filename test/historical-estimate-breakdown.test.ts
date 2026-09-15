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
