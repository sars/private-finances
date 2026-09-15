import { randomUUID } from 'node:crypto';
import type { Database, Executor } from './database.js';
import {
  convertMoney,
  currencyExponent,
  type FxResult,
  type FxProvenance,
} from './fx.js';

export interface DailyFxRate {
  id: string;
  source: string;
  base: string;
  target: string;
  rate: string;
  asOf: string;
  retrievedAt: string;
  version: number;
  provenance: string;
}
export type DailyFxRateInput = Omit<DailyFxRate, 'id'>;
export type StoredFxProvenance = FxProvenance & { quotes?: DailyFxRate[] };
export type StoredFxResult =
  | Exclude<FxResult, { status: 'converted' }>
  | {
      status: 'converted';
      amountMinor: string;
      currency: string;
      provenance: StoredFxProvenance;
    };
const dateValid = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function validate(input: DailyFxRateInput): void {
  if (
    !input ||
    typeof input.source !== 'string' ||
    !input.source.trim() ||
    input.source.length > 200 ||
    typeof input.provenance !== 'string' ||
    !input.provenance.trim() ||
    input.provenance.length > 2000 ||
    currencyExponent(input.base) === undefined ||
    currencyExponent(input.target) === undefined ||
    input.base === input.target ||
    typeof input.rate !== 'string' ||
    !/^\d{1,30}(?:\.\d{1,30})?$/.test(input.rate) ||
    BigInt(input.rate.replace('.', '')) <= 0n ||
    typeof input.asOf !== 'string' ||
    !dateValid(input.asOf) ||
    typeof input.retrievedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
      input.retrievedAt,
    ) ||
    !Number.isFinite(Date.parse(input.retrievedAt)) ||
    !dateValid(input.retrievedAt.slice(0, 10)) ||
    Number(input.retrievedAt.slice(11, 13)) > 23 ||
    Number(input.retrievedAt.slice(14, 16)) > 59 ||
    Number(input.retrievedAt.slice(17, 19)) > 59 ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version > 2147483647
  )
    throw new Error('invalid_fx_rate');
}
export async function initializeFxRates(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS daily_fx_rates (
    id uuid PRIMARY KEY, source text NOT NULL, base text NOT NULL, target text NOT NULL,
    rate text NOT NULL, as_of date NOT NULL, retrieved_at timestamptz NOT NULL,
    version integer NOT NULL CHECK(version>0), provenance text NOT NULL,
    UNIQUE(source,base,target,as_of,version)
  )`);
  await tx.query(
    'CREATE INDEX IF NOT EXISTS daily_fx_rates_date_idx ON daily_fx_rates(as_of)',
  );
  await tx.query(`CREATE OR REPLACE FUNCTION reject_daily_fx_rate_change() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'daily_fx_rates_are_immutable'; END;
    $$ LANGUAGE plpgsql`);
  await tx.query(`CREATE OR REPLACE TRIGGER daily_fx_rates_immutable
    BEFORE UPDATE OR DELETE ON daily_fx_rates FOR EACH ROW EXECUTE FUNCTION reject_daily_fx_rate_change()`);
}
function stored(row: Record<string, unknown>): DailyFxRate {
  return {
    id: String(row.id),
    source: String(row.source),
    base: String(row.base),
    target: String(row.target),
    rate: String(row.rate),
    // A PostgreSQL DATE is a calendar label, not a timezone-bearing instant.
    asOf: String(row.calendar_date),
    retrievedAt: new Date(String(row.retrieved_at)).toISOString(),
    version: Number(row.version),
    provenance: String(row.provenance),
  };
}
/** Append-only versions; a correction never overwrites the quote used by an earlier report. */
export class FxRates {
  constructor(readonly db: Database) {}
  async insert(input: DailyFxRateInput): Promise<DailyFxRate> {
    validate(input);
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO daily_fx_rates(id,source,base,target,rate,as_of,retrieved_at,version,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(source,base,target,as_of,version) DO NOTHING RETURNING *,as_of::text AS calendar_date`,
        [
          randomUUID(),
          input.source,
          input.base,
          input.target,
          input.rate,
          input.asOf,
          input.retrievedAt,
          input.version,
          input.provenance,
        ],
      );
      if (result.rows[0]) return stored(result.rows[0]);
      const existing = stored(
        (
          await tx.query(
            'SELECT *,as_of::text AS calendar_date FROM daily_fx_rates WHERE source=$1 AND base=$2 AND target=$3 AND as_of=$4 AND version=$5',
            [input.source, input.base, input.target, input.asOf, input.version],
          )
        ).rows[0]!,
      );
      if (
        existing.rate !== input.rate ||
        existing.provenance !== input.provenance ||
        existing.retrievedAt !== new Date(input.retrievedAt).toISOString()
      )
        throw new Error('fx_rate_version_conflict');
      return existing;
    });
  }
  async list(from: string, to: string): Promise<DailyFxRate[]> {
    if (!dateValid(from) || !dateValid(to) || from > to)
      throw new Error('invalid_fx_rate_range');
    return (
      await this.db.query(
        'SELECT *,as_of::text AS calendar_date FROM daily_fx_rates WHERE as_of>=$1 AND as_of<=$2 ORDER BY as_of,source,base,target,version DESC',
        [from, to],
      )
    ).rows.map(stored);
  }
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function latest(rates: readonly DailyFxRate[], date: string): DailyFxRate[] {
  const found = new Map<string, DailyFxRate>();
  for (const rate of rates) {
    if (rate.asOf !== date) continue;
    validate(rate);
    const key = JSON.stringify([rate.source, rate.base, rate.target]);
    if (!found.has(key) || found.get(key)!.version < rate.version)
      found.set(key, rate);
  }
  return [...found.values()].sort(
    (a, b) =>
      compare(a.source, b.source) ||
      compare(a.base, b.base) ||
      compare(a.target, b.target),
  );
}
function ratio(quote: DailyFxRate, base: string): [bigint, bigint] {
  const [whole, fraction = ''] = quote.rate.split('.');
  const n = BigInt(whole! + fraction),
    d = 10n ** BigInt(fraction.length);
  return quote.base === base ? [n, d] : [d, n];
}
/** Direct/inverse daily evidence first, then same-source UAH cross rates; never round an intermediate leg. */
export function convertWithDailyRates(
  input: Parameters<typeof convertMoney>[0],
  rates: readonly DailyFxRate[],
): StoredFxResult {
  const actual = convertMoney({ ...input, quotes: undefined });
  if (actual.status === 'converted' || actual.reason !== 'no_matching_quote')
    return actual;
  const date = new Date(input.occurredAt!).toISOString().slice(0, 10);
  const selected = latest(rates, date);
  const direct = selected.find(
    (q) =>
      (q.base === input.currency && q.target === input.targetCurrency) ||
      (q.target === input.currency && q.base === input.targetCurrency),
  );
  if (direct) {
    const result = convertMoney({
      ...input,
      quotes: [{ ...direct, resolution: 'daily' }],
    });
    return result.status === 'converted'
      ? { ...result, provenance: { ...result.provenance, quotes: [direct] } }
      : result;
  }
  const pairs = (q: DailyFxRate, a: string, b: string) =>
    (q.base === a && q.target === b) || (q.base === b && q.target === a);
  for (const first of selected.filter((q) => pairs(q, input.currency, 'UAH'))) {
    const second = selected.find(
      (q) => q.source === first.source && pairs(q, 'UAH', input.targetCurrency),
    );
    if (!second) continue;
    const [n1, d1] = ratio(first, input.currency),
      [n2, d2] = ratio(second, 'UAH');
    let n = n1 * n2,
      d = d1 * d2;
    let a = n,
      b = d;
    while (b) [a, b] = [b, a % b];
    n /= a;
    d /= a;
    const numerator =
      BigInt(input.amountMinor) *
      n *
      10n ** BigInt(currencyExponent(input.targetCurrency)!);
    const denominator = d * 10n ** BigInt(currencyExponent(input.currency)!);
    const magnitude = numerator < 0n ? -numerator : numerator;
    const rounded =
      magnitude / denominator +
      (2n * (magnitude % denominator) >= denominator ? 1n : 0n);
    return {
      status: 'converted',
      amountMinor: (numerator < 0n ? -rounded : rounded).toString(),
      currency: input.targetCurrency,
      provenance: {
        kind: 'market_estimate',
        source: first.source,
        asOf: date,
        resolution: 'daily',
        base: input.currency,
        target: input.targetCurrency,
        rateNumerator: n.toString(),
        rateDenominator: d.toString(),
        inverted: false,
        rounding: 'half_away_from_zero',
        quotes: [first, second],
      },
    };
  }
  return actual;
}
