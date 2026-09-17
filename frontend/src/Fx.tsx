import { useUrlField, useSearchPatch } from './lib/navigation';
import { money } from './lib/format';
import { useDisplayCurrency } from './lib/display-currency';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Search,
  CircleAlert,
  Clock3,
  Coins,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Choice,
  Field,
  FilterBar,
  PageHeader,
  PeriodPicker,
} from '@/components/finance';

type ConversionRow = {
  id: string;
  owner: 'rodion' | 'katya';
  description: string;
  bookedAt: string;
  originalAmountMinor: string;
  originalCurrency: string;
  convertedAmountMinor: string | null;
  method: 'identity' | 'actual_bank' | 'market_estimate' | null;
  provenance: { source: string; asOf: string | null } | null;
  kind: string;
  transactionStatus: 'booked' | 'pending';
};
type Totals = {
  currency: string;
  confirmedMinor: string;
  unresolvedMinor: string;
  pendingMinor: string;
  missing: number;
  rows: ConversionRow[];
  monthly?: Array<{
    month: string;
    owner: 'rodion' | 'katya';
    confirmedMinor: string;
    covered: number;
    missing: number;
  }>;
};
const pageSize = 50;
const methods = {
  identity: 'Original amount',
  actual_bank: 'Actual bank',
  market_estimate: 'Daily estimate',
};
function bucket(row: ConversionRow) {
  if (BigInt(row.originalAmountMinor) >= 0n) return null;
  if (row.transactionStatus === 'pending') return 'pending';
  if (row.kind === 'personal_expense') return 'confirmed';
  if (row.kind === 'unresolved') return 'unresolved';
  return null;
}
export default function Fx() {
  const patch = useSearchPatch();
  const { currency: target } = useDisplayCurrency();
  const patchSearch = useSearchPatch();
  const [owner, setOwner] = useUrlField('owner', 'all');
  const [from, setFrom] = useUrlField('from', '2026-01-01');
  const [to, setTo] = useUrlField('to', '');
  const [currency, setCurrency] = useUrlField('currency', '');
  const [category, setCategory] = useUrlField('category', '');
  const [pattern, setPattern] = useUrlField('pattern', 'all');
  const [scope, setScope] = useUrlField('scope', 'all');
  const [totals, setTotals] = useState<Totals>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [monthLimit, setMonthLimit] = useState(12);
  useEffect(() => {
    setPage(1);
    setMonthLimit(12);
  }, [owner, from, to, currency, category, pattern, scope, search]);
  const monthlyEstimates = useMemo(() => {
    const counts = new Map<string, number>();
    const calendar = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Riga',
      year: 'numeric',
      month: '2-digit',
    });
    for (const row of totals?.rows ?? []) {
      if (
        row.method !== 'market_estimate' ||
        row.transactionStatus !== 'booked' ||
        row.kind !== 'personal_expense' ||
        BigInt(row.originalAmountMinor) >= 0n
      )
        continue;
      const parts = calendar.formatToParts(new Date(row.bookedAt));
      const month =
        parts.find((part) => part.type === 'year')!.value +
        '-' +
        parts.find((part) => part.type === 'month')!.value;
      const key = `${month}:${row.owner}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [totals]);
  const monthlyGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<Totals['monthly']>>();
    for (const month of totals?.monthly ?? []) {
      const group = groups.get(month.month) ?? [];
      group.push(month);
      groups.set(month.month, group);
    }
    return [...groups.values()];
  }, [totals]);
  const monthlyRows = useMemo(() => {
    const rows: Array<
      Omit<NonNullable<Totals['monthly']>[number], 'owner'> & {
        owner: 'family' | 'rodion' | 'katya';
        estimated: number;
      }
    > = [];
    for (const group of monthlyGroups.slice(0, monthLimit)) {
      const owners = group.map((month) => ({
        ...month,
        estimated: monthlyEstimates.get(`${month.month}:${month.owner}`) ?? 0,
      }));
      if (owner === 'all')
        rows.push({
          month: group[0]!.month,
          owner: 'family',
          confirmedMinor: owners
            .reduce((sum, month) => sum + BigInt(month.confirmedMinor), 0n)
            .toString(),
          covered: owners.reduce((sum, month) => sum + month.covered, 0),
          missing: owners.reduce((sum, month) => sum + month.missing, 0),
          estimated: owners.reduce((sum, month) => sum + month.estimated, 0),
        });
      rows.push(...owners);
    }
    return rows;
  }, [monthlyGroups, monthlyEstimates, monthLimit, owner]);
  const matchingRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (totals?.rows ?? []).filter(
      (row) => !term || row.description.toLocaleLowerCase().includes(term),
    );
  }, [totals, search]);
  const pages = Math.max(1, Math.ceil(matchingRows.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visibleRows = matchingRows.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const dateError = Boolean(from && to && from > to);
  const currencyError = Boolean(currency && !/^[A-Z]{3}$/.test(currency));
  const query = useMemo(() => {
    const params = new URLSearchParams({ display: target });
    if (owner !== 'all') params.set('owner', owner);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (currency) params.set('currency', currency);
    if (category.trim()) params.set('category', category);
    if (pattern !== 'all') params.set('pattern', pattern);
    if (scope !== 'all') params.set('scope', scope);
    return params.toString();
  }, [target, owner, from, to, currency, category, pattern, scope]);
  useEffect(() => {
    if (dateError || currencyError) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await fetch('/api/fx?' + query, {
          signal: controller.signal,
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'Your session needs attention. Reload to sign in again.'
              : 'We couldn’t load currency conversions. Please try again.',
          );
        const data = await response.json();
        if (
          !Array.isArray(data.rows) ||
          data.currency !== target ||
          !Number.isSafeInteger(data.missing) ||
          data.missing < 0 ||
          data.missing > data.rows.length ||
          ![data.confirmedMinor, data.unresolvedMinor, data.pendingMinor].every(
            (value) => typeof value === 'string' && /^\d+$/.test(value),
          ) ||
          !data.rows.every(
            (row: Partial<ConversionRow> | null) =>
              row &&
              typeof row.id === 'string' &&
              typeof row.description === 'string' &&
              typeof row.bookedAt === 'string' &&
              typeof row.originalCurrency === 'string' &&
              typeof row.originalAmountMinor === 'string' &&
              /^-?\d+$/.test(row.originalAmountMinor) &&
              (row.convertedAmountMinor === null ||
                (typeof row.convertedAmountMinor === 'string' &&
                  /^-?\d+$/.test(row.convertedAmountMinor))) &&
              (row.method === null ||
                row.method === 'identity' ||
                row.method === 'actual_bank' ||
                row.method === 'market_estimate'),
          )
        )
          throw new Error(
            'The currency response was incomplete. Please try again.',
          );
        if (!controller.signal.aborted) setTotals(data);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Unable to load conversions.',
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [query, target, dateError, currencyError, refresh]);
  function reset() {
    patch({
      owner: 'all',
      from: '',
      to: '',
      currency: '',
      category: '',
      pattern: 'all',
      scope: 'all',
    });
  }
  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <PageHeader
        title="Currency conversion"
        description="The same transactions in another currency, with missing rates clearly marked."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={loading || dateError || currencyError}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />
      <FilterBar>
        <Field label="Account owner" htmlFor="fx-owner">
          <Choice
            id="fx-owner"
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
        <Field label="Period" className="sm:flex-1">
          <PeriodPicker
            value={{ from, to }}
            onChange={(next) => patchSearch({ from: next.from, to: next.to })}
          />
        </Field>
        <Button variant="ghost" size="sm" onClick={reset}>
          Reset filters
        </Button>
        <details className="w-full">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            More filters
            {currency || category || pattern !== 'all' || scope !== 'all'
              ? ' · active'
              : ''}
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Spending pattern" htmlFor="fx-pattern">
              <Choice
                id="fx-pattern"
                className="w-full"
                value={pattern}
                onChange={setPattern}
                options={[
                  { value: 'all', label: 'All patterns' },
                  { value: 'routine', label: 'Routine' },
                  { value: 'exceptional', label: 'Exceptional' },
                  { value: 'unreviewed', label: 'Unreviewed' },
                ]}
              />
            </Field>
            <Field label="Payment group" htmlFor="fx-scope">
              <Choice
                id="fx-scope"
                className="w-full"
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'all', label: 'All payment types' },
                  { value: 'spending', label: 'Personal spending' },
                  { value: 'unresolved', label: 'Unresolved' },
                  {
                    value: 'excluded',
                    label: 'Transfers, investments & non-personal',
                  },
                ]}
              />
            </Field>
            <Field
              label="Filter by original currency"
              htmlFor="fx-source-currency"
            >
              <Input
                id="fx-source-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="All currencies"
                aria-describedby="fx-source-hint"
              />
              <p
                id="fx-source-hint"
                className="mt-1 text-xs text-muted-foreground"
              >
                Leave blank or enter a three-letter code such as EUR.
              </p>
            </Field>
            <Field label="Category" htmlFor="fx-category">
              <Input
                id="fx-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                maxLength={80}
                placeholder="All categories"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Includes matching subcategories.
              </p>
            </Field>
          </div>
        </details>
      </FilterBar>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Changing the display currency keeps your transactions and filters.
        Bank-recorded equivalents may exclude separate fees; daily estimates are
        labeled when available.
      </p>
      {dateError || currencyError ? (
        <p role="alert" className="text-sm text-destructive">
          {dateError
            ? 'Choose an end date on or after the start date.'
            : 'Use a three-letter account currency code, or leave it blank.'}
        </p>
      ) : loading && !totals ? (
        <div
          role="status"
          aria-label="Loading currency totals"
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-32 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-60 rounded-lg" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="space-y-3 py-8">
            <p role="alert" className="text-sm text-muted-foreground">
              {error}
            </p>
            <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : (
        totals && (
          <>
            <div
              role="status"
              className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${totals.missing ? 'border-amber-500/30 bg-amber-500/5' : 'bg-muted/30'}`}
            >
              {totals.missing ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
              ) : (
                <Coins className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="space-y-1">
                <p className="font-medium">
                  {totals.missing
                    ? 'Partial totals — some rates are missing'
                    : 'Conversion coverage'}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {totals.rows.length - totals.missing} of {totals.rows.length}{' '}
                  transactions have amounts in {totals.currency}.
                  {totals.missing > 0 &&
                    ` ${totals.missing} remain visible below and are excluded from converted totals. Missing amounts are never counted as zero.`}
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                {
                  key: 'confirmed',
                  label: 'Personal spending',
                  value: totals.confirmedMinor,
                  icon: Wallet,
                },
                {
                  key: 'unresolved',
                  label: 'Unresolved payments',
                  value: totals.unresolvedMinor,
                  icon: CircleAlert,
                },
                {
                  key: 'pending',
                  label: 'Pending payments',
                  value: totals.pendingMinor,
                  icon: Clock3,
                },
              ].map(({ key, label, value, icon: Icon }) => {
                const rows = totals.rows.filter((row) => bucket(row) === key);
                const covered = rows.filter(
                  (row) => row.convertedAmountMinor !== null,
                ).length;
                const missing = rows.length - covered;
                return (
                  <Card key={key} className="gap-3 shadow-xs">
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                        {label}
                        <Icon className="size-4 shrink-0" />
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="break-words text-xl font-semibold tabular-nums">
                        {missing > 0 && covered === 0
                          ? 'Not available'
                          : money(value, totals.currency)}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {missing
                          ? `${covered} covered · ${missing} missing rate${missing === 1 ? '' : 's'}`
                          : `${rows.length} transaction${rows.length === 1 ? '' : 's'}`}
                      </p>
                      {missing > 0 && covered > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Partial amount; missing rates excluded.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            {totals.monthly && totals.monthly.length > 0 && (
              <Card className="shadow-xs">
                <CardHeader className="gap-2">
                  <CardTitle className="text-base">
                    Monthly personal spending
                  </CardTitle>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Confirmed personal expenses
                    {owner === 'all'
                      ? ' for the family and each owner'
                      : ' by owner'}
                    , grouped by calendar month in Riga. Totals use your filters
                    and exclude pending, unresolved and other payment types.
                    Daily estimates are included where labeled.
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="divide-y">
                    {monthlyRows.map((month) => {
                      const estimated = month.estimated;
                      return (
                        <div
                          key={`${month.month}:${month.owner}`}
                          className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] ${month.owner === 'family' ? 'rounded-md bg-muted/40 px-3 first:pt-3' : ''}`}
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              <time dateTime={month.month}>
                                {new Intl.DateTimeFormat('en', {
                                  month: 'short',
                                  year: 'numeric',
                                  timeZone: 'Europe/Riga',
                                }).format(
                                  new Date(`${month.month}-01T00:00:00Z`),
                                )}
                              </time>
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {month.owner === 'family'
                                ? 'Family total'
                                : month.owner === 'rodion'
                                  ? 'Rodion'
                                  : 'Katya'}
                            </p>
                          </div>
                          <div className="col-start-1 row-start-2 text-xs leading-relaxed text-muted-foreground sm:col-start-2 sm:row-start-1">
                            {month.covered + month.missing === 0 ? (
                              'No confirmed personal expenses'
                            ) : (
                              <>
                                <p>
                                  {month.covered} covered
                                  {estimated > 0
                                    ? ` (${estimated} daily estimate${estimated === 1 ? '' : 's'})`
                                    : ''}
                                </p>
                                {month.missing > 0 && (
                                  <p className="mt-0.5 text-amber-700 dark:text-amber-400">
                                    {month.missing} missing rate
                                    {month.missing === 1 ? '' : 's'}
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                          <div className="col-start-2 row-span-2 row-start-1 text-right sm:col-start-3 sm:row-span-1">
                            <p className="break-words text-sm font-semibold tabular-nums">
                              {month.missing > 0 && month.covered === 0
                                ? 'Not available'
                                : month.covered + month.missing === 0
                                  ? '—'
                                  : money(
                                      month.confirmedMinor,
                                      totals.currency,
                                    )}
                            </p>
                            {month.missing > 0 && month.covered > 0 && (
                              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                                Partial total
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {monthlyGroups.length > monthLimit && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => setMonthLimit((value) => value + 12)}
                    >
                      Show more months
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
            <Card className="shadow-xs">
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle className="text-base">Transactions</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Amounts shown in {totals.currency}
                  </p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Credits and other money movements also appear here. Only
                  personal outflows enter personal spending; unresolved and
                  pending payments stay separate.
                </p>
                <div className="relative sm:max-w-sm">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
                  />
                  <Input
                    aria-label="Search transaction descriptions"
                    placeholder="Search transactions"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="pl-9"
                  />
                </div>
                {search.trim() && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {matchingRows.length} matching transactions. Search changes
                    this list; totals above use your filters.
                  </p>
                )}
              </CardHeader>
              <CardContent>
                {matchingRows.length ? (
                  <>
                    <div className="divide-y">
                      {visibleRows.map((row) => (
                        <div
                          key={row.id}
                          className="grid gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                        >
                          <div className="min-w-0">
                            <p className="break-words text-sm font-medium">
                              {row.description || 'No description provided'}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              <time dateTime={row.bookedAt}>
                                {row.bookedAt.slice(0, 10)}
                              </time>{' '}
                              · Europe/Riga
                            </p>
                            <details className="mt-2 text-xs text-muted-foreground">
                              <summary
                                className={`w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring ${row.convertedAmountMinor === null ? 'text-amber-700 dark:text-amber-400' : ''}`}
                              >
                                {row.method
                                  ? methods[row.method]
                                  : 'Missing rate'}
                              </summary>
                              <div className="mt-1 space-y-1 break-words rounded-md bg-muted/40 p-2 leading-relaxed">
                                {row.convertedAmountMinor === null ? (
                                  <p>
                                    No verified conversion is available for this
                                    transaction in {totals.currency}.
                                  </p>
                                ) : (
                                  <>
                                    <p>
                                      Date:{' '}
                                      {(
                                        row.provenance?.asOf ?? row.bookedAt
                                      ).slice(0, 10)}
                                    </p>
                                    <p>
                                      Source:{' '}
                                      {row.method === 'identity'
                                        ? 'Original account record'
                                        : row.provenance?.source ||
                                          'Source not supplied'}
                                    </p>
                                  </>
                                )}
                              </div>
                            </details>
                            <a
                              href={`/transactions/${encodeURIComponent(row.id)}/history`}
                              className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                            >
                              Transaction history
                              <ArrowUpRight
                                aria-hidden="true"
                                className="size-3"
                              />
                            </a>
                          </div>
                          <div className="grid grid-cols-2 gap-4 text-sm sm:min-w-64 sm:text-right">
                            <div>
                              <p className="text-xs text-muted-foreground">
                                Original
                              </p>
                              <p className="mt-1 break-words tabular-nums">
                                {money(
                                  row.originalAmountMinor,
                                  row.originalCurrency,
                                )}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">
                                In {totals.currency}
                              </p>
                              <p
                                className={`mt-1 break-words font-semibold tabular-nums ${row.convertedAmountMinor === null ? 'text-amber-700 dark:text-amber-400' : ''}`}
                              >
                                {row.convertedAmountMinor === null
                                  ? 'Missing rate'
                                  : money(
                                      row.convertedAmountMinor,
                                      totals.currency,
                                    )}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                      <p
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        {(currentPage - 1) * pageSize + 1}–
                        {Math.min(currentPage * pageSize, matchingRows.length)}{' '}
                        of {matchingRows.length} transactions
                      </p>
                      <nav
                        aria-label="Transaction pages"
                        className="flex items-center gap-2"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={currentPage === 1}
                          onClick={() => setPage(currentPage - 1)}
                        >
                          <ChevronLeft aria-hidden="true" className="size-4" />
                          Previous
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {currentPage} / {pages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={currentPage === pages}
                          onClick={() => setPage(currentPage + 1)}
                        >
                          Next
                          <ChevronRight aria-hidden="true" className="size-4" />
                        </Button>
                      </nav>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-3 py-9 text-center">
                    <Coins
                      aria-hidden="true"
                      className="size-8 text-muted-foreground"
                    />
                    <h2 className="text-sm font-semibold">
                      {search.trim()
                        ? 'No transactions match your search'
                        : 'No transactions match these filters'}
                    </h2>
                    <p className="max-w-sm text-xs text-muted-foreground">
                      {search.trim()
                        ? 'Try another description or clear the search.'
                        : 'Try a wider date range. Missing bank imports cannot be interpreted as zero spending.'}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => (search.trim() ? setSearch('') : reset())}
                    >
                      {search.trim() ? 'Clear search' : 'Reset filters'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )
      )}
    </div>
  );
}
