import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANKS,
  BANK_NAMES,
  BANK_SLUGS,
  bankCountry,
  bankLabel,
  bankName,
  bankSlug,
  isBankName,
  isBankSlug,
} from '../src/connectors/banks.js';
import { accountLabel } from '../src/connectors/enablebanking.js';
import { parseInstance } from '../src/schedule.js';
import { memoryDatabase, migrate } from '../src/database.js';

test('every supported bank has a slug and a provider name that map to each other', () => {
  for (const bank of BANKS) {
    assert.equal(bankSlug(bank.name), bank.slug);
    assert.equal(bankName(bank.slug), bank.name);
    assert.ok(isBankSlug(bank.slug));
    assert.ok(isBankName(bank.name));
  }
  assert.equal(new Set(BANK_SLUGS).size, BANKS.length);
  assert.equal(new Set(BANK_NAMES).size, BANKS.length);
});

test('a slug is a single lowercase token, so it is safe in a filename and a unit name', () => {
  for (const slug of BANK_SLUGS) assert.match(slug, /^[a-z0-9]+$/);
});

test('anything outside the table is rejected rather than guessed at', () => {
  assert.equal(isBankSlug('swedbank as'), false);
  assert.equal(isBankSlug('Swedbank'), false);
  assert.equal(isBankName('swedbank'), false);
  assert.equal(isBankName(undefined), false);
  assert.throws(() => bankName('n26' as never), /unknown_bank/);
  assert.throws(() => bankSlug('N26' as never), /unknown_bank/);
});

test('an account at any supported bank is named after the bank the owner knows', () => {
  assert.equal(accountLabel('swedbank', 'EUR'), 'Swedbank EUR');
  assert.equal(
    accountLabel('swedbank', 'EUR', { product: 'Ikdienas' }),
    'Swedbank EUR · Ikdienas',
  );
  assert.equal(accountLabel('wise', 'USD'), 'Wise USD');
});

test('a bank the provider registers under a longer name is still named as the owner knows it', () => {
  // The provider calls it "LHV Pank" and that exact string is what the
  // consent must carry; the owner calls it "LHV", and so does every account.
  assert.equal(bankName('lhv'), 'LHV Pank');
  assert.equal(bankSlug('LHV Pank'), 'lhv');
  assert.equal(bankLabel('lhv'), 'LHV');
  assert.equal(accountLabel('lhv', 'EUR'), 'LHV EUR');
  assert.equal(
    accountLabel('lhv', 'EUR', { product: 'Current account' }),
    'LHV EUR',
  );
  assert.equal(accountLabel('lhv', 'XXX'), 'LHV multi-currency');
  for (const bank of BANKS) assert.ok(bank.label.length <= bank.name.length);
});

test('every bank names the country the provider lists it under, and LHV is Estonian', () => {
  for (const bank of BANKS) assert.match(bank.country, /^[A-Z]{2}$/);
  assert.equal(bankCountry('LHV Pank'), 'EE');
  assert.equal(bankCountry('Swedbank'), 'LV');
});

test('every supported bank can be scheduled', () => {
  for (const slug of BANK_SLUGS)
    assert.deepEqual(parseInstance(`enablebanking-rodion-${slug}`), [
      'enablebanking',
      'rodion',
      slug,
    ]);
  assert.throws(
    () => parseInstance('enablebanking-rodion-n26'),
    /invalid_schedule_instance/,
  );
  assert.throws(
    () => parseInstance('enablebanking-rodion'),
    /invalid_schedule_instance/,
  );
});

test('a migrated database accepts a consent for every supported bank', async () => {
  // Adding a bank to the table without widening the bank_consents constraint
  // would fail only when the owner tried to approve it. It fails here instead.
  const db = memoryDatabase();
  try {
    await migrate(db);
    for (const name of BANK_NAMES) {
      await db.query(
        `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
         VALUES('rodion',$1,'LV',$2,now()+interval '15 minutes',now()+interval '10 days','pending')`,
        [name, `hash-${name}`],
      );
    }
    const stored = await db.query<{ bank: string }>(
      'SELECT bank FROM bank_consents ORDER BY bank',
    );
    assert.deepEqual(
      stored.rows.map((r) => r.bank).sort(),
      [...BANK_NAMES].sort(),
    );
    await assert.rejects(
      db.query(
        `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
         VALUES('rodion','N26','LV','hash-n26',now()+interval '15 minutes',now()+interval '10 days','pending')`,
      ),
    );
  } finally {
    await db.close?.();
  }
});
