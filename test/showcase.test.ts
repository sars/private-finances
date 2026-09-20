import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate, postgresDatabase } from '../src/database.js';
import { seedShowcase, showcaseTransactions } from '../src/showcase.js';
import {
  accountDisplayName,
  ownerNames,
  setOwnerNames,
} from '../src/account-names.js';

test('the showcase refuses any database that is not a local demo one', async () => {
  // Constructing this opens no connection, so the refusal has to come before
  // the first statement — which is the point: a seeder that emptied the
  // household's ledger and then noticed would be no protection at all.
  const production = postgresDatabase(
    'postgresql://user:pw@127.0.0.1:5432/private_finances',
  );
  await assert.rejects(
    () => seedShowcase(production),
    /refusing to seed/,
    'a PostgreSQL database must be refused',
  );
});

test('the invented household is the same every time it is generated', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const first = showcaseTransactions(now, 4);
  const second = showcaseTransactions(now, 4);
  assert.deepEqual(
    first.map((p) => p.input),
    second.map((p) => p.input),
    'a reseed must not rewrite the article beneath its screenshots',
  );
});

test('a seeded workspace has the money the screens need to show', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    const now = new Date('2026-09-20T12:00:00Z');
    const result = await seedShowcase(db, { now, months: 3 });
    assert.ok(result.transactions > 100, 'a demo needs enough to look real');
    assert.equal(result.accounts, 9);

    const kinds = await db.query<{ kind: string; n: string }>(
      "SELECT kind, count(*) AS n FROM transactions WHERE source='showcase' GROUP BY kind",
    );
    const byKind = new Map(kinds.rows.map((r) => [r.kind, Number(r.n)]));
    // Each of these drives a different part of the interface, and a demo that
    // is missing one shows an empty state in the article instead of a feature.
    assert.ok(byKind.get('personal_expense')! > 50, 'spending');
    assert.ok(byKind.get('internal_transfer')! >= 2, 'money moved between us');
    assert.ok(byKind.get('investment')! >= 1, 'money put aside');
    assert.ok(byKind.get('non_personal')! >= 1, 'business money');
    assert.ok(byKind.get('unresolved')! >= 1, 'undecided money');

    // An internal transfer has two sides or it is not a transfer, and a
    // one-sided one would count as spending on every total in the article.
    const transfers = await db.query<{ amount_minor: string }>(
      "SELECT amount_minor FROM transactions WHERE source='showcase' AND kind='internal_transfer'",
    );
    const net = transfers.rows.reduce(
      (total, row) => total + BigInt(row.amount_minor),
      0n,
    );
    assert.equal(net, 0n, 'both sides of every transfer must be present');

    // Nothing may carry the household's own names into a screenshot.
    const descriptions = await db.query<{ description: string }>(
      "SELECT DISTINCT description FROM transactions WHERE source='showcase'",
    );
    for (const row of descriptions.rows)
      assert.doesNotMatch(row.description, /rodion|katya/i);

    const categorised = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM transactions WHERE source='showcase' AND category_id IS NOT NULL",
    );
    assert.ok(Number(categorised.rows[0]!.n) > 50, 'spending must be placed');
  } finally {
    await db.close();
  }
});

test('the demo renames the household without touching the ledger identity', () => {
  const before = ownerNames();
  try {
    setOwnerNames({ rodion: 'Alex', katya: 'Sam' });
    assert.equal(ownerNames().rodion, 'Alex');
    assert.equal(
      accountDisplayName({
        owner: 'rodion',
        source: 'monobank',
        label: 'Black',
        currency: 'UAH',
      }),
      'Alex · Monobank · Black UAH',
    );
  } finally {
    setOwnerNames(before);
  }
});
