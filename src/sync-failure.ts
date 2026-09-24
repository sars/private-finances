import { ConnectorError } from './connectors/types.js';

/**
 * How an import's failure is told to the scheduler, and read back by it.
 *
 * The scheduler latches a bank for a person to look at whenever the import ends
 * in a way it does not recognise, because a consent that failed must not be
 * retried every half hour. That is right for a bank that refused something and
 * wrong for a database that went away: on 23 September 2026 the nightly
 * unattended upgrade restarted PostgreSQL four minutes into an import of
 * Kate's Monobank, the import lost its connection, and the error it reported
 * was not one the scheduler knew — so a four-second restart stopped that bank
 * until somebody noticed a day later. The bank had not been asked anything it
 * could have refused.
 */

/**
 * SQLSTATEs and socket errors that mean the database was unreachable or was
 * shut down underneath the import: class 57P is an operator or crash shutdown,
 * class 08 a connection that could not be made or was lost. None of them says
 * anything about the bank.
 */
const DATABASE_GONE = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
]);

/** What node-postgres throws, without a code, when the server hangs up. */
const DATABASE_GONE_MESSAGES = [
  'Connection terminated unexpectedly',
  'Connection terminated',
  'timeout exceeded when trying to connect',
];

export function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && DATABASE_GONE.has(code)) return true;
  // A Unix socket that is not there while PostgreSQL restarts.
  if (
    code === 'ENOENT' &&
    (error as { syscall?: unknown }).syscall === 'connect'
  )
    return true;
  return DATABASE_GONE_MESSAGES.some((message) =>
    error.message.startsWith(message),
  );
}

export type FailureCode =
  ConnectorError['code'] | 'consent_pending' | 'configuration_or_sync_error';

/** The one word the import writes about why it stopped. Never a message. */
export function failureCode(error: unknown): FailureCode {
  if (error instanceof ConnectorError) return error.code;
  if (error instanceof Error && error.message === 'consent_pending')
    return 'consent_pending';
  // Retried on the transient backoff, an hour and then three, rather than
  // latched: the database is back within seconds of a restart.
  if (databaseUnavailable(error)) return 'transient';
  return 'configuration_or_sync_error';
}

/**
 * The import's reported failure, from everything it wrote to stderr.
 *
 * It is the last `bank_sync_failed` line rather than the whole stream: the
 * database pool announces a lost connection on its own line before the import
 * gives up, so a stream read as one JSON document stopped parsing the moment
 * that announcement was added and every such failure latched as unknown.
 */
export function reportedFailure(stderr: string): string | null {
  const lines = stderr.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { event?: unknown; code?: unknown };
      if (
        parsed.event === 'bank_sync_failed' &&
        typeof parsed.code === 'string'
      )
        return parsed.code;
    } catch {
      // Not a line this module wrote.
    }
  }
  return null;
}
