/**
 * Exact valuation of what the household holds.
 *
 * Every quantity, price and rate is a decimal string and every intermediate
 * value a rational number; only the final figure in the display currency is
 * rounded, half away from zero, to that currency's minor units. Nothing here
 * touches the database: the service loads rows and hands them over.
 *
 * USD is the pivot. A price is "USD for one unit of the symbol", whether the
 * symbol is a currency, a fund, a share or a coin. Daily bank quotes are
 * stored the other way round (UAH for one unit of USD or EUR), so they are
 * turned into USD-per-unit here, from the same source and date, before use.
 */
import type { DailyFxRate } from './fx-rates.js';
import { currencyExponent } from './fx.js';

export interface Rational {
  n: bigint;
  d: bigint;
}
const ZERO: Rational = { n: 0n, d: 1n };
const ONE: Rational = { n: 1n, d: 1n };

/** "-0.5", "9660", "0.18174197"; never exponent notation, never a float. */
export function parseDecimal(text: unknown): Rational | null {
  if (typeof text !== 'string') return null;
  const match = /^(-?)(\d{1,30})(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const n = BigInt(whole! + fraction) * (sign ? -1n : 1n);
  return reduce({ n, d: 10n ** BigInt(fraction.length) });
}
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};
function reduce(value: Rational): Rational {
  if (value.d < 0n) value = { n: -value.n, d: -value.d };
  const g = gcd(value.n, value.d);
  return { n: value.n / g, d: value.d / g };
}
export const multiply = (a: Rational, b: Rational): Rational =>
  reduce({ n: a.n * b.n, d: a.d * b.d });
export const divide = (a: Rational, b: Rational): Rational => {
  if (b.n === 0n) throw new Error('division_by_zero');
  return reduce({ n: a.n * b.d, d: a.d * b.n });
};
export const add = (a: Rational, b: Rational): Rational =>
  reduce({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
export const isZero = (a: Rational) => a.n === 0n;

/** Round to `scale` decimal places, half away from zero; returns the scaled integer. */
export function roundScaled(value: Rational, scale: number): bigint {
  const magnitude = value.n < 0n ? -value.n : value.n;
  const scaled = magnitude * 10n ** BigInt(scale);
  const whole = scaled / value.d;
  const rounded = whole + (2n * (scaled % value.d) >= value.d ? 1n : 0n);
  return value.n < 0n ? -rounded : rounded;
}
/** Minor units of a supported currency, as the rest of the application stores money. */
export function toMinor(value: Rational, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === undefined) throw new Error('unsupported_currency');
  return roundScaled(value, exponent).toString();
}
/** A plain decimal string with at most `scale` places and no trailing zeros. */
export function toDecimal(value: Rational, scale: number): string {
  const scaled = roundScaled(value, scale);
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled)
    .toString()
    .padStart(scale + 1, '0');
  const whole = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, '') : '';
  return `${negative && (whole !== '0' || fraction) ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
/** How many decimals a quantity of this denomination keeps: the currency's exponent, or eight. */
export function quantityScale(denomination: string): number {
  return currencyExponent(denomination) ?? 8;
}

export interface PricePoint {
  symbol: string;
  asOf: string;
  usdPerUnit: string;
  source: string;
}
export interface PriceLookup {
  price: Rational;
  asOf: string;
  source: string;
  /** True when no quote exists for the day itself and an earlier one stood in. */
  approximate: boolean;
}
const dayMs = 86400000;
const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs,
  );
/** How many days back a quote may stand in for a missing one; a week covers a holiday weekend. */
export const PRICE_STALENESS_DAYS = 7;

/**
 * USD for one unit of `symbol` on `date`: a stored price for that day first,
 * then a bank quote for that day, then the most recent of either within a
 * week, marked approximate. Nothing at all yields null, never a guess.
 */
export function usdPerUnit(
  symbol: string,
  date: string,
  prices: readonly PricePoint[],
  rates: readonly DailyFxRate[],
): PriceLookup | null {
  if (symbol === 'USD')
    return { price: ONE, asOf: date, source: 'identity', approximate: false };
  const candidates: PriceLookup[] = [];
  for (const point of prices) {
    if (point.symbol !== symbol || point.asOf > date) continue;
    if (daysBetween(point.asOf, date) > PRICE_STALENESS_DAYS) continue;
    const price = parseDecimal(point.usdPerUnit);
    if (!price || price.n <= 0n) continue;
    candidates.push({
      price,
      asOf: point.asOf,
      source: point.source,
      approximate: point.asOf !== date,
    });
  }
  // A bank quotes UAH for one USD and UAH for one EUR; both from the same
  // source and day give USD for one EUR, and the first alone gives USD for one UAH.
  const byDay = new Map<string, DailyFxRate[]>();
  for (const rate of rates) {
    if (rate.asOf > date || daysBetween(rate.asOf, date) > PRICE_STALENESS_DAYS)
      continue;
    if (rate.target !== 'UAH') continue;
    const key = `${rate.asOf}|${rate.source}`;
    const list = byDay.get(key) ?? [];
    list.push(rate);
    byDay.set(key, list);
  }
  for (const [key, list] of byDay) {
    const [asOf, source] = key.split('|') as [string, string];
    const latest = (base: string) =>
      list
        .filter((rate) => rate.base === base)
        .sort((a, b) => b.version - a.version)[0];
    const usd = latest('USD');
    if (!usd) continue;
    const usdInUah = parseDecimal(usd.rate);
    if (!usdInUah || usdInUah.n <= 0n) continue;
    let price: Rational | undefined;
    if (symbol === 'UAH') price = divide(ONE, usdInUah);
    else {
      const other = latest(symbol);
      const otherInUah = other ? parseDecimal(other.rate) : null;
      if (otherInUah && otherInUah.n > 0n) price = divide(otherInUah, usdInUah);
    }
    if (price)
      candidates.push({ price, asOf, source, approximate: asOf !== date });
  }
  if (!candidates.length) return null;
  // The day itself wins, stored prices before bank quotes on a tie; then the
  // nearest earlier day, with a stable source order so two runs agree.
  candidates.sort(
    (a, b) =>
      (a.asOf < b.asOf ? 1 : a.asOf > b.asOf ? -1 : 0) ||
      a.source.localeCompare(b.source),
  );
  return candidates[0]!;
}

export interface ValuedHolding {
  id: string;
  name: string;
  kind: string;
  denomination: string;
  invested: boolean;
  liquid: boolean;
  owner: string | null;
  group: string | null;
  maturesOn: string | null;
  note: string | null;
  archived: boolean;
  revision: number;
}
export interface SnapshotPoint {
  holdingId: string;
  asOf: string;
  quantity: string;
  source: string;
  enteredAmount: string | null;
  enteredCurrency: string | null;
  note: string | null;
}
export interface ValuedRow {
  holding: ValuedHolding;
  /** The quantity in force on the date, or null when nothing was ever recorded. */
  quantity: string | null;
  quantityAsOf: string | null;
  /** True when the quantity comes from an earlier snapshot than the date asked for. */
  carried: boolean;
  source: string | null;
  enteredAmount: string | null;
  enteredCurrency: string | null;
  note: string | null;
  /** In the display currency's minor units; null when no price could be found. */
  valueMinor: string | null;
  price: {
    usdPerUnit: string;
    asOf: string;
    source: string;
    approximate: boolean;
  } | null;
}
export interface Totals {
  totalMinor: string;
  investedMinor: string;
  notInvestedMinor: string;
  liquidMinor: string;
  uahMinor: string;
  /** Holdings with a non-zero quantity that no price could value. */
  missing: number;
  /** Holdings with a quantity on the date, carried or not. */
  counted: number;
}
export interface DatedTotals extends Totals {
  asOf: string;
}

/** The snapshot in force for each holding on `date`: its latest one on or before that day. */
export function inForce(
  holdings: readonly ValuedHolding[],
  snapshots: readonly SnapshotPoint[],
  date: string,
): Map<string, SnapshotPoint> {
  const chosen = new Map<string, SnapshotPoint>();
  for (const point of snapshots) {
    if (point.asOf > date) continue;
    const current = chosen.get(point.holdingId);
    if (!current || current.asOf < point.asOf)
      chosen.set(point.holdingId, point);
  }
  for (const holding of holdings) {
    const point = chosen.get(holding.id);
    // A retired holding keeps its history but stops being carried forward.
    if (point && holding.archived && point.asOf !== date)
      chosen.delete(holding.id);
  }
  return chosen;
}

export function valueOn(
  date: string,
  display: string,
  holdings: readonly ValuedHolding[],
  snapshots: readonly SnapshotPoint[],
  prices: readonly PricePoint[],
  rates: readonly DailyFxRate[],
): { rows: ValuedRow[]; totals: Totals } {
  if (currencyExponent(display) === undefined)
    throw new Error('unsupported_currency');
  const displayPrice = usdPerUnit(display, date, prices, rates);
  const chosen = inForce(holdings, snapshots, date);
  const rows: ValuedRow[] = [];
  let total = ZERO,
    invested = ZERO,
    liquid = ZERO,
    uah = ZERO,
    missing = 0,
    counted = 0;
  for (const holding of holdings) {
    const point = chosen.get(holding.id);
    if (!point) {
      rows.push({
        holding,
        quantity: null,
        quantityAsOf: null,
        carried: false,
        source: null,
        enteredAmount: null,
        enteredCurrency: null,
        note: null,
        valueMinor: null,
        price: null,
      });
      continue;
    }
    counted += 1;
    const quantity = parseDecimal(point.quantity);
    if (!quantity) throw new Error('invalid_quantity');
    const lookup = usdPerUnit(holding.denomination, date, prices, rates);
    let valueMinor: string | null = null;
    if (lookup && displayPrice) {
      const value = divide(
        multiply(quantity, lookup.price),
        displayPrice.price,
      );
      valueMinor = toMinor(value, display);
      total = add(total, value);
      if (holding.invested) invested = add(invested, value);
      if (holding.liquid) liquid = add(liquid, value);
      if (holding.denomination === 'UAH') uah = add(uah, value);
    } else if (!isZero(quantity)) missing += 1;
    rows.push({
      holding,
      quantity: point.quantity,
      quantityAsOf: point.asOf,
      carried: point.asOf !== date,
      source: point.source,
      enteredAmount: point.enteredAmount,
      enteredCurrency: point.enteredCurrency,
      note: point.note,
      valueMinor,
      price: lookup
        ? {
            usdPerUnit: toDecimal(lookup.price, 12),
            asOf: lookup.asOf,
            source: lookup.source,
            approximate: lookup.approximate,
          }
        : null,
    });
  }
  const notInvested = add(total, { n: -invested.n, d: invested.d });
  return {
    rows,
    totals: {
      totalMinor: toMinor(total, display),
      investedMinor: toMinor(invested, display),
      notInvestedMinor: toMinor(notInvested, display),
      liquidMinor: toMinor(liquid, display),
      uahMinor: toMinor(uah, display),
      missing,
      counted,
    },
  };
}

/** Totals for every snapshot date, oldest first. */
export function series(
  dates: readonly string[],
  display: string,
  holdings: readonly ValuedHolding[],
  snapshots: readonly SnapshotPoint[],
  prices: readonly PricePoint[],
  rates: readonly DailyFxRate[],
): DatedTotals[] {
  return [...new Set(dates)].sort().map((asOf) => ({
    asOf,
    ...valueOn(asOf, display, holdings, snapshots, prices, rates).totals,
  }));
}

/**
 * A quantity typed in another currency: how many units of the denomination
 * that money buys on the day. Only for denominations that have a price.
 */
export function quantityFromAmount(
  amount: Rational,
  currency: string,
  denomination: string,
  date: string,
  prices: readonly PricePoint[],
  rates: readonly DailyFxRate[],
): string | null {
  if (currency === denomination)
    return toDecimal(amount, quantityScale(denomination));
  const from = usdPerUnit(currency, date, prices, rates);
  const to = usdPerUnit(denomination, date, prices, rates);
  if (!from || !to) return null;
  return toDecimal(
    divide(multiply(amount, from.price), to.price),
    quantityScale(denomination),
  );
}
