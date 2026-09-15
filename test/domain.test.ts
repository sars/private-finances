import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expenseSummary,
  validateClassification,
  validateTransaction,
  type Kind,
  type TransactionInput,
} from '../src/domain.js';

const transaction: TransactionInput = {
  source: 'synthetic',
  sourceId: 'tx-1',
  accountId: 'account-1',
  owner: 'rodion',
  bookedAt: '2024-02-29T12:30:00Z',
  currency: 'EUR',
  amountMinor: '-1250',
  description: 'Synthetic example',
};
const row = (amountMinor: string, kind: Kind, currency = 'EUR') => ({
  ...transaction,
  amountMinor,
  kind,
  currency,
  category: kind === 'personal_expense' ? 'Food / Groceries' : null,
});

test('summary keeps money exact beyond Number.MAX_SAFE_INTEGER and separates currencies', () => {
  assert.deepEqual(
    expenseSummary([
      row('-100', 'personal_expense', 'UAH'),
      row('-9007199254740993', 'personal_expense'),
      row('-7', 'personal_expense'),
      row('-4', 'unresolved'),
      row('-6', 'unresolved'),
    ]),
    {
      byCurrency: [
        {
          currency: 'EUR',
          personalExpenseMinor: '9007199254741000',
          unresolvedOutflowMinor: '10',
          unresolvedCount: 2,
          provisionalOutflowMinor: '0',
          provisionalCount: 0,
          pendingOutflowMinor: '0',
          pendingCount: 0,
        },
        {
          currency: 'UAH',
          personalExpenseMinor: '100',
          unresolvedOutflowMinor: '0',
          unresolvedCount: 0,
          provisionalOutflowMinor: '0',
          provisionalCount: 0,
          pendingOutflowMinor: '0',
          pendingCount: 0,
        },
      ],
    },
  );
});

test('summary excludes transfers, investments, non-personal and positive/zero flows', () => {
  assert.deepEqual(
    expenseSummary([
      row('-500', 'internal_transfer'),
      row('-500', 'investment'),
      row('-500', 'non_personal'),
      row('500', 'personal_expense'),
      row('500', 'unresolved'),
      row('0', 'unresolved'),
    ]),
    {
      byCurrency: [
        {
          currency: 'EUR',
          personalExpenseMinor: '0',
          unresolvedOutflowMinor: '0',
          unresolvedCount: 0,
          provisionalOutflowMinor: '0',
          provisionalCount: 0,
          pendingOutflowMinor: '0',
          pendingCount: 0,
        },
      ],
    },
  );
  assert.deepEqual(expenseSummary([]), { byCurrency: [] });
});

test('transaction validation preserves provenance, accepts exact signed amounts and timezone offsets', () => {
  assert.deepEqual(validateTransaction(transaction), {
    ...transaction,
    bookedAt: '2024-02-29T12:30:00.000Z',
  });
  for (const amountMinor of ['0', '+1', '-999999999999999999999999999999']) {
    assert.equal(
      validateTransaction({ ...transaction, amountMinor }).amountMinor,
      BigInt(amountMinor).toString(),
    );
  }
  assert.equal(
    validateTransaction({
      ...transaction,
      bookedAt: '2026-09-11T10:25:42.123+03:00',
    }).bookedAt,
    '2026-09-11T07:25:42.123Z',
  );
});

test('transaction validation rejects malformed amounts, identifiers, owners, currencies and dates', () => {
  for (const input of [
    null,
    [],
    'transaction',
    {},
    ...[1, '1.5', '1e3', ' 1', '--2', '1'.repeat(31)].map((amountMinor) => ({
      ...transaction,
      amountMinor,
    })),
    ...['eur', 'EU', 'EURO', '€UR'].map((currency) => ({
      ...transaction,
      currency,
    })),
    ...[
      '2025-02-29T12:00:00Z',
      '2024-04-31T12:00:00Z',
      '2024-00-01T12:00:00Z',
      '2024-01-00T12:00:00Z',
      '2024-01-01',
      '2024-01-01T24:00:00Z',
      '2024-01-01T12:60:00Z',
      '2024-01-01T12:00:60Z',
      '2024-01-01T12:00:00+24:00',
      '2024-01-01T12:00:00+03:60',
      '2024-01-01T12:00:00',
    ].map((bookedAt) => ({ ...transaction, bookedAt })),
    { ...transaction, owner: 'other' },
    { ...transaction, source: ' '.repeat(2) },
    { ...transaction, sourceId: 'x'.repeat(201) },
    { ...transaction, accountId: '' },
    { ...transaction, description: 'x'.repeat(2001) },
  ])
    assert.throws(() => validateTransaction(input), Error);
});

test('classification requires reason and personal category with bounded fields', () => {
  assert.deepEqual(
    validateClassification({
      kind: 'personal_expense',
      category: 'Food / Groceries',
      reason: 'Owner confirmed',
    }),
    {
      kind: 'personal_expense',
      category: 'Food / Groceries',
      reason: 'Owner confirmed',
    },
  );
  assert.deepEqual(
    validateClassification({
      kind: 'unresolved',
      category: null,
      reason: 'Needs review',
    }),
    { kind: 'unresolved', category: null, reason: 'Needs review' },
  );
  for (const input of [
    null,
    [],
    { kind: 'invalid', category: null, reason: 'Why' },
    { kind: 'personal_expense', category: null, reason: 'Why' },
    { kind: 'personal_expense', category: ' ', reason: 'Why' },
    { kind: 'personal_expense', category: 'x'.repeat(251), reason: 'Why' },
    { kind: 'unresolved', category: null, reason: '' },
    { kind: 'unresolved', category: null, reason: 'x'.repeat(501) },
    { kind: 'unresolved', reason: 'Why' },
  ])
    assert.throws(() => validateClassification(input), Error);
});
