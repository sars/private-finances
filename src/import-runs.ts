/**
 * Every attempt to import a bank, and what it did — including the ones that
 * failed and the ones that never reached the bank at all.
 *
 * `bank_import_windows` records coverage: which span of days is known to have
 * been fetched for an account. It is written inside the committing transaction
 * and only then, which is right for coverage and useless for diagnosis — a
 * bank that is refusing work writes nothing there and so disappears from any
 * list built over it. The same import used to leave exactly one other trace,
 * the `error_code` on its connection, overwritten by the next attempt.
 *
 * So an attempt is recorded here when it starts and completed when it stops,
 * carrying the window it asked for, every request it made, and where it
 * stopped. The two records answer different questions and neither replaces the
 * other: an attempt says what happened, a window says what is covered.
 *
 * ## What a step may carry, and what it may never carry
 *
 * A step is the shape of a request and the shape of the answer: which stage of
 * the import, which account by the identifier the application already stores,
 * the request path with every variable segment removed, the HTTP status, how
 * many items came back, how long it took. That is enough to read a failure.
 *
 * It must never carry a payload, an amount, a merchant, a description, a
 * counterparty, a token, a session identifier or a provider account id. The
 * path is reduced to its shape before it is stored precisely because
 * `/sessions/{id}` and `/accounts/{uid}/transactions` are not safe to keep,
 * and `sanitizePath` is the only way a path enters a step.
 */
import { randomUUID } from 'node:crypto';
import type { Executor } from './database.js';
import { describeConnection } from './import-status.js';

/** How long an attempt is kept before the next write prunes it. */
export const ATTEMPT_RETENTION_DAYS = 120;
export const DEFAULT_RUN_PAGE = 50;
export const MAX_RUN_PAGE = 200;

/** Every stage an attempt passes through, in the order it passes through them. */
export type StepStage =
  | 'claim'
  | 'request'
  | 'accounts'
  | 'balance'
  | 'transactions'
  | 'commit'
  | 'identify'
  | 'finish'
  | 'error';

export type AttemptStep = {
  stage: StepStage;
  /** Milliseconds from the start of the attempt, so a slow stage is obvious. */
  at: number;
  ms?: number;
  /** The application's own account identifier, never the provider's. */
  account?: string;
  /** A request path with every variable segment replaced; see `sanitizePath`. */
  path?: string;
  status?: number;
  /** Bytes a bank answered a request with; never any of those bytes. */
  size?: number;
  /** Items the stage handled: accounts listed, payments fetched, rows written. */
  count?: number;
  /** A `ConnectorError` code, or the stage's own word for what went wrong. */
  code?: string;
  /** What the bank asked us to wait, when it said so, in milliseconds. */
  retryAfterMs?: number;
  /** A short machine-readable note. Never free text from a bank or a person. */
  note?: string;
};

export type ImportAttempt = {
  id: string;
  connection: string;
  /** The bank as the owner knows it, never the aggregator's name. */
  label: string;
  bank: string | null;
  provider: 'monobank' | 'enablebanking';
  owner: string;
  startedAt: string;
  finishedAt: string | null;
  from: string;
  to: string;
  outcome: 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  accounts: number;
  changed: number;
  /** Milliseconds the attempt took, when it has finished. */
  ms: number | null;
};

export type ImportAttemptDetail = ImportAttempt & {
  steps: AttemptStep[];
  /** The coverage rows this attempt committed, one per account it reached. */
  windows: {
    accountId: string;
    label: string | null;
    currency: string;
    from: string;
    to: string;
    changed: number;
  }[];
};

export type ImportRunPage = {
  runs: ImportAttempt[];
  /** Pass back as `cursor` for the next page; absent at the end. */
  nextCursor: string | null;
  /** How many attempts the filters select, across every page. */
  total: number;
};

export type RunQuery = {
  connection?: string;
  outcome?: 'succeeded' | 'failed' | 'running';
  /** Inclusive lower bound on `started_at`, as an ISO instant. */
  from?: string;
  /** Exclusive upper bound on `started_at`, as an ISO instant. */
  to?: string;
  cursor?: string;
  limit?: number;
};

/**
 * A request path reduced to the shape that is safe to keep.
 *
 * Enable Banking addresses a consent session and a provider account id in the
 * path itself, and neither belongs in a record the dashboard reads back. Only
 * segments this application wrote as literals survive; anything else becomes
 * `…`, and the query string goes entirely — it carries the date range, which
 * the attempt already states, and nothing else worth keeping.
 */
const PATH_LITERALS = new Set([
  'sessions',
  'accounts',
  'details',
  'balances',
  'transactions',
  'personal',
  'client-info',
  'statement',
]);
export function sanitizePath(path: string): string {
  const [withoutQuery = ''] = path.split('?');
  const segments = withoutQuery
    .split('/')
    .filter(Boolean)
    .map((segment) => (PATH_LITERALS.has(segment) ? segment : '…'));
  return '/' + segments.join('/');
}

/**
 * Collects an attempt's steps in memory and writes them once at the end.
 *
 * Deliberately not a row per step: an attempt is short, its steps are small,
 * and writing them together means a failure cannot leave half a record behind.
 * `finish` is safe to call after the import has already failed — recording the
 * attempt must never be the reason an import fails — so every write here is
 * wrapped and a failure to record is swallowed, having first been counted.
 */
export class AttemptRecorder {
  readonly id = randomUUID();
  private readonly started = Date.now();
  private readonly steps: AttemptStep[] = [];
  private opened = false;

  constructor(
    private readonly db: Executor,
    private readonly connection: string,
    private readonly from: Date,
    private readonly to: Date,
  ) {}

  /** Writes the `running` row. Never throws: diagnosis is not the point of a sync. */
  async open(): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO bank_sync_attempts(id,connection,started_at,from_at,to_at,outcome)
         VALUES($1,$2,now(),$3,$4,'running')`,
        [
          this.id,
          this.connection,
          this.from.toISOString(),
          this.to.toISOString(),
        ],
      );
      this.opened = true;
    } catch {
      // An attempt that cannot be recorded still imports money.
    }
  }

  step(stage: StepStage, detail: Omit<AttemptStep, 'stage' | 'at'> = {}): void {
    // A runaway connector must not turn one attempt into an unbounded row.
    if (this.steps.length >= 400) return;
    this.steps.push({ stage, at: Date.now() - this.started, ...detail });
  }

  /** Times one stage and records it, whether it returns or throws. */
  async timed<T>(
    stage: StepStage,
    detail: Omit<AttemptStep, 'stage' | 'at' | 'ms'>,
    run: () => Promise<T>,
  ): Promise<T> {
    const at = Date.now();
    try {
      const value = await run();
      this.step(stage, { ...detail, ms: Date.now() - at });
      return value;
    } catch (error) {
      this.step(stage, {
        ...detail,
        ms: Date.now() - at,
        code: errorCode(error),
      });
      throw error;
    }
  }

  async finish(
    outcome: 'succeeded' | 'failed',
    summary: { accounts: number; changed: number; errorCode?: string | null },
  ): Promise<void> {
    if (!this.opened) return;
    try {
      await this.db.query(
        `UPDATE bank_sync_attempts
         SET finished_at=now(), outcome=$2, error_code=$3, accounts=$4, changed=$5, steps=$6::jsonb
         WHERE id=$1`,
        [
          this.id,
          outcome,
          summary.errorCode ?? null,
          summary.accounts,
          summary.changed,
          JSON.stringify(this.steps),
        ],
      );
      await this.db.query(
        `DELETE FROM bank_sync_attempts
         WHERE started_at < now() - ($1 || ' days')::interval`,
        [String(ATTEMPT_RETENTION_DAYS)],
      );
    } catch {
      // As above: the import is what matters, the record of it is not.
    }
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'sync_failed';
}

/**
 * When this connection will next be tried, and why it is waiting.
 *
 * Written by the scheduler, which is the only thing that knows: it holds the
 * cooldown, and a deferred run exits before touching a bank or this database.
 * A connection with no run row yet is left alone — it has never been scheduled,
 * so there is nothing to defer.
 */
export async function recordNextAttempt(
  db: Executor,
  connection: string,
  retryAfter: Date | null,
  reason: string | null,
): Promise<void> {
  await db.query(
    'UPDATE bank_sync_runs SET retry_after=$2, retry_reason=$3 WHERE connection=$1',
    [connection, retryAfter ? retryAfter.toISOString() : null, reason],
  );
}

/**
 * When the newest attempt for this connection began, if it can no longer be
 * running and never said how it ended.
 *
 * Such an attempt is a process that died — a database restart under it, an
 * out-of-memory kill — before it could write anything about the bank. It is
 * the one kind of latched run whose cause is known not to be the bank, so the
 * scheduler may try again on the transient backoff instead of waiting for a
 * person. Both conditions are required. The lease is claimed a moment after the
 * attempt opens and renewed every minute for five, and a run that misses its
 * renewal gives up, so no live lease ten minutes in means nothing is running;
 * the ten minutes cover the moment between opening the attempt and claiming.
 */
const INTERRUPTED_MS = 10 * 60000;
export async function interruptedAttemptStartedAt(
  db: Executor,
  connection: string,
): Promise<number | null> {
  const found = await db.query(
    `SELECT a.started_at FROM bank_sync_attempts a
     LEFT JOIN bank_sync_runs r ON r.connection = a.connection
     WHERE a.connection = $1
       AND a.outcome = 'running'
       AND a.started_at < now() - ($2 || ' milliseconds')::interval
       AND (r.lease_until IS NULL OR r.lease_until < now())
       AND a.started_at = (SELECT max(started_at) FROM bank_sync_attempts WHERE connection = $1)`,
    [connection, String(INTERRUPTED_MS)],
  );
  const started = found.rows[0]?.started_at;
  return started ? new Date(started as string).getTime() : null;
}

/**
 * The cursor is the row's own order key, so a page cannot skip or repeat.
 *
 * Both halves are checked against the shape the columns actually hold, not
 * merely for being present. The id reaches SQL as `$n::uuid`, and PostgreSQL
 * raises on a cast it cannot make — so a cursor someone has mistyped in the
 * address bar would fail the whole request rather than the one filter. An
 * unreadable cursor is ignored, which returns the first page: the same
 * narrowing-is-optional rule the other filters follow.
 */
const CURSOR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function decodeCursor(
  cursor: string,
): { startedAt: string; id: string } | null {
  const at = cursor.indexOf('|');
  if (at <= 0) return null;
  const startedAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!Number.isFinite(Date.parse(startedAt))) return null;
  if (!CURSOR_UUID.test(id)) return null;
  return { startedAt, id };
}

/**
 * How long an attempt may say it is running before nobody believes it.
 *
 * The importer's own unit gives up at forty minutes and its lease renews every
 * minute, so a row still claiming to run well past that is not running: the
 * process was killed — an out-of-memory, a restart during a release — between
 * opening its row and completing it. Nothing else will ever close that row,
 * because the only writer for it is the process that died.
 */
const ABANDONED_MS = 45 * 60000;

function attemptFrom(row: Record<string, unknown>, now: number): ImportAttempt {
  const connection = String(row.connection);
  const described = describeConnection(connection);
  const started = new Date(row.started_at as string);
  const finished = row.finished_at ? new Date(row.finished_at as string) : null;
  // Derived when read rather than swept by a timer. A sweeper would be a second
  // mechanism to keep in step with the first, and it would still be wrong for
  // exactly as long as it had not run; this is right the moment it is asked,
  // and it never rewrites a row whose real fate might yet be written.
  const abandoned =
    row.outcome === 'running' && now - started.getTime() > ABANDONED_MS;
  return {
    id: String(row.id),
    connection,
    label: described.label,
    bank: described.bank,
    provider: described.provider,
    owner: described.owner,
    startedAt: started.toISOString(),
    finishedAt: finished ? finished.toISOString() : null,
    from: new Date(row.from_at as string).toISOString(),
    to: new Date(row.to_at as string).toISOString(),
    outcome: abandoned ? 'failed' : (row.outcome as ImportAttempt['outcome']),
    errorCode: abandoned
      ? 'abandoned'
      : row.error_code
        ? String(row.error_code)
        : null,
    accounts: Number(row.accounts),
    changed: Number(row.changed),
    ms: finished ? finished.getTime() - started.getTime() : null,
  };
}

/**
 * One page of attempts, newest first, cut with a keyset rather than an offset.
 *
 * The same reason the payments list is cut this way: a list that is being
 * appended to while it is read must not show a row twice or drop one between
 * pages, and `OFFSET` on a growing table does both.
 */
export async function importRuns(
  db: Executor,
  query: RunQuery = {},
): Promise<ImportRunPage> {
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? DEFAULT_RUN_PAGE), 1),
    MAX_RUN_PAGE,
  );
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (clause: (index: number) => string, value: unknown) => {
    values.push(value);
    where.push(clause(values.length));
  };
  if (query.connection) add((i) => `connection=$${i}`, query.connection);
  if (query.outcome) add((i) => `outcome=$${i}`, query.outcome);
  if (query.from) add((i) => `started_at>=$${i}::timestamptz`, query.from);
  if (query.to) add((i) => `started_at<$${i}::timestamptz`, query.to);
  const filters = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const counted = await db.query(
    `SELECT count(*)::int AS total FROM bank_sync_attempts ${filters}`,
    values,
  );

  const paged = [...values];
  const pageWhere = [...where];
  const seek = query.cursor ? decodeCursor(query.cursor) : null;
  if (seek) {
    paged.push(seek.startedAt, seek.id);
    pageWhere.push(
      `(started_at, id) < ($${paged.length - 1}::timestamptz, $${paged.length}::uuid)`,
    );
  }
  paged.push(limit + 1);
  const rows = await db.query(
    `SELECT id,connection,started_at,finished_at,from_at,to_at,outcome,error_code,accounts,changed
     FROM bank_sync_attempts
     ${pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''}
     ORDER BY started_at DESC, id DESC LIMIT $${paged.length}`,
    paged,
  );
  // One clock for the whole page, so two rows a millisecond apart cannot
  // disagree about whether they have been abandoned.
  const now = Date.now();
  const page = rows.rows.slice(0, limit).map((row) => attemptFrom(row, now));
  const last = page[page.length - 1];
  return {
    runs: page,
    nextCursor:
      rows.rows.length > limit && last ? `${last.startedAt}|${last.id}` : null,
    total: Number(counted.rows[0]?.total ?? 0),
  };
}

/** One attempt in full: its steps, and the coverage it committed. */
export async function importRun(
  db: Executor,
  id: string,
): Promise<ImportAttemptDetail | null> {
  const found = await db.query(
    `SELECT id,connection,started_at,finished_at,from_at,to_at,outcome,error_code,accounts,changed,steps
     FROM bank_sync_attempts WHERE id=$1`,
    [id],
  );
  const row = found.rows[0];
  if (!row) return null;
  // Coverage is not linked to the attempt by a key: the window table predates
  // this record and is written by a transaction that must not depend on it. The
  // attempt's own span identifies its windows exactly, because a connection
  // imports one window at a time under a lease no other run can hold.
  const windows = await db.query(
    `SELECT w.account_id, a.label, w.currency, w.from_at, w.to_at, w.changed
     FROM bank_import_windows w
     LEFT JOIN own_accounts a ON a.account_id = w.account_id
     WHERE w.connection=$1 AND w.completed_at >= $2::timestamptz
       AND w.completed_at <= coalesce($3::timestamptz, now())
     ORDER BY w.completed_at`,
    [String(row.connection), row.started_at, row.finished_at],
  );
  return {
    ...attemptFrom(row, Date.now()),
    steps: Array.isArray(row.steps) ? (row.steps as AttemptStep[]) : [],
    windows: windows.rows.map((w) => ({
      accountId: String(w.account_id),
      label: w.label === null || w.label === undefined ? null : String(w.label),
      currency: String(w.currency),
      from: new Date(w.from_at as string).toISOString(),
      to: new Date(w.to_at as string).toISOString(),
      changed: Number(w.changed),
    })),
  };
}
