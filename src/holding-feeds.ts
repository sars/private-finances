/**
 * Reading what a broker, an exchange and two public ledgers say the household
 * holds (PF-020, step four). Each feed is a small read-only client with the
 * same discipline as the bank connectors: a fixed host, a timeout, a size
 * limit, no redirects, an injected fetcher so tests never touch the network,
 * and errors reduced to a code. Nothing here writes to the database; the
 * results are handed to `holding-fill`, which decides which holding they
 * belong to.
 *
 * Quantities and prices leave this module as decimal strings, never floats.
 */
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseDecimal, toDecimal, type Rational } from './holding-valuation.js';

export type FeedErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'transient'
  | 'schema'
  | 'incomplete'
  | 'configuration';
export class FeedError extends Error {
  constructor(
    readonly code: FeedErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export type Fetcher = (
  url: URL,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const MAX_BYTES = 4 * 1024 * 1024;

/** A GET or POST against a known origin, returning the body as text. */
export async function fetchText(
  fetcher: Fetcher,
  url: URL,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
  timeoutMs = 20000,
): Promise<string> {
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await fetcher(url, {
      ...init,
      // Node's fetch honours these; a test fetcher ignores them.
      ...({
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      } as object),
    });
  } catch {
    throw new FeedError('transient');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new FeedError('auth');
    if (response.status === 418 || response.status === 429)
      throw new FeedError('rate_limit');
    if (response.status >= 500) throw new FeedError('transient');
    throw new FeedError('schema', `http_${response.status}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new FeedError('incomplete');
  return text;
}

/** A decimal string from a provider figure, or null when it is not a plain number. */
function decimal(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value))
    value = String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  return parseDecimal(text) ? text : null;
}

// ---------------------------------------------------------------------------
// Interactive Brokers Flex Web Service
// ---------------------------------------------------------------------------

export const IBKR_REQUEST_ORIGIN = 'https://ndcdyn.interactivebrokers.com';
export const IBKR_STATEMENT_ORIGIN = 'https://gdcdyn.interactivebrokers.com';
const IBKR_REQUEST_PATH = '/AccountManagement/FlexWebService/SendRequest';
const IBKR_STATEMENT_PATH = '/AccountManagement/FlexWebService/GetStatement';

export interface FlexPosition {
  symbol: string;
  quantity: string;
  markPrice: string | null;
  currency: string | null;
  assetCategory: string | null;
}
export interface FlexCash {
  currency: string;
  endingCash: string;
}
export interface FlexStatement {
  positions: FlexPosition[];
  cash: FlexCash[];
  /** The statement's own dates, when it states them. */
  fromDate: string | null;
  toDate: string | null;
}

/** Attributes of every element with the given name; the Flex XML is flat
 *  elements with attributes and nothing else worth a parser dependency. */
function elements(xml: string, name: string): Array<Record<string, string>> {
  const found: Array<Record<string, string>> = [];
  const pattern = new RegExp(`<${name}\\b([^>]*?)/?>`, 'g');
  for (const match of xml.matchAll(pattern)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[1]!.matchAll(/([A-Za-z_][\w.-]*)="([^"]*)"/g))
      attributes[attribute[1]!] = attribute[2]!
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    found.push(attributes);
  }
  return found;
}
function textOf(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return match ? match[1]!.trim() : null;
}
const flexDate = (value: string | undefined) =>
  value && /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
    : value && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : null;

/** The positions and cash of an Activity Flex statement, summary rows only. */
export function parseFlexStatement(xml: string): FlexStatement {
  if (!xml.includes('<FlexQueryResponse')) throw new FeedError('schema');
  const statement = elements(xml, 'FlexStatement')[0] ?? {};
  const summaryOnly = (row: Record<string, string>) =>
    !row.levelOfDetail || row.levelOfDetail.toUpperCase() === 'SUMMARY';
  const positions: FlexPosition[] = [];
  for (const row of elements(xml, 'OpenPosition')) {
    if (!summaryOnly(row)) continue;
    const symbol = (row.symbol ?? '').trim().toUpperCase();
    const quantity = decimal(row.position);
    if (!symbol || quantity === null) continue;
    positions.push({
      symbol,
      quantity,
      markPrice: decimal(row.markPrice),
      currency: row.currency ? row.currency.trim().toUpperCase() : null,
      assetCategory: row.assetCategory ?? null,
    });
  }
  const cash: FlexCash[] = [];
  for (const row of elements(xml, 'CashReportCurrency')) {
    if (!summaryOnly(row)) continue;
    const currency = (row.currency ?? '').trim().toUpperCase();
    const endingCash = decimal(row.endingCash);
    // The report's "BASE_SUMMARY" row totals every currency in the base one
    // and would double the cash; only real currencies are wanted.
    if (!/^[A-Z]{3}$/.test(currency) || endingCash === null) continue;
    cash.push({ currency, endingCash });
  }
  return {
    positions,
    cash,
    fromDate: flexDate(statement.fromDate),
    toDate: flexDate(statement.toDate),
  };
}

/**
 * Ask for the statement, then collect it. IBKR generates a statement on
 * request and answers 1019 (in progress) or 1009 (busy) until it is ready,
 * and 1018 when a token is asked too often, so the second step waits and
 * retries a bounded number of times. The token travels in the query string,
 * which is how the service is designed; the URL is never logged.
 */
export async function fetchFlexStatement(
  token: string,
  queryId: string,
  fetcher: Fetcher,
  options: { attempts?: number; waitMs?: number } = {},
): Promise<FlexStatement> {
  if (!/^\d{6,64}$/.test(token) || !/^\d{1,16}$/.test(queryId))
    throw new FeedError('configuration');
  const attempts = options.attempts ?? 8;
  const waitMs = options.waitMs ?? 5000;
  const headers = { 'user-agent': 'Java', accept: 'text/xml' };
  const request = new URL(IBKR_REQUEST_PATH, IBKR_REQUEST_ORIGIN);
  request.searchParams.set('t', token);
  request.searchParams.set('q', queryId);
  request.searchParams.set('v', '3');
  const first = await fetchText(fetcher, request, { headers });
  if (textOf(first, 'Status') !== 'Success') {
    const code = textOf(first, 'ErrorCode') ?? 'unknown';
    throw new FeedError(
      code === '1012' || code === '1013' || code === '1015' ? 'auth' : 'schema',
      `flex_${code}`,
    );
  }
  const reference = textOf(first, 'ReferenceCode');
  if (!reference || !/^\d{1,32}$/.test(reference))
    throw new FeedError('schema');
  const statement = new URL(IBKR_STATEMENT_PATH, IBKR_STATEMENT_ORIGIN);
  statement.searchParams.set('q', reference);
  statement.searchParams.set('t', token);
  statement.searchParams.set('v', '3');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const body = await fetchText(fetcher, statement, { headers });
    if (body.includes('<FlexQueryResponse')) return parseFlexStatement(body);
    const code = textOf(body, 'ErrorCode');
    if (code === '1019' || code === '1009' || code === '1018') {
      await sleep(code === '1018' ? waitMs * 2 : waitMs);
      continue;
    }
    throw new FeedError('schema', `flex_${code ?? 'unknown'}`);
  }
  throw new FeedError('transient', 'flex_not_ready');
}

// ---------------------------------------------------------------------------
// Binance Spot, read only
// ---------------------------------------------------------------------------

export const BINANCE_ORIGIN = 'https://api.binance.com';
/** Coins pegged to the dollar that need no market price. */
const DOLLAR_STABLE = new Set([
  'USDT',
  'USDC',
  'FDUSD',
  'BUSD',
  'TUSD',
  'DAI',
  'USDP',
]);

export interface ExchangeAsset {
  asset: string;
  quantity: string;
  /** USD for one unit, from the exchange's own market, or null when it has none. */
  usdPerUnit: string | null;
}
export interface ExchangeHoldings {
  assets: ExchangeAsset[];
  /** Everything that could be priced, in USD; null when nothing could. */
  totalUsd: string | null;
  /** Assets that hold a quantity but have no dollar market on the exchange. */
  unpriced: string[];
}

export function signBinanceQuery(
  params: URLSearchParams,
  secret: string,
): string {
  return createHmac('sha256', secret).update(params.toString()).digest('hex');
}

/** Every market's last price, USD-equivalent per asset where a dollar market exists. */
export function usdPrices(
  tickers: Array<{ symbol: string; price: string }>,
): Map<string, string> {
  const last = new Map<string, string>();
  for (const ticker of tickers) {
    const price = decimal(ticker.price);
    if (typeof ticker.symbol === 'string' && price !== null)
      last.set(ticker.symbol, price);
  }
  const prices = new Map<string, string>();
  for (const stable of DOLLAR_STABLE) prices.set(stable, '1');
  const btcUsd = last.get('BTCUSDT') ?? last.get('BTCUSDC');
  for (const [symbol, price] of last) {
    for (const quote of ['USDT', 'USDC', 'FDUSD']) {
      if (symbol.endsWith(quote) && symbol.length > quote.length) {
        const asset = symbol.slice(0, -quote.length);
        if (!prices.has(asset)) prices.set(asset, price);
      }
    }
  }
  if (btcUsd) {
    const btc = parseDecimal(btcUsd)!;
    for (const [symbol, price] of last) {
      if (!symbol.endsWith('BTC') || symbol.length <= 3) continue;
      const asset = symbol.slice(0, -3);
      if (prices.has(asset)) continue;
      const inBtc = parseDecimal(price);
      if (inBtc) prices.set(asset, toDecimal(mul(inBtc, btc), 12));
    }
  }
  return prices;
}
const mul = (a: Rational, b: Rational): Rational => ({
  n: a.n * b.n,
  d: a.d * b.d,
});
const add = (a: Rational, b: Rational): Rational => ({
  n: a.n * b.d + b.n * a.d,
  d: a.d * b.d,
});

export function valueExchangeAssets(
  balances: Array<{ asset: string; free: string; locked: string }>,
  prices: Map<string, string>,
): ExchangeHoldings {
  const assets: ExchangeAsset[] = [];
  const unpriced: string[] = [];
  let total: Rational = { n: 0n, d: 1n };
  let priced = false;
  for (const balance of balances) {
    const free = parseDecimal(decimal(balance.free) ?? '');
    const locked = parseDecimal(decimal(balance.locked) ?? '');
    if (!free || !locked || typeof balance.asset !== 'string') continue;
    const quantity = add(free, locked);
    if (quantity.n === 0n) continue;
    const asset = balance.asset.trim().toUpperCase();
    // Binance lists a locked-staking twin of a coin as LDxxx; it is the same coin.
    const priceKey =
      asset.startsWith('LD') &&
      asset.length > 2 &&
      prices.has(asset.slice(2)) &&
      !prices.has(asset)
        ? asset.slice(2)
        : asset;
    const price = prices.get(priceKey) ?? null;
    assets.push({
      asset,
      quantity: toDecimal(quantity, 8),
      usdPerUnit: price,
    });
    if (price) {
      total = add(total, mul(quantity, parseDecimal(price)!));
      priced = true;
    } else unpriced.push(asset);
  }
  assets.sort((a, b) => a.asset.localeCompare(b.asset));
  return {
    assets,
    totalUsd: priced ? toDecimal(total, 2) : null,
    unpriced,
  };
}

export async function fetchBinanceSpot(
  key: string,
  secret: string,
  fetcher: Fetcher,
  now: () => number = Date.now,
): Promise<ExchangeHoldings> {
  if (
    !/^[A-Za-z0-9]{32,128}$/.test(key) ||
    !/^[A-Za-z0-9]{32,128}$/.test(secret)
  )
    throw new FeedError('configuration');
  const params = new URLSearchParams({
    omitZeroBalances: 'true',
    recvWindow: '10000',
    timestamp: String(now()),
  });
  params.set('signature', signBinanceQuery(params, secret));
  const account = new URL('/api/v3/account', BINANCE_ORIGIN);
  account.search = params.toString();
  const accountBody = JSON.parse(
    await fetchText(fetcher, account, {
      headers: { 'X-MBX-APIKEY': key, accept: 'application/json' },
    }),
  ) as { balances?: unknown };
  if (!Array.isArray(accountBody.balances)) throw new FeedError('schema');
  const tickerBody = JSON.parse(
    await fetchText(fetcher, new URL('/api/v3/ticker/price', BINANCE_ORIGIN), {
      headers: { accept: 'application/json' },
    }),
  ) as unknown;
  if (!Array.isArray(tickerBody)) throw new FeedError('schema');
  return valueExchangeAssets(
    accountBody.balances as Array<{
      asset: string;
      free: string;
      locked: string;
    }>,
    usdPrices(tickerBody as Array<{ symbol: string; price: string }>),
  );
}

/** Public last prices for a few coins, from the exchange's open ticker. */
export async function fetchBinancePublicPrices(
  symbols: readonly string[],
  fetcher: Fetcher,
): Promise<Map<string, string>> {
  const body = JSON.parse(
    await fetchText(fetcher, new URL('/api/v3/ticker/price', BINANCE_ORIGIN), {
      headers: { accept: 'application/json' },
    }),
  ) as unknown;
  if (!Array.isArray(body)) throw new FeedError('schema');
  const all = usdPrices(body as Array<{ symbol: string; price: string }>);
  const wanted = new Map<string, string>();
  for (const symbol of symbols) {
    const price = all.get(symbol.toUpperCase());
    if (price) wanted.set(symbol.toUpperCase(), price);
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// Public ledgers: a bitcoin address and an ethereum address
// ---------------------------------------------------------------------------

export const BTC_API_ORIGIN = 'https://mempool.space';
export const ETH_RPC_DEFAULT = 'https://eth.public-rpc.com';

export function isBitcoinAddress(value: string): boolean {
  return /^(bc1[a-z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(value);
}
export function isEthereumAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Confirmed plus unconfirmed balance of an address, in BTC as a decimal string. */
export async function fetchBitcoinBalance(
  address: string,
  fetcher: Fetcher,
  origin = BTC_API_ORIGIN,
): Promise<string> {
  if (!isBitcoinAddress(address)) throw new FeedError('configuration');
  const body = JSON.parse(
    await fetchText(fetcher, new URL(`/api/address/${address}`, origin), {
      headers: { accept: 'application/json' },
    }),
  ) as {
    chain_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown };
    mempool_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown };
  };
  return bitcoinFromStats(body);
}
export function bitcoinFromStats(body: {
  chain_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown };
  mempool_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown };
}): string {
  const sats = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new FeedError('schema');
    return BigInt(value);
  };
  const chain = body.chain_stats ?? {};
  const pending = body.mempool_stats ?? {};
  const total =
    sats(chain.funded_txo_sum ?? 0) -
    sats(chain.spent_txo_sum ?? 0) +
    sats(pending.funded_txo_sum ?? 0) -
    sats(pending.spent_txo_sum ?? 0);
  return toDecimal({ n: total, d: 100000000n }, 8);
}

/** Balance of an address in ETH as a decimal string, through JSON-RPC eth_getBalance. */
export async function fetchEthereumBalance(
  address: string,
  fetcher: Fetcher,
  rpcUrl = ETH_RPC_DEFAULT,
): Promise<string> {
  if (!isEthereumAddress(address)) throw new FeedError('configuration');
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:') throw new FeedError('configuration');
  const body = JSON.parse(
    await fetchText(fetcher, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      }),
    }),
  ) as { result?: unknown; error?: unknown };
  return etherFromHexWei(body.result);
}
export function etherFromHexWei(result: unknown): string {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(result))
    throw new FeedError('schema');
  return toDecimal({ n: BigInt(result), d: 10n ** 18n }, 8);
}
