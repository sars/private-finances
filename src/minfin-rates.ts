import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from './database.js';
import { FxRates, type DailyFxRateInput } from './fx-rates.js';
import { MINFIN_SOURCE } from './fx-sources.js';

/**
 * The card rates the household's own banks published on one calendar day.
 *
 * PrivatBank's archive is empty on the days it does not trade — 26 October 2025
 * was a Sunday, and eleven months of nightly retries had already failed against
 * it — and a day with no rate leaves every foreign payment booked that day
 * unconverted. Minfin collects what Ukrainian banks quote and serves it per
 * date, so the day can be answered by the same banks the household actually
 * uses rather than by a central bank's reference number.
 *
 * Only these four count, on the owner's instruction, and only their **card**
 * rates: the spending being converted is card purchases, so the card rate is
 * what the bank actually charged. A bank that published nothing usable that day
 * is left out rather than guessed at, and the provenance names every bank that
 * did contribute, so a day carried by one bank is visible as exactly that.
 *
 * This reads Minfin's own JSON, not its rendered page. An earlier version
 * scraped the HTML because the documented API needs a paid key; the endpoint
 * the site itself calls is free and unauthenticated, returns the per-bank
 * breakdown the scrape could not reach, and cannot be broken by a redesign.
 */
export const MINFIN_BANKS: readonly string[] = [
  'monobank',
  'privatbank',
  'sensebank',
  'a-bank',
];
/**
 * Pairs worth asking about. GBP is deliberately absent: not one of the four
 * banks quotes it, in cash or on a card, so there is nothing of theirs to
 * average and a GBP day the primary source leaves empty stays missing.
 */
export const MINFIN_CURRENCIES = ['USD', 'EUR'] as const;
/** Decimal places the averaged rate keeps. The mean of three banks rarely
 * terminates, and six places on a rate near fifty is far finer than any amount
 * is ever rounded to. */
const AVERAGE_PLACES = 6;
const MAX_RESPONSE_BYTES = 512 * 1024;
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
  if (!Number.isFinite(now.getTime()))
    throw new MinfinRateError('invalid_date');
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
  return `https://minfin.com.ua/api/currency/rates/banks/${currency.toLowerCase()}/?page=1&cpp=100&date=${date}&commercial_sort=true`;
}
/** A quoted decimal exactly as published; never a float, and never a zero
 * standing in for "this bank did not say". */
function decimalParts(value: unknown): [bigint, number] | null {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,12})?$/.test(value))
    return null;
  const [whole, fraction = ''] = value.split('.');
  const digits = BigInt(whole! + fraction);
  return digits === 0n ? null : [digits, fraction.length];
}
/**
 * The mean of each contributing bank's midpoint.
 *
 * Averaging midpoints and taking the midpoint of the averages are the same
 * number, so there is no choice hidden here. The arithmetic stays in integers
 * to the last step; only the final quotient is rounded, half away from zero.
 */
export function averageMidpoint(
  quotes: readonly { buy: string; sell: string }[],
): string {
  if (!quotes.length) throw new MinfinRateError('invalid_response');
  const parsed = quotes.map(({ buy, sell }) => {
    const low = decimalParts(buy),
      high = decimalParts(sell);
    if (!low || !high) throw new MinfinRateError('invalid_response');
    return { low, high };
  });
  const places = Math.max(
    ...parsed.flatMap(({ low, high }) => [low[1], high[1]]),
  );
  const lift = ([digits, at]: [bigint, number]) =>
    digits * 10n ** BigInt(places - at);
  let total = 0n;
  for (const { low, high } of parsed) {
    const buy = lift(low),
      sell = lift(high);
    if (buy > sell) throw new MinfinRateError('invalid_response');
    total += buy + sell;
  }
  // total / (2n · 10^places), carried to AVERAGE_PLACES decimals and rounded
  // half away from zero. Everything above this line is exact.
  const numerator = total * 10n ** BigInt(AVERAGE_PLACES);
  const denominator = 2n * BigInt(parsed.length) * 10n ** BigInt(places);
  const rounded =
    numerator / denominator +
    (2n * (numerator % denominator) >= denominator ? 1n : 0n);
  const digits = rounded.toString().padStart(AVERAGE_PLACES + 1, '0');
  return `${digits.slice(0, -AVERAGE_PLACES)}.${digits.slice(-AVERAGE_PLACES)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}
/**
 * One quote for the day, from whichever of the four banks published a card rate.
 *
 * A bank's entry carries its own timestamp, and some of them are stamped the
 * following day; those are that day's rate, not this one, so they are left out.
 * A currency none of the four quoted returns nothing at all, which is a day the
 * secondary source cannot answer rather than a day worth inventing.
 */
export function parseMinfinRates(
  raw: string,
  currency: string,
  date: string,
  retrievedAt: string,
): ParsedMinfinRate[] {
  validateMinfinDate(date, new Date(retrievedAt));
  if (!(MINFIN_CURRENCIES as readonly string[]).includes(currency))
    throw new MinfinRateError('invalid_date');
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES
  )
    throw new MinfinRateError('invalid_response');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new MinfinRateError('invalid_response');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new MinfinRateError('invalid_response');
  const rows = (body as Record<string, unknown>).data;
  if (!Array.isArray(rows) || rows.length > 500)
    throw new MinfinRateError('invalid_response');
  const contributing: { slug: string; buy: string; sell: string }[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new MinfinRateError('invalid_response');
    const row = entry as Record<string, unknown>;
    const slug = String(row.slug ?? '');
    if (!MINFIN_BANKS.includes(slug)) continue;
    if (seen.has(slug)) throw new MinfinRateError('invalid_response');
    seen.add(slug);
    const card = row.card;
    if (!card || typeof card !== 'object' || Array.isArray(card)) continue;
    const quote = card as Record<string, unknown>;
    // The bank's own timestamp decides which day this rate belongs to.
    if (typeof quote.date !== 'string' || quote.date.slice(0, 10) !== date)
      continue;
    if (!decimalParts(quote.bid) || !decimalParts(quote.ask)) continue;
    contributing.push({
      slug,
      buy: String(quote.bid),
      sell: String(quote.ask),
    });
  }
  if (!contributing.length) return [];
  contributing.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const named = contributing
    .map((bank) => `${bank.slug} ${bank.buy}/${bank.sell}`)
    .join(', ');
  return [
    {
      source: MINFIN_SOURCE,
      base: currency,
      target: 'UAH',
      rate: averageMidpoint(contributing),
      asOf: date,
      retrievedAt,
      provenance: `${minfinRateUrl(currency, date)}; mean of the card buy/sell midpoints published for ${date} by ${contributing.length} of ${MINFIN_BANKS.length} household banks — ${named}; card-market estimate, not an executed bank exchange, and not the National Bank reference.`,
    },
  ];
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
): Promise<ParsedMinfinRate[]> {
  const now = options.now ?? (() => new Date());
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(minfinRateUrl(currency, date), {
        redirect: 'error',
        headers: { Accept: 'application/json' },
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
    return parseMinfinRates(
      await boundedBody(response),
      currency,
      date,
      now().toISOString(),
    );
  }
  throw new MinfinRateError('http');
}
/**
 * Every pair the four banks quote for the day.
 *
 * A pair none of them published is simply absent from the result: unlike the
 * primary source, whose three pairs always move together, this one is allowed
 * to answer for part of a day, because a bank quoting euro and not dollar is an
 * ordinary fact rather than a broken response.
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
    rates.push(...(await fetchOne(currency, date, options)));
  }
  return rates.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
}
/** Commit the day's quotes atomically, exactly as the primary source does. */
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
  if (!rates.length) return { stored: 0, skipped: true };
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
