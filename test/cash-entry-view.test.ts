import test from 'node:test';
import assert from 'node:assert/strict';
const { rigaCalendarDate, validCashAmount } = await import(
  new URL('../../frontend/src/lib/cash-entry.ts', import.meta.url).href
);
test('cash entry defaults to the Riga calendar day across UTC and DST boundaries', () => {
  assert.equal(
    rigaCalendarDate(new Date('2026-09-12T22:30:00Z')),
    '2026-09-13',
  );
  assert.equal(
    rigaCalendarDate(new Date('2026-01-01T22:30:00Z')),
    '2026-01-02',
  );
});
test('cash amount rejects zero, negatives, exponents and excess precision', () => {
  for (const value of ['1', '0.01', '42.50', '003.2'])
    assert.equal(validCashAmount(value), true, value);
  for (const value of [
    '0',
    '0.00',
    '-2',
    '1e3',
    '1.001',
    'NaN',
    '',
    '100000000000',
  ])
    assert.equal(validCashAmount(value), false, value);
});
