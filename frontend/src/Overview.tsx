import { useUrlField, useSearchPatch } from './lib/navigation';
import { useSession } from './lib/query';
import {
  historicalEstimateBreakdown,
  type HistoricalProjectionRow,
  type EstimateGroup,
} from './lib/historical-estimate-breakdown';
import { periodRange } from './lib/spending-period';
import { useDisplayCurrency } from './lib/display-currency';
import LlmBudget from './LlmBudget';
import { useEffect, useMemo, useState } from 'react';
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
import { lazy, Suspense } from 'react';
import { money, toNumber } from './lib/format';
import { Button } from '@/components/ui/button';
const BarSeries = lazy(() => import('@/components/charts/BarSeries'));
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Choice } from '@/components/finance';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

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
  historicalEstimates?: {
    estimatedMinor: string;
    unknownMinor: string;
    estimatedCount: number;
    unknownCount: number;
    missing: number;
    rows?: HistoricalProjectionRow[];
  };
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
function Loading() {
  return (
    <div role="status" aria-label="Loading overview" className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((n) => (
          <Skeleton key={n} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <span className="sr-only">Loading your transactions</span>
    </div>
  );
}

export default function Overview({
  analytics = false,
}: {
  analytics?: boolean;
}) {
  const patch = useSearchPatch();
  const actor = useSession().data?.actor;
  const [owner, setOwner] = useUrlField('owner', 'all');
  const defaultRange = periodRange(analytics ? 'year' : 'month');
  const [from, setFrom] = useUrlField('from', defaultRange[0]);
  const [to, setTo] = useUrlField('to', defaultRange[1]);
  const [currency, setCurrency] = useUrlField('currency', 'all');
  const [category, setCategory] = useUrlField('category', '');
  const [pattern, setPattern] = useUrlField('pattern', 'all');
  const [scope, setScope] = useUrlField('scope', 'all');
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const { currency: focusCurrency } = useDisplayCurrency();
  const [showEstimates, setShowEstimates] = useState(false);
  const [granularity, setGranularity] = useState(analytics ? 'month' : 'day');
  const [knownCurrencies, setKnownCurrencies] = useState<string[]>([]);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [reporting, setReporting] = useState<Reporting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [visibleCount, setVisibleCount] = useState(8);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const dateError = Boolean(from && to && from > to);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (owner !== 'all') params.set('owner', owner);
    if (currency !== 'all') params.set('currency', currency);
    if (category) params.set('category', category);
    if (pattern !== 'all') params.set('pattern', pattern);
    if (scope !== 'all') params.set('scope', scope);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [owner, currency, category, from, to, pattern, scope]);
  useEffect(() => {
    if (dateError) return;
    const controller = new AbortController();
    setVisibleCount(8);
    setLoading(true);
    setError('');
    async function load() {
      try {
        const response = await fetch(
          `/api/overview?${query}&display=${focusCurrency}`,
          {
            signal: controller.signal,
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          },
        );
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'Your session needs attention. Reload the page to sign in again.'
              : 'We couldn’t load your overview. Your saved transactions are unchanged.',
          );
        const data = await response.json();
        if (
          !Array.isArray(data.transactions) ||
          !Array.isArray(data.byCurrency)
        )
          throw new Error(
            'The overview returned an unexpected response. Please try again.',
          );
        if (controller.signal.aborted) return;
        const conversion = data.reporting;
        if (
          !Array.isArray(conversion.rows) ||
          conversion.currency !== focusCurrency
        )
          throw new Error(
            'The conversion response was incomplete. Please retry.',
          );
        if (controller.signal.aborted) return;
        setRows(data.transactions);
        setReporting(conversion);
        setKnownCurrencies((previous) =>
          [
            ...new Set([
              ...previous,
              ...data.byCurrency.map((r: { currency: string }) => r.currency),
            ]),
          ].sort(),
        );
        setKnownCategories((previous) =>
          [
            ...new Set([
              ...previous,
              ...data.transactions.flatMap((r: Transaction) => {
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
  }, [query, refresh, dateError, focusCurrency]);
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
  const focused = reporting
    ? {
        personalExpenseMinor: reporting.confirmedMinor,
        unresolvedOutflowMinor: reporting.unresolvedMinor,
        unresolvedCount: unresolved,
        pendingOutflowMinor: reporting.pendingMinor,
        pendingCount: pending,
      }
    : null;
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
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Riga',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(row.bookedAt));
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
      })),
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
      .map(([name, minor]) => ({
        name,
        minor: minor.toString(),
        value: toNumber(minor.toString(), activeCurrency),
      }));
  }, [confirmed, activeCurrency]);
  const recent = [...rows]
    .sort((a, b) => b.bookedAt.localeCompare(a.bookedAt))
    .slice(0, visibleCount);
  const filtered =
    owner !== 'all' ||
    currency !== 'all' ||
    category ||
    from ||
    to ||
    pattern !== 'all' ||
    scope !== 'all';
  function reset() {
    patch({
      owner: 'all',
      currency: 'all',
      category: '',
      pattern: 'all',
      scope: 'all',
      from: defaultRange[0],
      to: defaultRange[1],
    });
  }
  const metricCards = focused
    ? [
        {
          title: 'Classified spending',
          amount: focused.personalExpenseMinor,
          note: `${confirmed.length} confirmed outflows`,
          icon: Wallet,
          color: 'text-primary',
        },
        {
          title: 'Awaiting review',
          amount: focused.unresolvedOutflowMinor,
          note: `${focused.unresolvedCount} unclassified outflows`,
          icon: CircleAlert,
          color: 'text-amber-600 dark:text-amber-400',
        },
        {
          title: 'Pending payments',
          amount: focused.pendingOutflowMinor,
          note: `${focused.pendingCount} payments not yet booked`,
          icon: Clock3,
          color: 'text-muted-foreground',
        },
      ]
    : [];

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Household finances
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {analytics ? 'Spending analytics' : 'Your spending, this period'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {analytics
              ? 'Explore categories, habits and exceptional purchases.'
              : 'A focused view of household spending and your next review.'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefresh((n) => n + 1)}
          disabled={loading || dateError}
        >
          <RefreshCw
            className={`mr-2 size-3.5 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap gap-1" aria-label="Reporting period">
          {[
            ['month', 'This month'],
            ['previous', 'Last month'],
            ['year', '2026 so far'],
            ['archive', '2025 archive'],
          ].map(([key, label]) => {
            const range = periodRange(key);
            return (
              <Button
                key={key}
                size="sm"
                variant={
                  from === range[0] && to === range[1] ? 'secondary' : 'ghost'
                }
                aria-pressed={from === range[0] && to === range[1]}
                onClick={() => {
                  patch({ from: range[0], to: range[1] });
                }}
              >
                {label}
              </Button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={filtersExpanded}
          aria-controls="overview-filters"
          onClick={() => setFiltersExpanded(!filtersExpanded)}
        >
          <SlidersHorizontal className="mr-2 size-3.5" />
          Filters & dates
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          {from || 'Beginning of history'} – {to || 'Today'} · Europe/Riga ·{' '}
          {owner === 'all'
            ? 'Together'
            : owner === 'rodion'
              ? 'Rodion'
              : 'Katya'}{' '}
          · {focusCurrency}
        </p>
        <a
          className="font-medium text-primary"
          href={
            analytics
              ? `/?${query}&display=${focusCurrency}`
              : `/analytics?display=${focusCurrency}`
          }
        >
          {analytics ? 'Back to home' : 'Explore spending analytics'} →
        </a>
      </div>
      <div
        id="overview-filters"
        className={`${filtersExpanded ? 'flex' : 'hidden'} flex-wrap items-end gap-3 rounded-xl border bg-card p-4`}
      >
        <div className="hidden self-center text-muted-foreground lg:block">
          <SlidersHorizontal className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-36 flex-1 sm:flex-none">
          <label
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
            htmlFor="overview-owner"
          >
            Account owner
          </label>
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
        </div>
        <div className="min-w-32 flex-1 sm:flex-none">
          <label
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
            htmlFor="overview-currency"
          >
            Original currency
          </label>
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
        </div>
        <div className="min-w-36 flex-1 sm:flex-none">
          <label
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
            htmlFor="overview-category"
          >
            Category
          </label>
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
        </div>
        <div className="min-w-36 flex-1 sm:flex-none">
          <label
            htmlFor="overview-pattern"
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            Spending pattern
          </label>
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
        </div>
        <div className="min-w-36 flex-1 sm:flex-none">
          <label
            htmlFor="overview-scope"
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            Money movements
          </label>
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
        </div>
        <div className="min-w-36 flex-1 sm:flex-none">
          <label
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
            htmlFor="overview-from"
          >
            From <span className="font-normal">(Europe/Riga)</span>
          </label>
          <Input
            id="overview-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full sm:w-40"
          />
        </div>
        <div className="min-w-36 flex-1 sm:flex-none">
          <label
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
            htmlFor="overview-to"
          >
            Through <span className="font-normal">(Europe/Riga)</span>
          </label>
          <Input
            id="overview-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="w-full sm:w-40"
          />
        </div>
        {filtered && (
          <Button size="sm" variant="ghost" onClick={reset}>
            Reset
          </Button>
        )}
      </div>
      {dateError ? (
        <p role="alert" className="text-sm text-destructive">
          Choose an end date on or after the start date.
        </p>
      ) : loading && !reporting ? (
        <Loading />
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CircleAlert className="size-8 text-muted-foreground" />
            <h2 className="font-semibold">Overview unavailable</h2>
            <p role="alert" className="max-w-md text-sm text-muted-foreground">
              {error}
            </p>
            <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !rows.length ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="rounded-full bg-muted p-4">
              <Inbox className="size-6 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">
              {filtered
                ? 'No transactions match these filters'
                : 'Your overview starts with your first import'}
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
              {filtered
                ? 'Try a wider date range or another account owner. An empty view does not mean there was no spending.'
                : 'Connect your accounts to see recorded spending here. Bank imports and unclassified payments will stay visible separately.'}
            </p>
            {filtered ? (
              <Button variant="outline" onClick={reset}>
                Clear filters
              </Button>
            ) : (
              <Button render={<a href="/connections" />}>
                View bank connections
                <ArrowRight className="ml-2 size-4" />
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {(unresolved > 0 || pending > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
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
                <ArrowRight className="ml-2 size-3.5" />
              </Button>
            </div>
          )}
          {reporting &&
            Object.values(reporting.coverage).some((c) => c.missing > 0) && (
              <p
                role="status"
                className="text-sm text-amber-700 dark:text-amber-300"
              >
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
          {analytics && reporting?.historicalEstimates && (
            <section
              className="rounded-xl border bg-card p-4"
              aria-label="Historical estimates"
            >
              <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={showEstimates}
                  onChange={(e) => setShowEstimates(e.target.checked)}
                  className="size-4 accent-[var(--primary)]"
                />
                Show historical estimates
              </label>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Older payments can use tentative merchant or MCC categories.
                Estimates remain separate from confirmed spending and do not
                change the bank records.
              </p>
              {showEstimates && (
                <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Additional estimated spending
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums">
                      {money(
                        reporting.historicalEstimates.estimatedMinor,
                        activeCurrency,
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {reporting.historicalEstimates.estimatedCount} tentative
                      payments
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Still unexplained
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums">
                      {money(
                        reporting.historicalEstimates.unknownMinor,
                        activeCurrency,
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {reporting.historicalEstimates.unknownCount} payments need
                      context
                    </p>
                  </div>
                  {reporting.historicalEstimates.missing > 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-300 sm:col-span-2">
                      {reporting.historicalEstimates.missing} payments have no
                      conversion rate and are omitted from these amounts.
                    </p>
                  )}
                  <HistoricalEstimateTables
                    transactions={rows}
                    reporting={reporting}
                  />
                  <a
                    href="/review?all=0&window=historical"
                    className="text-xs font-medium text-primary sm:col-span-2"
                  >
                    Inspect estimates and unclear payments →
                  </a>
                </div>
              )}
            </section>
          )}
          <section aria-label="Spending summary" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                All selected accounts converted to {activeCurrency} · daily
                rates
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {metricCards.map(({ title, amount, note, icon: Icon, color }) => (
                <Card key={title} className="gap-0 py-0 shadow-none">
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        {title}
                      </span>
                      <Icon className={`size-4 ${color}`} />
                    </div>
                    <p className="mt-3 break-all text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">
                      {money(amount, activeCurrency)}
                    </p>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {note}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="min-w-0 shadow-none">
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div>
                  <CardTitle className="text-base">
                    Spending over time
                  </CardTitle>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    All selected account currencies ·{' '}
                    {granularity === 'month'
                      ? 'monthly'
                      : granularity === 'week'
                        ? 'weekly'
                        : 'daily'}{' '}
                    · Europe/Riga
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
                    className="mt-4 h-60 w-full"
                    role="img"
                    aria-label={`Recorded ${granularity === 'month' ? 'monthly' : granularity === 'week' ? 'weekly' : 'daily'} spending in ${activeCurrency}. Total ${money(focused!.personalExpenseMinor, activeCurrency)}.`}
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
                      />
                    </Suspense>
                  </div>
                ) : (
                  <div className="flex h-60 flex-col items-center justify-center gap-2 text-center">
                    <CheckCheck className="size-6 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      No confirmed personal spending yet
                    </p>
                    <p className="max-w-xs text-xs text-muted-foreground">
                      Reviewed personal expenses in {activeCurrency} will appear
                      here.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Where it went</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Confirmed categories · {activeCurrency}
                </p>
              </CardHeader>
              <CardContent>
                {categories.length ? (
                  <div className="space-y-4">
                    {categories.slice(0, analytics ? 15 : 5).map((c, i) => (
                      <div key={c.name}>
                        <div className="mb-2 flex items-start justify-between gap-3 text-xs">
                          <span
                            className="min-w-0 truncate font-medium"
                            title={c.name}
                          >
                            {c.name}
                          </span>
                          <span className="min-w-0 max-w-[55%] break-all text-right tabular-nums text-muted-foreground">
                            {money(c.minor, activeCurrency)}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Number((BigInt(c.minor) * 10000n) / BigInt(categories[0].minor)) / 100}%`,
                              background: 'var(--primary)',
                              opacity: Math.max(0.45, 1 - i * 0.06),
                            }}
                          />
                        </div>
                      </div>
                    ))}
                    {categories.length > 5 && (
                      <p className="pt-1 text-xs text-muted-foreground">
                        Showing the{' '}
                        {analytics ? Math.min(15, categories.length) : 5}{' '}
                        largest of {categories.length} categories.
                      </p>
                    )}
                    <a
                      href="/categories"
                      className="inline-flex items-center gap-1.5 pt-1 text-xs font-medium text-primary"
                    >
                      Manage categories
                      <ArrowRight className="size-3.5" />
                    </a>
                  </div>
                ) : (
                  <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
                    <Wallet className="size-6 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      Categories will appear here
                    </p>
                    <p className="max-w-xs text-xs text-muted-foreground">
                      Classify a personal expense to start seeing its place in
                      your spending.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          {analytics && (
            <div className="grid gap-5 md:grid-cols-2">
              <SpendingBreakdown
                title="By person"
                rows={confirmed}
                currency={activeCurrency}
                group={(r) => (r.owner === 'rodion' ? 'Rodion' : 'Katya')}
              />
              <SpendingBreakdown
                title="Everyday or exceptional"
                rows={confirmed}
                currency={activeCurrency}
                group={(r) =>
                  r.spendingPattern?.pattern === 'routine'
                    ? 'Routine'
                    : r.spendingPattern?.pattern === 'exceptional'
                      ? 'Exceptional'
                      : 'Pattern not reviewed'
                }
              />
            </div>
          )}
          {!analytics && (
            <div className="grid gap-3 sm:grid-cols-2">
              <a
                className="rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40"
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
                className="rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40"
                href="/review?all=0&window=historical"
              >
                <p className="text-sm font-medium">
                  Check historical spending →
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Start with unclear large payments and inspect estimates.
                </p>
              </a>
            </div>
          )}
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">Recent activity</CardTitle>
                <p className="mt-1.5 text-xs text-muted-foreground">
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
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <div className="divide-y">
                {recent.map((row) => {
                  const negative = BigInt(row.amountMinor) < 0n;
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
                      className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:px-6"
                    >
                      <div className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground sm:flex">
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
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>
                            {new Intl.DateTimeFormat('en-CA', {
                              timeZone: 'Europe/Riga',
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                            }).format(new Date(row.bookedAt))}
                          </span>
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
                            className={`hidden truncate sm:inline ${BigInt(row.amountMinor) < 0n && !row.spendingPolicy?.excluded && (row.kind === 'unresolved' || row.status === 'pending') ? 'text-amber-600 dark:text-amber-400' : ''}`}
                          >
                            {status}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground sm:hidden">
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
                        <p className="break-all text-xs font-semibold tabular-nums sm:text-sm">
                          {!negative && BigInt(row.amountMinor) > 0n ? '+' : ''}
                          {money(row.amountMinor, row.currency)}
                        </p>
                        <a
                          href={`/review?all=1&id=${row.id}`}
                          className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
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
          {!analytics && <LlmBudget compact refresh={refresh} />}
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

function SpendingBreakdown({
  title,
  rows,
  currency,
  group,
}: {
  title: string;
  rows: Transaction[];
  currency: string;
  group: (row: Transaction) => string;
}) {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const key = group(row);
    totals.set(key, (totals.get(key) ?? 0n) - BigInt(row.amountMinor));
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0n);
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Confirmed spending in the selected period
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {totals.size ? (
          [...totals]
            .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))
            .map(([label, minor]) => (
              <div key={label}>
                <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                  <span>{label}</span>
                  <span className="tabular-nums">
                    {money(minor.toString(), currency)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{
                      width: `${total > 0n ? Number((minor * 10000n) / total) / 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No confirmed spending in this period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function HistoricalEstimateTables({
  transactions,
  reporting,
}: {
  transactions: Transaction[];
  reporting: Reporting;
}) {
  const groups = historicalEstimateBreakdown(
    transactions,
    reporting.rows,
    reporting.historicalEstimates?.rows ?? [],
  );
  return (
    <div className="space-y-3 sm:col-span-2">
      <p className="text-xs text-muted-foreground">
        Tentative breakdowns only · confirmed spending remains in the charts
        below. Missing conversions are omitted.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <EstimateTable
          title="Tentative spending by month"
          label="Month"
          rows={groups.months}
          currency={reporting.currency}
        />
        <EstimateTable
          title="Tentative spending by category"
          label="Category"
          rows={groups.categories}
          currency={reporting.currency}
        />
      </div>
      {groups.missing > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {groups.missing} tentative payments are missing a display-currency
          rate.
        </p>
      )}
    </div>
  );
}
function EstimateTable({
  title,
  label,
  rows,
  currency,
}: {
  title: string;
  label: string;
  rows: EstimateGroup[];
  currency: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border">
      <h3 className="border-b bg-muted/30 px-3 py-2.5 text-xs font-medium">
        {title}
      </h3>
      {rows.length ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">{label}</th>
                <th className="px-3 py-2 text-right font-normal">Payments</th>
                <th className="px-3 py-2 text-right font-normal">Estimate</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className="max-w-44 break-words px-3 py-2.5 font-normal"
                  >
                    {row.label}
                  </th>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {row.count}
                  </td>
                  <td className="break-words px-3 py-2.5 text-right tabular-nums">
                    {money(row.minor, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          No converted tentative spending in this period.
        </p>
      )}
    </div>
  );
}
