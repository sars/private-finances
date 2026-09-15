import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recipientBankFromIban,
  recipientCardNetwork,
} from '../src/recipient-bank.js';

// Synthetic account number and computed check digits; no actual bank account.
function iban(code: string): string {
  const account = code + '0000000000000000001';
  const checksum = 98n - (BigInt(account + '301000') % 97n);
  return 'UA' + checksum.toString().padStart(2, '0') + account;
}

test('valid counterparty IBAN identifies registry bank with provenance', () => {
  const result = recipientBankFromIban(iban('322001'));
  assert.equal(result?.bankName, 'АТ "УНІВЕРСАЛ БАНК"');
  assert.equal(result?.source, 'IBAN bank code');
  assert.equal(result?.registryRetrievedAt, '2026-09-12');
  assert.equal(
    recipientBankFromIban(iban('305299').toLowerCase())?.bankName,
    'АТ КБ "ПриватБанк"',
  );
  assert.deepEqual(
    recipientBankFromIban(iban('322001').replace(/(.{4})/g, '$1 ')),
    result,
  );
});

test('unknown valid bank code remains unknown; invalid or masked IBAN never infers bank', () => {
  assert.equal(recipientBankFromIban(iban('999999'))?.bankName, null);
  assert.equal(recipientBankFromIban(iban('999999'))?.bankCode, '999999');
  for (const value of [
    null,
    322001,
    '',
    'UA00' + iban('322001').slice(4),
    iban('322001').slice(0, -1),
    'UA12322001*******************',
    'DE89370400440532013000',
    'prefix ' + iban('322001'),
  ]) {
    assert.equal(recipientBankFromIban(value), null);
  }
});

test('network requires an explicitly masked PAN with sufficient visible prefix', () => {
  assert.equal(recipientCardNetwork('4149 **** **** 1234'), 'Visa');
  assert.equal(recipientCardNetwork('51xx xxxx xxxx 1234'), 'Mastercard');
  assert.equal(recipientCardNetwork('2221********1234'), 'Mastercard');
  assert.equal(recipientCardNetwork('2720********1234'), 'Mastercard');
  for (const value of [
    '2220********1234',
    '2721********1234',
    '22**********1234',
    '5***********1234',
    '**** **** **** 4149',
    '4149000000001234',
    '4149',
    'UA413220010000000000000000001',
    null,
  ]) {
    assert.equal(recipientCardNetwork(value), null);
  }
});
