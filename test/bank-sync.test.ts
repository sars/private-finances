import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository, Conflict } from '../src/repository.js';
import { syncBank } from '../src/bank-sync.js';
import {
  ConnectorError,
  type BankConnector,
  type BankAccount,
} from '../src/connectors/types.js';
import { synthetic } from '../src/synthetic.js';

test('bank windows commit atomically, replay without duplication and retain failure diagnostics', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await migrate(db);
    const repo = new Repository(db);
    const account: BankAccount = {
      source: 'monobank',
      owner: 'rodion',
      accountId: 'a',
      providerAccountId: 'a',
      currency: 'UAH',
      label: 'Test',
    };
    const connector: BankConnector = {
      source: 'monobank',
      owner: 'rodion',
      accounts: async () => [account],
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
    const from = new Date('2026-09-01'),
      to = new Date('2026-09-02');
    assert.deepEqual(await syncBank(repo, connector, from, to), {
      accounts: 1,
      changed: 1,
    });
    assert.deepEqual(await syncBank(repo, connector, from, to), {
      accounts: 1,
      changed: 0,
    });
    connector.transactions = async () => {
      throw new ConnectorError('rate_limit', 60000);
    };
    await assert.rejects(syncBank(repo, connector, from, to), ConnectorError);
    assert.equal(
      (await db.query('SELECT * FROM bank_import_windows')).rows.length,
      2,
    );
    assert.equal(
      (await db.query('SELECT error_code FROM bank_sync_runs')).rows[0]!
        .error_code,
      'rate_limit',
    );
    connector.transactions = async () => [
      {
        ...synthetic[0]!,
        source: 'monobank',
        accountId: 'a',
        owner: 'katya',
        status: 'booked',
        sourceDetails: {},
      },
    ];
    await assert.rejects(syncBank(repo, connector, from, to), ConnectorError);
    assert.equal((await repo.list()).length, 1);
    await db.query(
      "UPDATE bank_sync_runs SET lease_until=now()+interval '1 minute'",
    );
    await assert.rejects(syncBank(repo, connector, from, to), Conflict);
  } finally {
    await db.close();
  }
});

test('Wise failure and active lease do not overwrite or block Revolut state', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const wise: BankConnector = {
      source: 'enablebanking',
      owner: 'rodion',
      bank: 'wise',
      accounts: async () => {
        throw new ConnectorError('consent');
      },
      transactions: async () => [],
    };
    const revolut: BankConnector = {
      ...wise,
      bank: 'revolut',
      accounts: async () => [],
    };
    const from = new Date('2026-09-01'),
      to = new Date('2026-09-02');
    await assert.rejects(syncBank(repo, wise, from, to), ConnectorError);
    await db.query(
      "UPDATE bank_sync_runs SET lease_until=now()+interval '1 minute' WHERE connection='enablebanking:rodion:wise'",
    );
    await assert.rejects(syncBank(repo, wise, from, to), Conflict);
    await syncBank(repo, revolut, from, to);
    const rows = (
      await db.query(
        'SELECT connection,state,error_code FROM bank_sync_runs ORDER BY connection',
      )
    ).rows;
    assert.deepEqual(rows, [
      {
        connection: 'enablebanking:rodion:revolut',
        state: 'succeeded',
        error_code: null,
      },
      {
        connection: 'enablebanking:rodion:wise',
        state: 'failed',
        error_code: 'consent',
      },
    ]);
    await assert.rejects(
      syncBank(repo, { ...wise, bank: undefined }, from, to),
      ConnectorError,
    );
  } finally {
    await db.close();
  }
});
