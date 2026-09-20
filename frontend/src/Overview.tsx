import {
  invalidateFinancialData,
  useRefreshSignal,
  useSession,
} from './lib/query';
import { owners } from './lib/account-visuals';
import { periodRange } from './lib/spending-period';
import { useDisplayCurrency } from './lib/display-currency';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCheck,
  CircleAlert,
  Inbox,
  Wallet,
} from 'lucide-react';
import { accountIdentity } from './lib/account-identity';
import { money, toNumber } from './lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AccountBadge,
  BarList,
  EmptyState,
  KpiCard,
  Money,
  PageHeader,
  ProblemsBlock,
  RefreshButton,
  TransactionRow,
  sameSpanLastMonth,
  type Problem,
} from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';
const BarSeries = lazy(() => import('@/components/charts/BarSeries'));

type Transaction = {
  id: string;
  revision?: number;
  spendingPattern?: { pattern: string; needsReview: boolean };
  owner: 'rodion' | 'katya';
  source: string;
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
  };
}

/**
 * The household's spending money, across both members.
 *
 * Read from the same endpoint the Balances screen uses, and totalled the same
 * way: only the accounts whose purpose is personal, over figures the server
 * already converted with each agreed overdraft taken out. Business and
 * investment accounts are somebody's money but not money to spend, and a
 * headline that mixed them in would flatter every month.
 */
type BalancesResponse = {
  accounts: {
    source: string;
    accountId: string;
    purpose: 'personal' | 'business' | 'investment' | 'unreviewed';
    balances: { currency: string }[];
  }[];
  reporting?: {
    currency: string;
    rows: {
      source: string;
      accountId: string;
      currency: string;
      convertedMinor: string | null;
    }[];
  };
};

async function fetchOwnMoney(display: string, signal: AbortSignal) {
  const response = await fetch(`/api/balances?display=${display}`, {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as BalancesResponse;
  if (!data.reporting) return null;
  const converted = new Map(
    data.reporting.rows.map((row) => [
      `${row.source}:${row.accountId}:${row.currency}`,
      row.convertedMinor,
    ]),
  );
  let minor = 0n;
  let missing = 0;
  for (const account of data.accounts) {
    if (account.purpose !== 'personal') continue;
    for (const balance of account.balances) {
      const amount = converted.get(
        `${account.source}:${account.accountId}:${balance.currency}`,
      );
      if (amount) minor += BigInt(amount);
      else missing += 1;
    }
  }
  return {
    minor: minor.toString(),
    missing,
    currency: data.reporting.currency,
  };
}

async function fetchProblems(signal: AbortSignal): Promise<Problem[]> {
  const response = await fetch('/api/problems', {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { problems?: Problem[] };
  return Array.isArray(data.problems) ? data.problems : [];
}

function Loading() {
  return (
    <div role="status" aria-label="Loading overview" className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((n) => (
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
  const actor = useSession().data?.actor;
  const isMobile = useIsMobile();
  // Home is this month, for the whole household, in the display currency, and
  // offers no way to change any of that. Every control it used to carry exists
  // on Spending analytics, which is the screen for asking questions; this one
  // answers the two that do not need asking — what has gone wrong, and how the
  // month is going.
  const [from, to] = periodRange('month');
  const period = { from: from!, to: to! };
  const { currency: focusCurrency } = useDisplayCurrency();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [reporting, setReporting] = useState<Reporting | null>(null);
  const [previous, setPrevious] = useState<Totals | null>(null);
  const [own, setOwn] = useState<{
    minor: string;
    missing: number;
    currency: string;
  } | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useRefreshSignal();
  const [visibleCount, setVisibleCount] = useState(8);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set('from', period.from);
    params.set('to', period.to);
    return params.toString();
  }, [period.from, period.to]);
  const before = sameSpanLastMonth(period);
  const previousQuery = useMemo(() => {
    if (!before) return null;
    const params = new URLSearchParams();
    params.set('from', before.from);
    params.set('to', before.to);
    return params.toString();
  }, [before?.from, before?.to]);
  useEffect(() => {
    const controller = new AbortController();
    setVisibleCount(8);
    setLoading(true);
    setError('');
    async function load() {
      try {
        const [current, earlier, money, faults] = await Promise.all([
          fetchOverview(query, focusCurrency, controller.signal),
          previousQuery
            ? fetchOverview(previousQuery, focusCurrency, controller.signal)
                .then((r) => r.reporting as Totals)
                .catch(() => null)
            : Promise.resolve(null),
          // Neither of these may take the page down with them: a dashboard that
          // shows nothing because one panel failed is worse than one panel
          // short.
          fetchOwnMoney(focusCurrency, controller.signal).catch(() => null),
          fetchProblems(controller.signal).catch(() => []),
        ]);
        if (controller.signal.aborted) return;
        setRows(current.rows);
        setReporting(current.reporting);
        setPrevious(earlier);
        setOwn(money);
        setProblems(faults);
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
  }, [query, previousQuery, refresh, focusCurrency]);
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
  // Day by day, for the month in view. There is no interval to choose: a month
  // has one useful shape and the other two answer questions Analytics asks.
  const chart = useMemo(() => {
    const groups = new Map<string, bigint>();
    for (const row of [...confirmed].sort((a, b) =>
      a.bookedAt.localeCompare(b.bookedAt),
    ))
      groups.set(
        rigaDay(row.bookedAt),
        (groups.get(rigaDay(row.bookedAt)) || 0n) - BigInt(row.amountMinor),
      );
    return [...groups].map(([name, minor]) => ({
      name,
      minor: minor.toString(),
      value: toNumber(minor.toString(), activeCurrency),
    })) as Point[];
  }, [confirmed, activeCurrency]);
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

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-8">
      <PageHeader title="Home" actions={<RefreshButton />} />
      {loading && !reporting ? (
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
                onClick={() => void invalidateFinancialData()}
              >
                Try again
              </Button>
            }
          />
        </Card>
      ) : !rows.length ? (
        <>
          <ProblemsBlock problems={problems} />
          <Card className="shadow-xs">
            <EmptyState
              icon={Inbox}
              title="Your overview starts with your first import"
              text="Connect your accounts to see recorded spending here."
              action={
                <Button render={<a href="/connections" />}>
                  View bank connections
                  <ArrowRight />
                </Button>
              }
            />
          </Card>
        </>
      ) : (
        <>
          <ProblemsBlock problems={problems} />
          {unresolved > 0 && reporting && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <p className="text-sm font-medium">
                    <Money
                      minor={reporting.unresolvedMinor}
                      currency={activeCurrency}
                    />{' '}
                    across {unresolved}{' '}
                    {unresolved === 1 ? 'payment' : 'payments'} needs a decision
                  </p>
                  {othersUnresolved > 0 && (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {othersUnresolved} of them{' '}
                      {othersUnresolved === 1 ? 'belongs' : 'belong'} to{' '}
                      <span>
                        {owners[actor === 'rodion' ? 'katya' : 'rodion'].name}
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
                Review
                <ArrowRight />
              </Button>
            </div>
          )}
          {reporting && (
            <div className="grid gap-3 sm:grid-cols-2">
              <KpiCard
                label="Spent this month"
                minor={reporting.confirmedMinor}
                previousMinor={previous?.confirmedMinor ?? null}
                currency={activeCurrency}
                previousLabel="over the same days last month"
                icon={Wallet}
                href={`/review?all=1&display=${focusCurrency}`}
              />
              {own && (
                <KpiCard
                  label="Own money"
                  minor={own.minor}
                  currency={own.currency}
                  note={
                    own.missing > 0
                      ? `${own.missing} without a rate`
                      : 'Personal accounts'
                  }
                  icon={Wallet}
                  href="/balances"
                />
              )}
            </div>
          )}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="min-w-0 shadow-xs">
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <CardTitle className="text-sm font-medium">
                  Spending day by day
                </CardTitle>
                <a
                  className="text-xs font-medium text-primary"
                  href={`/analytics?display=${focusCurrency}`}
                >
                  Explore analytics →
                </a>
              </CardHeader>
              <CardContent>
                {chart.length ? (
                  <div
                    className="mt-2 h-48 w-full sm:h-60"
                    role="img"
                    aria-label={`Recorded daily spending in ${activeCurrency}. Total ${money(reporting!.confirmedMinor, activeCurrency)}.`}
                  >
                    <Suspense
                      fallback={
                        <div className="h-full w-full animate-pulse rounded-md bg-muted" />
                      }
                    >
                      <BarSeries
                        data={chart}
                        index="name"
                        series={[{ key: 'value', label: 'Spent' }]}
                        formatValue={(_, __, point) =>
                          money(String(point.minor), activeCurrency)
                        }
                        formatIndex={(v) => v.slice(5)}
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
              </CardHeader>
              <CardContent>
                {categories.length ? (
                  <BarList
                    rows={categories.slice(0, 5)}
                    currency={activeCurrency}
                  />
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
          <Card className="overflow-hidden shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle className="text-sm font-medium">
                Recent activity
              </CardTitle>
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
              {/* The date, the bank and what it was filed as. Whether the bank
                  has settled it, the rule that excluded it and the link into
                  its history were all taken out: each was a second line of
                  small print on a row whose job is to let the reader recognise
                  a payment. */}
              <div className="px-4 sm:px-6">
                {recent.map((row) => (
                  <TransactionRow
                    key={row.id}
                    mark={
                      <AccountBadge
                        source={row.source}
                        currency={row.currency}
                        label={row.spendingPolicy?.accountLabel}
                        owner={row.owner}
                        size="md"
                      />
                    }
                    markOnPhone
                    description={
                      row.description || 'Payment without a description'
                    }
                    meta={
                      <>
                        {rigaDay(row.bookedAt)}
                        {' · '}
                        {
                          accountIdentity(
                            row.source,
                            row.currency,
                            row.spendingPolicy?.accountLabel,
                          ).name
                        }
                        {row.category ? ` · ${row.category}` : ''}
                      </>
                    }
                    amount={
                      <Money
                        minor={row.amountMinor}
                        currency={row.currency}
                        signed
                        className="text-sm font-semibold"
                      />
                    }
                  />
                ))}
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
        </>
      )}
    </div>
  );
}
