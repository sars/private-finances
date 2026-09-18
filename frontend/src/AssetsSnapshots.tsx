import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  Clock3,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { apiGet, useSession } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import { useUrlField, useUrlSearch } from './lib/navigation';
import {
  byGroupThenName,
  deleteSnapshotDay,
  feedNames,
  holdingsUrl,
  isDay,
  isDecimal,
  refreshHoldings,
  rigaToday,
  postForm,
  sourceNames,
  type HoldingRow,
  type HoldingsReport,
  readFeeds,
  describeOutcomes,
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
import {
  EmptyState,
  Money,
  PageHeader,
  RefreshButton,
} from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * Every snapshot the household has taken, and the one form that writes a day's
 * figures. Which day the form is for is in the address (`?date=`), so counting
 * today and correcting a day counted last month are the same screen, reached
 * by two different links.
 */
export default function AssetsSnapshots() {
  const { currency: display } = useDisplayCurrency();
  const { data: session } = useSession();
  const isMobile = useIsMobile();
  const today = rigaToday();
  // The form's day comes from the URL; its absence is what keeps the form shut.
  const [date] = useUrlField('date', today);
  const search = useUrlSearch();
  const formOpen = search.date !== undefined;
  const day = isDay(date) ? date : today;

  const query = useQuery({
    queryKey: ['holdings', display, day],
    queryFn: ({ signal }) =>
      apiGet<HoldingsReport>(holdingsUrl(display, day), signal),
  });
  const report = query.data;
  const [showFed, setShowFed] = useState(false);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const isToday = day === today;

  /** Today's automatic figures, read now and written into the day; returns the one-line account of it. */
  async function readAutomatic(): Promise<string | null> {
    if (!session) return null;
    setReading(true);
    try {
      const { outcomes } = await readFeeds(session.csrf, day);
      return describeOutcomes(outcomes);
    } finally {
      setReading(false);
    }
  }

  async function readOnly() {
    if (!session || reading || saving) return;
    setError('');
    setSummary('');
    try {
      const account = await readAutomatic();
      await refreshHoldings();
      setSummary(`Automatic figures for ${day}: ${account}.`);
    } catch (cause) {
      setError(
        `Automatic figures not read: ${cause instanceof Error ? cause.message : 'try again'}`,
      );
    }
  }
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [removeError, setRemoveError] = useState('');

  // Asking for a day adds it to the series even when nothing was counted then —
  // the report values the holdings on any date. `dates` is the list of days a
  // figure was actually written, so the history follows that.
  const snapshots = useMemo(() => {
    const real = new Set(report?.dates ?? []);
    return (report?.series ?? [])
      .filter((point) => real.has(point.asOf))
      .sort((a, b) => b.asOf.localeCompare(a.asOf));
  }, [report?.series, report?.dates]);
  const countedThatDay = (report?.dates ?? []).includes(day);

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
  // What the boxes start with: the figure this holding has on that day, even
  // when it was carried from an earlier one. Editing a day begins from what
  // the day already says, not from an empty form.
  const prefill = useMemo(() => {
    const values: Record<string, string> = {};
    for (const row of manual) values[row.holding.id] = row.quantity ?? '';
    return values;
  }, [manual]);

  // Moving to another day is a different form; nothing typed for the old one
  // carries over, and neither does what the old one reported.
  const [openedDay, setOpenedDay] = useState(day);
  if (openedDay !== day) {
    setOpenedDay(day);
    setEdited({});
    setSummary('');
    setError('');
  }

  const valueOf = (id: string) => edited[id] ?? prefill[id] ?? '';
  // Only what a person actually changed is written; an untouched box re-saving
  // its own figure would record a count that never happened.
  const changed = manual
    .map((row) => ({
      row,
      amount: valueOf(row.holding.id).trim(),
      before: (prefill[row.holding.id] ?? '').trim(),
    }))
    .filter((entry) => entry.amount !== '' && entry.amount !== entry.before);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || saving || reading) return;
    if (!changed.length && !isToday) {
      setError('Nothing changed yet. Edit at least one figure.');
      setSummary('');
      return;
    }
    const wrong = changed.filter((entry) => !isDecimal(entry.amount));
    if (wrong.length) {
      setError(
        `Not a number: ${wrong.map((entry) => entry.row.holding.name).join(', ')}. Write digits, with a dot for the fraction.`,
      );
      setSummary('');
      return;
    }
    setError('');
    setSummary('');
    // Today's snapshot is the automatic figures of this moment and what was
    // typed, taken together; the reading comes first so a failure there is
    // reported beside the saved rows rather than lost.
    let automatic: string | null = null;
    if (isToday) {
      try {
        automatic = await readAutomatic();
      } catch (cause) {
        automatic = `not read (${cause instanceof Error ? cause.message : 'try again'})`;
      }
    }
    setSaving({ done: 0, total: changed.length });
    const failed: string[] = [];
    const written: string[] = [];
    for (const [index, entry] of changed.entries()) {
      setSaving({ done: index, total: changed.length });
      try {
        await postForm('/api/holding-snapshots', {
          csrf: session.csrf,
          holdingId: entry.row.holding.id,
          asOf: day,
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
    // A saved figure goes back to being the box's own starting value; a failed
    // one stays edited, so it can be tried again without being typed twice.
    setEdited((current) => {
      const next = { ...current };
      for (const id of written) delete next[id];
      return next;
    });
    await refreshHoldings();
    setSummary(
      `${written.length} typed figure${written.length === 1 ? '' : 's'} saved for ${day}${failed.length ? `, ${failed.length} failed: ${failed.join('; ')}` : ''}${automatic ? `. Automatic figures: ${automatic}` : ''}.`,
    );
  }

  async function remove(asOf: string) {
    if (!session || removing) return;
    setRemoving(asOf);
    setRemoveError('');
    setNotice('');
    try {
      const { removed } = await deleteSnapshotDay(session.csrf, asOf);
      setConfirming(null);
      await refreshHoldings();
      setNotice(
        `${removed === 1 ? '1 figure' : `${removed} figures`} removed from ${asOf}.`,
      );
    } catch (cause) {
      setRemoveError(
        `${asOf} not removed: ${cause instanceof Error ? cause.message : 'try again'}`,
      );
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-8">
      <div>
        <Button
          variant="ghost"
          size="sm"
          render={<a href={`/assets?display=${display}`} />}
        >
          <ChevronLeft />
          Back to Assets
        </Button>
      </div>
      <PageHeader
        title="Snapshots"
        description="Each date the household counted what it owns. Open a date to correct it, or count today."
        actions={
          <>
            <RefreshButton />
            <Button
              size="sm"
              disabled={!report}
              render={
                <a
                  href={`/assets/snapshots?date=${today}&display=${display}`}
                />
              }
            >
              <Plus />
              New snapshot for today
            </Button>
          </>
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
                  {day === today ? `Count today · ${day}` : `Figures of ${day}`}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Each box holds what this holding is worth on {day}, in the
                  holding’s own unit — carried from an earlier count where that
                  day has none. Change the ones that are wrong; a box left as it
                  was is not written. One Save writes them all.
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
                            day={day}
                            value={valueOf(row.holding.id)}
                            changed={
                              valueOf(row.holding.id).trim() !==
                              (prefill[row.holding.id] ?? '').trim()
                            }
                            disabled={!session || saving !== null}
                            onChange={(value) =>
                              setEdited((current) => ({
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
                        disabled={
                          !session ||
                          saving !== null ||
                          reading ||
                          (!manual.length && !isToday)
                        }
                      >
                        {reading && !saving
                          ? 'Reading automatic figures…'
                          : saving
                            ? `Saving ${saving.done + 1} of ${saving.total}…`
                            : isToday
                              ? changed.length
                                ? `Read automatic and save ${changed.length} changed`
                                : 'Read automatic figures and save'
                              : changed.length
                                ? `Save ${changed.length} changed`
                                : 'Save changed figures'}
                      </Button>
                      {isToday && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!session || saving !== null || reading}
                          onClick={() => void readOnly()}
                        >
                          Read automatic figures only
                        </Button>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {countedThatDay
                          ? `${day} already has a snapshot; saving replaces the figures you changed.`
                          : `${day} has no snapshot yet.`}
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
              {notice && (
                <p
                  role="status"
                  className="mt-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm"
                >
                  {notice}
                </p>
              )}
              {removeError && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {removeError}
                </p>
              )}
            </CardHeader>
            <CardContent className="p-0 sm:p-0">
              {snapshots.length === 0 ? (
                <EmptyState
                  icon={Clock3}
                  title="No snapshot yet"
                  text="Count today’s figures and save them; this list starts there."
                  action={
                    <Button
                      size="sm"
                      render={
                        <a
                          href={`/assets/snapshots?date=${today}&display=${display}`}
                        />
                      }
                    >
                      <Plus />
                      New snapshot
                    </Button>
                  }
                />
              ) : isMobile ? (
                <ul className="divide-y border-t">
                  {snapshots.map((point) => (
                    <li key={point.asOf} className="space-y-2 px-4 py-3">
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
                      <DayActions
                        asOf={point.asOf}
                        display={display}
                        asking={confirming === point.asOf}
                        busy={removing === point.asOf}
                        disabled={!session || removing !== null}
                        onAsk={() => {
                          setConfirming(point.asOf);
                          setRemoveError('');
                          setNotice('');
                        }}
                        onCancel={() => setConfirming(null)}
                        onConfirm={() => void remove(point.asOf)}
                      />
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
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
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
                        <TableCell className="text-right">
                          <DayActions
                            asOf={point.asOf}
                            display={display}
                            asking={confirming === point.asOf}
                            busy={removing === point.asOf}
                            disabled={!session || removing !== null}
                            onAsk={() => {
                              setConfirming(point.asOf);
                              setRemoveError('');
                              setNotice('');
                            }}
                            onCancel={() => setConfirming(null)}
                            onConfirm={() => void remove(point.asOf)}
                          />
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

/**
 * What a date row offers: open it in the form, or take the whole day out. The
 * question is asked in the row itself — a browser dialog would be dismissed
 * without being read, and this one says which day it means.
 */
function DayActions({
  asOf,
  display,
  asking,
  busy,
  disabled,
  onAsk,
  onCancel,
  onConfirm,
}: {
  asOf: string;
  display: string;
  asking: boolean;
  busy: boolean;
  disabled: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (asking)
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="w-full text-xs text-muted-foreground sm:w-auto">
          Remove all figures of {asOf}?
        </span>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Removing…' : 'Confirm'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        variant="outline"
        render={
          <a href={`/assets/snapshots?date=${asOf}&display=${display}`} />
        }
      >
        <Pencil />
        Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={onAsk}
        aria-label={`Remove the figures of ${asOf}`}
      >
        <Trash2 />
        Remove
      </Button>
    </div>
  );
}

/** One holding to write a figure for: what it is, where its figure came from,
 * and a box that already holds it. */
function EntryRow({
  row,
  day,
  value,
  changed,
  disabled,
  onChange,
}: {
  row: HoldingRow;
  day: string;
  value: string;
  changed: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const when =
    row.quantityAsOf === null
      ? 'never counted'
      : row.quantityAsOf === day
        ? 'counted this day'
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
        <span className="tabular-nums">{row.quantity ?? '—'}</span>
        <span className="ml-2 sm:ml-0 sm:block">
          {changed ? `${when}, edited` : when}
        </span>
      </div>
      <div className="flex items-center gap-2 sm:w-56">
        <Input
          aria-label={`Amount of ${row.holding.name} on ${day}`}
          inputMode="decimal"
          className="h-11 flex-1 tabular-nums sm:h-9"
          placeholder="0"
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
