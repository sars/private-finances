import type { Executor } from './database.js';

/**
 * Whether the household's data exists anywhere but the one server holding it.
 *
 * A backup nobody watches is a belief, not a protection: the timer can be
 * disabled, the credential can expire, the bucket can refuse a write, and the
 * only symptom is silence. So every run of `scripts/backup.sh` writes one row
 * here — the failures as well as the successes — and the operations page reads
 * the newest ones. An empty table therefore means something specific and true:
 * no off-server copy has ever been made, which is exactly what the page should
 * say rather than showing nothing at all.
 *
 * What is stored is deliberately thin. `destination` is a label such as
 * `amazon-s3`, never the repository URL, because the bucket address is private
 * configuration and this row travels inside the very dump that gets uploaded.
 * No financial content, no credentials and no error text reach this table; a
 * failure records only the stage it died at, which is what the owner needs in
 * order to know where to look.
 */
export type BackupOutcome = 'succeeded' | 'failed';
export type BackupStage = 'dump' | 'upload';

/**
 * A backup is expected every day, so a successful one is late once a whole day
 * plus the timer's randomised delay has passed without another. The allowance
 * is deliberately generous: a run due at 03:30 UTC may be held back up to
 * fifteen minutes, and a server rebooting through its window catches up on the
 * next one rather than being worth an alarm.
 */
export const BACKUP_EXPECTED_WITHIN_HOURS = 26;
const HOUR = 3600000;

export async function initializeBackupHealth(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS backup_runs (
      id uuid PRIMARY KEY,
      destination text NOT NULL CHECK(destination ~ '^[a-z][a-z0-9-]{0,39}$'),
      outcome text NOT NULL CHECK(outcome IN ('succeeded','failed')),
      stage text CHECK(stage IN ('dump','upload')),
      started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL DEFAULT now(),
      snapshot_id text CHECK(snapshot_id ~ '^[0-9a-f]{8,64}$'),
      size_bytes bigint CHECK(size_bytes >= 0),
      CHECK((outcome='failed') = (stage IS NOT NULL))
    )`);
  await tx.query(
    'CREATE INDEX IF NOT EXISTS backup_runs_finished_at ON backup_runs(finished_at DESC)',
  );
}

export type BackupHealth = {
  /**
   * `never_run` says no backup has ever been recorded, which for this project
   * is the honest opening state rather than an error. `failing` outranks
   * `late`: when the newest attempt failed, the age of the last success is no
   * longer the thing to report.
   */
  state: 'never_run' | 'healthy' | 'late' | 'failing';
  destination: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFailureStage: BackupStage | null;
  hoursSinceSuccess: number | null;
  snapshotId: string | null;
  sizeBytes: number | null;
  expectedWithinHours: number;
  /** Consecutive failures since the last success, for "once" versus "still". */
  consecutiveFailures: number;
};

type RunRow = {
  destination: string;
  outcome: BackupOutcome;
  stage: BackupStage | null;
  finished_at: string | Date;
  snapshot_id: string | null;
  size_bytes: string | number | null;
};

function instant(value: string | Date): string {
  return new Date(value).toISOString();
}

export async function backupHealth(
  db: Executor,
  now: Date = new Date(),
): Promise<BackupHealth> {
  // One pass over the recent tail rather than three aggregate queries: the
  // table gains a row a day, and the answer needs the newest attempt, the
  // newest success and the run of failures between them.
  const runs = (
    await db.query<RunRow>(
      `SELECT destination,outcome,stage,finished_at,snapshot_id,size_bytes
         FROM backup_runs ORDER BY finished_at DESC, id DESC LIMIT 200`,
    )
  ).rows;
  if (!runs.length)
    return {
      state: 'never_run',
      destination: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastFailureStage: null,
      hoursSinceSuccess: null,
      snapshotId: null,
      sizeBytes: null,
      expectedWithinHours: BACKUP_EXPECTED_WITHIN_HOURS,
      consecutiveFailures: 0,
    };
  const latest = runs[0]!;
  const success = runs.find((run) => run.outcome === 'succeeded') ?? null;
  let consecutiveFailures = 0;
  for (const run of runs) {
    if (run.outcome === 'succeeded') break;
    consecutiveFailures += 1;
  }
  const lastSuccessAt = success ? instant(success.finished_at) : null;
  const hoursSinceSuccess = lastSuccessAt
    ? (now.getTime() - Date.parse(lastSuccessAt)) / HOUR
    : null;
  const state: BackupHealth['state'] =
    latest.outcome === 'failed'
      ? 'failing'
      : hoursSinceSuccess !== null &&
          hoursSinceSuccess > BACKUP_EXPECTED_WITHIN_HOURS
        ? 'late'
        : 'healthy';
  return {
    state,
    destination: latest.destination,
    lastSuccessAt,
    lastAttemptAt: instant(latest.finished_at),
    lastFailureStage: latest.outcome === 'failed' ? latest.stage : null,
    hoursSinceSuccess:
      hoursSinceSuccess === null
        ? null
        : Math.round(hoursSinceSuccess * 10) / 10,
    snapshotId: success?.snapshot_id ?? null,
    sizeBytes: success?.size_bytes == null ? null : Number(success.size_bytes),
    expectedWithinHours: BACKUP_EXPECTED_WITHIN_HOURS,
    consecutiveFailures,
  };
}

/** "9 h" / "3 d": a backup's age is read as a scale, not to the minute. */
function backupAge(hours: number): string {
  return hours < 48
    ? `${Math.max(0, Math.round(hours))} h`
    : `${Math.round(hours / 24)} d`;
}

const DESTINATIONS: Record<string, string> = { 'amazon-s3': 'Amazon S3' };

/**
 * The two lines the operations page shows, in one place so that the React page
 * and the no-JavaScript shell cannot drift into saying different things about
 * the same state. Formatting of the instant is left to the caller, which knows
 * whether it is writing for a browser in the household's timezone or for the
 * plain page.
 */
export function backupSummary(
  backup: BackupHealth | undefined,
  formatInstant: (value: string) => string = (value) => value,
): { headline: string; detail: string } {
  if (!backup) return { headline: 'Unavailable', detail: '' };
  if (backup.state === 'never_run')
    return { headline: 'Never', detail: 'No copy exists off this server.' };
  if (backup.state === 'failing')
    return {
      headline: 'Failed',
      detail: [
        `${backup.lastFailureStage === 'dump' ? 'Database export' : 'Upload'} failed`,
        backup.consecutiveFailures > 1
          ? `${backup.consecutiveFailures} runs`
          : null,
        backup.lastSuccessAt
          ? `last copy ${formatInstant(backup.lastSuccessAt)}`
          : 'no copy has ever succeeded',
      ]
        .filter(Boolean)
        .join(' · '),
    };
  return {
    headline: `${backupAge(backup.hoursSinceSuccess ?? 0)} ago`,
    detail: [
      DESTINATIONS[backup.destination ?? ''] ?? backup.destination,
      backup.lastSuccessAt ? formatInstant(backup.lastSuccessAt) : null,
      backup.state === 'late' ? 'expected daily' : null,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * Records one attempt.
 *
 * The backup script writes its own rows through `psql`, reusing the libpq
 * variables the dump already has rather than introducing a second credential;
 * this is the same statement in the language the schema is defined in, for the
 * tests and for any later caller. The web application never starts a backup and
 * never writes here.
 */
export async function recordBackupRun(
  db: Executor,
  run: {
    destination: string;
    outcome: BackupOutcome;
    stage?: BackupStage | null;
    startedAt: Date;
    finishedAt?: Date;
    snapshotId?: string | null;
    sizeBytes?: number | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO backup_runs(id,destination,outcome,stage,started_at,finished_at,snapshot_id,size_bytes)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
    [
      run.destination,
      run.outcome,
      run.outcome === 'failed' ? (run.stage ?? null) : null,
      run.startedAt.toISOString(),
      (run.finishedAt ?? new Date()).toISOString(),
      run.snapshotId ?? null,
      run.sizeBytes ?? null,
    ],
  );
}
