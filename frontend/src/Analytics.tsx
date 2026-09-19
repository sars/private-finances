import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState } from 'react';
import { CircleAlert, Inbox } from 'lucide-react';
import { apiGet, useSession } from './lib/query';
import { useSearchPatch, useUrlField } from './lib/navigation';
import { useDisplayCurrency } from './lib/display-currency';
import { periodRange, rigaToday } from './lib/spending-period';
import { money, toNumber } from './lib/format';
import { owners } from './lib/account-visuals';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarList,
  BucketBars,
  Choice,
  EmptyState,
  Field,
  FilterBar,
  HeatGrid,
  KpiCard,
  PageHeader,
  PeriodPicker,
  RefreshButton,
  TreeTable,
  type BucketBar,
  type HeatRow,
} from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';
const BarSeries = lazy(() => import('@/components/charts/BarSeries'));

type Sum = { netMinor: string; count: number; missingFx: number };
type Largest = {
  id: string;
  description: string;
  netMinor: string;
  category: string | null;
  bookedAt: string;
  owner: 'rodion' | 'katya';
  period: string;
};
type Analytics = {
  currency: string;
  bucket: 'day' | 'week' | 'month';
  buckets: Array<{
    period: string;
    series: Array<Sum & { key: string; label: string }>;
    top: Largest[];
  }>;
  largest: Largest[];
  totals: Sum & { unresolvedMinor: string; provisionalMinor: string };
  tree: Array<
    Sum & {
      id: string;
      parentId: string | null;
      name: string;
      depth: number;
      provisionalMinor: string;
    }
  >;
};
type BucketKind = Analytics['bucket'];

const defaultKinds = 'personal_expense,unresolved';
const everyKind = 'personal_expense,unresolved,investment,non_personal';

// ---- calendar arithmetic on Riga days ("YYYY-MM-DD"), no zones involved ----
const dayOf = (day: string) => new Date(day + 'T12:00:00Z');
const toDay = (d: Date) => d.toISOString().slice(0, 10);
function shiftDays(day: string, n: number) {
  const d = dayOf(day);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}
function daysBetween(from: string, to: string) {
  return Math.round((dayOf(to).getTime() - dayOf(from).getTime()) / 86_400_000);
}
function monthEnd(month: string) {
  const [y, m] = month.split('-').map(Number);
  return toDay(new Date(Date.UTC(y!, m!, 0, 12)));
}
/** The first and last Riga day a bucket key covers. */
function bucketRange(key: string, bucket: BucketKind): [string, string] {
  if (bucket === 'month') return [key + '-01', monthEnd(key)];
  if (bucket === 'week') return [key, shiftDays(key, 6)];
  return [key, key];
}
/** Every bucket key from `from` to `to`, so a day without spending still shows
 * as an empty bar rather than vanishing from the row. */
function allBucketKeys(from: string, to: string, bucket: BucketKind) {
  const keys: string[] = [];
  let cursor =
    bucket === 'month'
      ? from.slice(0, 7)
      : bucket === 'week'
        ? shiftDays(from, -((dayOf(from).getUTCDay() + 6) % 7))
        : from;
  const end = bucket === 'month' ? to.slice(0, 7) : to;
  while (cursor <= end && keys.length < 400) {
    keys.push(cursor);
    cursor =
      bucket === 'month'
        ? toDay(
            new Date(
              Date.UTC(
                Number(cursor.slice(0, 4)),
                Number(cursor.slice(5, 7)),
                1,
                12,
              ),
            ),
          ).slice(0, 7)
        : shiftDays(cursor, bucket === 'week' ? 7 : 1);
  }
  return keys;
}
/** Which bucket size a period asks for when none is chosen. */
function autoBucket(from: string, to: string): BucketKind {
  const span = daysBetween(from, to) + 1;
  return span <= 45 ? 'day' : span <= 126 ? 'week' : 'month';
}
const monthShort = new Intl.DateTimeFormat('en-GB', { month: 'short' });
const monthLong = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
});
const dayShort = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
});
function bucketLabel(key: string, bucket: BucketKind, manyYears: boolean) {
  if (bucket === 'month')
    return manyYears
      ? `${monthShort.format(dayOf(key + '-01'))} ${key.slice(0, 4)}`
      : monthShort.format(dayOf(key + '-01'));
  if (bucket === 'week') return `wk ${dayShort.format(dayOf(key))}`;
  return dayShort.format(dayOf(key));
}
const bucketNoun: Record<BucketKind, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};
const isWeekend = (day: string) => [0, 6].includes(dayOf(day).getUTCDay());
const big = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);
const sumMinor = (values: Iterable<string>) => {
  let n = 0n;
  for (const v of values) n += BigInt(v);
  return n;
};

export default function Analytics() {
  const patch = useSearchPatch();
  const actor = useSession().data?.actor;
  const isMobile = useIsMobile();
  const { currency: display } = useDisplayCurrency();
  const defaults = periodRange('year');
  const [from] = useUrlField('from', defaults[0]!);
  const [to] = useUrlField('to', defaults[1]!);
  const [owner, setOwner] = useUrlField('owner', 'all');
  const [bucketChoice, setBucketChoice] = useUrlField('bucket', 'auto');
  const [others, setOthers] = useUrlField('others', 'hidden');
  const period = { from, to };
  const bucket: BucketKind =
    bucketChoice === 'day' ||
    bucketChoice === 'week' ||
    bucketChoice === 'month'
      ? bucketChoice
      : autoBucket(from, to);
  const today = rigaToday();

  const params = (range: { from: string; to: string }, b: BucketKind) => {
    const p = new URLSearchParams({
      display,
      bucket: b,
      series: 'category',
      depth: '2',
    });
    p.set('kinds', others === 'hidden' ? defaultKinds : everyKind);
    if (owner !== 'all') p.set('owner', owner);
    p.set('from', range.from);
    p.set('to', range.to);
    return p.toString();
  };
  const current = useQuery({
    queryKey: ['analytics', actor, params(period, bucket)],
    enabled: Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<Analytics>('/api/analytics?' + params(period, bucket), signal),
    placeholderData: (previous) => previous,
  });
  // A period inside one calendar year is read against that year's months, so
  // a single month can be compared with the average of the others.
  const year = from.slice(0, 4);
  const yearRange = {
    from: `${year}-01-01`,
    to: `${year}-12-31` < today ? `${year}-12-31` : today,
  };
  const wantsContext =
    to.slice(0, 4) === year &&
    !(from === yearRange.from && to === yearRange.to) &&
    bucket !== 'month';
  const context = useQuery({
    queryKey: ['analytics', actor, params(yearRange, 'month')],
    enabled: Boolean(actor) && wantsContext,
    queryFn: ({ signal }) =>
      apiGet<Analytics>('/api/analytics?' + params(yearRange, 'month'), signal),
  });
  const data = current.data;
  const currency = data?.currency ?? display;

  // Transactions speaks the same grammar for a category prefix, a period and a
  // member, and lists the household through the same conversion, so every
  // figure here drills to the payments that made it.
  const drill = (category?: string, range?: [string, string]) => {
    const p = new URLSearchParams({ display });
    p.set('from', range ? range[0] : from);
    p.set('to', range ? range[1] : to);
    if (owner !== 'all') p.set('who', owner);
    if (category && category !== 'Uncategorized') p.set('category', category);
    return `/transactions?${p.toString()}`;
  };

  const view = useMemo(() => {
    if (!data) return null;
    const b = data.bucket;
    const manyYears = from.slice(0, 4) !== to.slice(0, 4);
    const present = new Map(data.buckets.map((x) => [x.period, x]));
    const filled = allBucketKeys(from, to, b).map(
      (period) =>
        present.get(period) ?? { period, series: [], top: [] as Largest[] },
    );
    // Keys the server returned but the calendar walk missed (never expected)
    // are kept rather than dropped.
    for (const entry of data.buckets)
      if (!filled.some((x) => x.period === entry.period)) filled.push(entry);
    const buckets = filled.map((entry) => {
      const [start, end] = bucketRange(entry.period, b);
      const cut = end > to ? to : end;
      const partial = end > to || end >= today;
      return {
        key: entry.period,
        label: bucketLabel(entry.period, b, manyYears),
        long: b === 'month' ? monthLong.format(dayOf(start)) : undefined,
        minor: sumMinor(entry.series.map((s) => s.netMinor)).toString(),
        partial,
        note: partial
          ? b === 'day'
            ? 'today'
            : `to ${dayShort.format(dayOf(cut < today ? cut : today))}`
          : undefined,
        range: [start, cut] as [string, string],
        series: entry.series,
        top: entry.top,
      };
    });
    const full = buckets.filter((x) => !x.partial);
    const average =
      full.length > 0
        ? (sumMinor(full.map((x) => x.minor)) / BigInt(full.length)).toString()
        : null;
    const ranked = [...full].sort((x, y) =>
      big(BigInt(x.minor), BigInt(y.minor)),
    );
    const hot = new Set(
      (full.length >= 4 ? ranked.slice(0, 3) : []).map((x) => x.key),
    );
    const biggest = ranked[0] ?? buckets[0] ?? null;

    // Categories, rolled up from the depth-two series to their branch, with
    // the branch's own parts kept for the row that opens.
    const branchTotal = new Map<string, bigint>();
    const cell = new Map<string, Map<string, bigint>>(); // branch → bucket → minor
    const leafCell = new Map<string, Map<string, bigint>>(); // leaf → bucket
    const leavesOf = new Map<string, Set<string>>();
    for (const entry of buckets)
      for (const s of entry.series) {
        const branch = s.key.split(' / ')[0]!;
        const minor = BigInt(s.netMinor);
        branchTotal.set(branch, (branchTotal.get(branch) ?? 0n) + minor);
        const row = cell.get(branch) ?? new Map();
        cell.set(branch, row);
        row.set(entry.key, (row.get(entry.key) ?? 0n) + minor);
        if (s.key !== branch) {
          const leaves = leavesOf.get(branch) ?? new Set();
          leavesOf.set(branch, leaves);
          leaves.add(s.key);
          const leafRow = leafCell.get(s.key) ?? new Map();
          leafCell.set(s.key, leafRow);
          leafRow.set(entry.key, (leafRow.get(entry.key) ?? 0n) + minor);
        }
      }
    const branches = [...branchTotal]
      .sort(([, x], [, y]) => big(x, y))
      .map(([name]) => name);
    const cells = (row: Map<string, bigint> | undefined) =>
      Object.fromEntries([...(row ?? [])].map(([k, v]) => [k, v.toString()]));
    const gridRows: HeatRow[] = branches.slice(0, 12).map((branch) => ({
      key: branch,
      label: branch,
      cells: cells(cell.get(branch)),
      href: (column) =>
        drill(branch, buckets.find((x) => x.key === column)?.range),
      children: [...(leavesOf.get(branch) ?? [])]
        .sort((x, y) =>
          big(
            sumMinor([...(leafCell.get(x)?.values() ?? [])].map(String)),
            sumMinor([...(leafCell.get(y)?.values() ?? [])].map(String)),
          ),
        )
        .map((leaf) => ({
          key: leaf,
          label: leaf.slice(branch.length + 3),
          cells: cells(leafCell.get(leaf)),
          href: (column: string) =>
            drill(leaf, buckets.find((x) => x.key === column)?.range),
        })),
    }));

    // What made the heaviest buckets heavy: the branches that ran above their
    // own average across the full buckets, and the largest payments.
    const drivers =
      full.length >= 3
        ? ranked.slice(0, 3).map((entry) => {
            const above = branches
              .map((branch) => {
                const here = cell.get(branch)?.get(entry.key) ?? 0n;
                const avg =
                  sumMinor(
                    full.map((x) =>
                      (cell.get(branch)?.get(x.key) ?? 0n).toString(),
                    ),
                  ) / BigInt(full.length);
                return { branch, here, delta: here - avg };
              })
              .filter((x) => x.delta > 0n)
              .sort((x, y) => big(x.delta, y.delta))
              .slice(0, 3);
            return {
              ...entry,
              delta:
                average === null
                  ? null
                  : Number(
                      ((BigInt(entry.minor) - BigInt(average)) * 1000n) /
                        (BigInt(average) || 1n),
                    ) / 10,
              above,
            };
          })
        : [];
    return {
      buckets,
      full,
      average,
      hot,
      biggest,
      gridRows,
      drivers,
      branches,
    };
  }, [data, from, to, today, owner, display]);

  // One month against the average of the year's other full months.
  const comparison = useMemo(() => {
    if (!data || !context.data || !view) return null;
    const monthKey = from.slice(0, 7);
    if (from !== monthKey + '-01' || to !== monthEnd(monthKey)) return null;
    const others = context.data.buckets
      .filter((x) => x.period !== monthKey)
      .filter((x) => monthEnd(x.period) < today)
      .map((x) => sumMinor(x.series.map((s) => s.netMinor)));
    if (!others.length) return null;
    return {
      averageMinor: (
        others.reduce((n, v) => n + v, 0n) / BigInt(others.length)
      ).toString(),
      months: others.length,
    };
  }, [data, context.data, view, from, to, today]);

  const [largestBucket, setLargestBucket] = useState<string>('all');
  const largest = (data?.largest ?? []).filter(
    (item) => largestBucket === 'all' || item.period === largestBucket,
  );
  const topCategories = useMemo(
    () =>
      (data?.tree ?? [])
        .filter((n) => n.depth === 1)
        .sort((a, b) => big(BigInt(a.netMinor), BigInt(b.netMinor)))
        .slice(0, 8)
        .map((n) => ({ name: n.name, minor: n.netMinor, href: drill(n.id) })),
    [data, from, to, owner, display],
  );
  const chartRows = useMemo(
    () =>
      (view?.buckets ?? []).map((x) => ({
        period: x.key,
        total: toNumber(x.minor, currency),
        'minor:total': x.minor,
      })),
    [view, currency],
  );
  const useBars = (view?.buckets.length ?? 0) <= 14;
  const noun = bucketNoun[bucket];
  const whoLabel =
    owner === 'all' ? 'Both of us' : owners[owner as 'rodion' | 'katya'].name;

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-8">
      <PageHeader
        title="Spending analytics"
        description="Where the money went, with every figure a step from the payments behind it."
        actions={<RefreshButton />}
      />
      <FilterBar className="border-0 bg-transparent p-0">
        <Field hideLabel label="Period" className="basis-full sm:basis-auto">
          <PeriodPicker
            size="default"
            className="max-w-full"
            value={period}
            onChange={(next) => patch({ from: next.from, to: next.to })}
          />
        </Field>
        <Field hideLabel label="Whose" htmlFor="analytics-owner">
          <Choice
            id="analytics-owner"
            className="w-full sm:w-36"
            value={owner}
            onChange={setOwner}
            options={[
              { value: 'all', label: 'Both of us' },
              { value: 'rodion', label: owners.rodion.name },
              { value: 'katya', label: owners.katya.name },
            ]}
          />
        </Field>
        <Field hideLabel label="By" htmlFor="analytics-bucket">
          <Choice
            id="analytics-bucket"
            className="w-full sm:w-36"
            value={bucketChoice}
            onChange={setBucketChoice}
            options={[
              { value: 'auto', label: `Auto · ${noun}s` },
              { value: 'day', label: 'Days' },
              { value: 'week', label: 'Weeks' },
              { value: 'month', label: 'Months' },
            ]}
          />
        </Field>
        <Field
          hideLabel
          label="Investments & business"
          htmlFor="analytics-others"
        >
          <Choice
            id="analytics-others"
            className="w-full sm:w-40"
            value={others}
            onChange={setOthers}
            // The label above these is off the screen now, so the values carry
            // it: "Hidden" alone on a button says nothing about what is hidden.
            options={[
              { value: 'hidden', label: 'Personal only' },
              { value: 'included', label: 'With investments' },
            ]}
          />
        </Field>
      </FilterBar>
      {current.isPending ? (
        <div role="status" aria-label="Loading analytics" className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-28 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-lg" />
        </div>
      ) : current.error ? (
        <Card className="shadow-xs">
          <EmptyState
            icon={CircleAlert}
            title="Analytics unavailable"
            text={current.error.message}
            action={
              <Button variant="outline" onClick={() => void current.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : data && view && !data.totals.count && !data.totals.missingFx ? (
        <Card className="shadow-xs">
          <EmptyState
            icon={Inbox}
            title="Nothing in this period"
            text="No outflows match the period and filters. Widen the period or include the other kinds of money."
          />
        </Card>
      ) : data && view ? (
        <>
          <section aria-label="Totals" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {from} – {to} · {whoLabel} · converted to {currency} at daily
              rates
              {data.totals.missingFx
                ? ` · ${data.totals.missingFx} ${data.totals.missingFx === 1 ? 'payment has' : 'payments have'} no rate and ${data.totals.missingFx === 1 ? 'is' : 'are'} missing from every figure`
                : ''}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label="Spent"
                minor={data.totals.netMinor}
                previousMinor={comparison?.averageMinor ?? null}
                previousLabel={
                  comparison
                    ? `the average of the other ${comparison.months} full months`
                    : undefined
                }
                currency={currency}
                note={`${data.totals.count} payments`}
                href={drill()}
              />
              <KpiCard
                label={`Average full ${noun}`}
                minor={view.average ?? '0'}
                currency={currency}
                note={
                  view.full.length
                    ? `${view.full.length} full ${noun}${view.full.length === 1 ? '' : 's'}${view.buckets.length > view.full.length ? ', the open one left out' : ''}`
                    : `No full ${noun} in this period yet`
                }
              />
              <KpiCard
                label={`Biggest ${noun}`}
                minor={view.biggest?.minor ?? '0'}
                currency={currency}
                note={
                  view.biggest
                    ? (view.biggest.long ?? view.biggest.label) +
                      (view.average && view.biggest.minor !== '0'
                        ? ` · ${Math.round(Number((BigInt(view.biggest.minor) * 100n) / (BigInt(view.average) || 1n)) - 100)}% against the average`
                        : '')
                    : '—'
                }
                href={
                  view.biggest
                    ? drill(undefined, view.biggest.range)
                    : undefined
                }
              />
              <KpiCard
                label="Not yet placed"
                minor={data.totals.unresolvedMinor}
                currency={currency}
                note="Unresolved outflows inside the total"
                href={`/review?who=all&display=${display}`}
              />
            </div>
          </section>

          <Card className="shadow-xs">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {noun === 'month'
                  ? 'Month by month'
                  : noun === 'week'
                    ? 'Week by week'
                    : 'Day by day'}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {useBars
                  ? `The rule marks the average full ${noun}${view.hot.size ? '; the heaviest are in colour' : ''}${view.buckets.some((x) => x.partial) ? '; the open one is hatched' : ''}. Each bar opens its payments.`
                  : `The dashed line is the average full ${noun}${bucket === 'day' ? '; weekends are shaded' : ''}. Tap a bar for its figure.`}
              </p>
            </CardHeader>
            <CardContent>
              {useBars ? (
                <BucketBars
                  currency={currency}
                  averageMinor={view.average}
                  rows={view.buckets.map((x): BucketBar => ({
                    key: x.key,
                    label: x.label,
                    minor: x.minor,
                    partial: x.partial,
                    note: x.note,
                    hot: view.hot.has(x.key),
                    href: drill(undefined, x.range),
                  }))}
                />
              ) : (
                <div
                  className="mt-2 h-56 w-full sm:h-72"
                  role="img"
                  aria-label={`${noun}ly spending in ${currency}. Total ${money(data.totals.netMinor, currency)}.`}
                >
                  <Suspense
                    fallback={
                      <div className="h-full w-full animate-pulse rounded-md bg-muted" />
                    }
                  >
                    <BarSeries
                      data={chartRows}
                      index="period"
                      series={[{ key: 'total', label: 'Spending' }]}
                      formatValue={(_, __, row) =>
                        money(String(row['minor:total'] ?? '0'), currency)
                      }
                      formatIndex={(p) =>
                        bucket === 'day'
                          ? p.slice(8)
                          : bucketLabel(p, bucket, false)
                      }
                      formatHeading={(p) =>
                        bucket === 'day'
                          ? dayShort.format(dayOf(p))
                          : bucketLabel(p, bucket, true)
                      }
                      showYAxis={!isMobile}
                      minTickGap={isMobile ? 40 : 24}
                      reference={
                        view.average
                          ? {
                              value: toNumber(view.average, currency),
                              label: `average ${noun}`,
                            }
                          : undefined
                      }
                      shaded={bucket === 'day' ? isWeekend : undefined}
                    />
                  </Suspense>
                </div>
              )}
            </CardContent>
          </Card>

          {view.drivers.length > 0 && (
            <Card className="shadow-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  What made the heaviest {noun}s heavy
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  The categories that ran above their own average, and the
                  largest payments. Everything links to the payments.
                </p>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                {view.drivers.map((d) => (
                  <div
                    key={d.key}
                    className="min-w-0 space-y-3 rounded-lg border p-4"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <a
                        href={drill(undefined, d.range)}
                        className="min-w-0 break-words text-sm font-medium hover:underline"
                      >
                        {d.long ?? d.label}
                      </a>
                      <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums">
                        {money(d.minor, currency)}
                        {d.delta !== null && (
                          <span
                            className={
                              'ml-1.5 text-xs font-medium ' +
                              (d.delta > 0 ? 'text-negative' : 'text-positive')
                            }
                          >
                            {d.delta > 0 ? '+' : ''}
                            {d.delta}%
                          </span>
                        )}
                      </span>
                    </div>
                    {d.above.length > 0 && (
                      <ul className="space-y-1 text-xs">
                        {d.above.map((a) => (
                          <li
                            key={a.branch}
                            className="flex items-baseline justify-between gap-2"
                          >
                            <a
                              href={drill(a.branch, d.range)}
                              className="min-w-0 flex-1 truncate hover:underline"
                              title={`${a.branch} · ${money(a.here.toString(), currency)} this ${noun}`}
                            >
                              {a.branch}
                            </a>
                            <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                              +{money(a.delta.toString(), currency)} over usual
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {d.top.length > 0 && (
                      <ul className="space-y-1 border-t pt-2 text-xs">
                        {d.top.map((t) => (
                          <li
                            key={t.id}
                            className="flex items-baseline justify-between gap-2"
                          >
                            <a
                              href={`/transactions/${encodeURIComponent(t.id)}?display=${display}`}
                              className="min-w-0 truncate hover:underline"
                              title={t.description || 'Payment'}
                            >
                              {t.description || 'Payment'}
                            </a>
                            <span className="shrink-0 whitespace-nowrap font-medium tabular-nums">
                              {money(t.netMinor, currency)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card className="shadow-xs">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Every category, every {noun}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Darker means more. Open a category for its parts; every figure
                opens the payments behind it.
              </p>
            </CardHeader>
            <CardContent className="px-0 pb-0 sm:px-6 sm:pb-6">
              {isMobile ? (
                <HeatGrid
                  currency={currency}
                  totalLabel="All"
                  columns={view.branches.slice(0, 6).map((b) => ({
                    key: b,
                    label: b.length > 9 ? b.slice(0, 8) + '…' : b,
                  }))}
                  rows={view.buckets.map((x) => ({
                    key: x.key,
                    label: x.label,
                    cells: Object.fromEntries(
                      view.branches
                        .slice(0, 6)
                        .map((b) => [
                          b,
                          view.gridRows.find((r) => r.key === b)?.cells[
                            x.key
                          ] ?? '0',
                        ]),
                    ),
                    href: (branch) => drill(branch, x.range),
                  }))}
                  className="rounded-none border-x-0 sm:rounded-lg sm:border-x"
                />
              ) : (
                <HeatGrid
                  currency={currency}
                  columns={view.buckets.map((x) => ({
                    key: x.key,
                    label: x.label,
                  }))}
                  rows={view.gridRows}
                />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Card className="min-w-0 shadow-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Where it went
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Each opens the payments behind it
                </p>
              </CardHeader>
              <CardContent>
                {topCategories.length ? (
                  <BarList rows={topCategories} currency={currency} />
                ) : (
                  <EmptyState
                    icon={Inbox}
                    title="No categories yet"
                    className="h-40"
                  />
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0 shadow-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Biggest payments
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  The fifteen largest in the period, by {noun}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {[
                    { key: 'all', label: 'Whole period' },
                    ...view.buckets
                      .filter((x) =>
                        data.largest.some((l) => l.period === x.key),
                      )
                      .map((x) => ({ key: x.key, label: x.label })),
                  ].map((chip) => (
                    <Button
                      key={chip.key}
                      size="sm"
                      variant={
                        largestBucket === chip.key ? 'secondary' : 'ghost'
                      }
                      aria-pressed={largestBucket === chip.key}
                      onClick={() => setLargestBucket(chip.key)}
                    >
                      {chip.label}
                    </Button>
                  ))}
                </div>
                <ul className="divide-y text-sm">
                  {largest.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-baseline justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <a
                          href={`/transactions/${encodeURIComponent(item.id)}?display=${display}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {item.description || 'Payment'}
                        </a>
                        <p className="truncate text-xs text-muted-foreground">
                          {dayShort.format(new Date(item.bookedAt))} ·{' '}
                          {owners[item.owner].name} ·{' '}
                          {item.category ?? 'No category yet'}
                        </p>
                      </div>
                      <span className="shrink-0 font-semibold tabular-nums">
                        {money(item.netMinor, currency)}
                      </span>
                    </li>
                  ))}
                  {!largest.length && (
                    <li className="py-4 text-xs text-muted-foreground">
                      Nothing in this {noun}.
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>
          </div>

          <Card className="shadow-xs">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Every category, rolled up
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                A branch shows the total of everything under it; open it for the
                parts. Names link to the payments.
              </p>
            </CardHeader>
            <CardContent>
              <TreeTable
                currency={currency}
                rows={data.tree.map((n) => ({
                  id: n.id,
                  parentId: n.parentId,
                  name: n.name,
                  minor: n.netMinor,
                  count: n.count,
                  missingFx: n.missingFx,
                  href: drill(n.id),
                }))}
              />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
