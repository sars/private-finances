/**
 * Filling a day's snapshot from what the feeds know (PF-020, steps two and
 * four). A bank holding takes the balance its bank last stated, less the
 * agreed overdraft; a broker holding takes the position or the cash the
 * statement shows; the exchange holding takes its dollar total; a wallet
 * holding takes the address's balance. Every figure written is a snapshot
 * like any typed one — versioned, carried forward, visible with its source —
 * and every price learned along the way is stored for the valuation.
 *
 * What could not be filled is reported by count and reason, never by name
 * or figure, so a log line says how the run went without saying what the
 * household owns.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from './database.js';
import { currencyExponent } from './fx.js';
import { Holdings, type Holding } from './holdings.js';
import {
  fetchBinancePublicPrices,
  fetchBinanceSpot,
  fetchBitcoinBalance,
  fetchEthereumBalance,
  fetchFlexStatement,
  FeedError,
  type ExchangeHoldings,
  type Fetcher,
  type FlexStatement,
} from './holding-feeds.js';
import { parseDecimal, toDecimal } from './holding-valuation.js';

export interface FillSummary {
  filled: number;
  unchanged: number;
  /** Holdings with a feed that could not be filled, by reason. */
  skipped: Record<string, number>;
  pricesRecorded: number;
  /** Positions the statement showed that had no holding yet and were created. */
  created: number;
}
const empty = (): FillSummary => ({
  filled: 0,
  unchanged: 0,
  skipped: {},
  pricesRecorded: 0,
  created: 0,
});
const skip = (summary: FillSummary, reason: string) => {
  summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
};
/** How old a stored bank balance may be and still count for the day. */
export const BALANCE_MAX_AGE_DAYS = 3;

/** Records a figure and counts it as filled, or as unchanged when the day
 *  already held exactly that figure (the service returns the existing row). */
class Writer {
  private known = new Map<string, string>();
  constructor(private service: Holdings) {}
  async load() {
    for (const snapshot of await this.service.snapshots())
      this.known.set(`${snapshot.holdingId}|${snapshot.asOf}`, snapshot.id);
  }
  async write(
    summary: FillSummary,
    holding: Holding,
    asOf: string,
    amount: string,
    source: string,
  ) {
    const recorded = await this.service.recordSnapshot(null, {
      holdingId: holding.id,
      asOf,
      amount,
      source,
    });
    const key = `${holding.id}|${asOf}`;
    if (this.known.get(key) === recorded.id) summary.unchanged += 1;
    else summary.filled += 1;
    this.known.set(key, recorded.id);
  }
}
async function writer(service: Holdings) {
  const w = new Writer(service);
  await w.load();
  return w;
}

/**
 * Bank holdings from the balances the sync runs already stored. Nothing is
 * fetched: this is the part the web application may run on demand.
 */
export async function fillFromBalances(
  db: Database,
  asOf: string,
  now = new Date(),
): Promise<FillSummary> {
  const service = new Holdings(db);
  const summary = empty();
  const holdings = (await service.list(false)).filter((h) => h.feed === 'bank');
  if (!holdings.length) return summary;
  const w = await writer(service);
  const balances = (
    await db.query(
      'SELECT source,account_id,currency,amount_minor::text AS amount,credit_limit_minor::text AS credit_limit,observed_at FROM account_balances',
    )
  ).rows;
  for (const holding of holdings) {
    const [source, accountId] = (holding.feedRef ?? '').split('|');
    const row = balances.find(
      (b) =>
        b.source === source &&
        b.account_id === accountId &&
        b.currency === holding.denomination,
    );
    if (!row) {
      skip(summary, 'no_balance');
      continue;
    }
    const observed = new Date(String(row.observed_at));
    const ageDays = (now.getTime() - observed.getTime()) / 86400000;
    if (
      !Number.isFinite(ageDays) ||
      ageDays > BALANCE_MAX_AGE_DAYS ||
      observed.toISOString().slice(0, 10) > asOf
    ) {
      skip(
        summary,
        ageDays > BALANCE_MAX_AGE_DAYS ? 'balance_stale' : 'balance_after_day',
      );
      continue;
    }
    const exponent = currencyExponent(holding.denomination);
    if (exponent === undefined) {
      skip(summary, 'unsupported_currency');
      continue;
    }
    // The bank counts the agreed overdraft inside the balance; the household's
    // own money is what is left after taking it back out.
    const own =
      BigInt(String(row.amount)) -
      (row.credit_limit === null || row.credit_limit === undefined
        ? 0n
        : BigInt(String(row.credit_limit)));
    await w.write(
      summary,
      holding,
      asOf,
      toDecimal({ n: own, d: 10n ** BigInt(exponent) }, exponent),
      'bank',
    );
  }
  return summary;
}

/** Positions and cash of the broker statement onto the holdings that name them. */
export async function applyFlexStatement(
  db: Database,
  asOf: string,
  statement: FlexStatement,
): Promise<FillSummary> {
  const service = new Holdings(db);
  const summary = empty();
  const w = await writer(service);
  const all = await service.list();
  const fed = all.filter((h) => h.feed === 'ibkr' && !h.archived);
  const symbols = new Map(statement.positions.map((p) => [p.symbol, p]));
  for (const position of statement.positions) {
    if (position.markPrice && position.currency === 'USD') {
      await service.recordPrice(null, {
        symbol: position.symbol,
        asOf,
        usdPerUnit: position.markPrice,
        source: 'ibkr',
      });
      summary.pricesRecorded += 1;
    }
  }
  const claimed = new Set<string>();
  for (const holding of fed) {
    const reference = (holding.feedRef ?? holding.denomination).toUpperCase();
    if (reference === 'CASH') {
      // A per-currency row when the query has them; otherwise the base
      // summary, which is cash in the base currency and nothing else.
      const cash =
        statement.cash.find((c) => c.currency === holding.denomination)
          ?.endingCash ??
        (!statement.cash.length &&
        statement.baseCash !== null &&
        statement.baseCurrency === holding.denomination
          ? statement.baseCash
          : null);
      if (cash === null) {
        skip(summary, 'no_cash_row');
        continue;
      }
      await w.write(summary, holding, asOf, cash, 'ibkr');
      continue;
    }
    const position = symbols.get(reference);
    claimed.add(reference);
    // A position the statement no longer lists was sold: its holding is zero
    // from this day, which is what the spreadsheet did by hand.
    await w.write(summary, holding, asOf, position?.quantity ?? '0', 'ibkr');
  }
  // New positions get a holding of their own, shaped like the existing ones.
  const positionHolding = (h: Holding) =>
    (h.feedRef ?? h.denomination).toUpperCase() !== 'CASH';
  const template =
    fed.find((h) => positionHolding(h) && h.owner) ?? fed.find(positionHolding);
  for (const position of statement.positions) {
    if (claimed.has(position.symbol) || position.assetCategory === 'CASH')
      continue;
    if (
      all.some((h) => h.denomination === position.symbol && h.feed === 'ibkr')
    )
      continue;
    const created = await service.upsert('ibkr', {
      name: `${template?.group ?? 'Broker'} ${position.symbol}`,
      kind: 'broker',
      denomination: position.symbol,
      invested: true,
      liquid: true,
      owner: template?.owner ?? null,
      group: template?.group ?? 'Broker',
      feed: 'ibkr',
      feedRef: position.symbol,
    });
    await w.write(summary, created, asOf, position.quantity, 'ibkr');
    summary.created += 1;
  }
  return summary;
}

/** Below this dollar value a coin is dust: counted in the exchange total, not given a holding. */
export const EXCHANGE_DUST_USD = 1n;

/**
 * The exchange onto its holdings: every coin worth at least a dollar gets a
 * holding of its own, created when new and zeroed when gone, shaped like the
 * exchange's existing holdings; a `TOTAL` holding still takes the dollar
 * total of everything, but is skipped once per-coin holdings exist so the
 * same money is never counted twice.
 */
export async function applyExchangeHoldings(
  db: Database,
  asOf: string,
  exchange: ExchangeHoldings,
): Promise<FillSummary> {
  const service = new Holdings(db);
  const summary = empty();
  const w = await writer(service);
  const all = await service.list();
  const fed = all.filter((h) => h.feed === 'binance' && !h.archived);
  const perCoin = (h: Holding) =>
    (h.feedRef ?? 'TOTAL').toUpperCase() !== 'TOTAL';
  const symbolOk = (asset: string) => /^[A-Z0-9][A-Z0-9.\-]{0,15}$/.test(asset);
  for (const asset of exchange.assets) {
    if (asset.usdPerUnit && asset.asset !== 'USD' && symbolOk(asset.asset)) {
      await service.recordPrice(null, {
        symbol: asset.asset,
        asOf,
        usdPerUnit: asset.usdPerUnit,
        source: 'binance',
      });
      summary.pricesRecorded += 1;
    }
  }
  const claimed = new Set<string>();
  for (const holding of fed) {
    const reference = (holding.feedRef ?? 'TOTAL').toUpperCase();
    if (reference === 'TOTAL') {
      if (fed.some(perCoin)) {
        skip(summary, 'total_superseded_by_coins');
        continue;
      }
      if (holding.denomination !== 'USD' || exchange.totalUsd === null) {
        skip(
          summary,
          exchange.totalUsd === null ? 'no_prices' : 'total_needs_usd',
        );
        continue;
      }
      await w.write(summary, holding, asOf, exchange.totalUsd, 'binance');
      continue;
    }
    claimed.add(reference);
    const asset = exchange.assets.find((a) => a.asset === reference);
    await w.write(summary, holding, asOf, asset?.quantity ?? '0', 'binance');
  }
  // A coin worth a dollar or more with no holding yet gets one, shaped like
  // the exchange's other holdings; a retired total still lends its shape.
  const template =
    fed.find(perCoin) ?? all.find((h) => h.feed === 'binance') ?? null;
  for (const asset of exchange.assets) {
    if (claimed.has(asset.asset) || !asset.usdPerUnit || !symbolOk(asset.asset))
      continue;
    const quantity = parseDecimal(asset.quantity)!;
    const price = parseDecimal(asset.usdPerUnit)!;
    // quantity × price < dust, in exact arithmetic
    if (quantity.n * price.n < EXCHANGE_DUST_USD * quantity.d * price.d)
      continue;
    const created = await service.upsert('binance', {
      name: `${template?.group ?? 'Binance'} ${asset.asset}`,
      kind: 'crypto',
      denomination: asset.asset,
      invested: true,
      liquid: true,
      owner: template?.owner ?? null,
      group: template?.group ?? 'Binance',
      feed: 'binance',
      feedRef: asset.asset,
    });
    await w.write(summary, created, asOf, asset.quantity, 'binance');
    summary.created += 1;
  }
  return summary;
}

/** Wallet holdings from their public addresses; prices for their coins from the exchange's open ticker. */
export async function fillWallets(
  db: Database,
  asOf: string,
  fetcher: Fetcher,
  options: { ethRpcUrl?: string; btcOrigin?: string } = {},
): Promise<FillSummary> {
  const service = new Holdings(db);
  const summary = empty();
  const fed = (await service.list(false)).filter((h) => h.feed === 'wallet');
  if (!fed.length) return summary;
  const w = await writer(service);
  const coins = [...new Set(fed.map((h) => h.denomination))];
  let prices = new Map<string, string>();
  try {
    prices = await fetchBinancePublicPrices(coins, fetcher);
  } catch {
    /* a missing price leaves the holding without one, visibly */
  }
  for (const [symbol, price] of prices) {
    await service.recordPrice(null, {
      symbol,
      asOf,
      usdPerUnit: price,
      source: 'binance',
    });
    summary.pricesRecorded += 1;
  }
  for (const holding of fed) {
    try {
      const quantity =
        holding.denomination === 'BTC'
          ? await fetchBitcoinBalance(
              holding.feedRef ?? '',
              fetcher,
              options.btcOrigin,
            )
          : holding.denomination === 'ETH'
            ? await fetchEthereumBalance(
                holding.feedRef ?? '',
                fetcher,
                options.ethRpcUrl,
              )
            : null;
      if (quantity === null) {
        skip(summary, 'unsupported_chain');
        continue;
      }
      await w.write(summary, holding, asOf, quantity, 'wallet');
    } catch (error) {
      skip(
        summary,
        error instanceof FeedError ? `wallet_${error.code}` : 'wallet_failed',
      );
    }
  }
  return summary;
}

export interface FeedCredentials {
  ibkr?: { token: string; queryId: string };
  binance?: { key: string; secret: string };
}
export type FeedOutcome =
  | {
      feed: 'bank' | 'ibkr' | 'binance' | 'wallet';
      status: 'ok';
      summary: FillSummary;
    }
  | { feed: 'ibkr' | 'binance'; status: 'not_configured' }
  | { feed: 'ibkr' | 'binance' | 'wallet'; status: 'failed'; code: string };

/** One day's snapshot from every source there is, each feed failing on its own. */
export async function runFeeds(
  db: Database,
  asOf: string,
  credentials: FeedCredentials,
  fetcher: Fetcher,
  options: { ethRpcUrl?: string; now?: Date } = {},
): Promise<FeedOutcome[]> {
  const outcomes: FeedOutcome[] = [];
  outcomes.push({
    feed: 'bank',
    status: 'ok',
    summary: await fillFromBalances(db, asOf, options.now),
  });
  if (!credentials.ibkr)
    outcomes.push({ feed: 'ibkr', status: 'not_configured' });
  else
    try {
      const statement = await fetchFlexStatement(
        credentials.ibkr.token,
        credentials.ibkr.queryId,
        fetcher,
      );
      outcomes.push({
        feed: 'ibkr',
        status: 'ok',
        summary: await applyFlexStatement(db, asOf, statement),
      });
    } catch (error) {
      outcomes.push({ feed: 'ibkr', status: 'failed', code: codeOf(error) });
    }
  if (!credentials.binance)
    outcomes.push({ feed: 'binance', status: 'not_configured' });
  else
    try {
      const exchange = await fetchBinanceSpot(
        credentials.binance.key,
        credentials.binance.secret,
        fetcher,
      );
      outcomes.push({
        feed: 'binance',
        status: 'ok',
        summary: await applyExchangeHoldings(db, asOf, exchange),
      });
    } catch (error) {
      outcomes.push({ feed: 'binance', status: 'failed', code: codeOf(error) });
    }
  try {
    outcomes.push({
      feed: 'wallet',
      status: 'ok',
      summary: await fillWallets(db, asOf, fetcher, {
        ethRpcUrl: options.ethRpcUrl,
      }),
    });
  } catch (error) {
    outcomes.push({ feed: 'wallet', status: 'failed', code: codeOf(error) });
  }
  await recordFeedOutcomes(db, outcomes, options.now);
  return outcomes;
}

/**
 * Keeps the last outcome of each feed where a screen can read it.
 *
 * The run printed these and nothing else kept them, so a feed that had been
 * refused for a month looked exactly like one nobody had configured. The bank
 * feed is left out: it reads balances this application already holds and cannot
 * fail on its own, and recording it would invite the reader to treat a missing
 * bank balance as a feed problem when it is an import problem.
 *
 * Recording must never cost a snapshot that otherwise worked, so a failure to
 * write is swallowed here — the outcomes are returned to the caller and logged
 * either way.
 */
async function recordFeedOutcomes(
  db: Database,
  outcomes: FeedOutcome[],
  now?: Date,
): Promise<void> {
  const at = (now ?? new Date()).toISOString();
  for (const outcome of outcomes) {
    if (outcome.feed === 'bank') continue;
    try {
      await db.query(
        `INSERT INTO holding_feed_runs(feed,status,code,ran_at) VALUES($1,$2,$3,$4)
         ON CONFLICT(feed) DO UPDATE SET status=excluded.status,code=excluded.code,ran_at=excluded.ran_at`,
        [
          outcome.feed,
          outcome.status,
          outcome.status === 'failed' ? outcome.code : null,
          at,
        ],
      );
    } catch {
      // A snapshot that ran is worth more than the note saying it ran.
    }
  }
}
/** A feed's own code, or the application's own error name; never a provider payload. */
const codeOf = (error: unknown) =>
  error instanceof FeedError
    ? `${error.code}${error.detail ? `:${error.detail}` : ''}`
    : error instanceof Error && /^[a-z_]{1,60}$/.test(error.message)
      ? `failed:${error.message}`
      : 'failed';

/** True when the day is the last Thursday of its month. */
export function isLastThursday(day: string): boolean {
  const date = new Date(`${day}T12:00:00Z`);
  if (date.getUTCDay() !== 4) return false;
  const nextWeek = new Date(date);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  return nextWeek.getUTCMonth() !== date.getUTCMonth();
}

/** Today's calendar date where the household lives. */
export function rigaDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function secretFile(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The broker and exchange credentials that exist as files in the credentials
 *  directory; a feed whose files are absent is simply not configured. */
export async function loadFeedCredentials(
  directory: string | undefined,
): Promise<FeedCredentials> {
  if (!directory) return {};
  const [token, queryId, key, secretKey] = await Promise.all([
    secretFile(resolve(directory, 'ibkr-flex-token')),
    secretFile(resolve(directory, 'ibkr-flex-query')),
    secretFile(resolve(directory, 'binance-api-key')),
    secretFile(resolve(directory, 'binance-api-secret')),
  ]);
  return {
    ...(token && queryId ? { ibkr: { token, queryId } } : {}),
    ...(key && secretKey ? { binance: { key, secret: secretKey } } : {}),
  };
}
