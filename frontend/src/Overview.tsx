import { useUrlField, useSearchPatch } from './lib/navigation';
import { useSession } from './lib/query';
import { periodRange } from './lib/spending-period';
import { useDisplayCurrency } from './lib/display-currency';
import LlmBudget from './LlmBudget';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  CircleAlert,
  Clock3,
  History,
  Inbox,
  RefreshCw,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react';
import { money, toNumber } from './lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarList,
  Choice,
  EmptyState,
  Field,
  FilterBar,
  KpiCard,
  Money,
  PageHeader,
  PeriodPicker,
  previousPeriod,
} from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';
const BarSeries = lazy(() => import('@/components/charts/BarSeries'));

type Transaction = {
  id: string;
  revision?: number;
  spendingPattern?: { pattern: string; needsReview: boolean };
  owner: 'rodion' | 'katya';
  bookedAt: string;
  currency: string;
  amountMinor: string;
  description: string;
  kind: string;
  category: string | null;
  status?: 'pending' | 'booked';
  spendingPolicy?: {
    excluded: boolean;
    reason: 'business_account' | 'investment_account' | null;
    accountLabel: string | null;
    accountPurpose: 'personal' | 'business' | 'investment' | 'unreviewed';
  };
  storedClassification?: { kind: string; category: string | null };
  refund?: { fullyReduced: boolean };
};
type Reporting = {
  currency: string;
  confirmedMinor: string;
  unresolvedMinor: string;
  pendingMinor: string;
  coverage: Record<
    'confirmed' | 'unresolved' | 'pending',
    { converted: number; missing: number }
  >;
  rows: {
    id: string;
    convertedAmountMinor: string | null;
    /** What the payment cost after any refund against it. */
    netAmountMinor: string | null;
    counted: string;
  }[];
};
type Point = { name: string; value: number; minor: string };
type Totals = Pick<
  Reporting,
  'confirmedMinor' | 'unresolvedMinor' | 'pendingMinor'
>;

async function fetchOverview(
  query: string,
  display: string,
  signal: AbortSignal,
) {
  const response = await fetch(`/api/overview?${query}&display=${display}`, {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Your session needs attention. Reload the page to sign in again.'
        : 'We couldn’t load your overview. Your saved transactions are unchanged.',
    );
  const data = await response.json();
  if (!Array.isArray(data.transactions) || !Array.isArray(data.byCurrency))
    throw new Error(
      'The overview returned an unexpected response. Please try again.',
    );
  const reporting: Reporting = data.reporting;
  if (!Array.isArray(reporting?.rows) || reporting.currency !== display)
    throw new Error('The conversion response was incomplete. Please retry.');
  return {
    rows: data.transactions as Transaction[],
    reporting,
    currencies: (data.byCurrency as { currency: string }[]).map(
      (r) => r.currency,
    ),
  };
}

function Loading() {
  return (
    <div role="status" aria-label="Loading overview" className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((n) => (
          <Skeleton key={n} className="h-32 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-lg" />
      <Skeleton className="h-64 rounded-lg" />
      <span className="sr-only">Loading your transactions</span>
    </div>
  );
}

const rigaDay = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

export default function Overview() {
  const patch = useSearchPatch();
  const actor = useSession().data?.actor;
  const isMobile = useIsMobile();
  const [owner, setOwner] = useUrlField('owner', 'all');
  const defaultRange = periodRange('month');
  const [from] = useUrlField('from', defaultRange[0]!);
  const [to] = useUrlField('to', defaultRange[1]!);
  const period = { from, to };
  const [currency, setCurrency] = useUrlField('currency', 'all');
  const [category, setCategory] = useUrlField('category', '');
  const [pattern, setPattern] = useUrlField('pattern', 'all');
  const [scope, setScope] = useUrlField('scope', 'all');
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const { currency: focusCurrency } = useDisplayCurrency();
  const [granularity, setGranularity] = useState('day');
  const [knownCurrencies, setKnownCurrencies] = useState<string[]>([]);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [reporting, setReporting] = useState<Reporting | null>(null);
  const [previous, setPrevious] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [visibleCount, setVisibleCount] = useState(8);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const dateError = Boolean(from && to && from > to);
  const filterParams = useMemo(() => {
    const params = new URLSearchParams();
    if (owner !== 'all') params.set('owner', owner);
    if (currency !== 'all') params.set('currency', currency);
    if (category) params.set('category', category);
    if (pattern !== 'all') params.set('pattern', pattern);
    if (scope !== 'all') params.set('scope', scope);
    return params;
  }, [owner, currency, category, pattern, scope]);
  const query = useMemo(() => {
    const params = new URLSearchParams(filterParams);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [filterParams, from, to]);
  // The same filters over the stretch of equal length just before this one,
  // which is what the KPI deltas compare against.
  const before = previousPeriod(period);
  const previousQuery = useMemo(() => {
    if (!before) return null;
    const params = new URLSearchParams(filterParams);
    params.set('from', before.from);
    params.set('to', before.to);
    return params.toString();
  }, [filterParams, before?.from, before?.to]);
  useEffect(() => {
    if (dateError) return;
    const controller = new AbortController();
    setVisibleCount(8);
    setLoading(true);
    setError('');
    async function load() {
      try {
        const [current, earlier] = await Promise.all([
          fetchOverview(query, focusCurrency, controller.signal),
          previousQuery
            ? fetchOverview(previousQuery, focusCurrency, controller.signal)
                .then((r) => r.reporting as Totals)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        setRows(current.rows);
        setReporting(current.reporting);
        setPrevious(earlier);
        setKnownCurrencies((known) =>
          [...new Set([...known, ...current.currencies])].sort(),
        );
        setKnownCategories((known) =>
          [
            ...new Set([
              ...known,
              ...current.rows.flatMap((r) => {
                if (!r.category) return [];
                const parts = r.category.split(' / ');
                return parts.map((_, index) =>
                  parts.slice(0, index + 1).join(' / '),
                );
              }),
            ]),
          ].sort(),
        );
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Unable to load the overview.',
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [query, previousQuery, refresh, dateError, focusCurrency]);
  const activeCurrency = reporting?.currency ?? focusCurrency;
  const eligibleOutflow = (r: Transaction) =>
    BigInt(r.amountMinor) < 0n && !r.spendingPolicy?.excluded;
  // The same test Review applies, so a payment counted here is a payment that
  // screen can actually list (src/spending-review.ts).
  const reviewable = rows.filter(
    (r) =>
      eligibleOutflow(r) &&
      // The root catch-all counts too: a payment filed there is classified but
      // says nothing about the money, and Review now lists it again.
      (r.kind === 'unresolved' || r.category === 'Unspecified') &&
      !r.refund?.fullyReduced,
  );
  const unresolved = reviewable.filter((r) => r.status !== 'pending').length;
  const pending = rows.filter(
    (r) => eligibleOutflow(r) && r.status === 'pending',
  ).length;
  // This page reports the household; Review only ever shows the signed-in
  // owner's own payments, so say which of these they cannot open from here.
  const othersUnresolved = actor
    ? reviewable.filter((r) => r.owner !== actor).length
    : 0;
  const confirmed = useMemo(() => {
    // The amount after refunds, which is what the headline total and the month
    // table already report. Taking the amount before them made a charge that
    // was reversed — a released hold, a cancelled booking — count as spending
    // alongside the charge that replaced it, so the chart above the total
    // disagreed with the total.
    const converted = new Map(
      reporting?.rows
        .filter((r) => r.counted === 'confirmed')
        .map((r) => [r.id, r.netAmountMinor ?? r.convertedAmountMinor]) ?? [],
    );
    return rows.flatMap((r) => {
      const amount = converted.get(r.id);
      return amount !== null && amount !== undefined
        ? [{ ...r, amountMinor: amount, currency: activeCurrency }]
        : [];
    });
  }, [rows, reporting, activeCurrency]);
  const chart = useMemo(() => {
    const ordered = [...confirmed].sort((a, b) =>
      a.bookedAt.localeCompare(b.bookedAt),
    );
    const groups = new Map<string, bigint>();
    for (const row of ordered) {
      const day = rigaDay(row.bookedAt);
      let key = granularity === 'month' ? day.slice(0, 7) : day;
      if (granularity === 'week') {
        const date = new Date(day + 'T12:00:00Z');
        date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
        key = date.toISOString().slice(0, 10);
      }
      groups.set(key, (groups.get(key) || 0n) - BigInt(row.amountMinor));
    }
    return {
      monthly: granularity === 'month',
      points: [...groups].map(([name, minor]) => ({
        name,
        minor: minor.toString(),
        value: toNumber(minor.toString(), activeCurrency),
      })) as Point[],
    };
  }, [confirmed, activeCurrency, granularity]);
  const categories = useMemo(() => {
    const groups = new Map<string, bigint>();
    for (const row of confirmed) {
      const name = row.category || 'Uncategorized';
      groups.set(name, (groups.get(name) || 0n) - BigInt(row.amountMinor));
    }
    return [...groups]
      .sort((a, b) =>
        a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : a[0].localeCompare(b[0]),
      )
      .map(([name, minor]) => ({ name, minor: minor.toString() }));
  }, [confirmed]);
  const recent = [...rows]
    .sort((a, b) => b.bookedAt.localeCompare(a.bookedAt))
    .slice(0, visibleCount);
  const filtered =
    owner !== 'all' ||
    currency !== 'all' ||
    category ||
    pattern !== 'all' ||
    scope !== 'all';
  function reset() {
    patch({
      owner: 'all',
      currency: 'all',
      category: '',
      pattern: 'all',
      scope: 'all',
    });
  }
  const ownerName =
    owner === 'all' ? 'Together' : owner === 'rodion' ? 'Rodion' : 'Katya';
  const intervalName =
    granularity === 'month'
      ? 'monthly'
      : granularity === 'week'
        ? 'weekly'
        : 'daily';

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <PageHeader
        title="Home"
        description="Household spending for the period, and what still needs a decision."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefresh((n) => n + 1)}
            disabled={loading || dateError}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker
          value={period}
          onChange={(next) => patch({ from: next.from, to: next.to })}
        />
        <Button
          variant={filtered ? 'secondary' : 'ghost'}
          size="sm"
          aria-expanded={filtersExpanded}
          aria-controls="overview-filters"
          onClick={() => setFiltersExpanded(!filtersExpanded)}
        >
          <SlidersHorizontal />
          Filters
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          {from || 'Beginning of history'} – {to || 'Today'} · Europe/Riga ·{' '}
          {ownerName} · {focusCurrency}
        </p>
        <a
          className="font-medium text-primary"
          href={`/analytics?display=${focusCurrency}`}
        >
          Explore spending analytics →
        </a>
      </div>
      {filtersExpanded && (
        <FilterBar id="overview-filters">
          <Field label="Account owner" htmlFor="overview-owner">
            <Choice
              id="overview-owner"
              className="w-full sm:w-40"
              value={owner}
              onChange={setOwner}
              options={[
                { value: 'all', label: 'Together' },
                { value: 'rodion', label: 'Rodion' },
                { value: 'katya', label: 'Katya' },
              ]}
            />
          </Field>
          <Field label="Original currency" htmlFor="overview-currency">
            <Choice
              id="overview-currency"
              className="w-full sm:w-40"
              value={currency}
              onChange={setCurrency}
              options={[
                { value: 'all', label: 'All currencies' },
                ...[
                  ...new Set([
                    ...knownCurrencies,
                    ...(currency !== 'all' ? [currency] : []),
                  ]),
                ]
                  .sort()
                  .map((c) => ({ value: c, label: c })),
              ]}
            />
          </Field>
          <Field label="Category" htmlFor="overview-category">
            <Choice
              id="overview-category"
              className="w-full sm:w-44"
              value={category ? `category:${category}` : 'all'}
              onChange={(value) =>
                setCategory(value === 'all' ? '' : value.slice(9))
              }
              options={[
                { value: 'all', label: 'All categories' },
                ...[
                  ...new Set([
                    ...knownCategories,
                    ...(category ? [category] : []),
                  ]),
                ]
                  .sort()
                  .map((name) => ({ value: `category:${name}`, label: name })),
              ]}
            />
          </Field>
          <Field label="Spending pattern" htmlFor="overview-pattern">
            <Choice
              id="overview-pattern"
              className="w-full sm:w-44"
              value={pattern}
              onChange={setPattern}
              options={[
                { value: 'all', label: 'All patterns' },
                { value: 'routine', label: 'Routine' },
                { value: 'exceptional', label: 'Exceptional' },
                { value: 'unreviewed', label: 'Not reviewed' },
              ]}
            />
          </Field>
          <Field label="Money movements" htmlFor="overview-scope">
            <Choice
              id="overview-scope"
              className="w-full sm:w-44"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'All movements' },
                { value: 'spending', label: 'Personal expenses' },
                { value: 'excluded', label: 'Excluded from spending' },
                { value: 'unresolved', label: 'Unresolved' },
              ]}
            />
          </Field>
          {filtered && (
            <Button size="sm" variant="ghost" onClick={reset}>
              Reset
            </Button>
          )}
        </FilterBar>
      )}
      {dateError ? (
        <p role="alert" className="text-sm text-destructive">
          Choose an end date on or after the start date.
        </p>
      ) : loading && !reporting ? (
        <Loading />
      ) : error ? (
        <Card className="shadow-xs">
          <EmptyState
            icon={CircleAlert}
            title="Overview unavailable"
            text={error}
            action={
              <Button
                variant="outline"
                onClick={() => setRefresh((n) => n + 1)}
              >
                Try again
              </Button>
            }
          />
        </Card>
      ) : !rows.length ? (
        <Card className="shadow-xs">
          <EmptyState
            icon={Inbox}
            title={
              filtered
                ? 'No transactions match these filters'
                : 'Your overview starts with your first import'
            }
            text={
              filtered
                ? 'Try a wider date range or another account owner. An empty view does not mean there was no spending.'
                : 'Connect your accounts to see recorded spending here. Bank imports and unclassified payments will stay visible separately.'
            }
            action={
              filtered ? (
                <Button variant="outline" onClick={reset}>
                  Clear filters
                </Button>
              ) : (
                <Button render={<a href="/connections" />}>
                  View bank connections
                  <ArrowRight />
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          {(unresolved > 0 || pending > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <p className="text-sm font-medium">
                    There’s more to the picture
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {unresolved} unresolved{' '}
                    {unresolved === 1 ? 'transaction' : 'transactions'} ·{' '}
                    {pending} pending. Outflows only; incoming money is not
                    counted. These amounts are outside confirmed spending.
                  </p>
                  {othersUnresolved > 0 && (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {othersUnresolved} of them{' '}
                      {othersUnresolved === 1 ? 'belongs' : 'belong'} to{' '}
                      <span className="capitalize">
                        {actor === 'rodion' ? 'katya' : 'rodion'}
                      </span>{' '}
                      and can only be decided from that sign-in.
                    </p>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                render={<a href="/review?all=0&window=all" />}
              >
                Review transactions
                <ArrowRight />
              </Button>
            </div>
          )}
          {reporting &&
            Object.values(reporting.coverage).some((c) => c.missing > 0) && (
              <p role="status" className="text-sm text-warning">
                Partial conversion: {reporting.coverage.confirmed.missing}{' '}
                confirmed expenses, {reporting.coverage.unresolved.missing}{' '}
                unclassified outflows and {reporting.coverage.pending.missing}{' '}
                pending outflows lack a rate. Totals omit those amounts.{' '}
                <a
                  className="underline"
                  href={`/fx?${query}&display=${focusCurrency}`}
                >
                  Inspect missing rates
                </a>
              </p>
            )}
          {reporting && (
            <section aria-label="Spending summary" className="space-y-3">
              <p className="text-xs text-muted-foreground">
                All selected accounts converted to {activeCurrency} · daily
                rates
                {before ? ` · compared with ${before.from} – ${before.to}` : ''}
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <KpiCard
                  label="Classified spending"
                  minor={reporting.confirmedMinor}
                  previousMinor={previous?.confirmedMinor ?? null}
                  currency={activeCurrency}
                  note={`${confirmed.length} confirmed outflows`}
                  icon={Wallet}
                  href={`/review?all=1&display=${focusCurrency}`}
                />
                <KpiCard
                  label="Awaiting review"
                  minor={reporting.unresolvedMinor}
                  previousMinor={previous?.unresolvedMinor ?? null}
                  currency={activeCurrency}
                  note={`${unresolved} unclassified outflows`}
                  icon={CircleAlert}
                  href={`/review?all=0&window=all&display=${focusCurrency}`}
                />
                <KpiCard
                  label="Pending payments"
                  minor={reporting.pendingMinor}
                  previousMinor={previous?.pendingMinor ?? null}
                  currency={activeCurrency}
                  note={`${pending} payments not yet booked`}
                  icon={Clock3}
                />
              </div>
            </section>
          )}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="min-w-0 shadow-xs">
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div>
                  <CardTitle className="text-sm font-medium">
                    Spending over time
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {intervalName} · Europe/Riga
                  </p>
                </div>
                <Choice
                  aria-label="Chart interval"
                  size="sm"
                  className="w-24"
                  value={granularity}
                  onChange={setGranularity}
                  options={[
                    { value: 'day', label: 'Daily' },
                    { value: 'week', label: 'Weekly' },
                    { value: 'month', label: 'Monthly' },
                  ]}
                />
              </CardHeader>
              <CardContent>
                {chart.points.length ? (
                  <div
                    className="mt-2 h-48 w-full sm:h-60"
                    role="img"
                    aria-label={`Recorded ${intervalName} spending in ${activeCurrency}. Total ${money(reporting!.confirmedMinor, activeCurrency)}.`}
                  >
                    <Suspense
                      fallback={
                        <div className="h-full w-full animate-pulse rounded-md bg-muted" />
                      }
                    >
                      <BarSeries
                        data={chart.points}
                        index="name"
                        series={[{ key: 'value', label: 'Spent' }]}
                        formatValue={(_, __, point) =>
                          money(String(point.minor), activeCurrency)
                        }
                        formatIndex={(v) => (chart.monthly ? v : v.slice(5))}
                        formatHeading={(v) => v}
                        showYAxis={!isMobile}
                        minTickGap={isMobile ? 48 : 28}
                      />
                    </Suspense>
                  </div>
                ) : (
                  <EmptyState
                    icon={CheckCheck}
                    title="No confirmed personal spending yet"
                    text={`Reviewed personal expenses in ${activeCurrency} will appear here.`}
                    className="h-48 sm:h-60"
                  />
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0 shadow-xs">
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Where it went
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Confirmed categories · {activeCurrency}
                </p>
              </CardHeader>
              <CardContent>
                {categories.length ? (
                  <div className="space-y-4">
                    <BarList
                      rows={categories.slice(0, 6)}
                      currency={activeCurrency}
                    />
                    {categories.length > 6 && (
                      <p className="text-xs text-muted-foreground">
                        The 6 largest of {categories.length} categories.
                      </p>
                    )}
                    <a
                      href="/categories"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary"
                    >
                      Manage categories
                      <ArrowRight className="size-3.5" />
                    </a>
                  </div>
                ) : (
                  <EmptyState
                    icon={Wallet}
                    title="Categories will appear here"
                    text="Classify a personal expense to start seeing its place in your spending."
                    className="h-48"
                  />
                )}
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <a
              className="rounded-lg border bg-card p-4 shadow-xs transition-colors hover:bg-muted/40"
              href="/review?all=0&window=previous_month"
            >
              <p className="text-sm font-medium">
                Finish last month’s review →
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Resolve recent payments in manageable groups.
              </p>
            </a>
            <a
              className="rounded-lg border bg-card p-4 shadow-xs transition-colors hover:bg-muted/40"
              href="/review?all=0&window=historical"
            >
              <p className="text-sm font-medium">Check historical spending →</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Start with unclear large payments and inspect estimates.
              </p>
            </a>
          </div>
          <Card className="overflow-hidden shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <div>
                <CardTitle className="text-sm font-medium">
                  Recent activity
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {rows.length} recorded{' '}
                  {rows.length === 1 ? 'transaction' : 'transactions'}
                  {currency === 'all' ? ' · all currencies' : ` · ${currency}`}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                render={<a href="/review?all=1" />}
              >
                All transactions
                <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <div className="divide-y">
                {recent.map((row) => {
                  const negative = BigInt(row.amountMinor) < 0n;
                  const attention =
                    negative &&
                    !row.spendingPolicy?.excluded &&
                    (row.kind === 'unresolved' || row.status === 'pending');
                  const status = row.spendingPolicy?.excluded
                    ? row.status === 'pending'
                      ? 'Pending · excluded by account rule'
                      : 'Excluded by account rule'
                    : row.status === 'pending'
                      ? 'Pending'
                      : row.kind === 'unresolved'
                        ? negative
                          ? 'Needs review'
                          : 'Money in · not spending'
                        : row.kind === 'personal_expense'
                          ? row.category || 'Personal expense'
                          : row.kind.replaceAll('_', ' ');
                  return (
                    <div
                      key={row.id}
                      className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 sm:px-6"
                    >
                      <div className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground sm:flex">
                        {negative ? (
                          <ArrowUpRight className="size-4" />
                        ) : (
                          <ArrowDownLeft className="size-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate text-sm font-medium"
                          title={row.description}
                        >
                          {row.description || 'No description provided'}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>{rigaDay(row.bookedAt)}</span>
                          <span aria-hidden="true">·</span>
                          <span className="capitalize">{row.owner}</span>
                          {row.spendingPattern?.pattern === 'exceptional' && (
                            <span className="rounded border px-1.5 py-0.5">
                              Exceptional
                            </span>
                          )}
                          {row.spendingPattern?.needsReview && (
                            <span>Pattern needs review</span>
                          )}
                          <span className="hidden sm:inline" aria-hidden="true">
                            ·
                          </span>
                          <span
                            className={`hidden truncate sm:inline ${attention ? 'text-warning' : ''}`}
                          >
                            {status}
                          </span>
                        </div>
                        <p
                          className={`mt-0.5 truncate text-xs sm:hidden ${attention ? 'text-warning' : 'text-muted-foreground'}`}
                        >
                          {status}
                        </p>
                        {row.spendingPolicy?.excluded && (
                          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                            {row.spendingPolicy.accountLabel || 'This account'}{' '}
                            ·{' '}
                            {row.spendingPolicy.reason === 'investment_account'
                              ? 'Investment account'
                              : 'Business account'}{' '}
                            — outside personal spending.{' '}
                            <a
                              href="/accounts"
                              className="underline underline-offset-4 hover:text-foreground"
                            >
                              Account rules
                            </a>
                          </p>
                        )}
                      </div>
                      <div className="min-w-0 max-w-[55%] text-right">
                        <Money
                          minor={row.amountMinor}
                          currency={row.currency}
                          signed
                          className="block break-all text-sm font-semibold"
                        />
                        <a
                          href={`/review?all=1&id=${row.id}`}
                          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                        >
                          <History className="size-3" />
                          <span>History</span>
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
              {rows.length > recent.length && (
                <div className="border-t px-6 py-3 text-xs text-muted-foreground">
                  Showing {recent.length} of {rows.length}.
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-2"
                    onClick={() => setVisibleCount((count) => count + 25)}
                  >
                    Show more transactions
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
          <LlmBudget compact refresh={refresh} />
          <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            Based on imported records. Bank coverage may be incomplete.
            Transfers, investments and non-personal payments are excluded from
            personal spending.
          </p>
        </>
      )}
    </div>
  );
}
