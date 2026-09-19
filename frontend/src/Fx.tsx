import { useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from './lib/query';
import { money, tally } from './lib/format';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountBadge, PageHeader, RefreshButton } from '@/components/finance';
import { fxSourceLabel as sourceLabel } from '../../src/fx-sources';
import type { FxConversionStatus } from '../../src/fx-status';
import type { FxDay, FxDayState } from '../../src/fx-coverage';

/**
 * Conversion status.
 *
 * Not a report — every other screen already shows spending in the display
 * currency. This answers the one question none of them can: is every payment
 * counted in that currency, and are the rates behind it still arriving? It is
 * green almost always, and when it is not it says exactly what is missing.
 *
 * Order matters. The answer comes first, what is broken second, and the
 * evidence last: the rate strip is how you check the claim above it, not the
 * first thing you should have to read.
 */
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthFormat = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  timeZone: 'UTC',
});
const day = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));
/** "UAH, EUR or USD" — the currencies a payment could not be priced in. */
const orList = new Intl.ListFormat('en-GB', {
  style: 'long',
  type: 'disjunction',
});

/** The five things a calendar day can be, what each means, and what to do. */
const states: Record<
  FxDayState,
  { name: string; tone: string; meaning: string }
> = {
  // Two of these are faults, and they are different faults. A day the sync has
  // not reached is amber: the rate exists somewhere and a run would fetch it.
  // A day holding a payment nothing could price is red: the rate does not
  // exist, and the payment is listed above. The other two are quiet, because a
  // day nobody published is a closed fact and a day with no payment on it needs
  // nothing at all.
  covered: {
    name: 'Covered',
    tone: 'bg-primary',
    meaning: 'everything paid that day could be priced',
  },
  incomplete: {
    name: 'Payment unpriced',
    tone: 'bg-negative',
    meaning:
      'a rate is stored, but not one that could price everything paid that day',
  },
  empty_at_source: {
    name: 'Empty at source',
    tone: 'bg-muted-foreground/35',
    meaning: 'no bank published a rate that day, and none ever will',
  },
  not_fetched: {
    name: 'Not fetched',
    tone: 'bg-warning',
    meaning: 'the nightly sync has not stored a rate for this day yet',
  },
  not_needed: {
    name: 'No payments',
    tone: 'bg-muted-foreground/15',
    meaning: 'nothing was paid that day, so no rate is needed',
  },
};

/**
 * One cell per day, wrapping, with a light marker where a month starts.
 *
 * Deliberately not a chart: there is no magnitude here, only four states, and
 * the thing worth seeing is where a gap falls in the calendar.
 *
 * Every cell is a button rather than a coloured box, because a phone has no
 * hover: a `title` tooltip left an amber square on a phone screen with no way
 * at all to find out what it meant. Tapping one names the day underneath.
 */
function CoverageStrip({
  days,
  selected,
  onSelect,
}: {
  days: FxDay[];
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Daily rate coverage">
      {days.map((entry) => {
        const first = entry.date.endsWith('-01');
        const label = `${day(entry.date)}: ${states[entry.state].name}`;
        return (
          <li key={entry.date} className="flex items-end gap-1">
            {first && (
              <span
                aria-hidden="true"
                className="text-muted-foreground w-7 shrink-0 text-xs"
              >
                {monthFormat.format(new Date(`${entry.date}T00:00:00Z`))}
              </span>
            )}
            <button
              type="button"
              title={label}
              aria-pressed={selected === entry.date}
              onClick={() => onSelect(entry.date)}
              className={`block size-3.5 rounded-xs ${states[entry.state].tone} ${
                selected === entry.date
                  ? 'ring-foreground ring-2 ring-offset-1'
                  : ''
              }`}
            >
              <span className="sr-only">{label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** What the tapped square means, in a sentence. */
function DayDetail({ entry }: { entry: FxDay }) {
  return (
    <div role="status" className="bg-muted/50 rounded-md px-3 py-2">
      <p className="text-sm">
        <span className="font-medium">{day(entry.date)}</span> ·{' '}
        {states[entry.state].name}
        {entry.source ? ` · ${sourceLabel(entry.source)}` : ''}
      </p>
      <p className="text-muted-foreground text-xs">
        {states[entry.state].meaning}
        {entry.state === 'not_fetched' &&
          '. It fills on the next nightly run — if it stays, that run is failing.'}
        {entry.state === 'incomplete' &&
          '. The payment is listed above, with the currencies it cannot reach.'}
      </p>
    </div>
  );
}

/**
 * Every reporting currency, worst first.
 *
 * Conversion really is per-target — a hryvnia payment is already in hryvnia but
 * needs a rate to become euro — so this cannot be one number. What it must not
 * be is one number for whichever currency the header happens to be showing:
 * that page could read green while the ledger was broken in another currency,
 * which is the one thing a status page must not do. All three, always.
 *
 * The method columns never say anything is wrong and earn their space anyway.
 * Almost every bank-recorded figure is Monobank's own converted amount; if that
 * field stopped arriving they would all quietly fall back to a daily estimate
 * and nothing else in the application would notice.
 */
function CurrencyTable({
  currencies,
  total,
}: {
  currencies: FxConversionStatus['conversions']['currencies'];
  total: number;
}) {
  return (
    <ul className="divide-border divide-y">
      <li className="text-muted-foreground flex gap-3 pb-1 text-xs">
        <span className="w-10 shrink-0">In</span>
        <span className="flex-1 text-right">From the bank</span>
        <span className="flex-1 text-right">By daily rate</span>
        <span className="flex-1 text-right">Already in it</span>
        <span className="w-20 shrink-0 text-right">Missing</span>
      </li>
      {currencies.map((entry) => (
        <li
          key={entry.currency}
          className="flex min-h-11 items-center gap-3 py-2 text-sm tabular-nums"
        >
          <span className="w-10 shrink-0 font-medium">{entry.currency}</span>
          <span className="flex-1 text-right">{tally(entry.method.bank)}</span>
          <span className="flex-1 text-right">{tally(entry.method.daily)}</span>
          <span className="flex-1 text-right">
            {tally(entry.method.identity)}
          </span>
          <span
            className={`w-20 shrink-0 text-right ${entry.missing ? 'text-warning font-medium' : 'text-muted-foreground'}`}
          >
            {entry.missing ? tally(entry.missing) : 'None'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the rate actually was, day by day.
 *
 * The strip above says a day is covered; this says what it was covered *with*.
 * Newest first, because "what is it now" is the question asked most, and the
 * answer to it is the first row.
 *
 * Only covered days appear: a day with no rate has nothing to list, and the
 * strip already shows where those fall. Rows arrive a page at a time rather
 * than a year at once, so the document stays light on a phone.
 */
const PAGE = 30;
function RateHistory({
  days,
  selected,
}: {
  days: FxDay[];
  selected: string | null;
}) {
  const [shown, setShown] = useState(PAGE);
  const history = useMemo(
    () =>
      days
        .filter((entry) => entry.rates && Object.keys(entry.rates).length)
        .reverse(),
    [days],
  );
  // Every pair any day quotes, so the columns are stable as you scroll back
  // through days where one of them was briefly absent.
  const pairs = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of history)
      for (const pair of Object.keys(entry.rates ?? {})) seen.add(pair);
    return [...seen].sort();
  }, [history]);
  if (!history.length) return null;
  const rows = history.slice(0, shown);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Daily rates</h3>
      <ul className="divide-border divide-y">
        <li className="text-muted-foreground flex gap-3 pb-1 text-xs">
          <span className="w-24 shrink-0">Date</span>
          {pairs.map((pair) => (
            <span key={pair} className="flex-1 text-right">
              {pair.replace('/', ' → ')}
            </span>
          ))}
          <span className="hidden w-28 shrink-0 text-right sm:block">
            Source
          </span>
        </li>
        {rows.map((entry) => (
          <li
            key={entry.date}
            className={`flex min-h-11 items-center gap-3 py-2 text-sm tabular-nums ${
              selected === entry.date ? 'bg-muted/50' : ''
            }`}
          >
            <span className="text-muted-foreground w-24 shrink-0 text-xs">
              {day(entry.date)}
            </span>
            {pairs.map((pair) => (
              <span key={pair} className="flex-1 text-right">
                {entry.rates?.[pair] ?? '—'}
              </span>
            ))}
            <span className="text-muted-foreground hidden w-28 shrink-0 truncate text-right text-xs sm:block">
              {entry.source ? sourceLabel(entry.source) : ''}
            </span>
          </li>
        ))}
      </ul>
      {shown < history.length && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShown((held) => held + PAGE)}
        >
          Show {Math.min(PAGE, history.length - shown)} more
        </Button>
      )}
      <p className="text-muted-foreground text-xs tabular-nums">
        {tally(rows.length)} of {tally(history.length)} days
      </p>
    </div>
  );
}

export default function Fx() {
  const [status, setStatus] = useState<FxConversionStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useRefreshSignal();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await fetch('/api/fx', {
          signal: controller.signal,
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'Your session needs attention. Reload to sign in again.'
              : 'The conversion status could not be loaded.',
          );
        setStatus((await response.json()) as FxConversionStatus);
      } catch (cause) {
        if ((cause as Error)?.name === 'AbortError') return;
        setError((cause as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh]);

  const [selected, setSelected] = useState<string | null>(null);
  const selectedDay = useMemo(
    () => status?.rates.days.find((entry) => entry.date === selected) ?? null,
    [status, selected],
  );
  const present = useMemo(() => {
    const seen = new Set(status?.rates.days.map((entry) => entry.state));
    return (Object.keys(states) as FxDayState[]).filter((state) =>
      seen.has(state),
    );
  }, [status]);

  const everything = status ? status.conversions.missing === 0 : false;
  // Name the currencies that are short, rather than whichever one the header is
  // showing: the failure is the point, not the current view.
  const shortfall = (status?.conversions.currencies ?? [])
    .filter((entry) => entry.missing > 0)
    .map((entry) => entry.currency);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Conversion status"
        description="Whether every payment is counted in every currency a total can be reported in, and whether the rates behind them are still arriving."
        actions={<RefreshButton />}
      />
      {error && (
        <p role="alert" className="text-negative text-sm">
          {error}
        </p>
      )}
      {loading && !status && <Skeleton className="h-40 w-full" />}
      {status && (
        <>
          <Card className="gap-3 shadow-xs">
            <CardHeader>
              <CardTitle>Conversions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p
                role={everything ? undefined : 'status'}
                className={`text-lg font-semibold tracking-tight ${everything ? '' : 'text-warning'}`}
              >
                {everything
                  ? `All ${tally(status.conversions.total)} transactions convert to every currency`
                  : `${tally(status.conversions.missing)} of ${tally(status.conversions.total)} transactions have no ${orList.format(shortfall)} amount`}
              </p>
              <CurrencyTable
                currencies={status.conversions.currencies}
                total={status.conversions.total}
              />
            </CardContent>
          </Card>

          {status.conversions.missing > 0 && (
            <Card className="gap-3 shadow-xs">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CircleAlert className="text-warning size-4" />
                  Not converted
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {/* The amount stays in the currency it was paid in. There is no
                    converted figure — that is the whole point of the row — and
                    showing one here would be inventing the number the page
                    exists to say is missing. */}
                <ul className="divide-border divide-y">
                  {status.unconverted.map((row) => (
                    <li
                      key={row.id}
                      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2 sm:flex-nowrap"
                    >
                      <span className="text-muted-foreground w-20 shrink-0 text-xs tabular-nums sm:w-24">
                        {day(row.bookedAt.slice(0, 10))}
                      </span>
                      <AccountBadge
                        size="sm"
                        source={row.account.source}
                        label={row.account.label}
                        currency={row.account.currency}
                        owner={row.account.owner as 'rodion' | 'katya'}
                      />
                      <span
                        title={row.account.name}
                        className="min-w-0 flex-1 truncate text-sm"
                      >
                        {row.account.name}
                      </span>
                      {/* On the phone the amount and the reason drop to a line
                          of their own, so the account keeps the whole first
                          line and stays readable; `sm:contents` dissolves the
                          wrapper on desktop, where all four sit in one row. */}
                      <div className="flex w-full items-center gap-3 sm:contents">
                        <span className="text-sm tabular-nums">
                          {money(row.amountMinor, row.currency)}
                        </span>
                        <span className="text-muted-foreground text-xs sm:w-56 sm:shrink-0">
                          {row.reason}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                {status.unconvertedCapped && (
                  <p className="text-muted-foreground text-xs">
                    Showing the first {tally(status.unconverted.length)} of{' '}
                    {tally(status.conversions.missing)}.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="gap-3 shadow-xs">
            <CardHeader>
              <CardTitle>Rates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm">
                {status.rates.current ? (
                  <>
                    Rates current through{' '}
                    <span className="font-medium">
                      {day(status.rates.current)}
                    </span>
                  </>
                ) : (
                  'No rates are stored'
                )}{' '}
                <span className="text-muted-foreground tabular-nums">
                  · {tally(status.rates.covered)} of{' '}
                  {tally(status.rates.needed)} days priced everything paid on
                  them
                </span>
              </p>
              {status.rates.sources.length > 0 && (
                <p className="text-muted-foreground text-sm">
                  {status.rates.sources.map((entry, index) => (
                    <span key={entry.source}>
                      {index > 0 && ' · '}
                      <span className="text-foreground tabular-nums">
                        {tally(entry.days)}
                      </span>{' '}
                      {entry.days === 1 ? 'day' : 'days'} from{' '}
                      {sourceLabel(entry.source)}
                    </span>
                  ))}
                </p>
              )}
              <CoverageStrip
                days={status.rates.days}
                selected={selected}
                onSelect={(date) =>
                  setSelected((held) => (held === date ? null : date))
                }
              />
              <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {present.map((state) => (
                  <li key={state} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`size-2.5 rounded-xs ${states[state].tone}`}
                    />
                    {states[state].name}
                  </li>
                ))}
              </ul>
              {selectedDay && <DayDetail entry={selectedDay} />}
              <RateHistory days={status.rates.days} selected={selected} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
