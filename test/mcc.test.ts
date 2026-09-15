import test from 'node:test';
import assert from 'node:assert/strict';
import { readMcc, displayMcc } from '../src/mcc.js';
import { projectTransactionDetails } from '../src/transaction-details.js';

test('transfer MCC has readable context but cannot determine expense or ownership', () => {
  for (const details of [{ mcc: 4829 }, { merchant_category_code: '4829' }]) {
    const mcc = readMcc(details)!;
    assert.equal(mcc.code, 4829);
    assert.equal(mcc.financialTransfer, true);
    assert.equal(displayMcc(details), '4829 · Money transfer');
    assert.match(mcc.inferenceNote, /does not establish own-account transfer/);
    assert.match(mcc.inferenceNote, /personal expense/);
  }
});

test('unknown or malformed MCC is never given invented meaning', () => {
  assert.equal(readMcc({ mcc: 9998 })?.meaning, 'Unknown merchant category');
  assert.equal(displayMcc({ mcc: 9998 }), '9998 · Unknown merchant category');
  for (const value of [0, -1, 10000, 48.29, '4829 instructions', {}, null])
    assert.equal(readMcc({ mcc: value }), null);
  assert.equal(readMcc(undefined), null);
});

test('money-in bank details show money-transfer meaning for both providers', () => {
  for (const source of ['monobank', 'enablebanking']) {
    const details = projectTransactionDetails({
      id: 'synthetic-transfer',
      source,
      amount_minor: '4400000',
      currency: 'UAH',
      status: 'booked',
      description: 'Synthetic transfer',
      source_details:
        source === 'monobank'
          ? { mcc: 4829 }
          : { merchant_category_code: '4829' },
    });
    assert.equal(
      details.fields.find((f) => f.label === 'Direction')?.value,
      'Money in',
    );
    assert.equal(
      details.fields.find((f) => f.label === 'Merchant category code (MCC)')
        ?.value,
      '4829 · Money transfer',
    );
  }
});

test('consumer MCC names appear in bank details for both provider formats', () => {
  const expected = new Map([
    [5311, 'Department stores'],
    [7311, 'Advertising services'],
    [4900, 'Utilities — electricity, gas, water and sanitation'],
    [5399, 'Other general merchandise'],
    [5262, 'Marketplaces'],
    [7999, 'Other recreation services'],
    [7299, 'Other personal services'],
    [4812, 'Phones and telecommunications equipment'],
    [4816, 'Computer networks and information services'],
    [9222, 'Fines'],
    [7542, 'Car washes'],
  ]);
  for (const [code, meaning] of expected) {
    for (const source of ['monobank', 'enablebanking']) {
      const source_details =
        source === 'monobank'
          ? { mcc: code }
          : { merchant_category_code: String(code) };
      const details = projectTransactionDetails({
        id: 'synthetic-mcc',
        source,
        amount_minor: '-100',
        currency: 'EUR',
        status: 'booked',
        description: 'Synthetic merchant',
        source_details,
      });
      assert.equal(
        details.fields.find((f) => f.label === 'Merchant category code (MCC)')
          ?.value,
        `${code} · ${meaning}`,
      );
      assert.equal(readMcc(source_details)?.financialTransfer, false);
    }
  }
  assert.equal(displayMcc({ mcc: '0742' }), '0742 · Veterinary care');
  assert.equal(readMcc({ mcc: 6012 })?.financialTransfer, false);
});
