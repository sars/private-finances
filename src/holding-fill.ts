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
import { toDecimal } from './holding-valuation.js';

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
      const cash = statement.cash.find(
        (c) => c.currency === holding.denomination,
      );
      if (!cash) {
        skip(summary, 'no_cash_row');
        continue;
      }
      await w.write(summary, holding, asOf, cash.endingCash, 'ibkr');
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

/** The exchange's dollar total, or one asset's quantity, onto the holdings that ask for it. */
export async function applyExchangeHoldings(
  db: Database,
  asOf: string,
  exchange: ExchangeHoldings,
): Promise<FillSummary> {
  const service = new Holdings(db);
  const summary = empty();
  const w = await writer(service);
  const fed = (await service.list(false)).filter((h) => h.feed === 'binance');
  for (const asset of exchange.assets) {
    if (asset.usdPerUnit && !['USD'].includes(asset.asset)) {
      await service.recordPrice(null, {
        symbol: asset.asset,
        asOf,
        usdPerUnit: asset.usdPerUnit,
        source: 'binance',
      });
      summary.pricesRecorded += 1;
    }
  }
  for (const holding of fed) {
    const reference = (holding.feedRef ?? 'TOTAL').toUpperCase();
    if (reference === 'TOTAL') {
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
    const asset = exchange.assets.find((a) => a.asset === reference);
    await w.write(summary, holding, asOf, asset?.quantity ?? '0', 'binance');
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
  return outcomes;
}
const codeOf = (error: unknown) =>
  error instanceof FeedError
    ? `${error.code}${error.detail ? `:${error.detail}` : ''}`
    : 'failed';

/** Today's calendar date where the household lives. */
export function rigaDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
