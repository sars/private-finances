import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from './database.js';
import { FxRates, type DailyFxRateInput } from './fx-rates.js';

export const PRIVATBANK_SOURCE = 'PrivatBank commercial midpoint';
const MAX_RESPONSE_BYTES = 128 * 1024;
const currencies = new Set(['USD', 'EUR', 'GBP', 'JPY', 'KWD']);
export type ParsedPrivatBankRate = Omit<DailyFxRateInput, 'version'>;
export class PrivatBankRateError extends Error {
  constructor(
    readonly code: 'invalid_date' | 'invalid_response' | 'http' | 'network',
  ) {
    super(`privatbank_rates_${code}`);
  }
}
function validDate(date: string): boolean {
  return (
    typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}
export function privatBankArchiveBounds(now = new Date()): {
  from: string;
  to: string;
} {
  if (!Number.isFinite(now.getTime()))
    throw new PrivatBankRateError('invalid_date');
  return {
    from: new Date(
      Date.UTC(now.getUTCFullYear() - 4, now.getUTCMonth(), now.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}
export function validatePrivatBankDate(date: string, now = new Date()): void {
  const { from, to } = privatBankArchiveBounds(now);
  if (!validDate(date) || date < from || date > to)
    throw new PrivatBankRateError('invalid_date');
}
export function privatBankRateUrl(date: string): string {
  if (!validDate(date)) throw new PrivatBankRateError('invalid_date');
  const [year, month, day] = date.split('-');
  return `https://api.privatbank.ua/p24api/exchange_rates?json&date=${day}.${month}.${year}`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PrivatBankRateError('invalid_response');
  return value as Record<string, unknown>;
}
function midpoint(purchase: unknown, sale: unknown): string {
  if (
    typeof purchase !== 'string' ||
    typeof sale !== 'string' ||
    !/^\d{1,29}(?:\.\d{1,29})?$/.test(purchase) ||
    !/^\d{1,29}(?:\.\d{1,29})?$/.test(sale)
  )
    throw new PrivatBankRateError('invalid_response');
  const [buyWhole, buyFraction = ''] = purchase.split('.'),
    [sellWhole, sellFraction = ''] = sale.split('.');
  const places = Math.max(buyFraction.length, sellFraction.length);
  const buy = BigInt(buyWhole! + buyFraction.padEnd(places, '0')),
    sell = BigInt(sellWhole! + sellFraction.padEnd(places, '0'));
  if (buy <= 0n || sell <= 0n || buy > sell)
    throw new PrivatBankRateError('invalid_response');
  const digits = ((buy + sell) * 5n).toString().padStart(places + 2, '0');
  return `${digits.slice(0, -places - 1)}.${digits.slice(-places - 1)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}
/** Preserve numeric JSON lexemes before parsing; monetary decimals never pass through Number. */
export function parsePrivatBankRates(
  raw: string,
  date: string,
  retrievedAt: string,
): ParsedPrivatBankRate[] {
  validatePrivatBankDate(date, new Date(retrievedAt));
  try {
    if (
      typeof raw !== 'string' ||
      Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES
    )
      throw new PrivatBankRateError('invalid_response');
    // Match quoted strings as whole tokens, so digits inside strings/escaped keys remain untouched.
    const exact = raw.replace(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (token) => (token.startsWith('"') ? token : JSON.stringify(token)),
    );
    const body = object(JSON.parse(exact));
    const [year, month, day] = date.split('-');
    if (
      body.date !== `${day}.${month}.${year}` ||
      body.bank !== 'PB' ||
      body.baseCurrency !== '980' ||
      body.baseCurrencyLit !== 'UAH' ||
      !Array.isArray(body.exchangeRate) ||
      body.exchangeRate.length > 200
    )
      throw new PrivatBankRateError('invalid_response');
    const rates: ParsedPrivatBankRate[] = [];
    const seen = new Set<string>();
    for (const rawRate of body.exchangeRate) {
      const rate = object(rawRate);
      if (rate.baseCurrency !== 'UAH')
        throw new PrivatBankRateError('invalid_response');
      if (typeof rate.currency !== 'string' || !currencies.has(rate.currency))
        continue;
      if (seen.has(rate.currency))
        throw new PrivatBankRateError('invalid_response');
      seen.add(rate.currency);
      // NBU-only records are deliberately unavailable; never read either NB field.
      if (
        !Object.hasOwn(rate, 'saleRate') &&
        !Object.hasOwn(rate, 'purchaseRate')
      )
        continue;
      const value = midpoint(rate.purchaseRate, rate.saleRate);
      rates.push({
        source: PRIVATBANK_SOURCE,
        base: rate.currency,
        target: 'UAH',
        rate: value,
        asOf: date,
        retrievedAt,
        provenance: `${privatBankRateUrl(date)}; midpoint of PrivatBank commercial purchaseRate=${rate.purchaseRate} and saleRate=${rate.saleRate}; cash-market estimate, not an executed bank exchange.`,
      });
    }
    return rates.sort((a, b) =>
      a.base < b.base ? -1 : a.base > b.base ? 1 : 0,
    );
  } catch (error) {
    if (error instanceof PrivatBankRateError) throw error;
    throw new PrivatBankRateError('invalid_response');
  }
}
async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new PrivatBankRateError('invalid_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new PrivatBankRateError('invalid_response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function fetchPrivatBankRates(
  date: string,
  options: {
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<unknown>;
    now?: () => Date;
  } = {},
): Promise<ParsedPrivatBankRate[]> {
  const now = options.now ?? (() => new Date());
  validatePrivatBankDate(date, now());
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(privatBankRateUrl(date), {
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      if (attempt === 3) throw new PrivatBankRateError('network');
      await (options.sleep ?? sleep)(2000 * attempt);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ((response.status !== 429 && response.status < 500) || attempt === 3)
        throw new PrivatBankRateError('http');
      let delay = 2000 * attempt;
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const requested = /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - now().getTime();
        if (!Number.isFinite(requested) || requested > 60000)
          throw new PrivatBankRateError('http');
        delay = Math.max(delay, requested);
      }
      await (options.sleep ?? sleep)(delay);
      continue;
    }
    return parsePrivatBankRates(
      await boundedBody(response),
      date,
      now().toISOString(),
    );
  }
  throw new PrivatBankRateError('http');
}
/** Commit a complete provider day atomically; refresh appends versions under a shared writer lock. */
export async function storePrivatBankRates(
  db: Database,
  date: string,
  rates: ParsedPrivatBankRate[],
  refresh = false,
): Promise<{ stored: number; skipped: boolean }> {
  if (
    !validDate(date) ||
    rates.some(
      (rate) => rate.asOf !== date || rate.source !== PRIVATBANK_SOURCE,
    )
  )
    throw new PrivatBankRateError('invalid_response');
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7482420)');
    const existing = (
      await tx.query(
        'SELECT base,target,version FROM daily_fx_rates WHERE source=$1 AND as_of=$2',
        [PRIVATBANK_SOURCE, date],
      )
    ).rows;
    if (existing.length && !refresh) return { stored: 0, skipped: true };
    const scoped: Database = {
      query: (sql, params) => tx.query(sql, params),
      transaction: async (action) => action(tx),
      close: async () => {},
    };
    const store = new FxRates(scoped);
    for (const rate of rates) {
      const version =
        1 +
        Math.max(
          0,
          ...existing
            .filter(
              (row) => row.base === rate.base && row.target === rate.target,
            )
            .map((row) => Number(row.version)),
        );
      await store.insert({ ...rate, version });
    }
    return { stored: rates.length, skipped: false };
  });
}
