import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate, postgresDatabase } from '../src/database.js';
import { seedShowcase, showcaseTransactions } from '../src/showcase.js';
import { Repository } from '../src/repository.js';
import { web } from '../src/web.js';
import { seedTestOwners, signInAs } from './sign-in.js';
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

    // The savings, the rates and the import history are what the Assets,
    // Currency and Connections screens have to show; without them the article
    // photographs an empty state instead of a feature.
    assert.ok(result.holdings >= 16, 'savings');
    assert.ok(result.snapshots > 40, 'a reading per holding per month');
    assert.ok(result.rates > 80, 'a rate for every day the article shows');

    const groups = await db.query<{ group_name: string }>(
      'SELECT DISTINCT group_name FROM holdings',
    );
    const names = groups.rows.map((r) => r.group_name);
    // The owner went through these group by group. These may appear; the rest
    // of the real workspace's groups are simply not in the invented one, and a
    // generated household leaves no hole where they would have been.
    for (const kept of ['Binance', 'Interactive Brokers', 'Real estate'])
      assert.ok(names.includes(kept), `${kept} is shown`);
    for (const absent of ['Startups', 'Military bonds', 'PrivatBank'])
      assert.ok(!names.includes(absent), `${absent} must not exist`);

    // The pictures are drawn by a script that needs Playwright, which neither
    // CI nor the server has. A workspace without them must still seed: the
    // receipts are skipped and counted, never a failure.
    assert.equal(typeof result.receipts, 'number');
    const slips = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM receipt_jobs',
    );
    assert.equal(Number(slips.rows[0]!.n), result.receipts);

    const connections = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM bank_sync_runs WHERE state='succeeded'",
    );
    assert.ok(Number(connections.rows[0]!.n) >= 6, 'imports have been running');

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

test('the reseed page exists only in the demo workspace', async () => {
  const db = memoryDatabase();
  await migrate(db);
  await seedTestOwners(db);
  const server = web(new Repository(db), {
    port: 3399,
    mode: 'postgres',
    release: 'showcase-test',
  });
  await new Promise<void>((resolve) =>
    server.listen(3399, '127.0.0.1', resolve),
  );
  const base = 'http://127.0.0.1:3399';
  try {
    // Signed in as the owner, which is the dangerous case: outside the demo
    // the route must not merely refuse, it must not be there. What is behind
    // it empties a ledger, and the household's own workspace is the one place
    // that must never reach it.
    const cookie = await signInAs(base, 'rodion');
    const page = await fetch(base + '/showcase/reseed', {
      headers: { cookie },
    });
    assert.equal(page.status, 404);
    const post = await fetch(base + '/showcase/reseed', {
      method: 'POST',
      headers: {
        cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: 'whatever' }).toString(),
    });
    assert.ok(post.status === 403 || post.status === 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
