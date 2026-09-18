import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository, Conflict } from '../src/repository.js';
import { syncBank } from '../src/bank-sync.js';
import { AccountBalances, convertedBalances } from '../src/account-balances.js';
import { UiLayouts, arrange } from '../src/ui-layout.js';
import { MonobankConnector } from '../src/connectors/monobank.js';
import { EnableBankingConnector } from '../src/connectors/enablebanking.js';
import { FxRates } from '../src/fx-rates.js';
import {
  ConnectorError,
  type BankAccount,
  type BankConnector,
} from '../src/connectors/types.js';
import { synthetic } from '../src/synthetic.js';
import { generateKeyPairSync } from 'node:crypto';

const account: BankAccount = {
  source: 'monobank',
  owner: 'rodion',
  accountId: 'a',
  providerAccountId: 'a',
  currency: 'UAH',
  label: 'Test',
};

test('monobank states the balance in the listing already fetched, with the overdraft it includes', async () => {
  const paths: string[] = [];
  const mono = new MonobankConnector('rodion', 'token', async (path) => {
    paths.push(path);
    return {
      accounts: [
        { id: 'a', currencyCode: 980, type: 'black', balance: 3435539 },
        {
          id: 'b',
          currencyCode: 840, // a credit card: the limit is inside the balance
          type: 'white',
          balance: 150000,
          creditLimit: 100000,
        },
        { id: 'c', currencyCode: 978, type: 'iron', balance: 'not a number' },
        { id: 'd', currencyCode: 985, type: 'white', creditLimit: 0 },
      ],
      jars: [{ id: 'j', currencyCode: 980, title: 'Savings', balance: 50000 }],
    };
  });
  const accounts = await mono.accounts();
  // One request, the same one the importer already makes: a balance from
  // Monobank costs nothing against the 60-second-per-token allowance.
  assert.deepEqual(paths, ['/personal/client-info']);
  assert.deepEqual(accounts[0]!.balance, {
    currency: 'UAH',
    amountMinor: '3435539',
  });
  assert.deepEqual(accounts[1]!.balance, {
    currency: 'USD',
    amountMinor: '150000',
    creditLimitMinor: '100000',
  });
  // A value this code cannot read is dropped; the account still lists.
  assert.equal(accounts[2]!.balance, undefined);
  // No balance at all, and a zero overdraft is not worth recording.
  assert.equal(accounts[3]!.balance, undefined);
  // A jar holds money like anything else.
  assert.deepEqual(accounts[4]!.balance, {
    currency: 'UAH',
    amountMinor: '50000',
  });
});

test('enable banking prefers what is spendable now and describes a multi-currency account one currency at a time', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const bank = new EnableBankingConnector(
    {
      owner: 'rodion',
      bank: 'swedbank',
      applicationId: 'app',
      privateKey: pem,
      sessionId: 'session',
    },
    async (path) => {
      if (path.endsWith('/balances'))
        return {
          balances: [
            {
              balance_amount: { currency: 'EUR', amount: '120.00' },
              balance_type: 'CLBD',
              reference_date: '2026-09-16',
            },
            {
              balance_amount: { currency: 'EUR', amount: '98.55' },
              balance_type: 'ITAV',
              last_change_date_time: '2026-09-17T08:30:00Z',
            },
            {
              balance_amount: { currency: 'SEK', amount: '4000.50' },
              balance_type: 'CLBD',
              reference_date: '2026-09-16',
            },
            {
              // Forward availability is not what the account holds today.
              balance_amount: { currency: 'EUR', amount: '999.00' },
              balance_type: 'FWAV',
              reference_date: '2026-09-20',
            },
          ],
        };
      throw new ConnectorError('schema');
    },
  );
  const balances = await bank.balances({
    ...account,
    source: 'enablebanking',
    accountId: 'x',
    providerAccountId: 'uid',
    currency: 'XXX',
  });
  const byCurrency = new Map(balances.map((b) => [b.currency, b]));
  assert.equal(balances.length, 2);
  // Available beats booked for the same currency.
  assert.equal(byCurrency.get('EUR')!.amountMinor, '9855');
  assert.equal(byCurrency.get('EUR')!.asOf, '2026-09-17T08:30:00.000Z');
  // A bare calendar day is read at UTC midnight, as dated payments already are.
  assert.equal(byCurrency.get('SEK')!.amountMinor, '400050');
  assert.equal(byCurrency.get('SEK')!.asOf, '2026-09-16T00:00:00.000Z');
});

test('balances are stored per currency, refreshed in place, and a bad figure costs only itself', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const service = new AccountBalances(db);
    await db.query(
      "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('monobank','a','rodion','Black','personal')",
    );
    assert.equal(
      await service.record(
        account,
        [
          { currency: 'UAH', amountMinor: '1000' },
          { currency: 'USD', amountMinor: '2500' },
          { currency: 'EUR', amountMinor: '12.5' },
          { currency: 'xx', amountMinor: '100' },
        ],
        new Date('2026-09-17T10:00:00Z'),
      ),
      2,
    );
    await service.record(
      account,
      [{ currency: 'UAH', amountMinor: '-4000' }],
      new Date('2026-09-17T12:00:00Z'),
    );
    const { accounts } = await service.household();
    const held = accounts[0]!.balances;
    assert.equal(accounts.length, 1);
    assert.equal(held.length, 2);
    const uah = held.find((b) => b.currency === 'UAH')!;
    // Refreshed in place, and an overdrawn account is simply negative.
    assert.equal(uah.amountMinor, '-4000');
    assert.equal(uah.observedAt, '2026-09-17T12:00:00.000Z');
    // The currency this run did not mention keeps its older figure to go stale
    // rather than disappearing as though the money had gone.
    const usd = held.find((b) => b.currency === 'USD')!;
    assert.equal(usd.amountMinor, '2500');
    assert.equal(usd.observedAt, '2026-09-17T10:00:00.000Z');
  } finally {
    await db.close();
  }
});

test('an account whose bank reports nothing is still listed, for both members', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES
       ('monobank','a','rodion','Black','personal'),
       ('monobank','k','katya','White','personal')`,
    );
    await new AccountBalances(db).record(
      { source: 'monobank', accountId: 'a' },
      [{ currency: 'UAH', amountMinor: '1000' }],
    );
    const { accounts } = await new AccountBalances(db).household();
    assert.deepEqual(
      accounts.map((a) => [a.owner, a.balances.length]),
      [
        ['katya', 0],
        ['rodion', 1],
      ],
    );
  } finally {
    await db.close();
  }
});

test('a total converts at the newest rate on or before the day observed, and says what it could not convert', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const rates = new FxRates(db);
    await rates.insert({
      source: 'test',
      base: 'USD',
      target: 'UAH',
      rate: '41.5',
      asOf: '2026-09-15',
      retrievedAt: '2026-09-15T12:00:00.000Z',
      version: 1,
      provenance: 'synthetic test rate',
    });
    const observedAt = '2026-09-17T09:00:00.000Z';
    const result = await convertedBalances(
      db,
      [
        {
          source: 'monobank',
          accountId: 'a',
          currency: 'UAH',
          amountMinor: '1000',
          creditLimitMinor: null,
          asOf: null,
          observedAt,
        },
        {
          source: 'monobank',
          accountId: 'b',
          currency: 'USD',
          amountMinor: '10000',
          creditLimitMinor: null,
          asOf: null,
          observedAt,
        },
        {
          source: 'monobank',
          accountId: 'c',
          currency: 'GBP',
          amountMinor: '5000',
          creditLimitMinor: null,
          asOf: null,
          observedAt,
        },
      ],
      'UAH',
    );
    // 1000 UAH as itself, plus 100.00 USD at 41.5; the pound has no rate at all.
    assert.equal(result.totalMinor, '416000');
    assert.deepEqual(result.coverage, { converted: 2, missing: 1 });
    // Two days back, because the feed had not run since; an identity
    // conversion names no rate, because it used none.
    assert.equal(result.rows[1]!.rateDate, '2026-09-15');
    assert.equal(result.rows[0]!.rateDate, null);
    assert.equal(result.rows[2]!.convertedMinor, null);
  } finally {
    await db.close();
  }
});

test('the converted figures are own money: an agreed overdraft is the bank’s, and never reaches the total', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await new FxRates(db).insert({
      source: 'test',
      base: 'USD',
      target: 'UAH',
      rate: '41.5',
      asOf: '2026-09-15',
      retrievedAt: '2026-09-15T12:00:00.000Z',
      version: 1,
      provenance: 'synthetic test rate',
    });
    const observedAt = '2026-09-15T09:00:00.000Z';
    const stored = (
      accountId: string,
      currency: string,
      amountMinor: string,
      creditLimitMinor: string | null,
    ) => ({
      source: 'monobank',
      accountId,
      currency,
      amountMinor,
      creditLimitMinor,
      asOf: null,
      observedAt,
    });
    const result = await convertedBalances(
      db,
      [
        // Stated in the display currency itself: the limit still comes out.
        stored('a', 'UAH', '5300000', '2000000'),
        // And through a daily rate: 60.00 own of 100.00 stated, at 41.5.
        stored('b', 'USD', '10000', '4000'),
        // Spent past their own money, which is what a negative figure says.
        stored('c', 'UAH', '1000', '5000'),
      ],
      'UAH',
    );
    assert.equal(result.rows[0]!.convertedMinor, '3300000');
    assert.equal(result.rows[0]!.rateDate, null);
    assert.equal(result.rows[1]!.convertedMinor, '249000');
    assert.equal(result.rows[1]!.rateDate, '2026-09-15');
    assert.equal(result.rows[2]!.convertedMinor, '-4000');
    assert.equal(result.totalMinor, '3545000');
    assert.deepEqual(result.coverage, { converted: 3, missing: 0 });
  } finally {
    await db.close();
  }
});

test('a bank that will not state a balance still delivers its payments', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const connector: BankConnector = {
      source: 'monobank',
      owner: 'rodion',
      accounts: async () => [account],
      balances: async () => {
        throw new ConnectorError('rate_limit', 60000);
      },
      transactions: async () => [
        {
          ...synthetic[0]!,
          source: 'monobank',
          accountId: 'a',
          status: 'booked',
          sourceDetails: {},
        },
      ],
    };
    assert.deepEqual(
      await syncBank(
        repo,
        connector,
        new Date('2026-09-01'),
        new Date('2026-09-02'),
      ),
      { accounts: 1, changed: 1 },
    );
    assert.equal(
      (await db.query('SELECT * FROM account_balances')).rows.length,
      0,
    );
    // A stated balance is recorded on the way past, without a second request.
    connector.accounts = async () => [
      { ...account, balance: { currency: 'UAH', amountMinor: '777' } },
    ];
    await syncBank(
      repo,
      connector,
      new Date('2026-09-01'),
      new Date('2026-09-02'),
    );
    assert.equal(
      (await db.query('SELECT amount_minor FROM account_balances')).rows[0]!
        .amount_minor,
      '777',
    );
  } finally {
    await db.close();
  }
});

test('each member arranges only their own screen, and a stale arrangement is refused', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const layouts = new UiLayouts(db);
    assert.deepEqual(await layouts.get('rodion', 'balances'), {
      ordering: [],
      revision: 0,
    });
    const saved = await layouts.save(
      'rodion',
      'balances',
      ['monobank:b', 'monobank:a'],
      0,
    );
    assert.deepEqual(saved, {
      ordering: ['monobank:b', 'monobank:a'],
      revision: 1,
    });
    // Katya's screen is untouched by Rodion's arrangement.
    assert.deepEqual((await layouts.get('katya', 'balances')).ordering, []);
    // A second tab holding the old revision does not silently win.
    await assert.rejects(
      layouts.save('rodion', 'balances', ['monobank:a'], 0),
      Conflict,
    );
    await assert.rejects(
      layouts.save('rodion', 'balances', ['a', 'a'], 1),
      /invalid_layout/,
    );
    await assert.rejects(
      layouts.save('rodion', 'balances', 'not a list', 1),
      /invalid_layout/,
    );
  } finally {
    await db.close();
  }
});

test('an account nobody has placed keeps its natural position, behind the ones they have', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(
    arrange(items, ['c', 'a'], (item) => item.id).map((item) => item.id),
    ['c', 'a', 'b', 'd'],
  );
  // A key for an account that has closed simply never matches again.
  assert.deepEqual(
    arrange(items, ['gone', 'b'], (item) => item.id).map((item) => item.id),
    ['b', 'a', 'c', 'd'],
  );
});
