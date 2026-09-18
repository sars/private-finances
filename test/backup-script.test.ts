import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The backup script is the only part of this project that runs with a database
 * password and a bucket credential, and it is the part no test could reach
 * while it existed only on the server. Here `pg_dump`, `restic` and `psql` are
 * replaced by stubs that record what they were asked to do, which is enough to
 * prove the things that matter: a failed dump is never uploaded, a truncated
 * dump is never called a backup, and every outcome — including the failures —
 * reaches the table the operations page reads.
 */
type Run = {
  status: number;
  stdout: string;
  stderr: string;
  /** psql's argv, one entry per invocation, NUL-separated within an entry. */
  recorded: string[];
  /** What psql was given on stdin, one entry per invocation. */
  sql: string[];
  uploaded: boolean;
};

function runBackup(stubs: {
  dumpExits?: number;
  dumpBytes?: number;
  resticExits?: number;
  resticOutput?: string;
  psqlExits?: number;
}): Run {
  const home = mkdtempSync(join(tmpdir(), 'pf-backup-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const log = join(home, 'psql.log');
  const sqlLog = join(home, 'psql-stdin.log');
  const uploaded = join(home, 'uploaded');
  const stub = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  const dumpBytes = stubs.dumpBytes ?? 4096;
  // pg_dump writes its dump through --file=..., which is the last argument.
  stub(
    'pg_dump',
    `set -e
for arg in "$@"; do case "$arg" in --file=*) target="\${arg#--file=}";; esac; done
if [ "${stubs.dumpExits ?? 0}" != "0" ]; then echo 'connection refused' >&2; exit ${stubs.dumpExits ?? 0}; fi
head -c ${dumpBytes} /dev/zero > "$target"`,
  );
  stub(
    'restic',
    `set -e
cat > /dev/null
if [ "${stubs.resticExits ?? 0}" != "0" ]; then echo 'bucket denied' >&2; exit ${stubs.resticExits ?? 0}; fi
touch ${JSON.stringify(uploaded)}
cat <<'JSON'
${stubs.resticOutput ?? '{"message_type":"status","percent_done":0.5}\n{"message_type":"summary","snapshot_id":"9f2c1ab4","total_bytes_processed":4096}'}
JSON`,
  );
  // Records argv *and* stdin. Only stdin proves the statement can actually run:
  // psql expands its `:'name'` placeholders when it reads a script and not when
  // the string arrives through --command, so a test that inspects the arguments
  // alone passes against an invocation the real psql rejects.
  stub(
    'psql',
    `printf '%s\\0' "$@" >> ${JSON.stringify(log)}
printf '\\n---\\n' >> ${JSON.stringify(log)}
cat >> ${JSON.stringify(sqlLog)}
printf '\\n---\\n' >> ${JSON.stringify(sqlLog)}
exit ${stubs.psqlExits ?? 0}`,
  );
  const result = spawnSync('bash', ['scripts/backup.sh'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PGDATABASE: 'private_finances_test',
      RESTIC_REPOSITORY: 's3:example.invalid/bucket',
      RESTIC_PASSWORD_FILE: '/dev/null',
    },
  });
  let recorded: string[] = [];
  try {
    recorded = readFileSync(log, 'utf8')
      .split('\n---\n')
      .filter((entry) => entry.trim().length > 0);
  } catch {
    recorded = [];
  }
  let sql: string[] = [];
  try {
    sql = readFileSync(sqlLog, 'utf8')
      .split('\n---\n')
      .filter((entry) => entry.trim().length > 0);
  } catch {
    sql = [];
  }
  let wasUploaded = true;
  try {
    readFileSync(uploaded);
  } catch {
    wasUploaded = false;
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    recorded,
    sql,
    uploaded: wasUploaded,
  };
}

test('a successful backup uploads once and records the snapshot it made', () => {
  const run = runBackup({});
  assert.equal(run.status, 0);
  assert.equal(run.uploaded, true);
  assert.match(run.stdout, /"event":"backup_completed"/);
  assert.match(run.stdout, /"recorded":true/);
  assert.equal(run.recorded.length, 1);
  const call = run.recorded[0]!;
  assert.match(call, /outcome=succeeded/);
  assert.match(call, /snapshot=9f2c1ab4/);
  assert.match(call, /size=4096/);
  assert.match(call, /destination=amazon-s3/);
  // The statement itself arrives on stdin, which is the only way psql expands
  // the placeholders; see the regression test below.
  assert.equal(run.sql.length, 1);
  assert.match(run.sql[0]!, /INSERT INTO backup_runs/);
  // The bucket URL is the one thing that must not reach the table.
  assert.doesNotMatch(call, /example\.invalid/);
  assert.doesNotMatch(run.sql[0]!, /example\.invalid/);
});

test('the statement is fed to psql as a script, never through --command', () => {
  // The first version of this script passed the SQL to `psql --command`, and
  // every test passed. On the server it failed on the first real run:
  // `psql -c` sends its argument straight to the server, and `:'name'` is a
  // client-side feature, so PostgreSQL saw a literal colon and refused to parse
  // it. The backup itself was fine and only the status row was lost, which is
  // how it was noticed at all. Arguments alone cannot catch this; stdin can.
  const run = runBackup({});
  const call = run.recorded[0]!;
  assert.doesNotMatch(call, /--command/);
  assert.doesNotMatch(call, /\x00-c\x00/);
  assert.doesNotMatch(call, /INSERT INTO/);
  const sql = run.sql[0]!;
  assert.match(sql, /INSERT INTO backup_runs/);
  for (const placeholder of [
    'destination',
    'outcome',
    'stage',
    'started',
    'snapshot',
    'size',
  ])
    assert.match(
      sql,
      new RegExp(`:'${placeholder}'`),
      `${placeholder} should be a psql placeholder, not interpolated by bash`,
    );
  // Without this a rejected statement would exit 0 and be reported as recorded.
  assert.match(call, /--set=ON_ERROR_STOP=1/);
});

test('a dump that fails is recorded as a failure and never uploaded', () => {
  const run = runBackup({ dumpExits: 2 });
  assert.equal(run.status, 1);
  assert.equal(run.uploaded, false);
  assert.match(run.stderr, /"event":"backup_failed","stage":"dump"/);
  // Connection diagnostics stay out of the service log.
  assert.doesNotMatch(run.stderr, /connection refused/);
  assert.equal(run.recorded.length, 1);
  assert.match(run.recorded[0]!, /outcome=failed/);
  assert.match(run.recorded[0]!, /stage=dump/);
});

test('a truncated dump is a failure, not a very small backup', () => {
  const run = runBackup({ dumpBytes: 12 });
  assert.equal(run.status, 1);
  assert.equal(run.uploaded, false);
  assert.match(run.stderr, /"stage":"dump"/);
  assert.match(run.recorded[0]!, /outcome=failed/);
});

test('an upload that fails is recorded at the upload stage and fails the run', () => {
  const run = runBackup({ resticExits: 1 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /"event":"backup_failed","stage":"upload"/);
  assert.doesNotMatch(run.stderr, /bucket denied/);
  assert.match(run.recorded[0]!, /outcome=failed/);
  assert.match(run.recorded[0]!, /stage=upload/);
});

test('an upload with no summary is still a backup, recorded without a snapshot id', () => {
  const run = runBackup({
    resticOutput: '{"message_type":"status","percent_done":1}',
  });
  assert.equal(run.status, 0);
  assert.equal(run.uploaded, true);
  assert.match(run.recorded[0]!, /outcome=succeeded/);
  assert.match(run.recorded[0]!, /snapshot=\x00/);
});

test('a good backup that cannot be written down is still a good backup', () => {
  // The page will show it ageing, which errs towards alarm rather than towards
  // false comfort; losing the uploaded snapshot over a failed INSERT would not.
  const run = runBackup({ psqlExits: 1 });
  assert.equal(run.status, 0);
  assert.equal(run.uploaded, true);
  assert.match(run.stderr, /"event":"backup_status_unrecorded"/);
  assert.match(run.stdout, /"recorded":false/);
});
