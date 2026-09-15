import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import { Accounts, identifierHashFor } from '../src/accounts.js';
import { Repository } from '../src/repository.js';
import { restPlacements } from '../src/resting-place.js';

/**
 * Registering an account's own identifier from what the bank already tells us
 * (ADR 0008, step D1).
 *
 * This is the piece that makes a transfer between the household's own accounts
 * recognisable. A payment carries its counterparty's IBAN; matching that against
 * a registered account is the only evidence that does not depend on reading a
 * person's name. Before this, no account carried an identifier, so the
 * recognition could never fire.
 */

const iban = 'LV80BANK0000435195001';

test('ADR 0008 an account discovered from a provider carries its identifier', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const accounts = new Accounts(db);
    await accounts.discover({
      source: 'monobank',
      accountId: 'mono:katya:savings',
      owner: 'katya',
      label: 'Savings',
      iban,
    });
    const [registered] = await accounts.list('katya');
    assert.equal(registered!.identifierRegistered, true);
    const stored = await db.query(
      'SELECT identifier_hash FROM own_accounts WHERE account_id=$1',
      ['mono:katya:savings'],
    );
    assert.equal(
      stored.rows[0]!.identifier_hash,
      identifierHashFor({ scheme: 'iban', value: iban }),
      'the same hash the matching side computes, so the two cannot drift',
    );
  } finally {
    await db.close();
  }
});

test('ADR 0008 discovery is idempotent and never overwrites a hand-typed identifier', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const accounts = new Accounts(db);
    const typed = 'LV80BANK0000435195002';
    await accounts.discover({
      source: 'monobank',
      accountId: 'mono:rodion:main',
      owner: 'rodion',
      label: 'Main',
    });
    // The owner registers it themselves before any provider states one.
    await accounts.upsert(
      {
        source: 'monobank',
        accountId: 'mono:rodion:main',
        owner: 'rodion',
        label: 'Main',
        purpose: 'personal',
        identifier: { scheme: 'iban', value: typed },
      },
      'rodion',
    );
    // A later sync sees a different value; the owner's stands.
    await accounts.discover({
      source: 'monobank',
      accountId: 'mono:rodion:main',
      owner: 'rodion',
      label: 'Main',
      iban,
    });
    const stored = await db.query(
      'SELECT identifier_hash, purpose, label FROM own_accounts WHERE account_id=$1',
      ['mono:rodion:main'],
    );
    assert.equal(
      stored.rows[0]!.identifier_hash,
      identifierHashFor({ scheme: 'iban', value: typed }),
    );
    // And discovery does not undo the purpose or label the owner set.
    assert.equal(stored.rows[0]!.purpose, 'personal');
    assert.equal(stored.rows[0]!.label, 'Main');
  } finally {
    await db.close();
  }
});

test('ADR 0008 a provider that publishes nothing usable leaves the account alone', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const accounts = new Accounts(db);
    for (const value of [undefined, 'not-an-iban', '   ']) {
      await accounts.discover({
        source: 'monobank',
        accountId: `mono:rodion:jar-${String(value)}`,
        owner: 'rodion',
        label: 'Jar',
        ...(value === undefined ? {} : { iban: value }),
      });
    }
    const stored = await db.query(
      "SELECT count(*)::int AS count FROM own_accounts WHERE identifier_hash IS NOT NULL AND account_id LIKE 'mono:rodion:jar-%'",
    );
    assert.equal(
      Number(stored.rows[0]!.count),
      0,
      'provider metadata that is not an IBAN is not evidence',
    );
  } finally {
    await db.close();
  }
});

test('ADR 0008 registering an identifier is what lets a transfer stop counting as spending', async () => {
  // The whole point, end to end: the same payment is spending before the
  // counterparty account is known and an internal transfer afterwards.
  const db = memoryDatabase();
  try {
    await migrate(db);
    const accounts = new Accounts(db);
    const repo = new Repository(db);
    await db.query(
      `INSERT INTO own_accounts(source,account_id,owner,label,purpose)
       VALUES('monobank','mono:rodion:main','rodion','Main','personal')`,
    );
    await repo.importBatch([
      {
        source: 'monobank',
        sourceId: 'to-katya',
        accountId: 'mono:rodion:main',
        owner: 'rodion',
        bookedAt: '2026-08-01T10:00:00Z',
        currency: 'EUR',
        amountMinor: '-25000',
        description: 'Transfer',
        sourceDetails: { counterIban: iban },
      },
    ]);
    // Katya's account exists but its identifier has never been registered.
    await accounts.discover({
      source: 'monobank',
      accountId: 'mono:katya:savings',
      owner: 'katya',
      label: 'Savings',
    });
    await db.query(
      "UPDATE own_accounts SET purpose='personal' WHERE account_id='mono:katya:savings'",
    );
    await db.transaction((tx) => restPlacements(tx));
    assert.equal(
      (await repo.list('rodion'))[0]!.kind,
      'personal_expense',
      'with no identifier registered it can only look like spending',
    );

    // Now a sync states the IBAN, and the same evidence settles it.
    await db.query(
      "UPDATE transactions SET kind='unresolved', provisional=false, classification_source='none' WHERE source_id='to-katya'",
    );
    await accounts.discover({
      source: 'monobank',
      accountId: 'mono:katya:savings',
      owner: 'katya',
      label: 'Savings',
      iban,
    });
    const report = await db.transaction((tx) => restPlacements(tx));
    assert.equal(report.identified, 1);
    const settled = (await repo.list('rodion'))[0]!;
    assert.equal(settled.kind, 'internal_transfer');
    assert.equal(settled.classificationSource, 'identity');
    assert.equal(settled.provisional, false);
  } finally {
    await db.close();
  }
});
