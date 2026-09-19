import { useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from './lib/query';
import { money, tally } from './lib/format';
import { useDisplayCurrency } from './lib/display-currency';
import { CircleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountBadge, PageHeader, RefreshButton } from '@/components/finance';
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

/** The three things a calendar day can be, and what each one means. */
const states: Record<FxDayState, { name: string; tone: string }> = {
  // A day nobody published is a closed fact, not a fault, so it is grey and
  // quiet. A day the sync has not reached is amber, because it is the one of
  // the three the owner can actually do something about.
  covered: { name: 'Covered', tone: 'bg-primary' },
  empty_at_source: {
    name: 'Empty at source',
    tone: 'bg-muted-foreground/35',
  },
  not_fetched: { name: 'Not fetched', tone: 'bg-warning' },
};

/**
 * One cell per day, wrapping, with a light marker where a month starts.
 *
 * Deliberately not a chart: there is no magnitude here, only three states, and
 * the thing worth seeing is where a gap falls in the calendar. A cell carries
 * its date and state as its accessible name, so the strip reads as a list of
 * days rather than as decoration a screen reader has to skip.
 */
function CoverageStrip({ days }: { days: FxDay[] }) {
  return (
    <ul className="flex flex-wrap gap-0.5" aria-label="Daily rate coverage">
      {days.map((entry) => {
        const first = entry.date.endsWith('-01');
        return (
          <li key={entry.date} className="flex items-end gap-0.5">
            {first && (
              <span
                aria-hidden="true"
                className="text-muted-foreground w-7 shrink-0 text-xs"
              >
                {monthFormat.format(new Date(`${entry.date}T00:00:00Z`))}
              </span>
            )}
            <span
              title={`${day(entry.date)} — ${states[entry.state].name}`}
              className={`block size-2.5 rounded-xs ${states[entry.state].tone}`}
            >
              <span className="sr-only">
                {day(entry.date)}: {states[entry.state].name}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
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
          <span className="text-foreground tabular-nums">{tally(value)}</span>{' '}
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
                      <span className="text-muted-foreground w-24 shrink-0 text-xs tabular-nums">
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
                      <span className="text-sm tabular-nums">
                        {money(row.amountMinor, row.currency)}
                      </span>
                      <span className="text-muted-foreground w-full text-xs sm:w-56 sm:shrink-0">
                        {row.reason}
                      </span>
                    </li>
                  ))}
                </ul>
                {status.unconvertedCapped && (
                  <p className="text-muted-foreground text-xs">
                    Showing the first {tally(status.unconverted.length)}{' '}
                    of {tally(status.conversions.missing)}.
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
              <CoverageStrip days={status.rates.days} />
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
