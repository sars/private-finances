import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Clock3,
  Pencil,
  Plus,
  Gem,
  X,
} from 'lucide-react';
import { apiGet, queryClient } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import { useUrlField } from './lib/navigation';
import { money, toNumber } from './lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
  Choice,
  EmptyState,
  KpiCard,
  Money,
  PageHeader,
} from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';
import type { DonutSlice } from '@/components/charts/Donut';
const BarSeries = lazy(() => import('@/components/charts/BarSeries'));
const Donut = lazy(() => import('@/components/charts/Donut'));

type Holding = {
  id: string;
  name: string;
  kind: string;
  denomination: string;
  invested: boolean;
  liquid: boolean;
  owner: 'rodion' | 'katya' | null;
  group: string | null;
  maturesOn: string | null;
  note: string | null;
  archived: boolean;
  revision: number;
  feed: Feed | null;
  feedRef: string | null;
};
type Feed = 'bank' | 'ibkr' | 'binance' | 'wallet';
type LinkableAccount = {
  source: string;
  accountId: string;
  owner: 'rodion' | 'katya';
  label: string;
  currencies: string[];
};
type Row = {
  holding: Holding;
  quantity: string | null;
  quantityAsOf: string | null;
  carried: boolean;
  source: string | null;
  enteredAmount: string | null;
  enteredCurrency: string | null;
  valueMinor: string | null;
  price: {
    usdPerUnit: string;
    asOf: string;
    source: string;
    approximate: boolean;
  } | null;
};
type Totals = {
  asOf: string;
  totalMinor: string;
  investedMinor: string;
  notInvestedMinor: string;
  liquidMinor: string;
  uahMinor: string;
  missing: number;
  counted: number;
};
type Report = {
  display: string;
  at: string;
  dates: string[];
  rows: Row[];
  totals: Totals;
  previous: Totals | null;
  series: Totals[];
  accounts: LinkableAccount[];
};

const kinds: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank account',
  broker: 'Brokerage',
  crypto: 'Crypto',
  bond: 'Bond',
  deposit: 'Deposit',
  fund: 'Fund',
  real_estate: 'Real estate',
  business: 'Business',
  receivable: 'Owed to us',
  other: 'Other',
};
const feeds: Record<Feed, string> = {
  bank: 'Bank balance',
  ibkr: 'Interactive Brokers',
  binance: 'Binance',
  wallet: 'Wallet address',
};
const sourceLabel: Record<string, string> = {
  manual: 'typed',
  spreadsheet: 'spreadsheet',
  bank: 'from the bank',
  ibkr: 'from IBKR',
  binance: 'from Binance',
  wallet: 'from the wallet',
};
const currencies = ['USD', 'EUR', 'UAH', 'GBP'];
const isCurrency = (symbol: string) => currencies.includes(symbol);
const rigaToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const monthLabel = (day: string) =>
  new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit' }).format(
    new Date(`${day}T00:00:00Z`),
  );
const refresh = () => queryClient.invalidateQueries({ queryKey: ['holdings'] });

/** Everything the chosen half is not; minor units stay exact, so BigInt. */
const rest = (total: string, part: string) =>
  (BigInt(total) - BigInt(part)).toString();

/** The three ways the same money divides in two: the time chart and the
 *  composition rings read one of these. */
type SplitKey = 'invested' | 'uah' | 'liquid';
type Split = {
  label: string;
  first: string;
  second: string;
  /** The chart token the first half takes; the second half is always gray. */
  tone: number;
  a: (totals: Totals) => string;
  b: (totals: Totals) => string;
};
const splits: Record<SplitKey, Split> = {
  invested: {
    label: 'Invested vs not',
    first: 'Invested',
    second: 'Not invested',
    tone: 1,
    a: (totals) => totals.investedMinor,
    b: (totals) => totals.notInvestedMinor,
  },
  uah: {
    label: 'UAH vs other',
    first: 'In hryvnia',
    second: 'Other currencies',
    tone: 3,
    a: (totals) => totals.uahMinor,
    b: (totals) => rest(totals.totalMinor, totals.uahMinor),
  },
  liquid: {
    label: 'Liquid vs not',
    first: 'Liquid',
    second: 'Not liquid',
    tone: 2,
    a: (totals) => totals.liquidMinor,
    b: (totals) => rest(totals.totalMinor, totals.liquidMinor),
  },
};
const splitKeys = Object.keys(splits) as SplitKey[];
/** Seven slices before "Others", which keeps gray to itself; the last two
 *  step back through the tokens, drawn lighter so no two neighbours match. */
const topTones = [1, 2, 3, 4, 6, 1, 2];
const topCount = topTones.length;

export default function Assets() {
  const { currency: display } = useDisplayCurrency();
  const isMobile = useIsMobile();
  const [at, setAt] = useUrlField('at', '');
  const [excluded, setExcluded] = useUrlField('exclude', '');
  const [split, setSplit] = useState<SplitKey>('invested');
  const [showRetired, setShowRetired] = useState(false);
  const [grouped, setGrouped] = useState(true);
  const [showZero, setShowZero] = useState(false);
  const [onlyManual, setOnlyManual] = useState(false);
  // Groups start closed: the list is long, and the subtotals are the point.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const query = useQuery({
    queryKey: ['holdings', display, at],
    queryFn: ({ signal }) =>
      apiGet<Report>(
        `/api/holdings?display=${display}${at ? `&at=${at}` : ''}`,
        signal,
      ),
  });
  const report = query.data;
  const hidden = useMemo(() => excluded.split(',').filter(Boolean), [excluded]);
  const hide = (id: string) =>
    setExcluded([...hidden.filter((each) => each !== id), id].join(','));
  const unhide = (id: string) =>
    setExcluded(hidden.filter((each) => each !== id).join(','));
  const dateOptions = useMemo(() => {
    const days = [...(report?.dates ?? [])];
    if (at && !days.includes(at)) days.push(at);
    return days
      .sort()
      .reverse()
      .map((day) => ({ value: day, label: day }));
  }, [report?.dates, at]);
  const isZero = (row: Row) =>
    row.quantity !== null && /^-?0(?:\.0+)?$/.test(row.quantity);
  const rows = (report?.rows ?? []).filter(
    (row) =>
      (showRetired || !row.holding.archived) &&
      (showZero || !isZero(row)) &&
      (!onlyManual || !row.holding.feed),
  );
  // Rows by their group, with each group's value in the display currency;
  // a holding without a group sits under its kind.
  const groups = useMemo(() => {
    const byKey = new Map<string, { label: string; rows: Row[] }>();
    for (const row of rows) {
      const label = row.holding.group ?? kinds[row.holding.kind] ?? 'Other';
      const key = row.holding.group ? `g:${label}` : `k:${label}`;
      const entry = byKey.get(key) ?? { label, rows: [] };
      entry.rows.push(row);
      byKey.set(key, entry);
    }
    return [...byKey.entries()].map(([key, entry]) => {
      let sum = 0n;
      let missing = 0;
      for (const row of entry.rows) {
        if (row.valueMinor !== null) sum += BigInt(row.valueMinor);
        else if (row.quantity !== null && row.quantity !== '0') missing += 1;
      }
      return {
        key,
        label: entry.label,
        rows: entry.rows,
        totalMinor: sum.toString(),
        missing,
      };
    });
  }, [rows]);
  const toggleGroup = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const chart = useMemo(() => {
    const chosen = splits[split];
    return (report?.series ?? []).map((point) => {
      const aMinor = chosen.a(point);
      const bMinor = chosen.b(point);
      return {
        asOf: point.asOf,
        a: toNumber(aMinor, display),
        b: toNumber(bMinor, display),
        aMinor,
        bMinor,
        totalMinor: point.totalMinor,
      };
    });
  }, [report?.series, display, split]);
  // One ring per way the money divides, all read off the chosen date.
  const composition = useMemo(() => {
    const totals = report?.totals;
    if (!totals) return [];
    return splitKeys.map((key) => {
      const chosen = splits[key];
      const aMinor = chosen.a(totals);
      const bMinor = chosen.b(totals);
      return {
        key,
        label: chosen.label,
        slices: [
          {
            key: 'first',
            label: chosen.first,
            value: toNumber(aMinor, display),
            detail: money(aMinor, display),
            tone: chosen.tone,
          },
          {
            key: 'second',
            label: chosen.second,
            value: toNumber(bMinor, display),
            detail: money(bMinor, display),
            tone: 5,
          },
        ],
      };
    });
  }, [report?.totals, display]);
  // The biggest holdings on the date, minus the ones sent away; the next one
  // down takes the place each exclusion frees.
  const biggest = useMemo(() => {
    const counted = (report?.rows ?? [])
      .filter(
        (row) =>
          !row.holding.archived &&
          row.valueMinor !== null &&
          BigInt(row.valueMinor) > 0n &&
          !hidden.includes(row.holding.id),
      )
      .sort((left, right) => {
        const a = BigInt(left.valueMinor!);
        const b = BigInt(right.valueMinor!);
        return a === b ? 0 : b > a ? 1 : -1;
      });
    const head = counted.slice(0, topCount);
    const tail = counted.slice(topCount);
    const slices: DonutSlice[] = head.map((row, index) => ({
      key: row.holding.id,
      label: row.holding.name,
      value: toNumber(row.valueMinor!, display),
      detail: money(row.valueMinor!, display),
      tone: topTones[index],
      dim: index >= 5,
    }));
    if (tail.length) {
      const others = tail.reduce(
        (sum, row) => sum + BigInt(row.valueMinor!),
        0n,
      );
      slices.push({
        key: 'others',
        label: `Others · ${tail.length}`,
        value: toNumber(others.toString(), display),
        detail: money(others.toString(), display),
        tone: 5,
        dim: true,
        fixed: true,
      });
    }
    return slices;
  }, [report?.rows, display, hidden]);
  const names = useMemo(
    () =>
      new Map(
        (report?.rows ?? []).map((row) => [row.holding.id, row.holding.name]),
      ),
    [report?.rows],
  );
  const selected = report?.at ?? at;
  const anyValue = report ? BigInt(report.totals.totalMinor) !== 0n : false;
  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <PageHeader
        title="Assets"
        description="What the household owns, counted on a date and valued in the display currency. A figure not counted again is carried from the last time it was."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              render={<a href="/assets/snapshots" />}
            >
              <CalendarDays />
              Snapshots
            </Button>
            <Button
              variant="outline"
              size="sm"
              render={<a href={`/assets/snapshots?date=${rigaToday()}`} />}
            >
              <Plus />
              New snapshot
            </Button>
            <Button size="sm" render={<a href="/assets/new" />}>
              <Plus />
              Add holding
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
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      )}
      {!report ? (
        <div role="status" aria-label="Loading assets" className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-32 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-lg" />
          <span className="sr-only">Loading your assets</span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              Counted on
              <Choice
                aria-label="Snapshot date"
                size="sm"
                className="w-36"
                value={selected}
                onChange={(value) => setAt(value)}
                options={
                  dateOptions.length
                    ? dateOptions
                    : [{ value: selected, label: selected }]
                }
              />
            </span>
            <span>
              {report.totals.counted} holdings counted
              {report.totals.missing
                ? ` · ${report.totals.missing} without a price`
                : ''}
            </span>
            <label className="ml-auto flex items-center gap-2">
              <Checkbox
                checked={onlyManual}
                onCheckedChange={(checked) => setOnlyManual(Boolean(checked))}
              />
              Only what I type
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={showZero}
                onCheckedChange={(checked) => setShowZero(Boolean(checked))}
              />
              Show zero holdings
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={grouped}
                onCheckedChange={(checked) => setGrouped(Boolean(checked))}
              />
              Group rows
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={showRetired}
                onCheckedChange={(checked) => setShowRetired(Boolean(checked))}
              />
              Show retired holdings
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Everything"
              minor={report.totals.totalMinor}
              currency={display}
              previousMinor={report.previous?.totalMinor ?? null}
              higherIsWorse={false}
              icon={Gem}
              note={
                report.previous
                  ? undefined
                  : 'The first snapshot; deltas appear from the next one.'
              }
            />
            <KpiCard
              label="Invested"
              minor={report.totals.investedMinor}
              currency={display}
              previousMinor={report.previous?.investedMinor ?? null}
              higherIsWorse={false}
              note="Not invested is the rest"
            />
            <KpiCard
              label="Liquid"
              minor={report.totals.liquidMinor}
              currency={display}
              previousMinor={report.previous?.liquidMinor ?? null}
              higherIsWorse={false}
              note="Can be turned into money quickly"
            />
            <KpiCard
              label="In hryvnia"
              minor={report.totals.uahMinor}
              currency={display}
              previousMinor={report.previous?.uahMinor ?? null}
              higherIsWorse
              note="Everything denominated in UAH"
            />
          </div>
          <Card className="shadow-xs">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-sm font-medium">
                Over time · {display}
              </CardTitle>
              <Choice
                aria-label="What the bars split by"
                size="sm"
                className="w-44"
                value={split}
                onChange={(value) => setSplit(value as SplitKey)}
                options={splitKeys.map((key) => ({
                  value: key,
                  label: splits[key].label,
                }))}
              />
            </CardHeader>
            <CardContent>
              {chart.length < 2 ? (
                <EmptyState
                  icon={Clock3}
                  title="One snapshot so far"
                  text="The chart starts once a second date is counted."
                />
              ) : (
                <div className={isMobile ? 'h-48' : 'h-72'}>
                  <Suspense
                    fallback={<Skeleton className="h-full rounded-lg" />}
                  >
                    <BarSeries
                      data={chart}
                      index="asOf"
                      series={[
                        { key: 'a', label: splits[split].first },
                        { key: 'b', label: splits[split].second },
                      ]}
                      formatValue={(_, key, row) =>
                        money(String(row[`${key}Minor`]), display)
                      }
                      formatIndex={monthLabel}
                      formatHeading={(day) =>
                        `${day} · ${money(String(chart.find((p) => p.asOf === day)?.totalMinor ?? '0'), display)}`
                      }
                      yAxisWidth={isMobile ? 36 : 52}
                      minTickGap={isMobile ? 16 : 28}
                    />
                  </Suspense>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="shadow-xs">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                How it divides on {selected}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!anyValue ? (
                <EmptyState
                  icon={Gem}
                  title="Nothing counted on this date"
                  text="Pick another date, or record what the holdings were worth."
                />
              ) : (
                <Suspense fallback={<Skeleton className="h-52 rounded-lg" />}>
                  <div className="grid gap-6 sm:grid-cols-3">
                    {composition.map((ring) => (
                      <div key={ring.key} className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {ring.label}
                        </p>
                        <Donut slices={ring.slices} />
                      </div>
                    ))}
                  </div>
                </Suspense>
              )}
            </CardContent>
          </Card>
          <Card className="shadow-xs">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Biggest holdings on {selected}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                The seven largest and everything else together. Tap a slice to
                send it away and let the next one in.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {biggest.length === 0 ? (
                <EmptyState
                  icon={Gem}
                  title="Nothing to rank"
                  text="A holding appears here once it has a value on this date."
                />
              ) : (
                <div className="sm:max-w-md">
                  <Suspense fallback={<Skeleton className="h-52 rounded-lg" />}>
                    <Donut
                      slices={biggest}
                      onSelect={hide}
                      selectVerb="Leave out"
                    />
                  </Suspense>
                </div>
              )}
              {hidden.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Left out
                  </span>
                  {hidden.map((id) => (
                    <Badge
                      key={id}
                      variant="outline"
                      className="cursor-pointer gap-1"
                      render={
                        <button
                          type="button"
                          onClick={() => unhide(id)}
                          title={`Bring ${names.get(id) ?? 'it'} back`}
                        />
                      }
                    >
                      <X />
                      {names.get(id) ?? id}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="shadow-xs">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Holdings on {selected}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                What each holding was worth on the date. Open one to change it.
              </p>
            </CardHeader>
            <CardContent className="p-0 sm:p-0">
              {rows.length === 0 ? (
                <EmptyState
                  icon={Gem}
                  title="Nothing recorded yet"
                  text="Add the first holding, then record what it was worth on the date."
                  action={
                    <Button size="sm" render={<a href="/assets/new" />}>
                      <Plus />
                      Add holding
                    </Button>
                  }
                />
              ) : isMobile ? (
                <ul className="divide-y">
                  {(grouped
                    ? groups
                    : [
                        {
                          key: 'all',
                          label: '',
                          rows,
                          totalMinor: '0',
                          missing: 0,
                        },
                      ]
                  ).map((group) => (
                    <li key={group.key}>
                      {grouped && (
                        <GroupHeader
                          group={group}
                          display={display}
                          open={expanded.has(group.key)}
                          onToggle={() => toggleGroup(group.key)}
                          compact
                        />
                      )}
                      {(!grouped || expanded.has(group.key)) && (
                        <ul className="divide-y">
                          {group.rows.map((row) => (
                            <li key={row.holding.id} className="px-4 py-3">
                              <HoldingCard row={row} display={display} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Holding</TableHead>
                      <TableHead className="w-56">Amount</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="w-36">Counted</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(grouped
                      ? groups
                      : [
                          {
                            key: 'all',
                            label: '',
                            rows,
                            totalMinor: '0',
                            missing: 0,
                          },
                        ]
                    ).flatMap((group) => [
                      ...(grouped
                        ? [
                            <TableRow
                              key={`${group.key}:head`}
                              className="bg-muted/40 hover:bg-muted/40"
                            >
                              <TableCell colSpan={5} className="py-2">
                                <GroupHeader
                                  group={group}
                                  display={display}
                                  open={expanded.has(group.key)}
                                  onToggle={() => toggleGroup(group.key)}
                                />
                              </TableCell>
                            </TableRow>,
                          ]
                        : []),
                      ...(!grouped || expanded.has(group.key)
                        ? group.rows.map((row) => (
                            <HoldingTableRow
                              key={row.holding.id}
                              row={row}
                              display={display}
                            />
                          ))
                        : []),
                    ])}
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

/** One line per group: its name, how many holdings, their value together. */
function GroupHeader({
  group,
  display,
  open,
  onToggle,
  compact,
}: {
  group: { label: string; rows: Row[]; totalMinor: string; missing: number };
  display: string;
  open: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full items-center justify-between gap-3 text-left ${compact ? 'bg-muted/40 px-4 py-2' : ''}`}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <ChevronRight
          className={`size-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {group.label}
        <span className="text-xs font-normal text-muted-foreground">
          {group.rows.length}
        </span>
      </span>
      <span className="flex items-center gap-2 text-sm font-medium tabular-nums">
        {group.missing > 0 && (
          <span className="text-xs font-normal text-warning">
            {group.missing} without a price
          </span>
        )}
        <Money minor={group.totalMinor} currency={display} />
      </span>
    </button>
  );
}

function HoldingName({ holding }: { holding: Holding }) {
  const today = rigaToday();
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{holding.name}</span>
        {holding.archived && <Badge variant="outline">Retired</Badge>}
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{kinds[holding.kind] ?? holding.kind}</span>
        {holding.group && <span>· {holding.group}</span>}
        {holding.owner && (
          <span>· {holding.owner === 'rodion' ? 'Rodion' : 'Katya'}</span>
        )}
        <span>· {holding.invested ? 'invested' : 'not invested'}</span>
        <span>· {holding.liquid ? 'liquid' : 'illiquid'}</span>
        {holding.maturesOn && (
          <span className={holding.maturesOn <= today ? 'text-warning' : ''}>
            · {holding.maturesOn <= today ? 'matured' : 'matures'}{' '}
            {holding.maturesOn}
          </span>
        )}
        {holding.feed && <span>· fed by {feeds[holding.feed]}</span>}
      </p>
    </div>
  );
}

/** How much of the thing there is on the date, and what one of it costs.
 *  Read only: the figure is changed on the holding's own page. */
function AmountCell({ row }: { row: Row }) {
  return (
    <div className="space-y-0.5 text-sm tabular-nums">
      <div>
        {row.quantity ?? <span className="text-muted-foreground">—</span>}{' '}
        <span className="text-xs text-muted-foreground">
          {row.holding.denomination}
        </span>
      </div>
      {row.price && !isCurrency(row.holding.denomination) && (
        <div className="text-xs text-muted-foreground">
          × {row.price.usdPerUnit} USD
          {row.price.approximate ? ` from ${row.price.asOf}` : ''}
        </div>
      )}
    </div>
  );
}

function ValueCell({ row, display }: { row: Row; display: string }) {
  if (row.quantity === null)
    return <span className="text-xs text-muted-foreground">Not counted</span>;
  if (row.valueMinor === null)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-warning">
        <CircleAlert className="size-3.5" />
        No price
      </span>
    );
  return <Money minor={row.valueMinor} currency={display} />;
}

function CountedCell({ row }: { row: Row }) {
  if (!row.quantityAsOf) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {row.carried ? (
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3.5" />
          carried from {row.quantityAsOf}
        </span>
      ) : (
        row.quantityAsOf
      )}
      {row.source && row.source !== 'manual' && (
        <span className="block">{sourceLabel[row.source] ?? row.source}</span>
      )}
    </span>
  );
}

/** The pencil opens the holding's own page; nothing is edited in the list. */
function EditLink({ holding }: { holding: Holding }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      aria-label={`Edit ${holding.name}`}
      render={<a href={`/assets/${encodeURIComponent(holding.id)}`} />}
    >
      <Pencil className="size-3.5" />
    </Button>
  );
}

function HoldingTableRow({ row, display }: { row: Row; display: string }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <HoldingName holding={row.holding} />
      </TableCell>
      <TableCell className="align-top">
        <AmountCell row={row} />
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        <ValueCell row={row} display={display} />
      </TableCell>
      <TableCell className="align-top">
        <CountedCell row={row} />
      </TableCell>
      <TableCell className="align-top">
        <EditLink holding={row.holding} />
      </TableCell>
    </TableRow>
  );
}

function HoldingCard({ row, display }: { row: Row; display: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <HoldingName holding={row.holding} />
        <div className="flex items-center gap-1">
          <ValueCell row={row} display={display} />
          <EditLink holding={row.holding} />
        </div>
      </div>
      <AmountCell row={row} />
      <CountedCell row={row} />
    </div>
  );
}
