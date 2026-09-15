import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, postgresDatabase, type Database } from './database.js';
import { Repository } from './repository.js';
import {
  previousReportPeriod,
  Reports,
  type ReportKind,
  type ReportOwner,
  type ReportSnapshot,
} from './reports.js';

/** Calendar triggers use the same timezone as the report period boundaries. */
export function dueReportKinds(
  now: Date,
  timeZone = 'Europe/Riga',
): ReportKind[] {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_report_time');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    weekday: 'short',
    day: 'numeric',
  }).formatToParts(now);
  const kinds: ReportKind[] = [];
  if (parts.find((p) => p.type === 'weekday')?.value === 'Mon')
    kinds.push('week');
  if (parts.find((p) => p.type === 'day')?.value === '1') kinds.push('month');
  return kinds;
}

export async function runReportCycle(
  db: Database,
  now: Date,
  timeZone = 'Europe/Riga',
): Promise<ReportSnapshot[]> {
  const due = dueReportKinds(now, timeZone);
  const reports = new Reports(db);
  const household = await reports.list('all');
  const kinds: ReportKind[] = (['week', 'month'] as const).filter((kind) => {
    if (due.includes(kind)) return true;
    const period = previousReportPeriod(kind, now, timeZone);
    return !household.some(
      ({ report }) =>
        report.period.kind === period.kind &&
        report.period.timeZone === period.timeZone &&
        report.period.from === period.from &&
        report.period.to === period.to,
    );
  });
  if (!kinds.length) return [];
  // Read one consistent stored row set for the owner and household snapshots.
  // Stored rows do not establish bank coverage; report content says so explicitly.
  const transactions = await new Repository(db).list();
  const snapshots: ReportSnapshot[] = [];
  // Household is written last, so its presence is the completed-cycle checkpoint.
  // A crash before it is saved makes the next run retry all scopes idempotently.
  const owners: ReportOwner[] = ['rodion', 'katya', 'all'];
  for (const kind of kinds) {
    const period = previousReportPeriod(kind, now, timeZone);
    for (const owner of owners)
      snapshots.push(await reports.save(transactions, { owner, period }));
  }
  return snapshots;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('report_database_required');
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    const snapshots = await runReportCycle(
      db,
      new Date(),
      process.env.REPORT_TIMEZONE ?? 'Europe/Riga',
    );
    process.stdout.write(
      JSON.stringify({
        event: 'report_cycle',
        status: 'success',
        snapshots: snapshots.length,
      }) + '\n',
    );
  } finally {
    await db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    // Do not emit database errors or report contents into service logs.
    process.stderr.write('{"event":"report_cycle","status":"failed"}\n');
    process.exitCode = 1;
  });
}
