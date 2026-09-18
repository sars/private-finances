import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { syncBank } from '../src/bank-sync.js';
import { ConnectorError, type BankConnector } from '../src/connectors/types.js';
import { synthetic } from '../src/synthetic.js';
import { describeConnection, importStatus } from '../src/import-status.js';

test('a connection key is named as the owner knows the bank, never as the provider', () => {
  assert.deepEqual(describeConnection('monobank:katya'), {
    provider: 'monobank',
    owner: 'katya',
    bank: 'monobank',
    label: 'Monobank',
    unrecognised: false,
  });
  assert.deepEqual(describeConnection('enablebanking:rodion:lhv'), {
    provider: 'enablebanking',
    owner: 'rodion',
    bank: 'lhv',
    label: 'LHV',
    unrecognised: false,
  });
  // A key written by a newer release and read back after a rollback. The slug
  // is all this build knows, and it says so rather than guessing a bank.
  const rolledBack = describeConnection('enablebanking:rodion:monzo');
  assert.equal(rolledBack.unrecognised, true);
  assert.equal(rolledBack.bank, null);
  assert.equal(rolledBack.label, 'monzo');
  assert.doesNotMatch(rolledBack.label, /enable/i);
  // A per-owner key names no bank at all. Retired from the database, but the
  // reading must still hold: the owner is never shown the aggregator's name.
  const perOwner = describeConnection('enablebanking:rodion');
  assert.equal(perOwner.unrecognised, true);
  assert.equal(perOwner.bank, null);
  assert.equal(perOwner.label, 'Unknown bank');
  assert.doesNotMatch(perOwner.label, /enable/i);
});

test('the imports view is a reading of what the importer recorded', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const mono: BankConnector = {
      source: 'monobank',
      owner: 'rodion',
      accounts: async () => [
        {
          source: 'monobank',
          owner: 'rodion',
          accountId: 'mono:rodion:a',
          providerAccountId: 'a',
          currency: 'UAH',
          label: 'black',
        },
      ],
      transactions: async () => [
        {
          ...synthetic[0]!,
          source: 'monobank',
          accountId: 'mono:rodion:a',
          status: 'booked',
          sourceDetails: {},
        },
      ],
    };
    const wise: BankConnector = {
      source: 'enablebanking',
      owner: 'katya',
      bank: 'wise',
      accounts: async () => [
        {
          source: 'enablebanking',
          owner: 'katya',
          accountId: 'eb:katya:w',
          providerAccountId: 'w',
          currency: 'EUR',
          label: 'Wise EUR',
        },
      ],
      transactions: async () => {
        throw new ConnectorError('rate_limit', 60000);
      },
    };
    const from = new Date('2026-09-01'),
      to = new Date('2026-09-02');
    await syncBank(repo, mono, from, to);
    await assert.rejects(syncBank(repo, wise, from, to));
    await db.query(
      `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
       VALUES('katya','Wise','LV','h1',now(),'2026-09-22T14:04:49Z','authorized'),
             ('rodion','LHV Pank','EE','h2',now(),'2026-09-27T15:02:18Z','authorized')`,
    );

    const status = await importStatus(db, new Date());
    assert.deepEqual(
      status.connections.map((c) => [c.connection, c.state, c.label]),
      [
        ['enablebanking:katya:wise', 'failed', 'Wise'],
        ['enablebanking:rodion:lhv', 'never_run', 'LHV'],
        ['monobank:rodion', 'succeeded', 'Monobank'],
      ],
    );
    const [wiseRow, lhvRow, monoRow] = status.connections;
    assert.equal(monoRow!.runs24h, 1);
    assert.equal(monoRow!.changed7d, 1);
    assert.equal(monoRow!.accounts.length, 1);
    assert.equal(monoRow!.accounts[0]!.label, 'black');
    assert.equal(monoRow!.accounts[0]!.transactions, 1);
    assert.equal(monoRow!.accounts[0]!.currency, 'UAH');
    assert.ok(monoRow!.lastSuccessAt);
    assert.equal(monoRow!.consent, null);

    // The failed bank keeps its diagnosis and its approval, and the account it
    // discovered before failing is listed with nothing in it.
    assert.equal(wiseRow!.errorCode, 'rate_limit');
    assert.equal(wiseRow!.runs24h, 0);
    assert.equal(wiseRow!.consent?.expiresAt, '2026-09-22T14:04:49.000Z');
    assert.deepEqual(wiseRow!.accounts, []);

    // Approved and never imported is still a connection the owner waits on.
    assert.equal(lhvRow!.consent?.country, 'EE');
    assert.equal(lhvRow!.lastRunAt, null);

    assert.equal(status.runs.length, 1);
    assert.equal(status.runs[0]!.connection, 'monobank:rodion');
    assert.equal(status.runs[0]!.label, 'black');
    assert.equal(status.runs[0]!.changed, 1);

    // Thirty days on, the recent counts are empty but the record remains.
    const later = await importStatus(db, new Date(Date.now() + 31 * 86400000));
    const monoLater = later.connections.find(
      (c) => c.connection === 'monobank:rodion',
    )!;
    assert.equal(monoLater.runs7d, 0);
    assert.equal(monoLater.changed30d, 0);
    assert.equal(monoLater.accounts[0]!.transactions, 1);
  } finally {
    await db.close?.();
  }
});
