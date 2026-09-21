// The reading side of classification (docs/analytics.md): the same rows and
// the same conversion the transaction list uses, grouped into time buckets and
// series, with the category tree rolled up and the share each classification
// source decided. Because it is computed from the converted rows themselves,
// a drill link that lists those rows sums to the figure it came from.
import type { Transaction } from './repository.js';
import type { ConvertedSpendingRow } from './analytics.js';
import type { Kind } from './domain.js';
// The members' names live in one place because the demo workspace rewrites
// them, and a chart legend naming the household is exactly what it exists to
// prevent.
import { ownerNames, type AccountOwner } from './account-names.js';

export type Bucket = 'day' | 'week' | 'month';
export type SeriesBy = 'none' | 'category' | 'owner' | 'kind';
export type AnalyticsOptions = {
  bucket: Bucket;
  series: SeriesBy;
  /** Category depth for `series=category`, 1–3. */
  depth: number;
  /** Which kinds count. Spending plus the money not yet placed, by default. */
  kinds: Kind[];
};

const allKinds: Kind[] = [
  'personal_expense',
  'unresolved',
  'internal_transfer',
  'investment',
  'non_personal',
];
export const defaultKinds: Kind[] = ['personal_expense', 'unresolved'];
const kindLabels: Record<Kind, string> = {
  personal_expense: 'Personal expenses',
  unresolved: 'Unresolved',
  internal_transfer: 'Internal transfers',
  investment: 'Investments',
  non_personal: 'Non-personal',
};

export function parseAnalyticsOptions(
  params: URLSearchParams,
): AnalyticsOptions {
  const bucket = params.get('bucket') || 'month';
  if (!['day', 'week', 'month'].includes(bucket))
    throw new Error('invalid_bucket');
  const series = params.get('series') || 'none';
  if (!['none', 'category', 'owner', 'kind'].includes(series))
    throw new Error('invalid_series');
  const depth = Number(params.get('depth') || '1');
  if (!Number.isInteger(depth) || depth < 1 || depth > 3)
    throw new Error('invalid_depth');
  const kinds = params.get('kinds')
    ? params.get('kinds')!.split(',')
    : defaultKinds;
  if (!kinds.length || kinds.some((k) => !allKinds.includes(k as Kind)))
    throw new Error('invalid_kinds');
  return {
    bucket: bucket as Bucket,
    series: series as SeriesBy,
    depth,
    kinds: kinds as Kind[],
  };
}

const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Riga',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function rigaDay(iso: string) {
  return calendar.format(new Date(iso));
}
/** The bucket a Riga day falls in: the day, the Monday of its week, or the month. */
export function bucketOf(day: string, bucket: Bucket) {
  if (bucket === 'month') return day.slice(0, 7);
  if (bucket === 'week') {
    const date = new Date(day + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  }
  return day;
}

type Sum = { netMinor: bigint; count: number; missingFx: number };
const sum = (): Sum => ({ netMinor: 0n, count: 0, missingFx: 0 });
const out = (s: Sum) => ({
  netMinor: s.netMinor.toString(),
  count: s.count,
  missingFx: s.missingFx,
});

export function aggregateSpending(
  rows: Transaction[],
  converted: ConvertedSpendingRow[],
  { bucket, series, depth, kinds }: AnalyticsOptions,
) {
  const byId = new Map(converted.map((r) => [r.id, r]));
  const buckets = new Map<string, Map<string, Sum & { label: string }>>();
  const totals = sum();
  let unresolvedMinor = 0n,
    provisionalMinor = 0n;
  const tree = new Map<
    string,
    Sum & {
      id: string;
      parentId: string | null;
      name: string;
      depth: number;
      provisionalMinor: bigint;
    }
  >();
  const coverage = new Map<string, Sum>();
  // The largest payments, per bucket and over the whole period: what made a
  // heavy month heavy is usually two or three of them, and the screen names
  // them rather than asking a model to guess.
  type Largest = {
    id: string;
    description: string;
    netMinor: string;
    category: string | null;
    bookedAt: string;
    owner: string;
    period: string;
  };
  const candidates: Array<Largest & { amount: bigint }> = [];
  const byAmount = (a: { amount: bigint }, b: { amount: bigint }) =>
    a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0;
  const strip = ({ amount: _, ...rest }: Largest & { amount: bigint }) => rest;
  for (const row of rows) {
    // Outflows only; a personal expense or unresolved payment on an account
    // the owner excluded stays out, exactly as it does in the totals. A kind
    // the caller asked for explicitly — investments, business — is counted
    // wherever it was paid from.
    if (BigInt(row.amountMinor) >= 0n || !kinds.includes(row.kind)) continue;
    if (
      (row.kind === 'personal_expense' || row.kind === 'unresolved') &&
      row.spendingPolicy?.excluded
    )
      continue;
    const net = byId.get(row.id)?.netAmountMinor ?? null;
    const amount = net === null ? null : -BigInt(net);
    const add = (target: Sum) => {
      if (amount === null) target.missingFx++;
      else {
        target.netMinor += amount;
        target.count++;
      }
    };
    const period = bucketOf(rigaDay(row.bookedAt), bucket);
    const parts = (row.category ?? '').split(' / ').filter(Boolean);
    const [key, label] =
      series === 'category'
        ? [
            parts.length ? parts.slice(0, depth).join(' / ') : 'Uncategorized',
            parts.length ? parts.slice(0, depth).join(' / ') : 'Uncategorized',
          ]
        : series === 'owner'
          ? [row.owner, ownerNames()[row.owner as AccountOwner] ?? row.owner]
          : series === 'kind'
            ? [row.kind, kindLabels[row.kind]]
            : ['total', 'Spending'];
    const inBucket = buckets.get(period) ?? new Map();
    buckets.set(period, inBucket);
    const entry = inBucket.get(key) ?? { ...sum(), label };
    inBucket.set(key, entry);
    add(entry);
    add(totals);
    if (amount !== null) {
      if (row.kind === 'unresolved') unresolvedMinor += amount;
      if (row.provisional) provisionalMinor += amount;
      candidates.push({
        id: row.id,
        description: row.description,
        netMinor: amount.toString(),
        category: row.category,
        bookedAt: row.bookedAt,
        owner: row.owner,
        period,
        amount,
      });
    }
    const path = parts.length ? parts : ['Uncategorized'];
    for (let d = 1; d <= path.length; d++) {
      const id = path.slice(0, d).join(' / ');
      const node = tree.get(id) ?? {
        ...sum(),
        id,
        parentId: d > 1 ? path.slice(0, d - 1).join(' / ') : null,
        name: path[d - 1]!,
        depth: d,
        provisionalMinor: 0n,
      };
      tree.set(id, node);
      add(node);
      if (amount !== null && row.provisional) node.provisionalMinor += amount;
    }
    const source = coverage.get(row.classificationSource) ?? sum();
    coverage.set(row.classificationSource, source);
    add(source);
  }
  candidates.sort(byAmount);
  return {
    bucket,
    series,
    buckets: [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, inBucket]) => ({
        period,
        series: [...inBucket]
          .sort(([, a], [, b]) =>
            a.netMinor > b.netMinor ? -1 : a.netMinor < b.netMinor ? 1 : 0,
          )
          .map(([key, entry]) => ({ key, label: entry.label, ...out(entry) })),
        /** The three largest payments of the bucket, largest first. */
        top: candidates
          .filter((c) => c.period === period)
          .slice(0, 3)
          .map(strip),
      })),
    /** The fifteen largest payments of the period, largest first. */
    largest: candidates.slice(0, 15).map(strip),
    totals: {
      ...out(totals),
      unresolvedMinor: unresolvedMinor.toString(),
      provisionalMinor: provisionalMinor.toString(),
    },
    tree: [...tree.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => ({
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        depth: node.depth,
        ...out(node),
        provisionalMinor: node.provisionalMinor.toString(),
      })),
    coverage: Object.fromEntries(
      [...coverage].map(([source, entry]) => [source, out(entry)]),
    ),
  };
}
