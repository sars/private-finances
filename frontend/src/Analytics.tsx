import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo } from 'react';
import { CircleAlert, Inbox, Layers, RefreshCw } from 'lucide-react';
import { apiGet, invalidateFinancialData, useSession } from './lib/query';
import { useSearchPatch, useUrlField } from './lib/navigation';
import { useDisplayCurrency } from './lib/display-currency';
import { periodRange } from './lib/spending-period';
import { money, toNumber } from './lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarList,
  CategoryBar,
  Choice,
  EmptyState,
  Field,
  FilterBar,
  KpiCard,
  PageHeader,
  PeriodPicker,
  TreeTable,
  previousPeriod,
} from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';
import { HistoricalEstimates } from '@/components/historical-estimates';
const BarSeries = lazy(() => import('@/components/charts/BarSeries'));

type Sum = { netMinor: string; count: number; missingFx: number };
type Analytics = {
  currency: string;
  bucket: 'day' | 'week' | 'month';
  series: string;
  buckets: Array<{
    period: string;
    series: Array<Sum & { key: string; label: string }>;
  }>;
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
  coverage: Record<string, Sum>;
};

const defaultKinds = 'personal_expense,unresolved';
const everyKind = 'personal_expense,unresolved,investment,non_personal';
/** Who decided the money, in the three groups the owner asked to see. */
const coverageGroups: Array<{ label: string; sources: string[] }> = [
  {
    label: 'You or your rules',
    sources: ['human', 'rule', 'identity', 'bank', 'bank_worded'],
  },
  { label: 'The model', sources: ['model', 'memory'] },
  { label: 'Placed by default', sources: [] },
];

export default function Analytics() {
  const patch = useSearchPatch();
  const actor = useSession().data?.actor;
  const isMobile = useIsMobile();
  const { currency: display } = useDisplayCurrency();
  const defaults = periodRange('year');
  const [from] = useUrlField('from', defaults[0]!);
  const [to] = useUrlField('to', defaults[1]!);
  const [owner, setOwner] = useUrlField('owner', 'all');
  const [bucket, setBucket] = useUrlField('bucket', 'month');
  const [series, setSeries] = useUrlField('series', 'category');
  const [depth, setDepth] = useUrlField('depth', '1');
  const [others, setOthers] = useUrlField('others', 'hidden');
  const period = { from, to };
  const before = previousPeriod(period);
  const params = (range: { from: string; to: string }) => {
    const p = new URLSearchParams({ display, bucket, depth });
    p.set('series', others === 'separate' ? 'kind' : series);
    p.set('kinds', others === 'hidden' ? defaultKinds : everyKind);
    if (owner !== 'all') p.set('owner', owner);
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    return p.toString();
  };
  const current = useQuery({
    queryKey: ['analytics', actor, params(period)],
    enabled: Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<Analytics>('/api/analytics?' + params(period), signal),
    placeholderData: (previous) => previous,
  });
  const earlier = useQuery({
    queryKey: ['analytics', actor, before ? params(before) : null],
    enabled: Boolean(actor && before),
    queryFn: ({ signal }) =>
      apiGet<Analytics>('/api/analytics?' + params(before!), signal),
  });
  const data = current.data;
  const currency = data?.currency ?? display;

  // Home speaks the same grammar for a category prefix and a period, and its
  // totals come from the same conversion, so a row here drills to the payments
  // that made it.
  const drill = (category?: string) => {
    const p = new URLSearchParams({ display });
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (owner !== 'all') p.set('owner', owner);
    if (category && category !== 'Uncategorized') p.set('category', category);
    return `/?${p.toString()}`;
  };

  // The chart keeps the five largest series and folds the rest into one, so
  // every bucket still stacks to its total.
  const chart = useMemo(() => {
    if (!data)
      return { rows: [], series: [] as { key: string; label: string }[] };
    const totals = new Map<string, { label: string; net: bigint }>();
    for (const b of data.buckets)
      for (const s of b.series) {
        const t = totals.get(s.key) ?? { label: s.label, net: 0n };
        t.net += BigInt(s.netMinor);
        totals.set(s.key, t);
      }
    const ranked = [...totals].sort(([, a], [, b]) =>
      a.net > b.net ? -1 : a.net < b.net ? 1 : 0,
    );
    const kept = ranked
      .slice(0, 5)
      .map(([key, t]) => ({ key, label: t.label }));
    const folded = ranked.length > 5;
    const keys = folded
      ? [...kept, { key: 'other', label: 'Everything else' }]
      : kept;
    const rows = data.buckets.map((b) => {
      const row: Record<string, string | number> = { period: b.period };
      const minor = new Map<string, bigint>();
      for (const s of b.series) {
        const key = kept.some((k) => k.key === s.key) ? s.key : 'other';
        minor.set(key, (minor.get(key) ?? 0n) + BigInt(s.netMinor));
      }
      for (const { key } of keys) {
        const m = minor.get(key) ?? 0n;
        row[key] = toNumber(m.toString(), data.currency);
        row[`minor:${key}`] = m.toString();
      }
      return row;
    });
    return { rows, series: keys };
  }, [data]);
  const periodLabel = (p: string) =>
    data?.bucket === 'month'
      ? p
      : data?.bucket === 'week'
        ? `wk ${p.slice(5)}`
        : p.slice(5);

  const topCategories = useMemo(
    () =>
      (data?.tree ?? [])
        .filter((n) => n.depth === 1)
        .sort((a, b) => (BigInt(a.netMinor) > BigInt(b.netMinor) ? -1 : 1))
        .slice(0, 8)
        .map((n) => ({ name: n.name, minor: n.netMinor, href: drill(n.id) })),
    [data, from, to, owner, display],
  );
  const coverage = useMemo(() => {
    if (!data) return [];
    const grouped = coverageGroups.map((g) => ({ ...g, net: 0n, count: 0 }));
    for (const [source, s] of Object.entries(data.coverage)) {
      const group =
        grouped.find((g) => g.sources.includes(source)) ?? grouped[2]!;
      group.net += BigInt(s.netMinor);
      group.count += s.count;
    }
    return grouped.map((g) => ({ label: g.label, value: Number(g.net) }));
  }, [data]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <PageHeader
        title="Spending analytics"
        description="Where the money went, by period and by category, with every figure a step from the payments behind it."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void invalidateFinancialData()}
            disabled={current.isFetching}
          >
            <RefreshCw className={current.isFetching ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />
      <PeriodPicker
        value={period}
        onChange={(next) => patch({ from: next.from, to: next.to })}
      />
      <FilterBar>
        <Field label="Buckets" htmlFor="analytics-bucket">
          <Choice
            id="analytics-bucket"
            className="w-full sm:w-32"
            value={bucket}
            onChange={setBucket}
            options={[
              { value: 'day', label: 'Days' },
              { value: 'week', label: 'Weeks' },
              { value: 'month', label: 'Months' },
            ]}
          />
        </Field>
        <Field label="Split by" htmlFor="analytics-series">
          <Choice
            id="analytics-series"
            className="w-full sm:w-40"
            value={series}
            onChange={setSeries}
            disabled={others === 'separate'}
            options={[
              { value: 'none', label: 'Nothing' },
              { value: 'category', label: 'Category' },
              { value: 'owner', label: 'Person' },
            ]}
          />
        </Field>
        {series === 'category' && others !== 'separate' && (
          <Field label="Category depth" htmlFor="analytics-depth">
            <Choice
              id="analytics-depth"
              className="w-full sm:w-32"
              value={depth}
              onChange={setDepth}
              options={[
                { value: '1', label: 'Branches' },
                { value: '2', label: 'Two levels' },
                { value: '3', label: 'Leaves' },
              ]}
            />
          </Field>
        )}
        <Field label="Investments & business" htmlFor="analytics-others">
          <Choice
            id="analytics-others"
            className="w-full sm:w-44"
            value={others}
            onChange={setOthers}
            options={[
              { value: 'hidden', label: 'Hidden' },
              { value: 'included', label: 'Included in the total' },
              { value: 'separate', label: 'Their own series' },
            ]}
          />
        </Field>
        <Field label="Person" htmlFor="analytics-owner">
          <Choice
            id="analytics-owner"
            className="w-full sm:w-36"
            value={owner}
            onChange={setOwner}
            options={[
              { value: 'all', label: 'Together' },
              { value: 'rodion', label: 'Rodion' },
              { value: 'katya', label: 'Katya' },
            ]}
          />
        </Field>
      </FilterBar>
      {current.isPending ? (
        <div role="status" aria-label="Loading analytics" className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((n) => (
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
      ) : data && !data.totals.count && !data.totals.missingFx ? (
        <Card className="shadow-xs">
          <EmptyState
            icon={Inbox}
            title="Nothing in this period"
            text="No outflows match the period and filters. Widen the period or include the other kinds of money."
          />
        </Card>
      ) : data ? (
        <>
          <section aria-label="Totals" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Converted to {currency} · daily rates
              {before ? ` · compared with ${before.from} – ${before.to}` : ''}
              {data.totals.missingFx
                ? ` · ${data.totals.missingFx} payments have no rate and are missing from every figure`
                : ''}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <KpiCard
                label="Spent"
                minor={data.totals.netMinor}
                previousMinor={earlier.data?.totals.netMinor ?? null}
                currency={currency}
                note={`${data.totals.count} payments`}
                href={drill()}
              />
              <KpiCard
                label="Not yet placed"
                minor={data.totals.unresolvedMinor}
                previousMinor={earlier.data?.totals.unresolvedMinor ?? null}
                currency={currency}
                note="Unresolved outflows inside the total"
                href={`/review?all=0&window=all&display=${display}`}
              />
              <KpiCard
                label="Placed provisionally"
                minor={data.totals.provisionalMinor}
                previousMinor={earlier.data?.totals.provisionalMinor ?? null}
                currency={currency}
                note="Counted where the evidence pointed, still to confirm"
                icon={Layers}
              />
            </div>
          </section>
          <Card className="shadow-xs">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Who decided the money
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Share of the total by who classified it
              </p>
            </CardHeader>
            <CardContent>
              <CategoryBar segments={coverage} />
            </CardContent>
          </Card>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="min-w-0 shadow-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Spending over time
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {data.bucket === 'month'
                    ? 'Monthly'
                    : data.bucket === 'week'
                      ? 'Weekly, from Monday'
                      : 'Daily'}{' '}
                  · Europe/Riga
                  {chart.series.length > 1
                    ? ` · stacked by ${others === 'separate' ? 'kind' : series === 'owner' ? 'person' : 'category'}`
                    : ''}
                </p>
              </CardHeader>
              <CardContent>
                {chart.rows.length ? (
                  <div
                    className="mt-2 h-56 w-full sm:h-72"
                    role="img"
                    aria-label={`${data.bucket} spending in ${currency}. Total ${money(data.totals.netMinor, currency)}.`}
                  >
                    <Suspense
                      fallback={
                        <div className="h-full w-full animate-pulse rounded-md bg-muted" />
                      }
                    >
                      <BarSeries
                        data={chart.rows}
                        index="period"
                        series={chart.series}
                        formatValue={(_, key, row) =>
                          money(String(row[`minor:${key}`] ?? '0'), currency)
                        }
                        formatIndex={periodLabel}
                        formatHeading={(p) => p}
                        showYAxis={!isMobile}
                        minTickGap={isMobile ? 48 : 28}
                      />
                    </Suspense>
                  </div>
                ) : (
                  <EmptyState
                    icon={Inbox}
                    title="No converted spending to chart"
                    className="h-56"
                  />
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0 shadow-xs">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Largest branches
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
          <HistoricalEstimates
            from={from}
            to={to}
            owner={owner}
            display={display}
          />
        </>
      ) : null}
    </div>
  );
}
