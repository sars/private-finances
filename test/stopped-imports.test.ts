import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import { systemProblems, stoppedImportProblems } from '../src/problems.js';
import { connectionState, importStatus } from '../src/import-status.js';
import { interruptedAttemptStartedAt } from '../src/import-runs.js';
import {
  CredentialReminders,
  initializeCredentialHealth,
} from '../src/credential-health.js';

/**
 * 23 September 2026, as the server recorded it: an import of Kate's Monobank
 * died when PostgreSQL restarted, so its row still said `running` with a lease
 * long expired, and the scheduler, finding its latch, announced `blocked`.
 * The Bank imports page said "Importing now", Home said nothing for a day, and
 * nobody was told.
 */
const minutesAgo = (now: Date, n: number) =>
  new Date(now.getTime() - n * 60000).toISOString();

async function killedMidImport(now: Date) {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO bank_sync_runs(connection,state,lease_token,lease_until,last_success_at,retry_reason)
     VALUES('monobank:katya','running',gen_random_uuid(),$1,$2,'blocked'),
           ('monobank:rodion','succeeded',NULL,NULL,$3,NULL)`,
    [minutesAgo(now, 60 * 26), minutesAgo(now, 60 * 27), minutesAgo(now, 20)],
  );
  await db.query(
    `INSERT INTO bank_sync_attempts(id,connection,started_at,from_at,to_at,outcome)
     VALUES(gen_random_uuid(),'monobank:katya',$1,$2,$1,'running')`,
    [minutesAgo(now, 60 * 26 + 9), minutesAgo(now, 60 * 24 * 32)],
  );
  return db;
}

test('a run whose lease has gone is not "running"', () => {
  const now = new Date('2026-09-24T06:25:00Z');
  const live = { state: 'running', lease_until: minutesAgo(now, -3) };
  const dead = { state: 'running', lease_until: minutesAgo(now, 60) };
  assert.equal(connectionState(live, now), 'running');
  assert.equal(connectionState(dead, now), 'stopped');
  assert.equal(
    connectionState({ ...dead, retry_reason: 'transient' }, now),
    'interrupted',
  );
  assert.equal(
    connectionState({ state: 'failed', retry_reason: 'blocked' }, now),
    'stopped',
  );
  // A second firing that met a live run's latch says `blocked` too; the live
  // lease is the better evidence.
  assert.equal(
    connectionState({ ...live, retry_reason: 'blocked' }, now),
    'running',
  );
  assert.equal(connectionState({ state: 'succeeded' }, now), 'succeeded');
});

test('a latched bank is on Home and the Bank imports page at once, not a day later', async () => {
  const now = new Date('2026-09-24T06:25:00Z');
  const db = await killedMidImport(now);
  try {
    // Well inside the twenty-five-hour silence rule.
    await db.query(
      "UPDATE bank_sync_runs SET last_success_at=$1 WHERE connection='monobank:katya'",
      [minutesAgo(now, 90)],
    );
    const { problems } = await systemProblems(db, { now });
    assert.deepEqual(
      problems.map((p) => p.id).filter((id) => id.startsWith('bank:')),
      ['bank:monobank:katya'],
    );
    assert.equal(problems[0]!.severity, 'critical');
    assert.match(problems[0]!.title, /waiting to be looked at/);

    const status = await importStatus(db, now);
    const katya = status.connections.find(
      (c) => c.connection === 'monobank:katya',
    );
    assert.equal(katya?.state, 'stopped');
  } finally {
    await db.close();
  }
});

test('only a dead, unfinished attempt counts as interrupted', async () => {
  const now = new Date();
  const db = await killedMidImport(now);
  try {
    const started = await interruptedAttemptStartedAt(db, 'monobank:katya');
    assert.equal(started, Date.parse(minutesAgo(now, 60 * 26 + 9)));

    // Still within its lease: a slow run, not a dead one.
    await db.query(
      "UPDATE bank_sync_runs SET lease_until=now()+interval '4 minutes' WHERE connection='monobank:katya'",
    );
    assert.equal(await interruptedAttemptStartedAt(db, 'monobank:katya'), null);
    await db.query(
      "UPDATE bank_sync_runs SET lease_until=now()-interval '1 hour' WHERE connection='monobank:katya'",
    );

    // Closed as failed: the bank answered, and that is for a person.
    await db.query(
      "UPDATE bank_sync_attempts SET outcome='failed',finished_at=now() WHERE connection='monobank:katya'",
    );
    assert.equal(await interruptedAttemptStartedAt(db, 'monobank:katya'), null);

    // A newer attempt that finished makes the old open one history.
    await db.query(
      "UPDATE bank_sync_attempts SET outcome='running',finished_at=NULL WHERE connection='monobank:katya'",
    );
    await db.query(
      `INSERT INTO bank_sync_attempts(id,connection,started_at,finished_at,from_at,to_at,outcome)
       VALUES(gen_random_uuid(),'monobank:katya',now()-interval '30 minutes',now()-interval '25 minutes',now()-interval '31 days',now()-interval '30 minutes','succeeded')`,
    );
    assert.equal(await interruptedAttemptStartedAt(db, 'monobank:katya'), null);

    // Just opened, before the lease is claimed: never taken for dead.
    await db.query(
      `INSERT INTO bank_sync_attempts(id,connection,started_at,from_at,to_at,outcome)
       VALUES(gen_random_uuid(),'monobank:rodion',now()-interval '5 seconds',now()-interval '31 days',now()-interval '5 seconds','running')`,
    );
    assert.equal(
      await interruptedAttemptStartedAt(db, 'monobank:rodion'),
      null,
    );
  } finally {
    await db.close();
  }
});

test('a stopped import is told in Telegram once, and not while it may mend itself', async () => {
  const now = new Date();
  const db = await killedMidImport(now);
  const sent: string[] = [];
  const transport = {
    send: async (_chat: string, text: string) => {
      sent.push(text);
      return { messageId: sent.length };
    },
    react: async () => {
      throw new Error('unexpected_react');
    },
    reply: async () => {
      throw new Error('unexpected_reply');
    },
  };
  try {
    await initializeCredentialHealth(db);
    const reminders = new CredentialReminders(db, '-123', transport);

    // Stopped an hour after its last complete run: the scheduler may still
    // retry it by itself, so nothing is sent yet.
    await db.query(
      "UPDATE bank_sync_runs SET last_success_at=$1 WHERE connection='monobank:katya'",
      [minutesAgo(now, 60)],
    );
    assert.equal(await reminders.enqueueStoppedImports(now), 0);
    assert.equal(await reminders.dispatchOne(), 'idle');

    // Hours on, it is still stopped: one notice, however often it is checked.
    await db.query(
      "UPDATE bank_sync_runs SET last_success_at=$1 WHERE connection='monobank:katya'",
      [minutesAgo(now, 60 * 27)],
    );
    assert.equal(await reminders.enqueueStoppedImports(now), 1);
    assert.equal(await reminders.enqueueStoppedImports(now), 1);
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^⚠️ Monobank · Katya stopped and is waiting/);
    assert.match(sent[0]!, /Bank imports page/);

    // Recovered, then stopped again later: that is a new stop and a new notice.
    await db.query(
      `UPDATE bank_sync_runs SET state='running',lease_until=now()-interval '1 hour',
         last_success_at=$1,retry_reason='blocked' WHERE connection='monobank:katya'`,
      [minutesAgo(now, 60 * 5)],
    );
    assert.equal(await reminders.enqueueStoppedImports(now), 1);
    // …but it recovers before the notice goes out, which cancels it.
    await db.query(
      "UPDATE bank_sync_runs SET state='succeeded',lease_until=NULL,last_success_at=now(),retry_reason=NULL WHERE connection='monobank:katya'",
    );
    assert.equal(await reminders.enqueueStoppedImports(now), 0);
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(sent.length, 1);
  } finally {
    await db.close();
  }
});

test('an approval problem is not also sent as a stopped import', async () => {
  const now = new Date();
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO bank_sync_runs(connection,state,last_success_at,error_code)
       VALUES('enablebanking:rodion:lhv','failed',$1,'consent')`,
      [minutesAgo(now, 60 * 30)],
    );
    await db.query(
      `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
       VALUES('rodion','LHV Pank','EE','state-lhv',$1,$1,'authorized')`,
      [minutesAgo(now, 60 * 10)],
    );
    const { problems } = await systemProblems(db, { now });
    assert.deepEqual(
      problems.map((p) => p.id).filter((id) => id.startsWith('bank:')),
      ['bank:enablebanking:rodion:lhv:approval'],
    );
    assert.deepEqual(await stoppedImportProblems(db, now), []);
  } finally {
    await db.close();
  }
});
