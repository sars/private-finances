/**
 * The monthly snapshot: `node dist/src/holdings-snapshot-cli.js [YYYY-MM-DD]
 * [--check]`. Fills every holding that names a feed for the day (today in
 * Riga when no date is given) — bank balances already stored, the broker
 * statement, the exchange total, the wallet addresses — and records the
 * prices learned. `--check` only tries each configured credential and
 * prints a status word per feed, writing nothing.
 *
 * Needs `DATABASE_URL`; feeds are optional and switched on by the presence
 * of their files in `CREDENTIALS_DIRECTORY`: `ibkr-flex-token` with
 * `ibkr-flex-query`, and `binance-api-key` with `binance-api-secret`.
 * `ETH_RPC_URL` may point the ethereum lookup at another public node.
 * Output is counts and status codes; never a name, an address or a figure.
 * Production runs from `private-finances-assets-snapshot.timer`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, postgresDatabase } from './database.js';
import {
  fetchBinanceSpot,
  fetchFlexStatement,
  FeedError,
  type Fetcher,
} from './holding-feeds.js';
import { rigaDate, runFeeds, type FeedCredentials } from './holding-fill.js';

const log = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');

async function secret(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function loadFeedCredentials(
  directory: string | undefined,
): Promise<FeedCredentials> {
  if (!directory) return {};
  const [token, queryId, key, secretKey] = await Promise.all([
    secret(resolve(directory, 'ibkr-flex-token')),
    secret(resolve(directory, 'ibkr-flex-query')),
    secret(resolve(directory, 'binance-api-key')),
    secret(resolve(directory, 'binance-api-secret')),
  ]);
  return {
    ...(token && queryId ? { ibkr: { token, queryId } } : {}),
    ...(key && secretKey ? { binance: { key, secret: secretKey } } : {}),
  };
}

export function parseArguments(args: string[]): {
  asOf: string;
  check: boolean;
} {
  const check = args.includes('--check');
  const rest = args.filter((a) => a !== '--check');
  if (rest.length > 1) throw new Error('holdings_snapshot_usage');
  const asOf = rest[0] ?? rigaDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > rigaDate())
    throw new Error('holdings_snapshot_invalid_date');
  return { asOf, check };
}

const fetcher: Fetcher = (url, init) =>
  fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });

async function check(credentials: FeedCredentials) {
  const status = async (
    feed: string,
    attempt: (() => Promise<unknown>) | undefined,
  ) => {
    if (!attempt) return { feed, status: 'not_configured' };
    try {
      await attempt();
      return { feed, status: 'ok' };
    } catch (error) {
      return {
        feed,
        status: 'failed',
        code: error instanceof FeedError ? error.code : 'failed',
        detail: error instanceof FeedError ? error.detail : undefined,
      };
    }
  };
  log(
    await status(
      'ibkr',
      credentials.ibkr &&
        (() =>
          fetchFlexStatement(
            credentials.ibkr!.token,
            credentials.ibkr!.queryId,
            fetcher,
          )),
    ),
  );
  log(
    await status(
      'binance',
      credentials.binance &&
        (() =>
          fetchBinanceSpot(
            credentials.binance!.key,
            credentials.binance!.secret,
            fetcher,
          )),
    ),
  );
}

async function main() {
  const { asOf, check: checkOnly } = parseArguments(process.argv.slice(2));
  const credentials = await loadFeedCredentials(
    process.env.CREDENTIALS_DIRECTORY,
  );
  if (checkOnly) {
    await check(credentials);
    return;
  }
  if (!process.env.DATABASE_URL)
    throw new Error('holdings_snapshot_configuration');
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    log({ event: 'holdings_snapshot_start', asOf });
    const outcomes = await runFeeds(db, asOf, credentials, fetcher, {
      ethRpcUrl: process.env.ETH_RPC_URL,
    });
    for (const outcome of outcomes) log({ event: 'holdings_feed', ...outcome });
    log({
      event: 'holdings_snapshot_done',
      asOf,
      failed: outcomes.filter((o) => o.status === 'failed').length,
    });
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    log({
      event: 'holdings_snapshot_failed',
      error: error instanceof Error ? error.message : 'unknown',
    });
    process.exitCode = 1;
  });
