/** Exact reporting conversion. All amounts are signed integer minor units. */
export interface Money {
  amountMinor: string;
  currency: string;
}

export interface ActualExchange {
  source: string;
  account: Money;
  operation: Money;
}

export interface DatedMarketQuote {
  source: string;
  base: string;
  target: string;
  /** Target major units per one base major unit; never a floating-point number. */
  rate: string;
  /** An ISO date for daily quotes, or a timezone-qualified timestamp. */
  asOf: string;
  resolution: 'daily' | 'timestamp';
}

export interface FxProvenance {
  kind: 'identity' | 'actual_bank' | 'market_estimate';
  source: string;
  asOf: string | null;
  resolution: 'none' | 'transaction' | 'daily' | 'timestamp';
  base: string;
  target: string;
  /** Exact major-unit rate, including exponent adjustments for bank amounts. */
  rateNumerator: string;
  rateDenominator: string;
  inverted: boolean;
  rounding: 'half_away_from_zero';
}

export type FxResult =
  | {
      status: 'converted';
      amountMinor: string;
      currency: string;
      provenance: FxProvenance;
    }
  | {
      status: 'missing';
      currency: string;
      reason:
        | 'invalid_amount'
        | 'unsupported_currency'
        | 'missing_time'
        | 'invalid_time'
        | 'no_matching_quote';
    };

// Explicit support only: an unknown currency must never silently assume 2 digits.
const exponents: Readonly<Record<string, number>> = {
  UAH: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
};

export function currencyExponent(currency: string): number | undefined {
  return Object.hasOwn(exponents, currency) ? exponents[currency] : undefined;
}

function integer(value: string): bigint | null {
  return typeof value === 'string' && /^[+-]?\d{1,60}$/.test(value)
    ? BigInt(value)
    : null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

function instant(value: string): string | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (
    !match ||
    !validDate(match[1]!) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    return null;
  const zone = match[5]!;
  if (
    zone !== 'Z' &&
    (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

const abs = (value: bigint) => (value < 0n ? -value : value);
const scale = (exponent: number) => 10n ** BigInt(exponent);

function reduced(numerator: bigint, denominator: bigint): [bigint, bigint] {
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return [numerator / a, denominator / a];
}

function decimal(value: string): [bigint, bigint] | null {
  if (typeof value !== 'string' || !/^\d{1,30}(?:\.\d{1,30})?$/.test(value))
    return null;
  const [whole, fraction = ''] = value.split('.');
  const numerator = BigInt(whole! + fraction);
  return numerator > 0n ? reduced(numerator, scale(fraction.length)) : null;
}

function rounded(numerator: bigint, denominator: bigint): bigint {
  const magnitude = abs(numerator);
  const result =
    magnitude / denominator +
    (2n * (magnitude % denominator) >= denominator ? 1n : 0n);
  return numerator < 0n ? -result : result;
}

/**
 * Actual exchange evidence is scoped to this transaction's exact signed amount.
 * It describes effective cost, without inferring how the bank included fees.
 * Market inputs are explicitly estimates; daily matching uses the UTC date.
 * Timestamp quotes must match the transaction instant (no silent nearest rate).
 */
export function convertMoney(
  input: Money & {
    targetCurrency: string;
    occurredAt?: string;
    actualExchange?: ActualExchange;
    quotes?: readonly DatedMarketQuote[];
  },
): FxResult {
  const missing = (
    reason: Extract<FxResult, { status: 'missing' }>['reason'],
  ): FxResult => ({
    status: 'missing',
    currency: input.targetCurrency,
    reason,
  });
  const amount = integer(input.amountMinor);
  if (amount === null) return missing('invalid_amount');
  const fromExponent = currencyExponent(input.currency);
  const toExponent = currencyExponent(input.targetCurrency);
  if (fromExponent === undefined || toExponent === undefined)
    return missing('unsupported_currency');

  const converted = (
    numerator: bigint,
    denominator: bigint,
    evidence: Omit<
      FxProvenance,
      'base' | 'target' | 'rateNumerator' | 'rateDenominator' | 'rounding'
    >,
  ): FxResult => {
    const [n, d] = reduced(numerator, denominator);
    return {
      status: 'converted',
      amountMinor: rounded(
        amount * n * scale(toExponent),
        d * scale(fromExponent),
      ).toString(),
      currency: input.targetCurrency,
      provenance: {
        ...evidence,
        base: input.currency,
        target: input.targetCurrency,
        rateNumerator: n.toString(),
        rateDenominator: d.toString(),
        rounding: 'half_away_from_zero',
      },
    };
  };

  if (input.currency === input.targetCurrency)
    return converted(1n, 1n, {
      kind: 'identity',
      source: 'original_amount',
      asOf: null,
      resolution: 'none',
      inverted: false,
    });
  if (!input.occurredAt) return missing('missing_time');
  const occurredAt = instant(input.occurredAt);
  if (occurredAt === null) return missing('invalid_time');

  const actual = input.actualExchange;
  if (actual && typeof actual.source === 'string' && actual.source.trim()) {
    const forward =
      actual.account.currency === input.currency &&
      actual.operation.currency === input.targetCurrency;
    const reverse =
      actual.operation.currency === input.currency &&
      actual.account.currency === input.targetCurrency;
    if (forward || reverse) {
      const from = integer(
        (forward ? actual.account : actual.operation).amountMinor,
      );
      const to = integer(
        (forward ? actual.operation : actual.account).amountMinor,
      );
      if (
        from !== null &&
        to !== null &&
        from !== 0n &&
        to !== 0n &&
        from < 0n === to < 0n &&
        from === amount
      ) {
        return converted(
          abs(to) * scale(fromExponent),
          abs(from) * scale(toExponent),
          {
            kind: 'actual_bank',
            source: actual.source,
            asOf: occurredAt,
            resolution: 'transaction',
            inverted: reverse,
          },
        );
      }
    }
  }

  // Prefer exact timestamp evidence over a daily approximation, regardless of order.
  for (const resolution of ['timestamp', 'daily'] as const) {
    for (const quote of input.quotes ?? []) {
      if (
        quote.resolution !== resolution ||
        typeof quote.source !== 'string' ||
        !quote.source.trim()
      )
        continue;
      const forward =
        quote.base === input.currency && quote.target === input.targetCurrency;
      const reverse =
        quote.target === input.currency && quote.base === input.targetCurrency;
      if (!forward && !reverse) continue;
      const asOf =
        resolution === 'timestamp'
          ? instant(quote.asOf)
          : validDate(quote.asOf)
            ? quote.asOf
            : null;
      if (
        asOf !==
        (resolution === 'timestamp' ? occurredAt : occurredAt.slice(0, 10))
      )
        continue;
      const rate = decimal(quote.rate);
      if (!rate) continue;
      return converted(
        reverse ? rate[1] : rate[0],
        reverse ? rate[0] : rate[1],
        {
          kind: 'market_estimate',
          source: quote.source,
          asOf,
          resolution,
          inverted: reverse,
        },
      );
    }
  }
  return missing('no_matching_quote');
}
