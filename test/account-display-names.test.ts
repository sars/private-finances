import test from 'node:test';
import assert from 'node:assert/strict';
import { accountDisplayName, accountNameParts } from '../src/account-names.js';

test('an account is named by member, bank, product and currency, without repeating what the label says', () => {
  assert.equal(
    accountDisplayName({
      owner: 'rodion',
      source: 'monobank',
      label: 'iron',
      currency: 'UAH',
    }),
    'Rodion · Monobank · Iron UAH',
  );
  assert.equal(
    accountDisplayName({
      owner: 'rodion',
      source: 'monobank',
      label: 'black',
      currency: 'USD',
    }),
    'Rodion · Monobank · Black USD',
  );
  assert.equal(
    accountDisplayName({
      owner: 'rodion',
      source: 'monobank',
      label: 'fop',
      currency: 'USD',
    }),
    'Rodion · Monobank · FOP USD',
  );
  assert.equal(
    accountDisplayName({
      owner: 'katya',
      source: 'monobank',
      label: 'madeInUkraine',
      currency: 'UAH',
    }),
    'Katya · Monobank · Made in Ukraine UAH',
  );
  // The owner's label already names the bank and the currency.
  assert.equal(
    accountDisplayName({
      owner: 'katya',
      source: 'enablebanking',
      label: 'Wise EUR',
      currency: 'EUR',
    }),
    'Katya · Wise · EUR',
  );
  assert.equal(
    accountDisplayName({
      owner: 'rodion',
      source: 'enablebanking',
      label: 'Revolut USD',
    }),
    'Rodion · Revolut · USD',
  );
  // A bank with one account and no stated currency yet.
  assert.equal(
    accountDisplayName({
      owner: 'rodion',
      source: 'enablebanking',
      label: 'LHV',
    }),
    'Rodion · LHV',
  );
  assert.equal(
    accountDisplayName({
      owner: 'rodion',
      source: 'enablebanking',
      label: 'Swedbank',
      currency: 'EUR',
    }),
    'Rodion · Swedbank · EUR',
  );
  assert.equal(
    accountDisplayName({
      owner: 'katya',
      source: 'manual_cash',
      label: 'Cash EUR',
      currency: 'EUR',
    }),
    'Katya · Cash · EUR',
  );
  // A label nobody recognises is kept as the owner wrote it.
  assert.deepEqual(
    accountNameParts({
      owner: 'rodion',
      source: 'enablebanking',
      label: 'Holiday pot',
      currency: 'GBP',
    }),
    { owner: 'Rodion', bank: null, product: 'Holiday pot GBP' },
  );
  assert.equal(
    accountDisplayName({ owner: 'rodion', source: 'other', label: '' }),
    'Rodion',
  );
});
