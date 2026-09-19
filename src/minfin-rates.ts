import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from './database.js';
import { FxRates, type DailyFxRateInput } from './fx-rates.js';
import { MINFIN_SOURCE } from './fx-sources.js';

/**
 * Minfin's average commercial bank rate, read for one calendar day.
 *
 * PrivatBank's archive is empty on days it publishes nothing — weekends and
 * holidays — and a day with no rate leaves every foreign payment booked that
 * day unconverted. Minfin publishes, for every date back to 2006, the average
 * of the commercial cash rates it collects from Ukrainian banks, including the
 * four the household actually uses. It is a real commercial number, not the
 * National Bank's administrative reference, and unlike a single bank's quote it
 * does not disappear when that one bank takes the day off.
 *
 * There is no free API: `api.minfin.com.ua` needs a paid key, and the per-bank
 * historical breakdown is behind it. The public rates page is free and is what
 * this reads, so this is a scrape of a rendered page and is treated as one —
 * every assumption is asserted and a surprise is reported as unavailable rather
 * than guessed at. It is therefore a gap filler, asked only for days the
 * primary source left empty, never a nightly primary.
 */
export const MINFIN_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export type ParsedMinfinRate = Omit<DailyFxRateInput, 'version'>;
export class MinfinRateError extends Error {
  constructor(
    readonly code: 'invalid_date' | 'invalid_response' | 'http' | 'network',
  ) {
    super(`minfin_rates_${code}`);
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
/** The published archive starts in 2006; earlier dates are not a gap to fill. */
export const MINFIN_ARCHIVE_START = '2006-01-04';
export function validateMinfinDate(date: string, now = new Date()): void {
  if (!Number.isFinite(now.getTime())) throw new MinfinRateError('invalid_date');
  if (
    !validDate(date) ||
    date < MINFIN_ARCHIVE_START ||
    date > now.toISOString().slice(0, 10)
  )
    throw new MinfinRateError('invalid_date');
}
export function minfinRateUrl(currency: string, date: string): string {
  if (
    !validDate(date) ||
    !(MINFIN_CURRENCIES as readonly string[]).includes(currency)
  )
    throw new MinfinRateError('invalid_date');
  return `https://minfin.com.ua/ua/currency/banks/${currency.toLowerCase()}/${date}/`;
}
/** Minfin writes `48,5462`, sometimes with a space or NBSP grouping thousands. */
function decimalText(raw: string): string {
  const value = raw.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(value))
    throw new MinfinRateError('invalid_response');
  return value;
}
function midpoint(buy: string, sell: string): string {
  const [buyWhole, buyFraction = ''] = buy.split('.'),
    [sellWhole, sellFraction = ''] = sell.split('.');
  const places = Math.max(buyFraction.length, sellFraction.length);
  const low = BigInt(buyWhole! + buyFraction.padEnd(places, '0')),
    high = BigInt(sellWhole! + sellFraction.padEnd(places, '0'));
  if (low <= 0n || high <= 0n || low > high)
    throw new MinfinRateError('invalid_response');
  const digits = ((low + high) * 5n).toString().padStart(places + 2, '0');
  return `${digits.slice(0, -places - 1)}.${digits.slice(-places - 1)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}
/**
 * Read one currency's average bank rate out of the rendered page.
 *
 * Two assertions carry the whole parse. The date picker's `value` proves the
 * page really answers the date that was asked for — Minfin serves today's rates
 * for a URL it does not recognise, and storing those against a date in October
 * would be a fabricated rate wearing a real one's clothes. The currency link in
 * the average row proves the table is the one this URL promised.
 *
 * Only the two commercial cells carry `type="average"`; the National Bank's
 * column does not, so the rate the owner rejected is never even read. Anything
 * other than exactly buy and sell means the layout moved, and the safe answer
 * to that is that the day is unavailable, not a guess at which number is which.
 */
export function parseMinfinRate(
  html: string,
  currency: string,
  date: string,
  retrievedAt: string,
): ParsedMinfinRate {
  validateMinfinDate(date, new Date(retrievedAt));
  if (!(MINFIN_CURRENCIES as readonly string[]).includes(currency))
    throw new MinfinRateError('invalid_date');
  if (
    typeof html !== 'string' ||
    Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES
  )
    throw new MinfinRateError('invalid_response');
  const picker =
    /<input[^>]*name="currency-datepicker"[^>]*value="(\d{4}-\d{2}-\d{2})"/.exec(
      html,
    ) ??
    /<input[^>]*value="(\d{4}-\d{2}-\d{2})"[^>]*name="currency-datepicker"/.exec(
      html,
    );
  if (!picker || picker[1] !== date) throw new MinfinRateError('invalid_response');
  const heading = html.indexOf('Середній курс в банках');
  if (heading === -1) throw new MinfinRateError('invalid_response');
  const end = html.indexOf('</table>', heading);
  if (end === -1 || end - heading > 20000)
    throw new MinfinRateError('invalid_response');
  const table = html.slice(heading, end);
  const link = new RegExp(
    `<a[^>]*href="/ua/currency/banks/${currency.toLowerCase()}/${date}/"[^>]*>${currency}</a>`,
  );
  if (!link.test(table)) throw new MinfinRateError('invalid_response');
  const cells = [
    ...table.matchAll(/<div[^>]*type="average"[^>]*>([^<]+)</g),
  ].map((match) => decimalText(match[1]!));
  if (cells.length !== 2) throw new MinfinRateError('invalid_response');
  const [buy, sell] = cells as [string, string];
  return {
    source: MINFIN_SOURCE,
    base: currency,
    target: 'UAH',
    rate: midpoint(buy, sell),
    asOf: date,
    retrievedAt,
    provenance: `${minfinRateUrl(currency, date)}; midpoint of the Minfin average commercial bank rate across Ukrainian banks, buy=${buy} and sell=${sell}; cash-market estimate, not an executed bank exchange, and not the National Bank reference.`,
  };
}
async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new MinfinRateError('invalid_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new MinfinRateError('invalid_response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchOne(
  currency: string,
  date: string,
  options: {
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<unknown>;
    now?: () => Date;
  },
): Promise<ParsedMinfinRate> {
  const now = options.now ?? (() => new Date());
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(minfinRateUrl(currency, date), {
        redirect: 'error',
        headers: { Accept: 'text/html' },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      if (attempt === 3) throw new MinfinRateError('network');
      await (options.sleep ?? sleep)(2000 * attempt);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ((response.status !== 429 && response.status < 500) || attempt === 3)
        throw new MinfinRateError('http');
      let delay = 2000 * attempt;
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const requested = /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - now().getTime();
        if (!Number.isFinite(requested) || requested > 60000)
          throw new MinfinRateError('http');
        delay = Math.max(delay, requested);
      }
      await (options.sleep ?? sleep)(delay);
      continue;
    }
    return parseMinfinRate(
      await boundedBody(response),
      currency,
      date,
      now().toISOString(),
    );
  }
  throw new MinfinRateError('http');
}
/**
 * All three pairs for a day, or none of them.
 *
 * A partial day would let one currency convert while another silently fell
 * through to a different source for the same date, so a currency that cannot be
 * read makes the whole day unavailable.
 */
export async function fetchMinfinRates(
  date: string,
  options: {
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<unknown>;
    now?: () => Date;
  } = {},
): Promise<ParsedMinfinRate[]> {
  validateMinfinDate(date, (options.now ?? (() => new Date()))());
  const rates: ParsedMinfinRate[] = [];
  for (const currency of MINFIN_CURRENCIES) {
    if (rates.length) await (options.sleep ?? sleep)(2000);
    rates.push(await fetchOne(currency, date, options));
  }
  return rates.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
}
/** Commit a complete day atomically, exactly as the primary source does. */
export async function storeMinfinRates(
  db: Database,
  date: string,
  rates: ParsedMinfinRate[],
  refresh = false,
): Promise<{ stored: number; skipped: boolean }> {
  if (
    !validDate(date) ||
    rates.some((rate) => rate.asOf !== date || rate.source !== MINFIN_SOURCE)
  )
    throw new MinfinRateError('invalid_response');
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7482421)');
    const existing = (
      await tx.query(
        'SELECT base,target,version FROM daily_fx_rates WHERE source=$1 AND as_of=$2',
        [MINFIN_SOURCE, date],
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
