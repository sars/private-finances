import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { migrate, postgresDatabase } from './database.js';
import {
  PRIVATBANK_SOURCE,
  PrivatBankRateError,
  privatBankArchiveBounds,
  validatePrivatBankDate,
  fetchPrivatBankRates,
  storePrivatBankRates,
} from './privatbank-rates.js';
import {
  MinfinRateError,
  MINFIN_ARCHIVE_START,
  fetchMinfinRates,
  storeMinfinRates,
} from './minfin-rates.js';
import { MINFIN_SOURCE } from './fx-sources.js';
import { provenEmptyDates, recordFxAbsence } from './fx-coverage.js';

/** Inclusive daily range, or distinct imported transaction dates within the provider archive. */
export function planFxSyncDates(
  args: string[],
  transactionDates: string[],
  now = new Date(),
): { dates: string[]; refresh: boolean } {
  const refresh = args.includes('--refresh');
  if (args.filter((arg) => arg === '--refresh').length > 1)
    throw new Error('fx_sync_configuration');
  const range = args.filter((arg) => arg !== '--refresh');
  if (range.length !== 0 && range.length !== 2)
    throw new Error('fx_sync_configuration');
  const bounds = privatBankArchiveBounds(now);
  let dates: string[] = [];
  if (range.length) {
    const [from, to] = range as [string, string];
    validatePrivatBankDate(from, now);
    validatePrivatBankDate(to, now);
    if (from > to) throw new Error('fx_sync_configuration');
    for (
      let at = Date.parse(`${from}T00:00:00Z`);
      at <= Date.parse(`${to}T00:00:00Z`);
      at += 86400000
    )
      dates.push(new Date(at).toISOString().slice(0, 10));
  } else {
    dates = [...new Set(transactionDates)].filter(
      (date) => date >= bounds.from && date <= bounds.to,
    );
    for (const date of dates) validatePrivatBankDate(date, now);
  }
  if (dates.length > 1462) throw new Error('fx_sync_configuration');
  return { dates: dates.sort().reverse(), refresh };
}
const log = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('fx_sync_configuration');
  // Validate explicit dates before opening the database or making any public request.
  const initial = planFxSyncDates(process.argv.slice(2), []);
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    const transactionDates = initial.dates.length
      ? []
      : (
          await db.query(
            "SELECT DISTINCT to_char(booked_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM transactions UNION SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
          )
        ).rows.map((row) => String(row.day));
    const { dates, refresh } = planFxSyncDates(
      process.argv.slice(2),
      transactionDates,
    );
    // Any source, not just the primary one. A day the secondary source filled
    // is a settled day; asking both providers about it again every night would
    // be a nightly request to each of them for a date that can no longer change.
    const existing = new Set(
      (
        await db.query(
          "SELECT DISTINCT to_char(as_of,'YYYY-MM-DD') AS day FROM daily_fx_rates",
        )
      ).rows.map((row) => String(row.day)),
    );
    // A day both sources have already answered "nothing" to cannot change, so
    // it is settled rather than retried. Before this, an empty Sunday was asked
    // about on every run for as long as it stayed empty.
    const settled = refresh ? new Set<string>() : await provenEmptyDates(db);
    let fetched = 0,
      stored = 0,
      skipped = 0,
      unavailable = 0;
    for (const date of dates) {
      if (!refresh && (existing.has(date) || settled.has(date))) {
        skipped++;
        log({ event: 'fx_day_skipped', date, count: 0 });
        continue;
      }
      if (fetched > 0) await sleep(2000);
      const rates = await fetchPrivatBankRates(date);
      fetched++;
      const result = await storePrivatBankRates(db, date, rates, refresh);
      stored += result.stored;
      if (result.skipped) skipped++;
      if (rates.length) {
        log({
          event: result.skipped ? 'fx_day_skipped' : 'fx_day_stored',
          date,
          count: result.stored,
        });
        continue;
      }
      // PrivatBank publishes nothing on the days it does not trade, and eleven
      // months of nightly retries against an empty archive will not change
      // that. The day is recorded as genuinely empty at that source — which is
      // what lets the status page show it as a closed fact rather than as a
      // permanent warning — and the secondary source is asked instead.
      await recordFxAbsence(
        db,
        PRIVATBANK_SOURCE,
        date,
        new Date().toISOString(),
        'The PrivatBank archive returned no commercial rates for this date.',
      );
      if (date < MINFIN_ARCHIVE_START) {
        // Before the secondary archive begins there is nothing for it to have
        // published, and that is a fact rather than a failure — so it is
        // recorded as one, and the day settles as empty at source instead of
        // sitting on the status page as a gap somebody might still fill.
        await recordFxAbsence(
          db,
          MINFIN_SOURCE,
          date,
          new Date().toISOString(),
          `Minfin publishes no rates before ${MINFIN_ARCHIVE_START}.`,
        );
        unavailable++;
        log({ event: 'fx_day_unavailable', date, count: 0 });
        continue;
      }
      let secondary: Awaited<ReturnType<typeof fetchMinfinRates>>;
      try {
        await sleep(2000);
        secondary = await fetchMinfinRates(date);
      } catch (error) {
        if (!(error instanceof MinfinRateError)) throw error;
        // A source that could not be read is not a source that published
        // nothing. The day stays unresolved, no absence is recorded for it, and
        // the next run asks again.
        unavailable++;
        log({ event: 'fx_day_secondary_failed', date, count: 0 });
        continue;
      }
      const second = await storeMinfinRates(db, date, secondary, refresh);
      stored += second.stored;
      if (second.skipped) skipped++;
      if (!secondary.length) {
        await recordFxAbsence(
          db,
          MINFIN_SOURCE,
          date,
          new Date().toISOString(),
          'Minfin published no average bank rate for this date.',
        );
        unavailable++;
      }
      log({
        event: secondary.length
          ? second.skipped
            ? 'fx_day_skipped'
            : 'fx_day_stored_secondary'
          : 'fx_day_unavailable',
        date,
        count: second.stored,
      });
    }
    log({
      event: 'fx_sync_finished',
      dates: dates.length,
      fetched,
      stored,
      skipped,
      unavailable,
    });
  } finally {
    await db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        event: 'fx_sync_failed',
        code:
          error instanceof PrivatBankRateError ||
          error instanceof MinfinRateError
            ? error.code
            : 'configuration_or_store_error',
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
