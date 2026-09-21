import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate, postgresDatabase } from '../src/database.js';
import {
  SHOWCASE_LIMITS,
  seedShowcase,
  showcaseSeededAt,
  showcaseTransactions,
} from '../src/showcase.js';
import { Repository } from '../src/repository.js';
import { web } from '../src/web.js';
import { readReseedRequest } from '../src/showcase-control.js';
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

    // Balances are stored bank evidence, never summed from payments: an
    // unseeded workspace shows zeroes however many payments it holds, which
    // is exactly what the first seeded instance did.
    const balances = await db.query<{ n: string; total: string }>(
      'SELECT count(*) AS n, sum(abs(amount_minor)) AS total FROM account_balances',
    );
    assert.equal(Number(balances.rows[0]!.n), 9, 'one row per account');
    assert.ok(BigInt(balances.rows[0]!.total) > 0n, 'and none of them zero');

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

test('the showcase can be seeded again in a later month', async () => {
  // The failure this covers took four months to show up and looked like a
  // corrupt database: the seeder walked forward from a fixed value on the
  // first day of its window, the window moved with the month, and so the
  // second seeding offered the shared dates different numbers. A quote is
  // immutable — there is a trigger that refuses even a DELETE — so the insert
  // threw and left a fresh ledger sitting beside the previous holdings.
  //
  // Two seedings a month apart is the smallest case that shows it; reseeding
  // within one month never failed, which is why it went unnoticed.
  const db = memoryDatabase();
  await migrate(db);
  try {
    await seedShowcase(db, {
      now: new Date('2026-05-20T12:00:00Z'),
      months: 3,
    });
    const shared = await db.query<{ rate: string }>(
      "SELECT rate FROM daily_fx_rates WHERE base='USD' AND as_of='2026-05-03'",
    );
    assert.equal(shared.rows.length, 1);

    const later = new Date('2026-06-20T12:00:00Z');
    await seedShowcase(db, { now: later, months: 3 });

    // The shared date keeps the number it was first given, because that is
    // what immutability means and the seeder now offers the same one.
    const after = await db.query<{ rate: string }>(
      "SELECT rate FROM daily_fx_rates WHERE base='USD' AND as_of='2026-05-03'",
    );
    assert.equal(after.rows.length, 1, 'no second version of a settled day');
    assert.equal(after.rows[0]!.rate, shared.rows[0]!.rate);

    // And the day it was seeded has a quote. A date without one is what
    // "Conversion unavailable" says on the screens.
    const today = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM daily_fx_rates WHERE as_of='2026-06-20'",
    );
    assert.equal(Number(today.rows[0]!.n), 2, 'both currencies reach today');
  } finally {
    await db.close();
  }
});

test('a workspace seeded only part way does not claim to be whole', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    assert.equal(
      await showcaseSeededAt(db),
      null,
      'nothing has seeded this one yet',
    );
    await seedShowcase(db, {
      now: new Date('2026-09-20T12:00:00Z'),
      months: 2,
    });
    assert.ok(await showcaseSeededAt(db), 'a finished seeding says so');
  } finally {
    await db.close();
  }
});

test('the demo shows what a refund does, not just that money came back', async () => {
  // Before this, the seeder wrote a purchase and an equal credit three days
  // later and left them unlinked: `refund_links` was empty, so the reduced
  // headline, the "Original … · … returned" line and the "still settling"
  // note had never appeared in a screenshot of this application.
  const db = memoryDatabase();
  await migrate(db);
  try {
    const seeded = await seedShowcase(db, {
      now: new Date('2026-09-21T12:00:00Z'),
      months: 16,
    });
    assert.equal(seeded.refunds, 4, 'one refund every four months');

    const links = await db.query<{
      origin: string;
      dc: string;
      damt: string;
      cc: string;
      camt: string;
      status: string;
    }>(
      `SELECT l.origin, d.currency AS dc, d.amount_minor AS damt,
              c.currency AS cc, c.amount_minor AS camt, c.status
       FROM refund_links l
       JOIN transactions d ON d.id=l.debit_id
       JOIN transactions c ON c.id=l.credit_id
       WHERE l.state='active'`,
    );
    assert.equal(links.rows.length, 4);

    // Each shape drives a different part of the interface, and a demo missing
    // one shows the feature as simpler than it is.
    const rows = links.rows;
    assert.ok(
      rows.some((r) => r.dc === r.cc && r.damt === `-${r.camt}`),
      'the whole charge came back',
    );
    assert.ok(
      rows.some(
        (r) =>
          r.dc === r.cc &&
          BigInt(r.camt) < -BigInt(r.damt) &&
          BigInt(r.camt) > 0n,
      ),
      'some of it came back and the purchase survives, reduced',
    );
    assert.ok(
      rows.some((r) => r.status === 'pending'),
      'one reversal is still a hold, so the pair reads as settling',
    );
    const crossed = rows.find((r) => r.dc !== r.cc);
    assert.ok(crossed, 'charged in one currency and returned in another');
    assert.equal(
      crossed.origin,
      'manual',
      'the matcher never crosses a currency; a person confirmed this one',
    );
  } finally {
    await db.close();
  }
});

test('the reseed knobs change the workspace and cannot ask for the absurd', async () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const plain = showcaseTransactions(now, 12).length;
  const dense = showcaseTransactions(now, 12, { density: 2 }).length;
  assert.ok(dense > plain * 1.5, 'twice the density is visibly busier');

  // The ceiling is what keeps a mistyped figure from asking the server for a
  // workspace it cannot seed; the floor keeps it from asking for nothing.
  assert.equal(
    showcaseTransactions(now, 12, { density: 99 }).length,
    showcaseTransactions(now, 12, { density: SHOWCASE_LIMITS.density.max })
      .length,
    'density is capped',
  );
  assert.equal(
    showcaseTransactions(now, 12, { refunds: 500 }).filter((p) => p.refundOf)
      .length,
    showcaseTransactions(now, 12, {
      refunds: SHOWCASE_LIMITS.refunds.max,
    }).filter((p) => p.refundOf).length,
    'refunds are capped',
  );

  // Months are clamped where they are read, so a request for a decade does not
  // quietly become a ten-year seeding.
  const db = memoryDatabase();
  await migrate(db);
  try {
    const seeded = await seedShowcase(db, { now, months: 120, density: 0.25 });
    const oldest = await db.query<{ oldest: string }>(
      "SELECT min(booked_at)::text AS oldest FROM transactions WHERE source='showcase'",
    );
    const months =
      (now.getTime() - new Date(oldest.rows[0]!.oldest).getTime()) /
      (30 * 86400000);
    assert.ok(months < 26, `the window is capped, got about ${months} months`);
    assert.ok(seeded.transactions > 0);
  } finally {
    await db.close();
  }
});

test('the receipt knob cannot ask for a picture that was never drawn', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    const some = await seedShowcase(db, {
      now: new Date('2026-09-21T12:00:00Z'),
      months: 2,
      receipts: 2,
    });
    assert.equal(some.receipts, 2, 'two of the five were asked for');
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

test('the demo names the members on App health approvals too', async () => {
  const db = memoryDatabase();
  await migrate(db);
  await seedTestOwners(db);
  await db.query(
    `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
     VALUES('katya','Wise','LV','showcase-consent',now()+interval '15 minutes',now()+interval '4 days','authorized')`,
  );
  const before = ownerNames();
  setOwnerNames({ rodion: 'Alex', katya: 'Sam' });
  const server = web(new Repository(db), {
    port: 3400,
    mode: 'postgres',
    release: 'showcase-test',
  });
  await new Promise<void>((resolve) =>
    server.listen(3400, '127.0.0.1', resolve),
  );
  const base = 'http://127.0.0.1:3400';
  try {
    const cookie = await signInAs(base, 'rodion');
    const page = await (
      await fetch(base + '/ops', { headers: { cookie } })
    ).text();
    // The approvals arrived on this page after every other owner-bearing
    // string on it had been renamed, and were the one place still printing
    // the identifier. A screenshot of the demo is published; the ledger's own
    // name for somebody must not be in it.
    assert.match(page, /Wise \(LV\) · Sam/);
    assert.ok(
      !page.includes('Katya') && !page.includes('Rodion'),
      'the demo must not print the household identities on App health',
    );
  } finally {
    setOwnerNames(before);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});

test('the reseed page asks for a refill rather than doing one', async () => {
  // The page must not seed in this process. PGlite holds one process per data
  // directory, the service's cgroup is sized for serving rather than for
  // building a workspace, and seeding in place would leave the demo on the
  // release it booted with — which is the fault that made any of this worth
  // writing. So the whole of its job is to leave a request for the unit.
  const control = await mkdtemp(join(tmpdir(), 'showcase-control-'));
  const db = memoryDatabase();
  await migrate(db);
  const server = web(new Repository(db), {
    port: 3398,
    mode: 'demo',
    release: 'showcase-test',
    showcaseControlDirectory: control,
  });
  await new Promise<void>((resolve) =>
    server.listen(3398, '127.0.0.1', resolve),
  );
  const base = 'http://127.0.0.1:3398';
  try {
    const page = await fetch(base + '/showcase/reseed');
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const knob of ['density', 'months', 'refunds', 'receipts'])
      assert.match(html, new RegExp(`name="${knob}"`), `${knob} is offered`);

    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf, 'the form carries a token');

    const asked = await fetch(base + '/showcase/reseed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf,
        density: '2',
        months: '8',
        refunds: '3',
        receipts: '1',
      }).toString(),
    });
    assert.equal(asked.status, 202, 'accepted, not performed');

    // The ledger is untouched: this process seeded nothing.
    const written = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM transactions WHERE source='showcase'",
    );
    assert.equal(Number(written.rows[0]!.n), 0);

    const request = await readReseedRequest(control);
    assert.deepEqual(request?.shape, {
      density: 2,
      months: 8,
      refunds: 3,
      receipts: 1,
    });

    // And the page can report on it without the unit having run yet.
    const status = await (await fetch(base + '/showcase/reseed/status')).json();
    assert.equal((status as { state: string }).state, 'queued');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(control, { recursive: true, force: true });
  }
});

test('a knob outside its range asks for the nearest thing that is allowed', async () => {
  const control = await mkdtemp(join(tmpdir(), 'showcase-control-'));
  const db = memoryDatabase();
  await migrate(db);
  const server = web(new Repository(db), {
    port: 3397,
    mode: 'demo',
    release: 'showcase-test',
    showcaseControlDirectory: control,
  });
  await new Promise<void>((resolve) =>
    server.listen(3397, '127.0.0.1', resolve),
  );
  try {
    const page = await fetch('http://127.0.0.1:3397/showcase/reseed');
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]!;
    // A number input is a suggestion, not a guarantee: anything can be posted
    // here, and a workspace three years deep at thirty times the payments
    // would take the server down rather than fill a screenshot.
    await fetch('http://127.0.0.1:3397/showcase/reseed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf,
        density: '40',
        months: '600',
        refunds: 'not a number',
        receipts: '-3',
      }).toString(),
    });
    const request = await readReseedRequest(control);
    assert.deepEqual(request?.shape, {
      density: SHOWCASE_LIMITS.density.max,
      months: SHOWCASE_LIMITS.months.max,
      refunds: SHOWCASE_LIMITS.refunds.default,
      receipts: SHOWCASE_LIMITS.receipts.min,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(control, { recursive: true, force: true });
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
