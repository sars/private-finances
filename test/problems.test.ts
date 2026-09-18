import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { connectionLabel, systemProblems } from '../src/problems.js';
import type { CredentialHealth } from '../src/credential-health.js';
import { recordBackupRun } from '../src/backup-health.js';
import { readFileSync } from 'node:fs';

const NOW = new Date('2026-09-18T18:00:00.000Z');
const hoursAgo = (n: number) =>
  new Date(NOW.getTime() - n * 3600000).toISOString();

/**
 * A database where everything is working, so each test breaks one thing.
 *
 * The exchange rate's age is fixed when the row is written and cannot be
 * changed afterwards: `daily_fx_rates` carries a trigger that refuses every
 * update and delete, because a rate a total was once built on must stay
 * exactly as it was retrieved. `rateAgeHours` of null writes no rate at all.
 */
async function healthy(rateAgeHours: number | null = 2) {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO bank_sync_runs(connection,state,last_success_at)
     VALUES('monobank:katya','succeeded',$1),('enablebanking:rodion:lhv','succeeded',$1)`,
    [hoursAgo(1)],
  );
  await db.query(
    `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
     VALUES('rodion','LHV Pank','EE','state-lhv',$1,$1,'authorized')`,
    [new Date(NOW.getTime() + 9 * 86400000).toISOString()],
  );
  if (rateAgeHours !== null)
    await db.query(
      `INSERT INTO daily_fx_rates(id,source,base,target,rate,as_of,retrieved_at,version,provenance)
       VALUES(gen_random_uuid(),'test','EUR','USD','1.1','2026-09-18',$1,1,'test')`,
      [hoursAgo(rateAgeHours)],
    );
  return db;
}

const ids = (list: { id: string }[]) => list.map((p) => p.id).sort();

test('nothing is reported when every part of the household is working', async () => {
  const db = await healthy();
  try {
    const { problems } = await systemProblems(db, { now: NOW });
    assert.deepEqual(problems, []);
  } finally {
    await db.close();
  }
});

test('a bank silent for more than a day is a problem; a few hours is not', async () => {
  const db = await healthy();
  try {
    // The owner's threshold: hours of missing data are no cause for concern.
    await db.query(
      "UPDATE bank_sync_runs SET last_success_at=$1 WHERE connection='monobank:katya'",
      [hoursAgo(20)],
    );
    assert.deepEqual((await systemProblems(db, { now: NOW })).problems, []);
    await db.query(
      "UPDATE bank_sync_runs SET last_success_at=$1 WHERE connection='monobank:katya'",
      [hoursAgo(26)],
    );
    const { problems } = await systemProblems(db, { now: NOW });
    assert.deepEqual(ids(problems), ['bank:monobank:katya']);
    assert.equal(problems[0]!.severity, 'critical');
    assert.match(
      problems[0]!.title,
      /Monobank · Katya has not imported for 26/,
    );
    assert.equal(problems[0]!.href, '/connections');
  } finally {
    await db.close();
  }
});

test('an approval is announced one day before it lapses, not five', async () => {
  const db = await healthy();
  const expiry = async (days: number) => {
    await db.query(
      "UPDATE bank_consents SET expires_at=$1 WHERE owner='rodion'",
      [new Date(NOW.getTime() + days * 86400000).toISOString()],
    );
    return (await systemProblems(db, { now: NOW })).problems;
  };
  try {
    assert.deepEqual(await expiry(3), []);
    const soon = await expiry(0.5);
    assert.deepEqual(ids(soon), ['bank:enablebanking:rodion:lhv']);
    // The bank as the owner knows it, never the integration provider's name.
    assert.match(
      soon[0]!.title,
      /^LHV · Rodion approval expires within a day$/,
    );
    const lapsed = await expiry(-1);
    assert.match(
      lapsed[0]!.title,
      /LHV · Rodion has stopped: the bank approval expired/,
    );
  } finally {
    await db.close();
  }
});

test('one bank with several things wrong is one row, naming the most specific', async () => {
  const db = await healthy();
  try {
    // Expired approval, a rejected credential and a long silence at once: three
    // spellings of "this bank has stopped and only you can restart it".
    await db.query(
      "UPDATE bank_consents SET expires_at=$1 WHERE owner='rodion'",
      [hoursAgo(5)],
    );
    await db.query(
      `UPDATE bank_sync_runs SET state='failed',error_code='auth',last_success_at=$1
       WHERE connection='enablebanking:rodion:lhv'`,
      [hoursAgo(40)],
    );
    const { problems } = await systemProblems(db, { now: NOW });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.title, /approval expired/);
  } finally {
    await db.close();
  }
});

test('a run left for review is reported, but an ordinary retry is not', async () => {
  const db = await healthy();
  const failWith = async (code: string) => {
    await db.query(
      "UPDATE bank_sync_runs SET state='failed',error_code=$1 WHERE connection='monobank:katya'",
      [code],
    );
    return (await systemProblems(db, { now: NOW })).problems;
  };
  try {
    // These retry on their own schedule and need nobody.
    assert.deepEqual(await failWith('transient'), []);
    assert.deepEqual(await failWith('rate_limit'), []);
    assert.deepEqual(await failWith('consent_pending'), []);
    const latched = await failWith('sync_failed');
    assert.deepEqual(ids(latched), ['bank:monobank:katya']);
    assert.match(latched[0]!.title, /waiting to be looked at/);
  } finally {
    await db.close();
  }
});

test('exchange rates are only called stale after a weekend could not explain it', async () => {
  const retrieved = async (hours: number | null) => {
    const db = await healthy(hours);
    try {
      return (await systemProblems(db, { now: NOW })).problems;
    } finally {
      await db.close();
    }
  };
  // A Friday-to-Monday gap is ordinary; the source publishes on working days.
  assert.deepEqual(await retrieved(60), []);
  const stale = await retrieved(80);
  assert.deepEqual(ids(stale), ['fx:stale']);
  assert.equal(stale[0]!.severity, 'warning');
  assert.match(stale[0]!.title, /No new exchange rate for three days/);
  const never = await retrieved(null);
  assert.match(never[0]!.title, /No exchange rates have been retrieved/);
});

test('the exchange feed is judged by whether it was read, having no expiry date', async () => {
  const db = await healthy();
  try {
    await db.query(
      `INSERT INTO holding_feed_runs(feed,status,code,ran_at)
       VALUES('binance','failed','auth',$1),('ibkr','ok',NULL,$1)`,
      [hoursAgo(3)],
    );
    const { problems } = await systemProblems(db, { now: NOW });
    assert.deepEqual(ids(problems), ['feed:binance']);
    assert.match(problems[0]!.title, /^Binance could not be read$/);
    // The code the exchange returned stays out of the sentence the owner reads.
    assert.doesNotMatch(problems[0]!.detail, /auth/);
  } finally {
    await db.close();
  }
});

test('a backup that has not been taken stops every import, and says so', async () => {
  const db = await healthy();
  try {
    assert.deepEqual(
      (await systemProblems(db, { now: NOW, lastBackupAt: hoursAgo(2) }))
        .problems,
      [],
    );
    const stale = (
      await systemProblems(db, { now: NOW, lastBackupAt: hoursAgo(30) })
    ).problems;
    assert.deepEqual(ids(stale), ['backup:stale']);
    assert.match(stale[0]!.detail, /imports stop/);
    // Not knowing where the backups live is not the same as there being none.
    assert.deepEqual((await systemProblems(db, { now: NOW })).problems, []);
  } finally {
    await db.close();
  }
});

test('a credential past its warning ladder is critical only on the day', async () => {
  const db = await healthy();
  const health = (
    state: CredentialHealth['state'],
    warningDays: CredentialHealth['warningDays'],
  ): CredentialHealth => ({
    credential: 'ibkr_flex_token',
    label: 'IBKR Flex token',
    state,
    expiresAt: hoursAgo(-48),
    expiresOn: null,
    daysRemaining: 2,
    warningDays,
  });
  try {
    assert.deepEqual(
      (
        await systemProblems(db, {
          now: NOW,
          credentials: [health('healthy', null)],
        })
      ).problems,
      [],
    );
    const warned = (
      await systemProblems(db, {
        now: NOW,
        credentials: [health('expiring', 2)],
      })
    ).problems;
    assert.equal(warned[0]!.severity, 'warning');
    const today = (
      await systemProblems(db, {
        now: NOW,
        credentials: [health('expires_today', 0)],
      })
    ).problems;
    assert.equal(today[0]!.severity, 'critical');
  } finally {
    await db.close();
  }
});

test('critical problems are listed before warnings, longest-standing first', async () => {
  const db = await healthy(null);
  try {
    await db.query(
      "UPDATE bank_sync_runs SET last_success_at=$1 WHERE connection='monobank:katya'",
      [hoursAgo(30)],
    );
    await db.query(
      "UPDATE bank_sync_runs SET last_success_at=$1 WHERE connection='enablebanking:rodion:lhv'",
      [hoursAgo(90)],
    );
    const { problems } = await systemProblems(db, { now: NOW });
    assert.deepEqual(
      problems.map((p) => p.id),
      ['bank:enablebanking:rodion:lhv', 'bank:monobank:katya', 'fx:stale'],
    );
  } finally {
    await db.close();
  }
});

test('an off-server backup that has never run is not reported as broken', async () => {
  const db = await healthy();
  try {
    // Configuration the owner has not finished yet. System health states it
    // plainly as "Never"; this page reports faults, not unbuilt things.
    assert.deepEqual((await systemProblems(db, { now: NOW })).problems, []);
  } finally {
    await db.close();
  }
});

test('an off-server backup that stops is a warning, not a critical', async () => {
  const db = await healthy();
  try {
    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'succeeded',
      startedAt: new Date(hoursAgo(10)),
      finishedAt: new Date(hoursAgo(10)),
      sizeBytes: 4096,
    });
    assert.deepEqual((await systemProblems(db, { now: NOW })).problems, []);

    await db.query('DELETE FROM backup_runs');
    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'succeeded',
      startedAt: new Date(hoursAgo(40)),
      finishedAt: new Date(hoursAgo(40)),
      sizeBytes: 4096,
    });
    const late = (await systemProblems(db, { now: NOW })).problems;
    assert.deepEqual(ids(late), ['backup:off-server']);
    // Nothing has stopped arriving, so it is not the same shade as a bank that
    // has gone silent; what has gone is the protection.
    assert.equal(late[0]!.severity, 'warning');
    assert.match(late[0]!.title, /No off-server backup for 40 hours/);
    assert.equal(late[0]!.href, '/ops');

    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'failed',
      stage: 'upload',
      startedAt: new Date(hoursAgo(1)),
      finishedAt: new Date(hoursAgo(1)),
    });
    const failing = (await systemProblems(db, { now: NOW })).problems;
    assert.deepEqual(ids(failing), ['backup:off-server']);
    assert.equal(failing[0]!.title, 'Off-server backup failed');
    assert.match(failing[0]!.detail, /upload stage failed/);
    assert.equal(failing[0]!.since, new Date(hoursAgo(1)).toISOString());
  } finally {
    await db.close();
  }
});

test('every problem links to a page that exists', async () => {
  // A problem carries the page where the fix is, which is the whole point of
  // the row. Four of them pointed at /operations, which has never been a route
  // — the page is /ops — so the rows that mattered most led nowhere. The set
  // below is the router's own table in frontend/src/main.tsx.
  const routes = new Set([
    '/',
    '/analytics',
    '/review',
    '/transactions',
    '/cash',
    '/receipts',
    '/categories',
    '/ops',
    '/fx',
    '/balances',
    '/accounts',
    '/reports',
    '/connections',
    '/imports',
    '/settings',
    '/assets',
    '/assets/snapshots',
    '/assets/new',
  ]);
  // Every destination the module can emit, including the branches this test
  // cannot reach without a whole household's worth of fixture rows.
  // The TypeScript source, not the compiled module beside this test: the
  // destinations are string literals and reading them is the only way to check
  // a branch no fixture reaches. Tests run from the repository root.
  const source = readFileSync('src/problems.ts', 'utf8');
  const declared = [...source.matchAll(/href: '([^']*)'/g)].map((m) => m[1]!);
  assert.ok(declared.length >= 6, 'expected several declared destinations');
  for (const href of declared)
    assert.ok(routes.has(href), `problems.ts links to ${href}, not a route`);

  // And the rows actually produced carry one of them.
  const db = await healthy(null);
  try {
    await db.query('UPDATE bank_sync_runs SET last_success_at=$1', [
      hoursAgo(40),
    ]);
    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'failed',
      stage: 'upload',
      startedAt: new Date(hoursAgo(1)),
      finishedAt: new Date(hoursAgo(1)),
    });
    const { problems } = await systemProblems(db, {
      now: NOW,
      lastBackupAt: null,
      credentials: [
        {
          credential: 'openai_api_key',
          label: 'OpenAI API key',
          state: 'expired',
          expiresAt: hoursAgo(50),
          expiresOn: null,
          daysRemaining: -2,
          warningDays: 0,
        },
      ],
    });
    assert.ok(problems.length >= 4, 'expected several problems to be reported');
    for (const problem of problems)
      assert.ok(
        problem.href === null || routes.has(problem.href),
        `${problem.id} links to ${problem.href}, which is not a route`,
      );
  } finally {
    await db.close();
  }
});

test('a connection is named the way the owner names it', () => {
  assert.equal(connectionLabel('monobank:katya'), 'Monobank · Katya');
  assert.equal(connectionLabel('enablebanking:rodion:lhv'), 'LHV · Rodion');
  assert.equal(connectionLabel('enablebanking:katya:wise'), 'Wise · Katya');
  // A slug written by a newer release and read back after a rollback.
  assert.equal(connectionLabel('enablebanking:rodion:monzo'), 'monzo · Rodion');
});
