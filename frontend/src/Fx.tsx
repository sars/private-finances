import { useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from './lib/query';
import { money, tally } from './lib/format';
import { useDisplayCurrency } from './lib/display-currency';
import { CircleAlert } from 'lucide-react';
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

/** The four things a calendar day can be, what each means, and what to do. */
const states: Record<
  FxDayState,
  { name: string; tone: string; meaning: string }
> = {
  // Only one of these is a fault. A day nobody published is a closed fact and a
  // day with no payment on it needs nothing, so both stay quiet; a day the sync
  // has not reached is amber, because it is the one the owner can act on.
  covered: {
    name: 'Covered',
    tone: 'bg-primary',
    meaning: 'a rate is stored for this day',
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
      </p>
    </div>
  );
}

/**
 * How each converted payment got its figure.
 *
 * This line never says anything is wrong, and it earns its space anyway. Almost
 * every bank-recorded figure is Monobank's own converted amount; if that field
 * stopped arriving, all of them would quietly fall back to a daily estimate and
 * nothing else in the application would notice. Seeing the shares move is the
 * only warning that collapse would ever give.
 */
function Composition({
  method,
  currency,
}: {
  method: FxConversionStatus['conversions']['method'];
  currency: string;
}) {
  const parts = [
    [method.bank, 'from the bank'],
    [method.daily, 'by daily rate'],
    [method.identity, `already in ${currency}`],
  ] as const;
  const shown = parts.filter(([value]) => value > 0);
  if (!shown.length) return null;
  return (
    <p className="text-muted-foreground mt-1 text-sm">
      {shown.map(([value, label], index) => (
        <span key={label}>
          {index > 0 && ' · '}
          <span className="text-foreground tabular-nums">
            {tally(value)}
          </span>{' '}
          {label}
        </span>
      ))}
    </p>
  );
}

export default function Fx() {
  const { currency: target } = useDisplayCurrency();
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
        const response = await fetch(
          '/api/fx?display=' + encodeURIComponent(target),
          {
            signal: controller.signal,
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          },
        );
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
  }, [target, refresh]);

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
  return (
    <div className="space-y-5">
      <PageHeader
        title="Conversion status"
        description={`Whether every payment is counted in ${target}, and whether the rates behind it are still arriving.`}
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
            <CardContent>
              <p
                role={everything ? undefined : 'status'}
                className={`text-lg font-semibold tracking-tight ${everything ? '' : 'text-warning'}`}
              >
                {everything
                  ? `All ${tally(status.conversions.total)} transactions have a ${target} amount`
                  : `${tally(status.conversions.missing)} of ${tally(status.conversions.total)} transactions have no ${target} amount`}
              </p>
              <Composition
                method={status.conversions.method}
                currency={target}
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
                  {tally(status.rates.needed)} days
                </span>
              </p>
              {/* The rate itself. A page about rates that never showed one made
                  the owner take the coverage claim on trust; this is the number
                  a conversion on that day would actually use, chosen by the
                  same source precedence the conversion applies. */}
              {status.rates.latest.length > 0 && (
                <ul className="divide-border divide-y">
                  {status.rates.latest.map((quote) => (
                    <li
                      key={`${quote.base}/${quote.target}`}
                      className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
                    >
                      <span className="text-sm tabular-nums">
                        1 {quote.base} ={' '}
                        <span className="font-medium">
                          {quote.rate} {quote.target}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {sourceLabel(quote.source)} · {day(quote.asOf)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
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
              {selectedDay && <DayDetail entry={selectedDay} />}
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
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
