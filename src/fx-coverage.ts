import type { Database, Executor } from './database.js';
import {
  MINFIN_SOURCE,
  PRIVATBANK_SOURCE,
  compareFxSources,
} from './fx-sources.js';

/**
 * The sources asked about a calendar day, both commercial, neither the National
 * Bank. PrivatBank answers first; Minfin's average across Ukrainian banks is
 * asked only for the days PrivatBank leaves empty.
 */
export const FX_ARCHIVE_SOURCES: readonly string[] = [
  PRIVATBANK_SOURCE,
  MINFIN_SOURCE,
];

export type FxDayState =
  'covered' | 'empty_at_source' | 'not_fetched' | 'not_needed';
export interface FxDay {
  date: string;
  state: FxDayState;
  /** Which source stored the day's rate; only ever set on a covered day. The
   * page shows it when a cell is tapped, so a square can explain itself. */
  source?: string;
  /** The day's rates, `"EUR/UAH"` to the figure, from the winning source.
   * Only on a covered day, and the reason the page can list a history rather
   * than only assert that one exists. */
  rates?: Record<string, string>;
}

const dateValid = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/**
 * Days a source was asked about and had nothing to give.
 *
 * Without this record the page cannot tell a day nobody published from a day
 * the nightly sync has not reached yet. The first is a closed fact and must not
 * sit on the page as a permanent warning; the second is a real failure the
 * owner can act on. Conflating them produces an alarm that is always on, which
 * is an alarm nobody reads.
 */
export async function initializeFxCoverage(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS daily_fx_absences (
    source text NOT NULL, as_of date NOT NULL,
    checked_at timestamptz NOT NULL, note text NOT NULL,
    PRIMARY KEY(source, as_of)
  )`);
  await tx.query(
    'CREATE INDEX IF NOT EXISTS daily_fx_absences_date_idx ON daily_fx_absences(as_of)',
  );
}

export async function recordFxAbsence(
  db: Database,
  source: string,
  date: string,
  checkedAt: string,
  note: string,
): Promise<void> {
  if (!dateValid(date) || !source.trim() || !note.trim())
    throw new Error('invalid_fx_absence');
  await db.query(
    `INSERT INTO daily_fx_absences(source,as_of,checked_at,note) VALUES($1,$2,$3,$4)
     ON CONFLICT(source,as_of) DO UPDATE SET checked_at=EXCLUDED.checked_at, note=EXCLUDED.note`,
    [source, date, checkedAt, note],
  );
}

/**
 * Dates every source has already answered "nothing" to.
 *
 * These are closed facts. A Sunday in 2025 that neither provider published will
 * not start publishing, so asking both of them about it again every night is a
 * nightly request to two services for an answer that cannot change. The sync
 * skips them; `--refresh` still asks.
 */
export async function provenEmptyDates(db: Database): Promise<Set<string>> {
  return new Set(
    (
      await db.query(
        `SELECT to_char(as_of,'YYYY-MM-DD') AS day FROM daily_fx_absences
         WHERE source=ANY($1::text[])
         GROUP BY as_of HAVING count(DISTINCT source)=$2`,
        [[...FX_ARCHIVE_SOURCES], FX_ARCHIVE_SOURCES.length],
      )
    ).rows.map((row) => String(row.day)),
  );
}

export function eachDate(from: string, to: string): string[] {
  if (!dateValid(from) || !dateValid(to) || from > to)
    throw new Error('invalid_fx_rate_range');
  const dates: string[] = [];
  for (
    let at = Date.parse(`${from}T00:00:00Z`);
    at <= Date.parse(`${to}T00:00:00Z`);
    at += 86400000
  )
    dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}

/**
 * One state per calendar day across the range, for the status strip.
 *
 * A day is empty at source only once **every** source has been asked and come
 * back with nothing; a day only one of them has been asked about is still
 * waiting, and says so.
 *
 * `needed` is the set of days that actually require a rate — the days the sync
 * itself asks about. Every calendar day still gets a cell, because the shape of
 * the calendar is what makes a gap legible, but a day outside that set is drawn
 * as needing nothing and is left out of the count.
 */
export async function fxCoverage(
  db: Database,
  from: string,
  to: string,
  needed?: ReadonlySet<string>,
): Promise<FxDay[]> {
  const dates = eachDate(from, to);
  // The source that would win each day, and that source's figures — not merely
  // whatever stored something. The cell names, and the history lists, the rate
  // a conversion on that date would actually use.
  const covered = new Map<string, string>();
  const quotes = (
    await db.query(
      "SELECT source,base,target,rate,version,to_char(as_of,'YYYY-MM-DD') AS day FROM daily_fx_rates WHERE as_of>=$1 AND as_of<=$2",
      [from, to],
    )
  ).rows.map((row) => ({
    day: String(row.day),
    source: String(row.source),
    base: String(row.base),
    target: String(row.target),
    rate: String(row.rate),
    version: Number(row.version),
  }));
  for (const quote of quotes) {
    const held = covered.get(quote.day);
    if (!held || compareFxSources(quote.source, held) < 0)
      covered.set(quote.day, quote.source);
  }
  const figures = new Map<
    string,
    Map<string, { rate: string; version: number }>
  >();
  for (const quote of quotes) {
    if (quote.source !== covered.get(quote.day)) continue;
    const pair = `${quote.base}/${quote.target}`;
    const day = figures.get(quote.day) ?? new Map();
    const held = day.get(pair);
    // Corrections append versions; the newest is the one in force.
    if (!held || held.version < quote.version)
      day.set(pair, { rate: quote.rate, version: quote.version });
    figures.set(quote.day, day);
  }
  const asked = new Map<string, Set<string>>();
  for (const row of (
    await db.query(
      "SELECT source,to_char(as_of,'YYYY-MM-DD') AS day FROM daily_fx_absences WHERE as_of>=$1 AND as_of<=$2",
      [from, to],
    )
  ).rows) {
    const day = String(row.day);
    if (!asked.has(day)) asked.set(day, new Set());
    asked.get(day)!.add(String(row.source));
  }
  return dates.map((date): FxDay => {
    const source = covered.get(date);
    if (source)
      return {
        date,
        state: 'covered',
        source,
        rates: Object.fromEntries(
          [...(figures.get(date) ?? new Map())]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([pair, held]) => [pair, held.rate]),
        ),
      };
    // A day with no payment on it needs no rate, so a missing one is not a gap
    // and must not read as a fault. The sync only ever asks about days that
    // carry a transaction; counting the days it deliberately skips against it
    // would leave a warning on the page that nothing could ever clear.
    if (needed && !needed.has(date)) return { date, state: 'not_needed' };
    const sources = asked.get(date);
    const empty =
      !!sources && FX_ARCHIVE_SOURCES.every((source) => sources.has(source));
    return { date, state: empty ? 'empty_at_source' : 'not_fetched' };
  });
}
