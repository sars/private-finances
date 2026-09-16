import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  accountLabel,
  isMultiCurrency,
  EnableBankingConnector,
} from '../src/connectors/enablebanking.js';
import { ConnectorError, type Requester } from '../src/connectors/types.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const sessionId = '11111111-2222-3333-4444-555555555555';
const uid = 'account-uid';
const hash = 'identification-hash';

function provider(
  transactions: Record<string, unknown>[],
  currency: string,
  product: string | null = 'CURRENT',
): Requester {
  return async (path: string) => {
    if (path.startsWith(`/sessions/`))
      return {
        status: 'AUTHORIZED',
        access: { valid_until: new Date(Date.now() + 3600000).toISOString() },
        accounts_data: [{ uid, identification_hash: hash }],
      };
    if (path === `/accounts/${uid}/details`)
      return { currency, product, identification_hash: hash };
    if (path.startsWith(`/accounts/${uid}/transactions`))
      return { transactions };
    throw new Error(`unexpected path ${path}`);
  };
}

function payment(currency: string, amount: string, reference: string) {
  return {
    entry_reference: reference,
    status: 'BOOK',
    credit_debit_indicator: 'DBIT',
    transaction_amount: { currency, amount },
    booking_date: '2026-09-01',
    remittance_information: ['A SHOP'],
  };
}

function connector(requester: Requester) {
  return new EnableBankingConnector(
    {
      owner: 'rodion',
      bank: 'swedbank',
      applicationId: 'app',
      privateKey,
      sessionId,
    },
    requester,
  );
}

test('XXX is the provider saying the account holds no single currency', () => {
  assert.equal(isMultiCurrency('XXX'), true);
  assert.equal(isMultiCurrency('EUR'), false);
});

test('a multi-currency account is named for what it is, never "Swedbank XXX"', () => {
  assert.equal(
    accountLabel('swedbank', 'XXX', { product: 'CURRENT' }),
    'Swedbank current account',
  );
  assert.equal(accountLabel('swedbank', 'XXX'), 'Swedbank multi-currency');
  assert.equal(
    accountLabel('swedbank', 'XXX', { details: 'Savings' }),
    'Swedbank Savings',
  );
  // A single-currency account is untouched by any of this.
  assert.equal(accountLabel('wise', 'USD'), 'Wise USD');
  assert.equal(
    accountLabel('revolut', 'EUR', { product: 'Standard' }),
    'Revolut EUR · Standard',
  );
});

test('payments on a multi-currency account keep each their own currency', async () => {
  const bank = connector(
    provider(
      [payment('EUR', '65.00', 'a-1'), payment('SEK', '120.00', 'a-2')],
      'XXX',
    ),
  );
  const [account] = await bank.accounts();
  assert.equal(account!.currency, 'XXX');
  assert.equal(account!.label, 'Swedbank current account');
  const rows = await bank.transactions(
    account!,
    new Date('2026-08-17'),
    new Date('2026-09-16'),
  );
  assert.deepEqual(
    rows.map((r) => [r.currency, r.amountMinor]),
    [
      ['EUR', '-6500'],
      ['SEK', '-12000'],
    ],
  );
});

test('a single-currency account still refuses a payment in another currency', async () => {
  const bank = connector(provider([payment('SEK', '120.00', 'b-1')], 'EUR'));
  const [account] = await bank.accounts();
  await assert.rejects(
    bank.transactions(account!, new Date('2026-08-17'), new Date('2026-09-16')),
    (error: ConnectorError) => error.code === 'schema',
  );
});

test('a payment may not itself claim to have no currency', async () => {
  const bank = connector(provider([payment('XXX', '10.00', 'c-1')], 'XXX'));
  const [account] = await bank.accounts();
  await assert.rejects(
    bank.transactions(account!, new Date('2026-08-17'), new Date('2026-09-16')),
    (error: ConnectorError) => error.code === 'schema',
  );
});

test('the migration renames an account already registered as XXX, and nothing else', async () => {
  const { memoryDatabase, migrate, nameTheMultiCurrencyAccounts } =
    await import('../src/database.js');
  const db = memoryDatabase();
  try {
    await migrate(db);
    const rows: [string, string][] = [
      ['swedbank-current', 'Swedbank XXX · CURRENT'],
      ['swedbank-bare', 'Swedbank XXX'],
      ['swedbank-savings', 'Swedbank XXX · Savings'],
      ['wise-eur', 'Wise EUR'],
      ['owner-written', 'My travel money'],
    ];
    for (const [id, label] of rows)
      await db.query(
        `INSERT INTO own_accounts(source,account_id,owner,label,purpose)
         VALUES('enablebanking',$1,'rodion',$2,'personal')`,
        [id, label],
      );
    assert.equal(await nameTheMultiCurrencyAccounts(db), 3);
    const after = await db.query<{ account_id: string; label: string }>(
      'SELECT account_id, label FROM own_accounts ORDER BY account_id',
    );
    assert.deepEqual(
      after.rows.map((r) => [r.account_id, r.label]),
      [
        ['owner-written', 'My travel money'],
        ['swedbank-bare', 'Swedbank multi-currency'],
        ['swedbank-current', 'Swedbank current account'],
        ['swedbank-savings', 'Swedbank Savings'],
        ['wise-eur', 'Wise EUR'],
      ],
    );
    // A second run changes nothing: the names no longer match.
    assert.equal(await nameTheMultiCurrencyAccounts(db), 0);
  } finally {
    await db.close?.();
  }
});
