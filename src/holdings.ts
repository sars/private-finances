/**
 * What the household owns, snapshot by snapshot (PF-020).
 *
 * A holding is one thing with a value: cash in a currency, a bank account, a
 * fund position, a coin, a bond issue, a property, a stake in a business, a
 * debt somebody owes. Its denomination is the unit its quantity is counted
 * in — a currency code or a symbol that has a price. A snapshot records the
 * quantity on a calendar date. Snapshots for the same holding and date are
 * versioned, never overwritten, so a corrected figure keeps the one it
 * replaced. Between snapshots the last known quantity is carried forward,
 * which is what a spreadsheet column copied from the one before it did.
 *
 * Names and values describe the household's money, so they live only in the
 * database. Nothing in this module or its tests names a real holding.
 */
import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import { FxRates, type DailyFxRate } from './fx-rates.js';
import { currencyExponent } from './fx.js';
import { Conflict } from './errors.js';
import {
  parseDecimal,
  quantityFromAmount,
  quantityScale,
  series,
  toDecimal,
  usdPerUnit,
  valueOn,
  type DatedTotals,
  type PricePoint,
  type SnapshotPoint,
  type ValuedHolding,
  type ValuedRow,
  PRICE_STALENESS_DAYS,
} from './holding-valuation.js';

export const HOLDING_KINDS = [
  'cash',
  'bank',
  'broker',
  'crypto',
  'bond',
  'deposit',
  'fund',
  'real_estate',
  'business',
  'receivable',
  'other',
] as const;
export type HoldingKind = (typeof HOLDING_KINDS)[number];
export type Holding = ValuedHolding & { kind: HoldingKind };
export type Snapshot = SnapshotPoint & {
  id: string;
  version: number;
  enteredBy: string | null;
  createdAt: string;
};

export async function initializeHoldings(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS holdings (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN (${HOLDING_KINDS.map((k) => `'${k}'`).join(',')})),
    denomination text NOT NULL,
    invested boolean NOT NULL,
    liquid boolean NOT NULL,
    owner text CHECK (owner IN ('rodion','katya')),
    group_name text,
    matures_on date,
    note text,
    archived boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    revision integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await tx.query(`CREATE TABLE IF NOT EXISTS holding_snapshots (
    id uuid PRIMARY KEY,
    holding_id uuid NOT NULL REFERENCES holdings(id),
    as_of date NOT NULL,
    version integer NOT NULL CHECK (version>0),
    quantity text NOT NULL,
    entered_amount text,
    entered_currency text,
    source text NOT NULL,
    entered_by text,
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(holding_id, as_of, version)
  )`);
  await tx.query(
    'CREATE INDEX IF NOT EXISTS holding_snapshots_date ON holding_snapshots(as_of)',
  );
  await tx.query(`CREATE TABLE IF NOT EXISTS asset_prices (
    id uuid PRIMARY KEY,
    symbol text NOT NULL,
    as_of date NOT NULL,
    version integer NOT NULL CHECK (version>0),
    usd_per_unit text NOT NULL,
    source text NOT NULL,
    entered_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(symbol, as_of, version)
  )`);
}

const dateValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const uuidValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function text(value: unknown, max: number, error: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(error);
  return value.trim();
}
function optionalText(value: unknown, max: number, error: string) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, max, error);
}
function flag(value: unknown, error: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(error);
}
/** A currency code or a symbol such as a fund ticker or a coin: letters, digits, dots. */
function denomination(value: unknown): string {
  const symbol = text(value, 16, 'holding_invalid_denomination').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,15}$/.test(symbol))
    throw new Error('holding_invalid_denomination');
  return symbol;
}
function mapHolding(row: Row): Holding {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as HoldingKind,
    denomination: String(row.denomination),
    invested: Boolean(row.invested),
    liquid: Boolean(row.liquid),
    owner:
      row.owner === null || row.owner === undefined ? null : String(row.owner),
    group:
      row.group_name === null || row.group_name === undefined
        ? null
        : String(row.group_name),
    maturesOn:
      row.matures_on_text === null || row.matures_on_text === undefined
        ? null
        : String(row.matures_on_text),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    archived: Boolean(row.archived),
    revision: Number(row.revision),
  };
}
function mapSnapshot(row: Row): Snapshot {
  return {
    id: String(row.id),
    holdingId: String(row.holding_id),
    asOf: String(row.as_of_text),
    version: Number(row.version),
    quantity: String(row.quantity),
    source: String(row.source),
    enteredAmount:
      row.entered_amount === null || row.entered_amount === undefined
        ? null
        : String(row.entered_amount),
    enteredCurrency:
      row.entered_currency === null || row.entered_currency === undefined
        ? null
        : String(row.entered_currency),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    enteredBy:
      row.entered_by === null || row.entered_by === undefined
        ? null
        : String(row.entered_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
const HOLDING_COLUMNS =
  'id,name,kind,denomination,invested,liquid,owner,group_name,matures_on::text AS matures_on_text,note,archived,sort_order,revision';
const SNAPSHOT_COLUMNS =
  'id,holding_id,as_of::text AS as_of_text,version,quantity,entered_amount,entered_currency,source,entered_by,note,created_at';

export interface HoldingInput {
  id?: string;
  name: string;
  kind: string;
  denomination: string;
  invested: boolean | string;
  liquid: boolean | string;
  owner?: string | null;
  group?: string | null;
  maturesOn?: string | null;
  note?: string | null;
  archived?: boolean | string;
  sortOrder?: number | string;
  /** Required when `id` names an existing holding; must match its current revision. */
  revision?: number | string;
}
export interface SnapshotInput {
  holdingId: string;
  asOf: string;
  /** A decimal string in `currency`, or in the holding's denomination when omitted. */
  amount: string;
  currency?: string;
  note?: string | null;
  source?: string;
}
export interface PriceInput {
  symbol: string;
  asOf: string;
  usdPerUnit: string;
  source?: string;
}
export interface HoldingsReport {
  display: string;
  at: string;
  dates: string[];
  rows: ValuedRow[];
  totals: DatedTotals;
  previous: DatedTotals | null;
  series: DatedTotals[];
}

export class Holdings {
  constructor(readonly db: Database) {}

  async list(includeArchived = true): Promise<Holding[]> {
    return (
      await this.db.query(
        `SELECT ${HOLDING_COLUMNS} FROM holdings ${includeArchived ? '' : 'WHERE NOT archived'} ORDER BY sort_order,group_name NULLS LAST,name`,
      )
    ).rows.map(mapHolding);
  }

  /** Create a holding, or change one when `id` and its current `revision` are given. */
  async upsert(actor: string | null, input: HoldingInput): Promise<Holding> {
    const name = text(input.name, 120, 'holding_invalid_name');
    if (!HOLDING_KINDS.includes(input.kind as HoldingKind))
      throw new Error('holding_invalid_kind');
    const values = {
      name,
      kind: input.kind,
      denomination: denomination(input.denomination),
      invested: flag(input.invested, 'holding_invalid_flag'),
      liquid: flag(input.liquid, 'holding_invalid_flag'),
      owner: optionalText(input.owner, 16, 'holding_invalid_owner'),
      group: optionalText(input.group, 80, 'holding_invalid_group'),
      maturesOn: input.maturesOn ? input.maturesOn : null,
      note: optionalText(input.note, 2000, 'holding_invalid_note'),
      archived:
        input.archived === undefined
          ? false
          : flag(input.archived, 'holding_invalid_flag'),
      sortOrder:
        input.sortOrder === undefined || input.sortOrder === ''
          ? 0
          : Number(input.sortOrder),
    };
    if (values.owner !== null && !['rodion', 'katya'].includes(values.owner))
      throw new Error('holding_invalid_owner');
    if (values.maturesOn !== null && !dateValid(values.maturesOn))
      throw new Error('holding_invalid_date');
    if (
      !Number.isSafeInteger(values.sortOrder) ||
      Math.abs(values.sortOrder) > 100000
    )
      throw new Error('holding_invalid_sort');
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482401)');
      if (input.id !== undefined && input.id !== '') {
        if (!uuidValid(input.id)) throw new Error('holding_invalid_id');
        const revision = Number(input.revision);
        if (!Number.isSafeInteger(revision) || revision < 0)
          throw new Error('holding_revision_required');
        const current = (
          await tx.query(
            `SELECT ${HOLDING_COLUMNS} FROM holdings WHERE id=$1 FOR UPDATE`,
            [input.id],
          )
        ).rows[0];
        if (!current) throw new Error('holding_not_found');
        if (Number(current.revision) !== revision)
          throw new Conflict('holding_stale_revision');
        const updated = (
          await tx.query(
            `UPDATE holdings SET name=$2,kind=$3,denomination=$4,invested=$5,liquid=$6,owner=$7,group_name=$8,matures_on=$9,note=$10,archived=$11,sort_order=$12,revision=revision+1,updated_at=now()
             WHERE id=$1 RETURNING ${HOLDING_COLUMNS}`,
            [
              input.id,
              values.name,
              values.kind,
              values.denomination,
              values.invested,
              values.liquid,
              values.owner,
              values.group,
              values.maturesOn,
              values.note,
              values.archived,
              values.sortOrder,
            ],
          )
        ).rows[0]!;
        return mapHolding(updated);
      }
      const existing = (
        await tx.query('SELECT id FROM holdings WHERE name=$1', [values.name])
      ).rows[0];
      if (existing) throw new Conflict('holding_name_taken');
      const inserted = (
        await tx.query(
          `INSERT INTO holdings(id,name,kind,denomination,invested,liquid,owner,group_name,matures_on,note,archived,sort_order)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${HOLDING_COLUMNS}`,
          [
            randomUUID(),
            values.name,
            values.kind,
            values.denomination,
            values.invested,
            values.liquid,
            values.owner,
            values.group,
            values.maturesOn,
            values.note,
            values.archived,
            values.sortOrder,
          ],
        )
      ).rows[0]!;
      void actor;
      return mapHolding(inserted);
    });
  }

  /**
   * Record a quantity on a date. An amount typed in another currency is
   * converted with that day's prices into the denomination and kept beside
   * the result, so the figure the person actually entered is never lost.
   * The same quantity recorded twice is one row; a different one is a new
   * version.
   */
  async recordSnapshot(
    actor: string | null,
    input: SnapshotInput,
  ): Promise<Snapshot> {
    if (!uuidValid(input.holdingId))
      throw new Error('snapshot_invalid_holding');
    if (!dateValid(input.asOf)) throw new Error('snapshot_invalid_date');
    const amount = parseDecimal(input.amount);
    if (!amount) throw new Error('snapshot_invalid_amount');
    const note = optionalText(input.note, 2000, 'snapshot_invalid_note');
    const source =
      optionalText(input.source, 40, 'snapshot_invalid_source') ?? 'manual';
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482402)');
      const holding = (
        await tx.query(`SELECT ${HOLDING_COLUMNS} FROM holdings WHERE id=$1`, [
          input.holdingId,
        ])
      ).rows[0];
      if (!holding) throw new Error('snapshot_invalid_holding');
      const denom = String(holding.denomination);
      const currency = input.currency ? denomination(input.currency) : denom;
      let quantity: string;
      let enteredAmount: string | null = null;
      let enteredCurrency: string | null = null;
      if (currency === denom) {
        quantity = toDecimal(amount, quantityScale(denom));
      } else {
        if (currencyExponent(currency) === undefined)
          throw new Error('snapshot_invalid_currency');
        const { prices, rates } = await this.market(tx, [input.asOf]);
        const converted = quantityFromAmount(
          amount,
          currency,
          denom,
          input.asOf,
          prices,
          rates,
        );
        if (converted === null) throw new Error('snapshot_no_rate');
        quantity = converted;
        enteredAmount = toDecimal(amount, currencyExponent(currency)!);
        enteredCurrency = currency;
      }
      const latest = (
        await tx.query(
          `SELECT ${SNAPSHOT_COLUMNS} FROM holding_snapshots WHERE holding_id=$1 AND as_of=$2 ORDER BY version DESC LIMIT 1`,
          [input.holdingId, input.asOf],
        )
      ).rows[0];
      if (
        latest &&
        String(latest.quantity) === quantity &&
        (latest.note ?? null) === note &&
        (latest.entered_currency ?? null) === enteredCurrency
      )
        return mapSnapshot(latest);
      const inserted = (
        await tx.query(
          `INSERT INTO holding_snapshots(id,holding_id,as_of,version,quantity,entered_amount,entered_currency,source,entered_by,note)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${SNAPSHOT_COLUMNS}`,
          [
            randomUUID(),
            input.holdingId,
            input.asOf,
            latest ? Number(latest.version) + 1 : 1,
            quantity,
            enteredAmount,
            enteredCurrency,
            source,
            actor,
            note,
          ],
        )
      ).rows[0]!;
      return mapSnapshot(inserted);
    });
  }

  /** USD for one unit of a symbol on a day; a changed figure becomes a new version. */
  async recordPrice(
    actor: string | null,
    input: PriceInput,
  ): Promise<PricePoint> {
    const symbol = denomination(input.symbol);
    if (symbol === 'USD') throw new Error('price_invalid_symbol');
    if (!dateValid(input.asOf)) throw new Error('price_invalid_date');
    const price = parseDecimal(input.usdPerUnit);
    if (!price || price.n <= 0n) throw new Error('price_invalid_value');
    const usdPerUnitText = toDecimal(price, 12);
    const source =
      optionalText(input.source, 40, 'price_invalid_source') ?? 'manual';
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482403)');
      const latest = (
        await tx.query(
          'SELECT version,usd_per_unit,source FROM asset_prices WHERE symbol=$1 AND as_of=$2 ORDER BY version DESC LIMIT 1',
          [symbol, input.asOf],
        )
      ).rows[0];
      if (latest && String(latest.usd_per_unit) === usdPerUnitText)
        return {
          symbol,
          asOf: input.asOf,
          usdPerUnit: usdPerUnitText,
          source: String(latest.source),
        };
      await tx.query(
        'INSERT INTO asset_prices(id,symbol,as_of,version,usd_per_unit,source,entered_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          symbol,
          input.asOf,
          latest ? Number(latest.version) + 1 : 1,
          usdPerUnitText,
          source,
          actor,
        ],
      );
      return { symbol, asOf: input.asOf, usdPerUnit: usdPerUnitText, source };
    });
  }

  async snapshotDates(): Promise<string[]> {
    return (
      await this.db.query(
        'SELECT DISTINCT as_of::text AS day FROM holding_snapshots ORDER BY day',
      )
    ).rows.map((row) => String(row.day));
  }

  /** The latest version of every snapshot, oldest first. */
  async snapshots(): Promise<Snapshot[]> {
    return (
      await this.db.query(
        `SELECT ${SNAPSHOT_COLUMNS} FROM (
           SELECT *,row_number() OVER (PARTITION BY holding_id,as_of ORDER BY version DESC) AS position
           FROM holding_snapshots) latest WHERE position=1 ORDER BY as_of,holding_id`,
      )
    ).rows.map(mapSnapshot);
  }

  /** Latest stored prices and daily bank quotes that can serve the given days. */
  private async market(
    tx: Executor,
    dates: readonly string[],
  ): Promise<{ prices: PricePoint[]; rates: DailyFxRate[] }> {
    if (!dates.length) return { prices: [], rates: [] };
    const sorted = [...dates].sort();
    const from = new Date(
      Date.parse(`${sorted[0]}T00:00:00Z`) - PRICE_STALENESS_DAYS * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const to = sorted[sorted.length - 1]!;
    const prices = (
      await tx.query(
        `SELECT symbol,as_of::text AS day,usd_per_unit,source FROM (
           SELECT *,row_number() OVER (PARTITION BY symbol,as_of ORDER BY version DESC) AS position
           FROM asset_prices WHERE as_of>=$1 AND as_of<=$2) latest WHERE position=1`,
        [from, to],
      )
    ).rows.map((row) => ({
      symbol: String(row.symbol),
      asOf: String(row.day),
      usdPerUnit: String(row.usd_per_unit),
      source: String(row.source),
    }));
    const scoped: Database = {
      query: (sql, params) => tx.query(sql, params),
      transaction: (action) => action(tx),
      close: async () => {},
    };
    const rates = await new FxRates(scoped).list(from, to);
    return { prices, rates };
  }

  /**
   * Everything valued in `display` on `at` (the latest snapshot day when
   * omitted), with the totals of every snapshot day for the chart and the
   * day before for the deltas. A day with no snapshot of its own shows the
   * carried quantities, which is how a new month starts.
   */
  async report(display: string, at?: string): Promise<HoldingsReport> {
    if (currencyExponent(display) === undefined)
      throw new Error('holdings_invalid_display');
    if (at !== undefined && !dateValid(at))
      throw new Error('holdings_invalid_date');
    const holdings = await this.list();
    const snapshots = await this.snapshots();
    const dates = [...new Set(snapshots.map((s) => s.asOf))].sort();
    const resolved =
      at ?? dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10);
    const chartDates = dates.includes(resolved)
      ? dates
      : [...dates, resolved].sort();
    const { prices, rates } = await this.market(this.db, chartDates);
    const points = series(
      chartDates,
      display,
      holdings,
      snapshots,
      prices,
      rates,
    );
    const index = points.findIndex((p) => p.asOf === resolved);
    const { rows } = valueOn(
      resolved,
      display,
      holdings,
      snapshots,
      prices,
      rates,
    );
    return {
      display,
      at: resolved,
      dates,
      rows,
      totals: points[index]!,
      previous: index > 0 ? points[index - 1]! : null,
      series: points,
    };
  }

  /** The price a symbol would be valued with on a day, for showing beside a quantity. */
  async priceOn(symbol: string, date: string) {
    const { prices, rates } = await this.market(this.db, [date]);
    return usdPerUnit(denomination(symbol), date, prices, rates);
  }
}
