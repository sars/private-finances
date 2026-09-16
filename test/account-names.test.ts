import assert from 'node:assert/strict';
import test from 'node:test';
import {
  memoryDatabase,
  migrate,
  nameTheBankOnAccounts,
} from '../src/database.js';
import { accountLabel } from '../src/connectors/enablebanking.js';

/**
 * The owner could not find their own rent payment. It leaves Revolut, and the
 * app called that account "USD account" while their Wise dollar account was
 * called "USD" — five foreign accounts reading EUR, EUR account, GBP, USD and
 * USD account, with nothing naming the bank.
 */

test('an account is named after the bank the owner recognises', () => {
  assert.equal(accountLabel('revolut', 'USD', {}), 'Revolut USD');
  assert.equal(accountLabel('wise', 'EUR', {}), 'Wise EUR');
  assert.equal(
    accountLabel('revolut', 'USD', { product: 'USD account' }),
    'Revolut USD',
    'the provider only repeated the currency, so it adds nothing',
  );
  assert.equal(
    accountLabel('wise', 'USD', { product: 'USD' }),
    'Wise USD',
    'nor does the bare currency',
  );
});

test('anything the provider genuinely adds is kept, so two accounts stay apart', () => {
  assert.equal(
    accountLabel('revolut', 'EUR', { details: 'Savings' }),
    'Revolut EUR · Savings',
  );
  assert.equal(
    accountLabel('wise', 'GBP', { product: 'Jar' }),
    'Wise GBP · Jar',
  );
});

test('accounts already registered are renamed, and a name the owner chose is not', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES
       ('enablebanking','eb:rodion:rev-usd','rodion','USD account','personal'),
       ('enablebanking','eb:rodion:wise-usd','rodion','USD','personal'),
       ('enablebanking','eb:rodion:wise-gbp','rodion','My travel money','personal'),
       ('monobank','mono:rodion:iron','rodion','iron','personal')`,
    );
    await db.query(
      `INSERT INTO bank_sync_runs(connection,state) VALUES
       ('enablebanking:rodion:revolut','succeeded'),('enablebanking:rodion:wise','succeeded')`,
    );
    await db.query(
      `INSERT INTO bank_import_windows(id,connection,account_id,owner,currency,from_at,to_at,changed)
       VALUES (gen_random_uuid(),'enablebanking:rodion:revolut','eb:rodion:rev-usd','rodion','USD',now() - interval '1 day',now(),0),
              (gen_random_uuid(),'enablebanking:rodion:wise','eb:rodion:wise-usd','rodion','USD',now() - interval '1 day',now(),0),
              (gen_random_uuid(),'enablebanking:rodion:wise','eb:rodion:wise-gbp','rodion','GBP',now() - interval '1 day',now(),0)`,
    );

    await db.transaction((tx) => nameTheBankOnAccounts(tx));
    const labels = new Map(
      (
        await db.query(
          'SELECT account_id, label FROM own_accounts ORDER BY account_id',
        )
      ).rows.map((r) => [String(r.account_id), String(r.label)]),
    );
    assert.equal(labels.get('eb:rodion:rev-usd'), 'Revolut USD');
    assert.equal(labels.get('eb:rodion:wise-usd'), 'Wise USD');
    assert.equal(
      labels.get('eb:rodion:wise-gbp'),
      'My travel money',
      'the owner named this one themselves',
    );
    assert.equal(
      labels.get('mono:rodion:iron'),
      'iron',
      'Monobank is untouched',
    );

    // Running it again changes nothing.
    await db.transaction((tx) => nameTheBankOnAccounts(tx));
    const again = await db.query(
      "SELECT label FROM own_accounts WHERE account_id='eb:rodion:rev-usd'",
    );
    assert.equal(String(again.rows[0]?.label), 'Revolut USD');
  } finally {
    await db.close();
  }
});
