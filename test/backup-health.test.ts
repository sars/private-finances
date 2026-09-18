import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { memoryDatabase, migrate } from '../src/database.js';
import {
  BACKUP_EXPECTED_WITHIN_HOURS,
  backupHealth,
  backupSummary,
  recordBackupRun,
} from '../src/backup-health.js';

const now = new Date('2026-09-20T09:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600000);

async function database() {
  const db = memoryDatabase();
  await migrate(db);
  return db;
}

test('a database that has never been backed up says so rather than looking healthy', async () => {
  const db = await database();
  try {
    const health = await backupHealth(db, now);
    assert.equal(health.state, 'never_run');
    assert.equal(health.lastSuccessAt, null);
    assert.equal(health.lastAttemptAt, null);
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.expectedWithinHours, BACKUP_EXPECTED_WITHIN_HOURS);
    assert.deepEqual(backupSummary(health), {
      headline: 'Never',
      detail: 'No copy exists off this server.',
    });
  } finally {
    await db.close();
  }
});

test('a daily backup is healthy until a whole day and the timer delay have passed', async () => {
  for (const [hours, state] of [
    [1, 'healthy'],
    [25, 'healthy'],
    [BACKUP_EXPECTED_WITHIN_HOURS, 'healthy'],
    [BACKUP_EXPECTED_WITHIN_HOURS + 0.5, 'late'],
    [72, 'late'],
  ] as const) {
    const db = await database();
    try {
      await recordBackupRun(db, {
        destination: 'amazon-s3',
        outcome: 'succeeded',
        startedAt: hoursAgo(hours),
        finishedAt: hoursAgo(hours),
        snapshotId: 'a1b2c3d4',
        sizeBytes: 4194304,
      });
      const health = await backupHealth(db, now);
      assert.equal(health.state, state, `${hours}h should be ${state}`);
      assert.equal(health.destination, 'amazon-s3');
      assert.equal(health.snapshotId, 'a1b2c3d4');
      assert.equal(health.sizeBytes, 4194304);
      assert.equal(health.consecutiveFailures, 0);
    } finally {
      await db.close();
    }
  }
});

test('a failed attempt outranks the age of the last success and names its stage', async () => {
  const db = await database();
  try {
    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'succeeded',
      startedAt: hoursAgo(10),
      finishedAt: hoursAgo(10),
      snapshotId: 'ffffeeee',
      sizeBytes: 1024,
    });
    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'failed',
      stage: 'upload',
      startedAt: hoursAgo(2),
      finishedAt: hoursAgo(2),
    });
    const health = await backupHealth(db, now);
    // Ten hours old would read as healthy; the newer failure is the news.
    assert.equal(health.state, 'failing');
    assert.equal(health.lastFailureStage, 'upload');
    assert.equal(health.consecutiveFailures, 1);
    assert.equal(health.lastSuccessAt, hoursAgo(10).toISOString());
    assert.equal(health.snapshotId, 'ffffeeee');
    assert.match(backupSummary(health).detail, /^Upload failed · last copy /);

    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'failed',
      stage: 'dump',
      startedAt: hoursAgo(1),
      finishedAt: hoursAgo(1),
    });
    const repeated = await backupHealth(db, now);
    assert.equal(repeated.consecutiveFailures, 2);
    assert.equal(repeated.lastFailureStage, 'dump');
    assert.match(
      backupSummary(repeated).detail,
      /Database export failed · 2 runs/,
    );
  } finally {
    await db.close();
  }
});

test('a backup that has only ever failed does not claim an earlier copy', async () => {
  const db = await database();
  try {
    await recordBackupRun(db, {
      destination: 'amazon-s3',
      outcome: 'failed',
      stage: 'dump',
      startedAt: hoursAgo(1),
      finishedAt: hoursAgo(1),
    });
    const health = await backupHealth(db, now);
    assert.equal(health.state, 'failing');
    assert.equal(health.lastSuccessAt, null);
    assert.equal(health.hoursSinceSuccess, null);
    assert.match(backupSummary(health).detail, /no copy has ever succeeded/);
  } finally {
    await db.close();
  }
});

test('the stored row refuses a shape the operations page could not trust', async () => {
  const db = await database();
  try {
    // A success with a stage, or a failure without one, would let the page say
    // both "it worked" and "it died here" about the same run.
    await assert.rejects(
      db.query(
        `INSERT INTO backup_runs(id,destination,outcome,stage,started_at)
           VALUES (gen_random_uuid(),'amazon-s3','failed',NULL,now())`,
      ),
    );
    await assert.rejects(
      db.query(
        `INSERT INTO backup_runs(id,destination,outcome,stage,started_at)
           VALUES (gen_random_uuid(),'amazon-s3','succeeded','upload',now())`,
      ),
    );
    // The destination is a label, never a bucket URL carrying private configuration.
    await assert.rejects(
      db.query(
        `INSERT INTO backup_runs(id,destination,outcome,started_at)
           VALUES (gen_random_uuid(),'s3:s3.example.com/bucket','succeeded',now())`,
      ),
    );
    await assert.rejects(
      db.query(
        `INSERT INTO backup_runs(id,destination,outcome,started_at,snapshot_id)
           VALUES (gen_random_uuid(),'amazon-s3','succeeded',now(),'not-a-snapshot')`,
      ),
    );
  } finally {
    await db.close();
  }
});

/**
 * The statement the backup script actually sends, run against a real database.
 *
 * `recordBackupRun` proves the shape is right, but the script does not call it
 * — it speaks to psql, and the two are separate copies of the same INSERT. This
 * reads the script's copy, substitutes the placeholders psql would expand, and
 * executes it. A statement that cannot parse, or that the table's constraints
 * reject, fails here rather than at 03:30 on the server.
 */
function scriptStatement(values: Record<string, string>): string {
  const script = readFileSync('scripts/backup.sh', 'utf8');
  const body = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(script);
  assert.ok(body, 'scripts/backup.sh should feed psql a SQL heredoc');
  return body[1]!.replace(/:'(\w+)'/g, (_, name: string) => {
    assert.ok(name in values, `unexpected placeholder :'${name}'`);
    return `'${values[name]!.replaceAll("'", "''")}'`;
  });
}

test("the backup script's own INSERT parses and satisfies the constraints", async () => {
  const db = await database();
  try {
    await db.query(
      scriptStatement({
        destination: 'amazon-s3',
        outcome: 'succeeded',
        stage: '',
        started: '2026-09-19T00:35:00Z',
        snapshot: '6d89e96a',
        size: '4096',
      }),
    );
    const healthy = await backupHealth(db, new Date('2026-09-19T01:00:00Z'));
    assert.equal(healthy.state, 'healthy');
    assert.equal(healthy.destination, 'amazon-s3');
    assert.equal(healthy.snapshotId, '6d89e96a');
    assert.equal(healthy.sizeBytes, 4096);
    assert.equal(healthy.lastFailureStage, null);

    // The failure path sends empty strings for the snapshot and the size; they
    // have to become NULL, or the row breaks its own CHECK constraints.
    await db.query(
      scriptStatement({
        destination: 'amazon-s3',
        outcome: 'failed',
        stage: 'upload',
        started: '2026-09-19T02:35:00Z',
        snapshot: '',
        size: '',
      }),
    );
    const failing = await backupHealth(db, new Date('2026-09-19T03:00:00Z'));
    assert.equal(failing.state, 'failing');
    assert.equal(failing.lastFailureStage, 'upload');
    assert.equal(failing.consecutiveFailures, 1);
    // The older success is still named, with its snapshot.
    assert.equal(failing.snapshotId, '6d89e96a');
  } finally {
    await db.close();
  }
});
