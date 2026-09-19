import type { Database, Executor } from './database.js';
import { MINFIN_SOURCE, PRIVATBANK_SOURCE } from './fx-sources.js';

/**
 * The sources asked about a calendar day, both commercial, neither the National
 * Bank. PrivatBank answers first; Minfin's average across Ukrainian banks is
 * asked only for the days PrivatBank leaves empty.
 */
export const FX_ARCHIVE_SOURCES: readonly string[] = [
  PRIVATBANK_SOURCE,
  MINFIN_SOURCE,
];

export type FxDayState = 'covered' | 'empty_at_source' | 'not_fetched';
export interface FxDay {
  date: string;
  state: FxDayState;
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
 */
export async function fxCoverage(
  db: Database,
  from: string,
  to: string,
): Promise<FxDay[]> {
  const dates = eachDate(from, to);
  const covered = new Set(
    (
      await db.query(
        "SELECT DISTINCT to_char(as_of,'YYYY-MM-DD') AS day FROM daily_fx_rates WHERE as_of>=$1 AND as_of<=$2",
        [from, to],
      )
    ).rows.map((row) => String(row.day)),
  );
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
    if (covered.has(date)) return { date, state: 'covered' };
    const sources = asked.get(date);
    const empty =
      !!sources && FX_ARCHIVE_SOURCES.every((source) => sources.has(source));
    return { date, state: empty ? 'empty_at_source' : 'not_fetched' };
  });
}
