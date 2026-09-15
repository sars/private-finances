import { createHash, randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import { expenseSummary, type Owner } from './domain.js';
import type { Transaction } from './repository.js';

export type ReportKind = 'week' | 'month';
export type ReportOwner = Owner | 'all';
export type ReportPeriod = {
  kind: ReportKind;
  timeZone: string;
  from: string;
  /** Exclusive boundary, in UTC. */
  to: string;
};

function localDay(time: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(time);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const day = new Date(0);
  day.setUTCFullYear(get('year'), get('month') - 1, get('day'));
  return day.getTime();
}

/** First instant of the civil day, including zones that skip midnight at DST. */
function startOfDay(day: number, formatter: Intl.DateTimeFormat): string {
  let low = day - 36 * 3600000;
  let high = day + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(middle, formatter) < day) low = middle + 1;
    else high = middle;
  }
  if (localDay(low, formatter) !== day)
    throw new Error('report_calendar_day_missing');
  return new Date(low).toISOString();
}

export function previousReportPeriod(
  kind: ReportKind,
  now: Date,
  timeZone = 'Europe/Riga',
): ReportPeriod {
  if (!Number.isFinite(now.getTime()) || !['week', 'month'].includes(kind))
    throw new Error('invalid_report_period');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const end = new Date(localDay(now.getTime(), formatter));
  if (end.getUTCFullYear() < 100) throw new Error('invalid_report_year');
  if (kind === 'week')
    end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7));
  else end.setUTCDate(1);
  const start = new Date(end);
  if (kind === 'week') start.setUTCDate(start.getUTCDate() - 7);
  else start.setUTCMonth(start.getUTCMonth() - 1);
  return {
    kind,
    timeZone: formatter.resolvedOptions().timeZone,
    from: startOfDay(start.getTime(), formatter),
    to: startOfDay(end.getTime(), formatter),
  };
}

function ownerScope(owner: ReportOwner) {
  if (!['rodion', 'katya', 'all'].includes(owner))
    throw new Error('invalid_report_owner');
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildReport(
  transactions: Transaction[],
  options: { owner: ReportOwner; period: ReportPeriod },
) {
  ownerScope(options.owner);
  const { period } = options;
  // Only canonical, whole previous calendar periods are accepted, even on rerun.
  const expected = previousReportPeriod(
    period.kind,
    new Date(period.to),
    period.timeZone,
  );
  if (expected.from !== period.from || expected.to !== period.to)
    throw new Error('invalid_report_period');
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  const rows = transactions
    .filter(
      (t) =>
        (options.owner === 'all' || t.owner === options.owner) &&
        Date.parse(t.bookedAt) >= from &&
        Date.parse(t.bookedAt) < to,
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (new Set(rows.map((t) => t.id)).size !== rows.length)
    throw new Error('duplicate_report_transaction');
  const byCategory = new Map<
    string,
    {
      owner: Owner;
      currency: string;
      category: string;
      personalExpenseMinor: bigint;
    }
  >();
  for (const t of rows) {
    if (
      t.status === 'pending' ||
      t.kind !== 'personal_expense' ||
      BigInt(t.amountMinor) >= 0n
    )
      continue;
    if (t.category === null) throw new Error('report_expense_missing_category');
    // Money that came back reduces the purchase in its own month, so a category
    // total is what was finally spent on it (ADR 0007).
    const net = t.refund ? BigInt(t.refund.netMinor) : BigInt(t.amountMinor);
    if (net >= 0n) continue;
    const key = JSON.stringify([t.owner, t.currency, t.category]);
    const value = byCategory.get(key) ?? {
      owner: t.owner,
      currency: t.currency,
      category: t.category,
      personalExpenseMinor: 0n,
    };
    value.personalExpenseMinor -= net;
    byCategory.set(key, value);
  }
  const owners: Owner[] =
    options.owner === 'all' ? ['rodion', 'katya'] : [options.owner];
  return {
    formatVersion: 1,
    owner: options.owner,
    period: expected,
    transactionCount: rows.length,
    ...expenseSummary(rows),
    byOwner: owners.map((owner) => ({
      owner,
      ...expenseSummary(rows.filter((t) => t.owner === owner)),
    })),
    byPattern: (['routine', 'exceptional', 'unreviewed'] as const).map(
      (pattern) => ({
        pattern,
        ...expenseSummary(
          rows.filter(
            (t) => (t.spendingPattern?.pattern ?? 'unreviewed') === pattern,
          ),
        ),
      }),
    ),
    byCategory: [...byCategory.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, t]) => ({
        ...t,
        personalExpenseMinor: t.personalExpenseMinor.toString(),
      })),
    incompleteness: {
      // Stored rows alone cannot prove every bank/account/window was imported.
      importCoverage: 'unverified' as const,
      // A credit linked to a purchase is explained by that link and counted
      // through it, so it is not an unresolved payment (ADR 0007).
      unresolvedCount: rows.filter(
        (t) => t.kind === 'unresolved' && t.refund?.role !== 'refund',
      ).length,
      pendingCount: rows.filter(
        (t) => t.status === 'pending' && !t.spendingPolicy?.excluded,
      ).length,
      currencyConversion: 'not_applied' as const,
    },
    // Revisions capture source corrections and human decisions, including changes
    // that leave totals unchanged. No financial descriptions are stored here.
    sourceFingerprint: hash(
      rows.map((t) => [
        t.id,
        t.revision,
        t.owner,
        t.bookedAt,
        t.currency,
        t.amountMinor,
        t.status ?? 'booked',
        t.kind,
        t.category,
        t.spendingPattern?.pattern ?? 'unreviewed',
        t.spendingPattern?.revision ?? 0,
        t.spendingPolicy ?? null,
        // A new or removed refund link changes what a report says without
        // changing any transaction revision.
        t.refund?.reducedMinor ?? '0',
      ]),
    ),
  };
}
export type ReportContent = ReturnType<typeof buildReport>;
export type ReportSnapshot = {
  id: string;
  version: number;
  fingerprint: string;
  createdAt: string;
  report: ReportContent;
};

export async function initializeReports(db: Executor): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS report_snapshots (
    id uuid PRIMARY KEY, scope_key text NOT NULL,
    owner text NOT NULL CHECK(owner IN ('rodion','katya','all')),
    version integer NOT NULL CHECK(version > 0), fingerprint text NOT NULL,
    content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(scope_key, fingerprint), UNIQUE(scope_key, version)
  )`);
}
function snapshot(row: Row): ReportSnapshot {
  return {
    id: String(row.id),
    version: Number(row.version),
    fingerprint: String(row.fingerprint),
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(String(row.created_at))
    ).toISOString(),
    report: row.content as ReportContent,
  };
}

export class Reports {
  constructor(readonly db: Database) {}
  async save(
    transactions: Transaction[],
    options: { owner: ReportOwner; period: ReportPeriod },
  ): Promise<ReportSnapshot> {
    const report = buildReport(transactions, options);
    const scope = hash([report.owner, report.period]);
    const fingerprint = hash(report);
    return this.db.transaction(async (tx) => {
      // Serialize version allocation, including concurrent first-time reruns.
      await tx.query('SELECT pg_advisory_xact_lock(7482393)');
      const existing = await tx.query(
        'SELECT * FROM report_snapshots WHERE scope_key=$1 AND fingerprint=$2',
        [scope, fingerprint],
      );
      if (existing.rows[0]) return snapshot(existing.rows[0]);
      const inserted = await tx.query(
        `INSERT INTO report_snapshots(id,scope_key,owner,version,fingerprint,content)
        SELECT $1,$2,$3,COALESCE(MAX(version),0)+1,$4,$5::jsonb FROM report_snapshots WHERE scope_key=$2 RETURNING *`,
        [
          randomUUID(),
          scope,
          report.owner,
          fingerprint,
          JSON.stringify(report),
        ],
      );
      return snapshot(inserted.rows[0]!);
    });
  }
  async list(owner: ReportOwner): Promise<ReportSnapshot[]> {
    ownerScope(owner);
    const result = await this.db.query(
      'SELECT * FROM report_snapshots WHERE owner=$1 ORDER BY created_at DESC,id',
      [owner],
    );
    return result.rows.map(snapshot);
  }
}
