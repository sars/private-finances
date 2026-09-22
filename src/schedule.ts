import { execFile } from 'node:child_process';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANK_SLUGS } from './connectors/banks.js';
import { postgresDatabase } from './database.js';
import { recordNextAttempt } from './import-runs.js';

/** PF-002: bounded reconciliation, never a historical completeness watermark. */
export function dailyReplayWindow(now: Date): { from: string; to: string } {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_schedule_time');
  const to = new Date(now);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 31);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function parseInstance(instance: string): [string, string, string?] {
  const match = new RegExp(
    `^(monobank|enablebanking)-(rodion|katya)(?:-(${BANK_SLUGS.join('|')}))?$`,
  ).exec(instance);
  if (!match || (match[1] === 'enablebanking') !== Boolean(match[3]))
    throw new Error('invalid_schedule_instance');
  return [match[1]!, match[2]!, match[3]];
}

export async function verifiedMarker(
  path: string,
  expected: string,
  trustedUid = 0,
): Promise<boolean> {
  try {
    const info = await lstat(path);
    return (
      info.isFile() &&
      info.uid === trustedUid &&
      (info.mode & 0o022) === 0 &&
      info.size <= 1024 &&
      (await readFile(path, 'utf8')).trim() === expected
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * `consent_pending` is a bank the owner has not approved yet: the timer for a
 * newly added bank can be enabled before the approval, and the first import
 * follows the approval on its own, instead of the first run latching the
 * instance blocked for an operator to clear.
 */
export type SyncResult =
  'success' | 'transient' | 'rate_limit' | 'consent_pending' | 'blocked';

/**
 * How long to wait after a transient failure, by how many have come in a row.
 *
 * A rate limit is the provider saying it has had enough, and keeps the flat
 * twelve hours. A transient failure is something else: the bank was briefly
 * unreachable. Monobank's API goes down for a few minutes around 03:00 Kyiv,
 * and every Monobank transient in the server's journal — for both owners, on
 * separate tokens — has fallen between 03:04 and 03:10. Under a flat cooldown
 * one such night cost a whole day of imports, which is how an account came to
 * be eighteen hours stale from a ten-minute outage.
 *
 * So the first retry comes in an hour, the second three hours later, and only
 * a failure that keeps repeating earns a full day. Retrying an hour later costs
 * nothing: Monobank allows one request per minute per token and the connector
 * already spaces them by sixty-one seconds, while a provider that is genuinely
 * refusing work answers 429 and takes the rate-limit path instead.
 */
const TRANSIENT_BACKOFF_MS = [3600000, 10800000, 86400000];

/**
 * How many transient failures have come in a row, from the file the last one
 * wrote. A file that cannot be read as a count is treated as the longest wait
 * rather than the shortest: a corrupt streak must not become a reason to call
 * a bank more often.
 */
async function transientStreak(path: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const streak = Number(raw.trim());
  return Number.isSafeInteger(streak) && streak >= 0
    ? streak
    : TRANSIENT_BACKOFF_MS.length;
}
/**
 * Why this connection is waiting, as the run that set the cooldown wrote it.
 *
 * A wait set by a release that predates this file, or cleared by hand on the
 * server, leaves no reason — which is honest and still useful, because the time
 * is the part the owner is waiting for. Only the words this module writes are
 * accepted, so nothing a bank says can reach a screen through here.
 */
const RETRY_REASONS = new Set([
  'rate_limit',
  'transient',
  'polling_interval',
  'blocked',
]);
async function reasonOf(path: string): Promise<string | null> {
  try {
    const reason = (await readFile(path, 'utf8')).trim();
    return RETRY_REASONS.has(reason) ? reason : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function scheduleEnabled(
  directory: string,
  instance: string,
  trustedUid = 0,
) {
  parseInstance(instance);
  return (
    ((await verifiedMarker(
      resolve(directory, 'off-server-restore-verified'),
      'off-server-restore-verified',
      trustedUid,
    )) ||
      (await verifiedMarker(
        resolve(directory, 'local-restore-verified'),
        'local-restore-verified',
        trustedUid,
      ))) &&
    (await verifiedMarker(
      resolve(directory, 'schedules', `${instance}.enabled`),
      instance,
      trustedUid,
    ))
  );
}

type ScheduleOptions = {
  instance: string;
  now: Date;
  stateDirectory: string;
  ready: () => Promise<boolean>;
  invoke: (args: string[]) => Promise<SyncResult>;
  hourlyPolling?: boolean;
  halfHourlyPolling?: boolean;
  /**
   * Told when this connection will next be tried, and why it is waiting.
   *
   * The cooldown lives in a file here, which the web process deliberately does
   * not read, so until this existed the dashboard could only say that the last
   * import had failed — never that the next one was twelve hours off. A bank
   * that answers "slow down" then looks identical to a bank that has broken,
   * and the half-hourly timer firing in between says nothing, because a
   * deferred run exits before it touches anything at all.
   *
   * Diagnostic only: a failure to report must never change what the scheduler
   * does, so the caller's errors are swallowed by `report` below.
   */
  announce?: (retryAfter: Date | null, reason: string | null) => Promise<void>;
  /**
   * When the owner last approved this bank, or null if they never have.
   *
   * Only a connection that has an approval to renew supplies this. Monobank
   * holds a token rather than a consent and leaves it undefined, which keeps a
   * latch there exactly as final as it has always been.
   */
  consentRenewedAt?: () => Promise<number | null>;
};

/**
 * Lifts a latch the owner has already answered by approving the bank again.
 *
 * An expired consent latches like every other failure a person has to look at,
 * but unlike the rest it has one unambiguous answer, and the owner gives it on
 * the Bank connections page rather than on the server. Until this existed the
 * approval went through, the consent session was rewritten, and the scheduler
 * went on skipping the connection every half hour against a consent that had
 * been valid for hours — no import, no request to the bank at all, and a screen
 * still reporting that the bank had stopped. Revolut sat like that from 21
 * September 2026, about three hours after the owner had already renewed it.
 *
 * The web process cannot clear the latch itself. It runs as its own unit under
 * `ProtectSystem=strict` with no write access to the scheduler's state
 * directory, and that separation is deliberate — the scheduler's files are not
 * the dashboard's to edit. So the scheduler reads the one piece of evidence an
 * approval leaves behind, the session file rewritten each time the owner
 * approves, and lifts the latch when that file is newer than the latch itself.
 *
 * One approval buys exactly one attempt. A run that fails again writes a fresh
 * latch, now newer than the session, so a bank that is broken for some other
 * reason stays down for a person to look at rather than retrying every half
 * hour. Anything unreadable here leaves the latch alone: the safe direction is
 * the one that goes on waiting for a human.
 */
async function liftLatchTheOwnerAnswered(
  latch: string,
  consentRenewedAt: (() => Promise<number | null>) | undefined,
): Promise<void> {
  if (!consentRenewedAt) return;
  try {
    const latchedAt = (await lstat(latch)).mtimeMs;
    const approvedAt = await consentRenewedAt();
    if (approvedAt === null || approvedAt <= latchedAt) return;
    await unlink(latch);
  } catch {
    // A latch that is not there needs no lifting, and a state directory this
    // cannot read is not a reason to start calling a bank again.
  }
}

export async function runScheduledSync(options: ScheduleOptions) {
  const [provider, owner, bank] = parseInstance(options.instance);
  const window = dailyReplayWindow(options.now);
  if (!(await options.ready())) return 'disabled';
  const cooldown = resolve(
    options.stateDirectory,
    `${options.instance}.retry-after`,
  );
  const reasonFile = resolve(
    options.stateDirectory,
    `${options.instance}.retry-reason`,
  );
  /** Never lets a diagnostic write change what the scheduler decides. */
  const report = async (retryAfter: Date | null, reason: string | null) => {
    try {
      await options.announce?.(retryAfter, reason);
    } catch {
      // Saying why a bank is waiting must not stop it from waiting.
    }
  };
  /** Records a wait in both places: the file it is enforced from, and the
   * database the screens read. The reason sits beside the time because the
   * time alone cannot distinguish a bank resting from a bank in trouble. */
  const wait = async (until: number, reason: string) => {
    await writeFile(cooldown, String(until), { mode: 0o600 });
    await writeFile(reasonFile, reason + '\n', { mode: 0o600 });
    await report(new Date(until), reason);
  };
  try {
    const retryAt = Number(await readFile(cooldown, 'utf8'));
    if (!Number.isFinite(retryAt)) throw new Error('invalid_schedule_cooldown');
    if (options.now.getTime() < retryAt) {
      // Re-stated on every deferral rather than only when the cooldown was
      // set, so a wait that began before this record existed still reaches the
      // screen, and a cooldown cleared by hand on the server stops claiming a
      // bank is asleep when it is not.
      await report(new Date(retryAt), await reasonOf(reasonFile));
      return 'deferred';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const latch = resolve(options.stateDirectory, `${options.instance}.blocked`);
  await liftLatchTheOwnerAnswered(latch, options.consentRenewedAt);
  try {
    // Exclusive creation also prevents concurrent manual invocations. A crash
    // leaves the latch in place: a possibly failed consent is never retried.
    await writeFile(latch, 'review_required\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // No time to give: a latched instance waits for a person, not a clock.
      await report(null, 'blocked');
      return 'blocked';
    }
    throw error;
  }
  // A concurrent operator invocation may have checked the old cooldown before
  // waiting for this latch. Recheck after acquiring it before touching the bank.
  try {
    const retryAt = Number(await readFile(cooldown, 'utf8'));
    if (!Number.isFinite(retryAt)) throw new Error('invalid_schedule_cooldown');
    if (options.now.getTime() < retryAt) {
      await unlink(latch);
      return 'deferred';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const conservative = resolve(
    options.stateDirectory,
    `${options.instance}.conservative`,
  );
  const streakFile = resolve(
    options.stateDirectory,
    `${options.instance}.transient-streak`,
  );
  let backgroundHours = 6;
  if (
    provider === 'enablebanking' &&
    (options.hourlyPolling || options.halfHourlyPolling)
  ) {
    try {
      const reason = (await readFile(conservative, 'utf8')).trim();
      if (reason !== 'rate_limit' && reason !== 'transient')
        throw new Error('invalid_conservative_poll_state');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      backgroundHours = options.halfHourlyPolling ? 0.5 : 1;
    }
  }
  const result = await options.invoke([
    provider!,
    owner!,
    window.from,
    window.to,
    ...(bank ? [bank] : []),
  ]);
  if (
    provider === 'enablebanking' &&
    (result === 'rate_limit' || result === 'transient')
  )
    await writeFile(conservative, result + '\n', { mode: 0o600 });
  if (result === 'success' && provider === 'enablebanking')
    await wait(
      Math.max(options.now.getTime(), Date.now()) + backgroundHours * 3600000,
      'polling_interval',
    );
  if (result === 'rate_limit')
    await wait(
      // Twelve hours: long enough to let a bank's limit reset, short enough
      // that a balance is not a day and a half old by the next attempt (the
      // owner halved it from 24 hours on September 18, 2026).
      Math.max(options.now.getTime(), Date.now()) + 43200000,
      'rate_limit',
    );
  if (result === 'transient') {
    const streak = (await transientStreak(streakFile)) + 1;
    await writeFile(streakFile, String(streak) + '\n', { mode: 0o600 });
    await wait(
      Math.max(options.now.getTime(), Date.now()) +
        TRANSIENT_BACKOFF_MS[
          Math.min(streak, TRANSIENT_BACKOFF_MS.length) - 1
        ]!,
      'transient',
    );
  }
  // The streak counts consecutive failures, so anything that worked ends it.
  if (result === 'success')
    await unlink(streakFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  if (result !== 'blocked') await unlink(latch);
  return result;
}

function invokeCli(args: string[]): Promise<SyncResult> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL('./sync-cli.js', import.meta.url)), ...args],
      { timeout: 40 * 60 * 1000, maxBuffer: 65536 },
      (error, _stdout, stderr) => {
        if (!error) return done('success');
        // CLI emits sanitized JSON; do not forward child output to logs.
        try {
          const failure = JSON.parse(stderr.trim()) as {
            event?: string;
            code?: string;
          };
          if (
            !error.killed &&
            failure.event === 'bank_sync_failed' &&
            (failure.code === 'transient' ||
              failure.code === 'rate_limit' ||
              failure.code === 'consent_pending')
          )
            return done(failure.code);
        } catch {
          // Unknown output conservatively requires operator review.
        }
        done('blocked');
      },
    );
  });
}

/**
 * Puts the next-attempt time where the screens can read it.
 *
 * Opened per announcement and closed immediately: this process usually does
 * nothing but read a file and exit, and holding a connection open for that
 * would cost more than the fact is worth. A database that cannot be reached
 * costs the announcement and nothing else.
 */
async function announceToDatabase(
  connection: string,
  retryAfter: Date | null,
  reason: string | null,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await recordNextAttempt(db, connection, retryAfter, reason);
  } finally {
    await db.close();
  }
}

/**
 * When the owner last approved this bank, read from the session file the
 * approval writes — the same file, named the same way, that the import itself
 * opens to reach the provider. The scheduler only ever reads it.
 */
async function consentApprovedAt(
  owner: string,
  bank: string,
): Promise<number | null> {
  const directory = process.env.ENABLEBANKING_SESSION_DIRECTORY;
  if (!directory) return null;
  try {
    return (
      await lstat(resolve(directory, `enablebanking-${owner}-${bank}-session`))
    ).mtimeMs;
  } catch {
    // No approval on file is not an error here: it is a bank waiting for one.
    return null;
  }
}

async function main() {
  const instance = process.argv[2] ?? '';
  const [provider, owner, bank] = parseInstance(instance);
  const connection = `${provider}:${owner}${bank ? `:${bank}` : ''}`;
  const result = await runScheduledSync({
    instance,
    now: new Date(),
    stateDirectory: '/var/lib/private-finances-sync',
    ready: () => scheduleEnabled('/etc/private-finances', instance),
    invoke: invokeCli,
    announce: (retryAfter, reason) =>
      announceToDatabase(connection, retryAfter, reason),
    ...(bank
      ? { consentRenewedAt: () => consentApprovedAt(owner!, bank) }
      : {}),
    halfHourlyPolling: await verifiedMarker(
      resolve('/etc/private-finances/schedules', `${instance}.half-hourly`),
      instance,
    ),
    hourlyPolling: await verifiedMarker(
      resolve('/etc/private-finances/schedules', `${instance}.hourly`),
      instance,
    ),
  });
  process.stdout.write(
    JSON.stringify({ event: 'scheduled_sync', instance, result }) + '\n',
  );
  if (
    result !== 'success' &&
    result !== 'disabled' &&
    result !== 'deferred' &&
    result !== 'consent_pending'
  )
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write(
      '{"event":"scheduled_sync","result":"configuration_or_runner_error"}\n',
    );
    process.exitCode = 1;
  });
}
