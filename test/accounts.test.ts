import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Accounts, initializeAccounts } from '../src/accounts.js';
import { Repository } from '../src/repository.js';

const iban = 'LV80BANK0000435195001';
const account = {
  source: 'synthetic',
  accountId: 'savings',
  owner: 'rodion',
  label: 'Savings',
  purpose: 'personal',
  identifier: { scheme: 'iban', value: iban },
};
const transaction = {
  source: 'synthetic',
  sourceId: 'out',
  accountId: 'current',
  owner: 'rodion',
  bookedAt: '2026-09-01T00:00:00Z',
  currency: 'EUR',
  amountMinor: '-10000',
  description: 'Transfer',
  sourceDetails: {
    counterpartyAccountIdentifier: { scheme: 'iban', value: iban },
  },
};

test('registry is owner-scoped, validates ownership, preserves digest and hides identifiers', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await initializeAccounts(db);
    await initializeAccounts(db);
    const accounts = new Accounts(db);
    await accounts.upsert(account, 'rodion');
    assert.equal((await accounts.list('rodion')).length, 1);
    assert.deepEqual(await accounts.list('katya'), []);
    await assert.rejects(accounts.upsert(account, 'katya'), /not_found/);
    await assert.rejects(
      accounts.upsert({ ...account, owner: 'katya' }, 'katya'),
      /not_found/,
    );
    await assert.rejects(
      accounts.upsert({ ...account, purpose: 'other' }, 'rodion'),
      /invalid_purpose/,
    );
    await assert.rejects(
      accounts.upsert(
        { ...account, identifier: { scheme: 'iban', value: 'garbage' } },
        'rodion',
      ),
      /invalid_identifier/,
    );
    await accounts.upsert(
      { ...account, identifier: undefined, label: 'Updated' },
      'rodion',
    );
    assert.equal(
      (await accounts.list('rodion'))[0]!.identifierRegistered,
      true,
    );
    const stored = await db.query('SELECT * FROM own_accounts');
    assert.match(String(stored.rows[0]!.identifier_hash), /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(stored).includes(iban), false);
    assert.equal(
      JSON.stringify(
        await db.query('SELECT * FROM account_audit_events'),
      ).includes(iban),
      false,
    );
    const repo = new Repository(db);
    await repo.importBatch([
      { ...transaction, owner: 'katya', accountId: 'katya-bank' },
    ]);
    await assert.rejects(
      accounts.upsert({ ...account, accountId: 'katya-bank' }, 'rodion'),
      /not_found/,
    );
  } finally {
    await db.close();
  }
});

test('explicit matches remain suggestions through paired, FX, ambiguous and human-decided transactions', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await initializeAccounts(db);
    const accounts = new Accounts(db);
    const repo = new Repository(db);
    await accounts.upsert(account, 'rodion');
    await accounts.upsert(
      {
        ...account,
        accountId: 'current',
        identifier: { scheme: 'iban', value: 'LV80BANK0000435195002' },
      },
      'rodion',
    );
    await repo.importBatch([
      transaction,
      {
        ...transaction,
        sourceId: 'incoming',
        accountId: 'savings',
        currency: 'USD',
        amountMinor: '11000',
        sourceDetails: {
          counterpartyAccountIdentifier: {
            scheme: 'iban',
            value: 'LV80BANK0000435195002',
          },
        },
      },
      { ...transaction, sourceId: 'name-only', sourceDetails: {} },
      { ...transaction, sourceId: 'pending', status: 'pending' },
      {
        ...transaction,
        sourceId: 'bad',
        sourceDetails: {
          counterpartyAccountIdentifier: { scheme: 'iban', value: 'bad' },
        },
      },
    ]);
    let suggestions = await accounts.suggestions('rodion');
    assert.equal(suggestions.length, 2);
    assert.ok(
      suggestions.every(
        (s) => s.proposedKind === 'internal_transfer' && s.requiresReview,
      ),
    );
    assert.ok(
      (await repo.list()).every(
        (t) => t.kind === 'unresolved' && t.revision === 0,
      ),
    );
    const outgoing = (await repo.list()).find((t) => t.sourceId === 'out')!;
    await repo.classify(
      outgoing.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Owner requests review' },
      'rodion',
    );
    assert.equal((await accounts.suggestions('rodion')).length, 1);
    await accounts.upsert({ ...account, accountId: 'duplicate' }, 'rodion');
    await repo.importBatch([{ ...transaction, sourceId: 'ambiguous' }]);
    suggestions = await accounts.suggestions('rodion');
    assert.equal(
      suggestions.find(
        (s) =>
          s.transactionId !==
          suggestions.find((s) => s.proposedKind === 'internal_transfer')
            ?.transactionId,
      )?.reason,
      'ambiguous_identifier',
    );
    await accounts.upsert(
      {
        ...account,
        accountId: 'katya-account',
        owner: 'katya',
        identifier: { scheme: 'iban', value: 'LV80BANK0000435195003' },
      },
      'katya',
    );
    await repo.importBatch([
      {
        ...transaction,
        sourceId: 'cross',
        sourceDetails: { counterIban: 'LV80BANK0000435195003' },
      },
    ]);
    assert.ok(
      (await accounts.suggestions('rodion')).some(
        (s) =>
          s.reason === 'cross_owner_account' &&
          s.proposedKind === 'internal_transfer',
      ),
    );
    assert.deepEqual(await accounts.suggestions('katya'), []);
  } finally {
    await db.close();
  }
});

test('provider IBAN evidence and purpose proposals never classify by names or amounts', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await initializeAccounts(db);
    const accounts = new Accounts(db);
    const repo = new Repository(db);
    await accounts.upsert({ ...account, purpose: 'investment' }, 'rodion');
    await repo.importBatch([
      {
        ...transaction,
        sourceId: 'debit',
        sourceDetails: { creditor_account: { iban } },
      },
      {
        ...transaction,
        sourceId: 'credit',
        amountMinor: '20',
        sourceDetails: { debtor_account: { iban } },
      },
      {
        ...transaction,
        sourceId: 'wrong-side',
        sourceDetails: { debtor_account: { iban } },
      },
      {
        ...transaction,
        sourceId: 'mono',
        sourceDetails: { counterIban: iban },
      },
    ]);
    assert.equal((await accounts.suggestions('rodion')).length, 3);
    assert.ok(
      (await accounts.suggestions('rodion')).every(
        (s) => s.proposedKind === 'investment',
      ),
    );
  } finally {
    await db.close();
  }
});

test('long provider labels do not block discovered accounts', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const accounts = new Accounts(db);
    await accounts.discover({
      source: 'monobank',
      accountId: 'long',
      owner: 'rodion',
      label: 'x'.repeat(200),
    });
    assert.equal((await accounts.list('rodion'))[0]?.label.length, 100);
  } finally {
    await db.close();
  }
});
