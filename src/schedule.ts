import { execFile } from 'node:child_process';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANK_SLUGS } from './connectors/banks.js';

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
};

export async function runScheduledSync(options: ScheduleOptions) {
  const [provider, owner, bank] = parseInstance(options.instance);
  const window = dailyReplayWindow(options.now);
  if (!(await options.ready())) return 'disabled';
  const cooldown = resolve(
    options.stateDirectory,
    `${options.instance}.retry-after`,
  );
  try {
    const retryAt = Number(await readFile(cooldown, 'utf8'));
    if (!Number.isFinite(retryAt)) throw new Error('invalid_schedule_cooldown');
    if (options.now.getTime() < retryAt) return 'deferred';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const latch = resolve(options.stateDirectory, `${options.instance}.blocked`);
  try {
    // Exclusive creation also prevents concurrent manual invocations. A crash
    // leaves the latch in place: a possibly failed consent is never retried.
    await writeFile(latch, 'review_required\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'blocked';
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
    await writeFile(
      cooldown,
      String(
        Math.max(options.now.getTime(), Date.now()) + backgroundHours * 3600000,
      ),
      { mode: 0o600 },
    );
  if (result === 'rate_limit')
    await writeFile(
      cooldown,
      // Twelve hours: long enough to let a bank's limit reset, short enough
      // that a balance is not a day and a half old by the next attempt (the
      // owner halved it from 24 hours on September 18, 2026).
      String(Math.max(options.now.getTime(), Date.now()) + 43200000),
      { mode: 0o600 },
    );
  if (result === 'transient') {
    const streak = (await transientStreak(streakFile)) + 1;
    await writeFile(streakFile, String(streak) + '\n', { mode: 0o600 });
    await writeFile(
      cooldown,
      String(
        Math.max(options.now.getTime(), Date.now()) +
          TRANSIENT_BACKOFF_MS[
            Math.min(streak, TRANSIENT_BACKOFF_MS.length) - 1
          ]!,
      ),
      { mode: 0o600 },
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

async function main() {
  const instance = process.argv[2] ?? '';
  parseInstance(instance);
  const result = await runScheduledSync({
    instance,
    now: new Date(),
    stateDirectory: '/var/lib/private-finances-sync',
    ready: () => scheduleEnabled('/etc/private-finances', instance),
    invoke: invokeCli,
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
