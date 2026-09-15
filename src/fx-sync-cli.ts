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
    const existing = new Set(
      (
        await db.query(
          "SELECT DISTINCT to_char(as_of,'YYYY-MM-DD') AS day FROM daily_fx_rates WHERE source=$1",
          [PRIVATBANK_SOURCE],
        )
      ).rows.map((row) => String(row.day)),
    );
    let fetched = 0,
      stored = 0,
      skipped = 0,
      unavailable = 0;
    for (const date of dates) {
      if (!refresh && existing.has(date)) {
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
      if (!rates.length) unavailable++;
      log({
        event: result.skipped
          ? 'fx_day_skipped'
          : rates.length
            ? 'fx_day_stored'
            : 'fx_day_unavailable',
        date,
        count: result.stored,
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
          error instanceof PrivatBankRateError
            ? error.code
            : 'configuration_or_store_error',
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
