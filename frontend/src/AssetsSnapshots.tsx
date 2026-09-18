import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, Clock3, Plus } from 'lucide-react';
import { apiGet, useSession } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import {
  byGroupThenName,
  feedNames,
  holdingsUrl,
  isDecimal,
  refreshHoldings,
  rigaToday,
  postForm,
  sourceNames,
  type HoldingRow,
  type HoldingsReport,
} from './lib/holdings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, Money, PageHeader } from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * Every snapshot the household has taken, and the one form that takes the next
 * one. The figures are written into the page first and saved together: counting
 * the house is one sitting, not thirty separate saves.
 */
export default function AssetsSnapshots() {
  const { currency: display } = useDisplayCurrency();
  const { data: session } = useSession();
  const isMobile = useIsMobile();
  const today = rigaToday();
  const query = useQuery({
    queryKey: ['holdings', display, today],
    queryFn: ({ signal }) =>
      apiGet<HoldingsReport>(holdingsUrl(display, today), signal),
  });
  const report = query.data;
  const [opened, setOpened] = useState(false);
  const [showFed, setShowFed] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');

  // Asking for today adds today to the series even when nothing was counted
  // then — the report values the holdings on any date. `dates` is the list of
  // days a figure was actually written, so the history follows that.
  const snapshots = useMemo(() => {
    const real = new Set(report?.dates ?? []);
    return (report?.series ?? [])
      .filter((point) => real.has(point.asOf))
      .sort((a, b) => b.asOf.localeCompare(a.asOf));
  }, [report?.series, report?.dates]);
  const countedToday = (report?.dates ?? []).includes(today);
  // The form is the point of the page when today is uncounted; once it has been
  // counted it waits behind the action, so the history reads first.
  const formOpen = opened || (Boolean(report) && !countedToday);

  const manual = useMemo(
    () =>
      (report?.rows ?? [])
        .filter((row) => !row.holding.archived && !row.holding.feed)
        .sort((a, b) => byGroupThenName(a.holding, b.holding)),
    [report?.rows],
  );
  const fed = useMemo(
    () =>
      (report?.rows ?? [])
        .filter((row) => !row.holding.archived && row.holding.feed)
        .sort((a, b) => byGroupThenName(a.holding, b.holding)),
    [report?.rows],
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || saving) return;
    const entries = manual
      .map((row) => ({ row, amount: (typed[row.holding.id] ?? '').trim() }))
      .filter((entry) => entry.amount !== '');
    if (!entries.length) {
      setError('Nothing typed yet. Write at least one figure.');
      setSummary('');
      return;
    }
    const wrong = entries.filter((entry) => !isDecimal(entry.amount));
    if (wrong.length) {
      setError(
        `Not a number: ${wrong.map((entry) => entry.row.holding.name).join(', ')}. Write digits, with a dot for the fraction.`,
      );
      setSummary('');
      return;
    }
    setError('');
    setSummary('');
    // Saving makes today counted, which would otherwise fold the form away and
    // take the summary of what was written with it.
    setOpened(true);
    setSaving({ done: 0, total: entries.length });
    const failed: string[] = [];
    const written: string[] = [];
    for (const [index, entry] of entries.entries()) {
      setSaving({ done: index, total: entries.length });
      try {
        await postForm('/api/holding-snapshots', {
          csrf: session.csrf,
          holdingId: entry.row.holding.id,
          asOf: today,
          amount: entry.amount,
        });
        written.push(entry.row.holding.id);
      } catch (cause) {
        failed.push(
          `${entry.row.holding.name} (${cause instanceof Error ? cause.message : 'not saved'})`,
        );
      }
    }
    setSaving(null);
    // Only what the server took is cleared; a failed figure stays in its box so
    // it can be tried again without being typed a second time.
    setTyped((current) => {
      const next = { ...current };
      for (const id of written) delete next[id];
      return next;
    });
    await refreshHoldings();
    setSummary(
      `${written.length} saved${failed.length ? `, ${failed.length} failed: ${failed.join('; ')}` : ''}.`,
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-8">
      <PageHeader
        title="Snapshots"
        description="Each date the household counted what it owns. Count today by writing every figure, then saving them together."
        actions={
          <Button
            size="sm"
            disabled={!report || !session || formOpen}
            onClick={() => setOpened(true)}
          >
            <Plus />
            New snapshot for today
          </Button>
        }
      />
      {query.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-4"
        >
          <p className="max-w-xl text-sm">{query.error.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      )}
      {!report ? (
        <div role="status" aria-label="Loading snapshots" className="space-y-4">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-96 rounded-lg" />
          <span className="sr-only">Loading the snapshots</span>
        </div>
      ) : (
        <>
          {formOpen && (
            <Card className="shadow-xs">
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Count today · {today}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Each figure is in the holding’s own unit — the currency is
                  fixed for an asset. Leave a box empty to carry the last figure
                  forward. One Save writes them all.
                </p>
              </CardHeader>
              <CardContent className="space-y-4 p-0 sm:p-0">
                <form onSubmit={save} className="space-y-4">
                  {manual.length === 0 ? (
                    <div className="px-4 pb-4 sm:px-6">
                      <EmptyState
                        icon={CalendarDays}
                        title="Nothing to type"
                        text="Every holding is filled by a feed, or none exists yet."
                        action={
                          <Button
                            size="sm"
                            render={
                              <a href={`/assets/new?display=${display}`} />
                            }
                          >
                            <Plus />
                            Add a holding
                          </Button>
                        }
                      />
                    </div>
                  ) : (
                    <ul className="divide-y border-y">
                      {manual.map((row) => (
                        <li key={row.holding.id}>
                          <EntryRow
                            row={row}
                            today={today}
                            value={typed[row.holding.id] ?? ''}
                            disabled={!session || saving !== null}
                            onChange={(value) =>
                              setTyped((current) => ({
                                ...current,
                                [row.holding.id]: value,
                              }))
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="space-y-3 px-4 pb-4 sm:px-6">
                    {fed.length > 0 && (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={showFed}
                          onCheckedChange={(checked) =>
                            setShowFed(Boolean(checked))
                          }
                        />
                        Show automatic holdings ({fed.length})
                      </label>
                    )}
                    {showFed && fed.length > 0 && (
                      <ul className="divide-y rounded-md border">
                        {fed.map((row) => (
                          <li
                            key={row.holding.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                          >
                            <span className="min-w-0 truncate">
                              {row.holding.name}
                            </span>
                            <span className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="tabular-nums">
                                {row.quantity ?? '—'} {row.holding.denomination}
                              </span>
                              <span>
                                ·{' '}
                                {row.source
                                  ? (sourceNames[row.source] ?? row.source)
                                  : row.holding.feed
                                    ? feedNames[row.holding.feed]
                                    : ''}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {error && (
                      <p role="alert" className="text-sm text-destructive">
                        {error}
                      </p>
                    )}
                    {summary && (
                      <p
                        role="status"
                        className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm"
                      >
                        {summary}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="submit"
                        disabled={!session || saving !== null || !manual.length}
                      >
                        {saving
                          ? `Saving ${saving.done + 1} of ${saving.total}…`
                          : 'Save all figures'}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {countedToday
                          ? 'Today already has a snapshot; saving again replaces the figures you typed.'
                          : 'Today has no snapshot yet.'}
                      </span>
                    </div>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
          <Card className="shadow-xs">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Every snapshot · {display}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 sm:p-0">
              {snapshots.length === 0 ? (
                <EmptyState
                  icon={Clock3}
                  title="No snapshot yet"
                  text="Write today’s figures above and save them; this list starts there."
                />
              ) : isMobile ? (
                <ul className="divide-y border-t">
                  {snapshots.map((point) => (
                    <li key={point.asOf} className="px-4 py-3">
                      <a
                        href={`/assets?at=${point.asOf}&display=${display}`}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium tabular-nums">
                            {point.asOf}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {point.counted} counted
                          </span>
                        </span>
                        <span className="text-right">
                          <Money
                            minor={point.totalMinor}
                            currency={display}
                            className="block text-sm font-medium"
                          />
                          <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                            invested{' '}
                            <Money
                              minor={point.investedMinor}
                              currency={display}
                            />
                          </span>
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            liquid{' '}
                            <Money
                              minor={point.liquidMinor}
                              currency={display}
                            />
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Counted on</TableHead>
                      <TableHead className="text-right">Everything</TableHead>
                      <TableHead className="text-right">Invested</TableHead>
                      <TableHead className="text-right">Liquid</TableHead>
                      <TableHead className="text-right">Holdings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshots.map((point) => (
                      <TableRow key={point.asOf}>
                        <TableCell className="tabular-nums">
                          <a
                            href={`/assets?at=${point.asOf}&display=${display}`}
                            className="font-medium underline-offset-4 hover:underline"
                          >
                            {point.asOf}
                          </a>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          <Money minor={point.totalMinor} currency={display} />
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          <Money
                            minor={point.investedMinor}
                            currency={display}
                          />
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          <Money minor={point.liquidMinor} currency={display} />
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                          {point.counted}
                          {point.missing
                            ? ` · ${point.missing} without a price`
                            : ''}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** One holding to write a figure for: what it is, what it last was, a box. */
function EntryRow({
  row,
  today,
  value,
  disabled,
  onChange,
}: {
  row: HoldingRow;
  today: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const previous =
    row.quantity === null
      ? null
      : `${row.quantity} ${row.holding.denomination}`;
  const when =
    row.quantityAsOf === null
      ? 'never counted'
      : row.quantityAsOf === today
        ? 'counted today'
        : `carried from ${row.quantityAsOf}`;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="min-w-0 sm:flex-1">
        <p className="truncate text-sm font-medium" title={row.holding.name}>
          {row.holding.name}
        </p>
        {row.holding.group && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {row.holding.group}
          </p>
        )}
      </div>
      <div className="text-xs text-muted-foreground sm:w-52 sm:text-right">
        <span className="tabular-nums">{previous ?? '—'}</span>
        <span className="ml-2 sm:ml-0 sm:block">{when}</span>
      </div>
      <div className="flex items-center gap-2 sm:w-56">
        <Input
          aria-label={`Amount of ${row.holding.name} today`}
          inputMode="decimal"
          className="h-11 flex-1 tabular-nums sm:h-9"
          placeholder={row.quantity ?? '0'}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="w-14 shrink-0 text-xs text-muted-foreground">
          {row.holding.denomination}
        </span>
      </div>
    </div>
  );
}
