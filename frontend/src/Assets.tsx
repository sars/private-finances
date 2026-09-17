import { useQuery } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  CircleAlert,
  Clock3,
  Landmark,
  Pencil,
  Plus,
  RefreshCw,
  Gem,
} from 'lucide-react';
import { apiGet, queryClient, useSession } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import { useUrlField } from './lib/navigation';
import { money, toNumber } from './lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  Choice,
  EmptyState,
  KpiCard,
  Money,
  PageHeader,
} from '@/components/finance';
import { useIsMobile } from '@/hooks/use-mobile';
const BarSeries = lazy(() => import('@/components/charts/BarSeries'));

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
type FillSummary = {
  filled: number;
  unchanged: number;
  skipped: Record<string, number>;
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
const feedHint: Record<Feed, string> = {
  bank: 'The account whose stored balance fills this holding.',
  ibkr: 'The symbol in the statement, or CASH for the cash in this currency.',
  binance: 'TOTAL for everything in USD, or one asset symbol.',
  wallet: 'The public address; BTC and ETH are read.',
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

async function send(path: string, fields: Record<string, string>) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Your session has changed. Reload the page and try again.'
        : response.status === 409
          ? 'This changed since you opened it. Refresh and try again.'
          : 'Not saved. Check the figure and try again.',
    );
  return response.json();
}
const refresh = () => queryClient.invalidateQueries({ queryKey: ['holdings'] });

type Draft = {
  name: string;
  kind: string;
  denomination: string;
  invested: boolean;
  liquid: boolean;
  owner: string;
  group: string;
  maturesOn: string;
  note: string;
  archived: boolean;
  feed: string;
  feedRef: string;
};
const emptyDraft: Draft = {
  name: '',
  kind: 'bank',
  denomination: 'USD',
  invested: false,
  liquid: true,
  owner: '',
  group: '',
  maturesOn: '',
  note: '',
  archived: false,
  feed: '',
  feedRef: '',
};

export default function Assets() {
  const { currency: display } = useDisplayCurrency();
  const { data: session } = useSession();
  const isMobile = useIsMobile();
  const [at, setAt] = useUrlField('at', '');
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<Holding | null | undefined>();
  const [filling, setFilling] = useState(false);
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['holdings', display, at],
    queryFn: ({ signal }) =>
      apiGet<Report>(
        `/api/holdings?display=${display}${at ? `&at=${at}` : ''}`,
        signal,
      ),
  });
  const report = query.data;
  const dateOptions = useMemo(() => {
    const days = [...(report?.dates ?? [])];
    if (at && !days.includes(at)) days.push(at);
    return days
      .sort()
      .reverse()
      .map((day) => ({ value: day, label: day }));
  }, [report?.dates, at]);
  const rows = (report?.rows ?? []).filter(
    (row) => showRetired || !row.holding.archived,
  );
  const chart = useMemo(
    () =>
      (report?.series ?? []).map((point) => ({
        asOf: point.asOf,
        invested: toNumber(point.investedMinor, display),
        notInvested: toNumber(point.notInvestedMinor, display),
        investedMinor: point.investedMinor,
        notInvestedMinor: point.notInvestedMinor,
        totalMinor: point.totalMinor,
      })),
    [report?.series, display],
  );
  const today = rigaToday();
  const selected = report?.at ?? at;
  const linkedToBanks = (report?.rows ?? []).some(
    (row) => row.holding.feed === 'bank' && !row.holding.archived,
  );
  async function fillFromBanks() {
    if (!session || filling) return;
    setFilling(true);
    setNotice('');
    try {
      const { fill } = (await send('/api/holdings/fill', {
        csrf: session.csrf,
        asOf: selected,
      })) as { fill: FillSummary };
      await refresh();
      const skipped = Object.entries(fill.skipped)
        .map(([reason, count]) => `${count} ${reason.replaceAll('_', ' ')}`)
        .join(', ');
      setNotice(
        `${fill.filled} filled from stored bank balances, ${fill.unchanged} already current${skipped ? `; skipped: ${skipped}` : ''}.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Not filled.');
    } finally {
      setFilling(false);
    }
  }
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
              disabled={query.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw className={query.isFetching ? 'animate-spin' : ''} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!report || selected === today}
              onClick={() => setAt(today)}
            >
              <Plus />
              Snapshot today
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!report || !linkedToBanks || filling}
              onClick={() => void fillFromBanks()}
              title="Copies the balances the banks last stated into this date"
            >
              <Landmark className={filling ? 'animate-pulse' : ''} />
              Fill from banks
            </Button>
            <Button
              size="sm"
              disabled={!session}
              onClick={() => setEditing(null)}
            >
              <Plus />
              Add holding
            </Button>
          </>
        }
      />
      {notice && (
        <div
          role="status"
          className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm"
        >
          {notice}
        </div>
      )}
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
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Over time · {display}
              </CardTitle>
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
                        { key: 'invested', label: 'Invested' },
                        { key: 'notInvested', label: 'Not invested' },
                      ]}
                      formatValue={(_, key, row) =>
                        money(String(row[`${key}Minor`]), display)
                      }
                      formatIndex={monthLabel}
                      formatHeading={(day) =>
                        `${day} · ${money(String(chart.find((p) => p.asOf === day)?.totalMinor ?? '0'), display)}`
                      }
                      showYAxis={!isMobile}
                    />
                  </Suspense>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="shadow-xs">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-sm font-medium">
                  Holdings on {selected}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Type this date’s figure and press Enter. A figure typed in
                  another currency is converted at that day’s rate.
                </p>
              </div>
            </CardHeader>
            <CardContent className="p-0 sm:p-0">
              {rows.length === 0 ? (
                <EmptyState
                  icon={Gem}
                  title="Nothing recorded yet"
                  text="Add the first holding, then type what it was worth on the date."
                  action={
                    <Button size="sm" onClick={() => setEditing(null)}>
                      <Plus />
                      Add holding
                    </Button>
                  }
                />
              ) : isMobile ? (
                <ul className="divide-y">
                  {rows.map((row) => (
                    <li key={row.holding.id} className="px-4 py-3">
                      <HoldingCard
                        row={row}
                        asOf={selected}
                        display={display}
                        csrf={session?.csrf}
                        onEdit={() => setEditing(row.holding)}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Holding</TableHead>
                      <TableHead className="w-72">Amount</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="w-36">Counted</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <HoldingTableRow
                        key={row.holding.id}
                        row={row}
                        asOf={selected}
                        display={display}
                        csrf={session?.csrf}
                        onEdit={() => setEditing(row.holding)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {editing !== undefined && (
        <HoldingDialog
          holding={editing}
          accounts={report?.accounts ?? []}
          csrf={session?.csrf}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
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

/** The amount typed for the date, saved on Enter or blur; a currency pick when the figure is money. */
function AmountEntry({
  row,
  asOf,
  csrf,
  compact,
}: {
  row: Row;
  asOf: string;
  csrf?: string;
  compact?: boolean;
}) {
  const denomination = row.holding.denomination;
  const initial = row.carried || row.quantity === null ? '' : row.quantity;
  const [value, setValue] = useState(initial);
  const [currency, setCurrency] = useState(denomination);
  const [price, setPrice] = useState(row.price?.usdPerUnit ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [message, setMessage] = useState('');
  useEffect(() => {
    setValue(initial);
    setCurrency(denomination);
    setPrice(row.price?.usdPerUnit ?? '');
    setState('idle');
  }, [initial, denomination, row.price?.usdPerUnit, asOf]);
  async function save() {
    if (!csrf || state === 'saving') return;
    const typed = value.trim();
    if (!typed || (typed === initial && currency === denomination)) return;
    setState('saving');
    try {
      await send('/api/holding-snapshots', {
        csrf,
        holdingId: row.holding.id,
        asOf,
        amount: typed,
        ...(currency !== denomination ? { currency } : {}),
      });
      await refresh();
      setState('idle');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Not saved.');
    }
  }
  async function savePrice() {
    if (!csrf || state === 'saving') return;
    const typed = price.trim();
    if (!typed || typed === (row.price?.usdPerUnit ?? '')) return;
    setState('saving');
    try {
      await send('/api/asset-prices', {
        csrf,
        symbol: denomination,
        asOf,
        usdPerUnit: typed,
      });
      await refresh();
      setState('idle');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Not saved.');
    }
  }
  const options = [
    denomination,
    ...currencies.filter((code) => code !== denomination),
  ].map((code) => ({ value: code, label: code }));
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label={`Amount of ${row.holding.name}`}
          inputMode="decimal"
          className={compact ? 'h-9 flex-1 tabular-nums' : 'w-32 tabular-nums'}
          placeholder={row.carried && row.quantity ? row.quantity : '0'}
          value={value}
          disabled={!csrf || state === 'saving'}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter')
              (event.target as HTMLInputElement).blur();
          }}
        />
        {isCurrency(denomination) ? (
          <Choice
            aria-label="Currency of the typed amount"
            size="sm"
            className="w-20"
            value={currency}
            onChange={setCurrency}
            options={options}
          />
        ) : (
          <span className="text-xs text-muted-foreground">{denomination}</span>
        )}
      </div>
      {!isCurrency(denomination) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>× USD</span>
          <Input
            aria-label={`Price of one ${denomination} in USD`}
            inputMode="decimal"
            className="h-7 w-28 text-xs tabular-nums"
            placeholder="price"
            value={price}
            disabled={!csrf || state === 'saving'}
            onChange={(event) => setPrice(event.target.value)}
            onBlur={() => void savePrice()}
            onKeyDown={(event) => {
              if (event.key === 'Enter')
                (event.target as HTMLInputElement).blur();
            }}
          />
          {row.price?.approximate && (
            <span title={`Price from ${row.price.asOf}`}>
              from {row.price.asOf}
            </span>
          )}
        </div>
      )}
      {row.enteredCurrency && !row.carried && (
        <p className="text-xs text-muted-foreground">
          typed as {row.enteredAmount} {row.enteredCurrency}
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
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

function HoldingTableRow({
  row,
  asOf,
  display,
  csrf,
  onEdit,
}: {
  row: Row;
  asOf: string;
  display: string;
  csrf?: string;
  onEdit: () => void;
}) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <HoldingName holding={row.holding} />
      </TableCell>
      <TableCell className="align-top">
        <AmountEntry row={row} asOf={asOf} csrf={csrf} />
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        <ValueCell row={row} display={display} />
      </TableCell>
      <TableCell className="align-top">
        <CountedCell row={row} />
      </TableCell>
      <TableCell className="align-top">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Edit ${row.holding.name}`}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function HoldingCard({
  row,
  asOf,
  display,
  csrf,
  onEdit,
}: {
  row: Row;
  asOf: string;
  display: string;
  csrf?: string;
  onEdit: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <HoldingName holding={row.holding} />
        <div className="flex items-center gap-1">
          <ValueCell row={row} display={display} />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Edit ${row.holding.name}`}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
        </div>
      </div>
      <AmountEntry row={row} asOf={asOf} csrf={csrf} compact />
      <CountedCell row={row} />
    </div>
  );
}

function HoldingDialog({
  holding,
  accounts,
  csrf,
  onClose,
}: {
  holding: Holding | null;
  accounts: LinkableAccount[];
  csrf?: string;
  onClose: () => void;
}) {
  const prefix = useId();
  const [draft, setDraft] = useState<Draft>(
    holding
      ? {
          name: holding.name,
          kind: holding.kind,
          denomination: holding.denomination,
          invested: holding.invested,
          liquid: holding.liquid,
          owner: holding.owner ?? '',
          group: holding.group ?? '',
          maturesOn: holding.maturesOn ?? '',
          note: holding.note ?? '',
          archived: holding.archived,
          feed: holding.feed ?? '',
          feedRef: holding.feedRef ?? '',
        }
      : emptyDraft,
  );
  const accountOptions = accounts
    .filter(
      (account) =>
        !account.currencies.length ||
        account.currencies.includes(draft.denomination.trim().toUpperCase()),
    )
    .map((account) => ({
      value: `${account.source}|${account.accountId}`,
      label: `${account.label} · ${account.owner === 'rodion' ? 'Rodion' : 'Katya'}${account.currencies.length ? ` · ${account.currencies.join('/')}` : ''}`,
    }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const field = (key: keyof Draft) => (value: string | boolean) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!csrf || saving) return;
    if (!draft.name.trim()) {
      setError('Give the holding a name.');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/.test(draft.denomination.trim())) {
      setError('The unit is a currency code or a symbol, such as USD or QQQ.');
      return;
    }
    if (draft.maturesOn && !/^\d{4}-\d{2}-\d{2}$/.test(draft.maturesOn)) {
      setError('Write the maturity date as YYYY-MM-DD.');
      return;
    }
    if (draft.feed === 'bank' && !draft.feedRef) {
      setError('Pick the account whose balance fills this holding.');
      return;
    }
    if (draft.feed === 'wallet' && !draft.feedRef.trim()) {
      setError('Paste the wallet’s public address.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await send('/api/holdings', {
        csrf,
        ...(holding
          ? { id: holding.id, revision: String(holding.revision) }
          : {}),
        name: draft.name.trim(),
        kind: draft.kind,
        denomination: draft.denomination.trim().toUpperCase(),
        invested: String(draft.invested),
        liquid: String(draft.liquid),
        owner: draft.owner,
        group: draft.group.trim(),
        maturesOn: draft.maturesOn.trim(),
        note: draft.note.trim(),
        archived: String(draft.archived),
        feed: draft.feed,
        feedRef: draft.feed ? draft.feedRef.trim() : '',
      });
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not saved.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {holding ? 'Edit holding' : 'Add holding'}
            </DialogTitle>
            <DialogDescription>
              One thing with a value. Its unit decides how the amount is
              counted: a currency for money, a symbol for shares or coins.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${prefix}-name`}>Name</Label>
              <Input
                id={`${prefix}-name`}
                value={draft.name}
                onChange={(event) => field('name')(event.target.value)}
                maxLength={120}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-kind`}>Kind</Label>
              <Choice
                id={`${prefix}-kind`}
                value={draft.kind}
                onChange={field('kind')}
                options={Object.entries(kinds).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-unit`}>Unit</Label>
              <Input
                id={`${prefix}-unit`}
                value={draft.denomination}
                onChange={(event) =>
                  field('denomination')(event.target.value.toUpperCase())
                }
                placeholder="USD, EUR, UAH, BTC, QQQ…"
                maxLength={16}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-group`}>Group</Label>
              <Input
                id={`${prefix}-group`}
                value={draft.group}
                onChange={(event) => field('group')(event.target.value)}
                placeholder="Optional, such as a broker"
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-owner`}>Whose</Label>
              <Choice
                id={`${prefix}-owner`}
                value={draft.owner}
                onChange={field('owner')}
                options={[
                  { value: '', label: 'Household' },
                  { value: 'rodion', label: 'Rodion' },
                  { value: 'katya', label: 'Katya' },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-matures`}>Matures on</Label>
              <Input
                id={`${prefix}-matures`}
                value={draft.maturesOn}
                onChange={(event) => field('maturesOn')(event.target.value)}
                placeholder="YYYY-MM-DD, for a bond or deposit"
                maxLength={10}
              />
            </div>
            <div className="flex flex-col justify-end gap-2 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={draft.invested}
                  onCheckedChange={(checked) =>
                    field('invested')(Boolean(checked))
                  }
                />
                Invested
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={draft.liquid}
                  onCheckedChange={(checked) =>
                    field('liquid')(Boolean(checked))
                  }
                />
                Liquid
              </label>
              {holding && (
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={draft.archived}
                    onCheckedChange={(checked) =>
                      field('archived')(Boolean(checked))
                    }
                  />
                  Retired, keep its history
                </label>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-feed`}>Filled by</Label>
              <Choice
                id={`${prefix}-feed`}
                value={draft.feed}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    feed: value,
                    feedRef: '',
                  }))
                }
                options={[
                  { value: '', label: 'Typed by hand' },
                  ...Object.entries(feeds).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
            </div>
            {draft.feed && (
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-ref`}>
                  {draft.feed === 'bank' ? 'Account' : 'Reference'}
                </Label>
                {draft.feed === 'bank' ? (
                  <Choice
                    id={`${prefix}-ref`}
                    value={draft.feedRef}
                    onChange={field('feedRef')}
                    placeholder={
                      accountOptions.length
                        ? 'Pick an account'
                        : 'No account holds this currency'
                    }
                    options={accountOptions}
                  />
                ) : (
                  <Input
                    id={`${prefix}-ref`}
                    value={draft.feedRef}
                    onChange={(event) => field('feedRef')(event.target.value)}
                    placeholder={
                      draft.feed === 'ibkr'
                        ? draft.denomination || 'symbol, or CASH'
                        : draft.feed === 'binance'
                          ? 'TOTAL'
                          : 'public address'
                    }
                    maxLength={200}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  {feedHint[draft.feed as Feed]}
                </p>
              </div>
            )}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${prefix}-note`}>Note</Label>
              <Textarea
                id={`${prefix}-note`}
                value={draft.note}
                onChange={(event) => field('note')(event.target.value)}
                rows={2}
                maxLength={2000}
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !csrf}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
