import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  GripVertical,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import { apiGet, useSession, queryClient } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import { useUrlField } from './lib/navigation';
import {
  AccountBadge,
  EmptyState,
  Money,
  PageHeader,
} from './components/finance';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import type { ArrangeItem } from './components/finance/card-arranger';

const CardArranger = lazy(() => import('./components/finance/card-arranger'));

type Owner = 'rodion' | 'katya';
type Balance = {
  source: string;
  accountId: string;
  currency: string;
  amountMinor: string;
  creditLimitMinor: string | null;
  asOf: string | null;
  observedAt: string;
};
type BalanceAccount = {
  source: string;
  accountId: string;
  owner: Owner;
  label: string;
  purpose: 'personal' | 'business' | 'investment' | 'unreviewed';
  balances: Balance[];
};
type Reporting = {
  currency: string;
  totalMinor: string;
  coverage: { converted: number; missing: number };
  rows: {
    source: string;
    accountId: string;
    currency: string;
    convertedMinor: string | null;
    rateDate: string | null;
  }[];
};
type BalancesData = {
  accounts: BalanceAccount[];
  layout: { ordering: string[]; revision: number };
  reporting?: Reporting;
};

const owners: Owner[] = ['rodion', 'katya'];
const cardKey = (account: { source: string; accountId: string }) =>
  `${account.source}:${account.accountId}`;
const rowKey = (row: { source: string; accountId: string; currency: string }) =>
  `${row.source}:${row.accountId}:${row.currency}`;

/**
 * How long ago a figure was true, in the words a person would use.
 *
 * A balance without its age is a claim this screen cannot support: the banks
 * are polled on timers between half an hour and six hours apart, and one of
 * them was rate-limited into a daily cadence only last week. Saying "4 hours
 * ago" is the difference between a number somebody can act on and a number they
 * have to go and check.
 */
function ageOf(instant: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(instant)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return 'just now';
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export default function Balances() {
  const session = useSession();
  const actor = session.data?.actor;
  const { currency: display } = useDisplayCurrency();
  const [tab, setTab] = useUrlField('who', '');
  const [arranging, setArranging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // One clock for the whole render, so every card's age is measured from the
  // same instant rather than each from the moment it happened to render.
  const [now, setNow] = useState(() => Date.now());

  const query = useQuery({
    queryKey: ['balances', actor, display],
    enabled: !!actor,
    queryFn: ({ signal }) =>
      apiGet<BalancesData>(`/api/balances?display=${display}`, signal),
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  // The order on screen is the order the server sent, and a drag rewrites that
  // cached list directly. Holding a second copy of the order in local state was
  // the obvious first shape and the wrong one: saving writes to the same cache,
  // which counts as new data, which threw the local order away — so a dropped
  // card sprang back and only moved after a reload.
  const accounts = query.data?.accounts ?? [];

  const converted = useMemo(
    () =>
      new Map(
        (query.data?.reporting?.rows ?? []).map((row) => [rowKey(row), row]),
      ),
    [query.data],
  );
  const who: Owner = owners.includes(tab as Owner)
    ? (tab as Owner)
    : ((actor as Owner) ?? 'rodion');
  const mine = accounts.filter((account) => account.owner === who);

  /** That person's money in the display currency, and what is missing from it. */
  const total = useMemo(() => {
    let sum = 0n;
    let missing = 0;
    for (const account of mine)
      for (const balance of account.balances) {
        const row = converted.get(rowKey(balance));
        if (row?.convertedMinor) sum += BigInt(row.convertedMinor);
        else missing += 1;
      }
    return { minor: sum.toString(), missing };
  }, [mine, converted]);

  /**
   * One stored arrangement covers both tabs, but a drag only ever reorders the
   * tab in view. The moved keys are slotted back into the positions that
   * person's cards already occupied, so rearranging your own accounts cannot
   * quietly discard how the other member's were arranged.
   */
  function merged(visible: string[]): string[] {
    const queue = [...visible];
    return accounts.map((account) =>
      account.owner === who
        ? (queue.shift() ?? cardKey(account))
        : cardKey(account),
    );
  }

  async function persist(visible: string[]) {
    if (!session.data || !query.data) return;
    const previous = query.data;
    const keys = merged(visible);
    const rank = new Map(keys.map((key, index) => [key, index]));
    // The card moves the moment it is dropped, before the server has agreed.
    // If the save then fails the whole list goes back to where it was, so
    // nobody is left looking at an arrangement that was never recorded.
    queryClient.setQueryData(['balances', actor, display], {
      ...previous,
      accounts: [...previous.accounts].sort(
        (a, b) =>
          (rank.get(cardKey(a)) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(cardKey(b)) ?? Number.MAX_SAFE_INTEGER),
      ),
    });
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/ui-layout', {
        method: 'POST',
        credentials: 'same-origin',
        body: new URLSearchParams({
          csrf: session.data.csrf,
          key: 'balances',
          revision: String(previous.layout.revision),
          ordering: JSON.stringify(keys),
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'The arrangement changed elsewhere. Refresh before moving more cards.'
            : 'Could not save the arrangement. Please retry.',
        );
      const result = (await response.json()) as {
        layout: { ordering: string[]; revision: number };
      };
      queryClient.setQueryData(
        ['balances', actor, display],
        (held: BalancesData | undefined) =>
          held && { ...held, layout: result.layout },
      );
    } catch (cause) {
      queryClient.setQueryData(['balances', actor, display], previous);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save the arrangement.',
      );
    } finally {
      setSaving(false);
    }
  }

  function card(account: BalanceAccount) {
    const freshest = account.balances
      .map((balance) => balance.observedAt)
      .sort()
      .at(-1);
    return (
      <Card
        key={cardKey(account)}
        className={`h-full gap-0 py-0 shadow-xs${arranging ? ' border-dashed' : ''}`}
      >
        <CardContent className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <AccountBadge
              source={account.source}
              currency={
                account.balances.length === 1
                  ? account.balances[0]!.currency
                  : null
              }
              label={account.label}
              owner={account.owner}
              size="md"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={account.label}>
                {account.label}
              </p>
              {/* Said only when it is worth saying. Most accounts are the
                  household's own spending, and a card repeating "Personal"
                  nine times teaches nobody anything; an account nobody has
                  classified, or one whose money is not personal spending, is
                  exactly what a reader of this screen needs pointing out. */}
              {account.purpose !== 'personal' && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {account.purpose === 'unreviewed'
                    ? 'Purpose not decided'
                    : account.purpose === 'business'
                      ? 'Business'
                      : 'Investment'}
                </p>
              )}
            </div>
            {arranging && (
              <GripVertical
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            )}
          </div>
          {account.balances.length ? (
            <div className="mt-3 space-y-2">
              {account.balances.map((balance) => {
                const row = converted.get(rowKey(balance));
                return (
                  <div key={balance.currency}>
                    <Money
                      minor={balance.amountMinor}
                      currency={balance.currency}
                      className="text-2xl font-semibold tracking-tight break-all"
                    />
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {balance.currency !== display &&
                        (row?.convertedMinor ? (
                          <>
                            <Money
                              minor={row.convertedMinor}
                              currency={display}
                            />
                            {row.rateDate ? ` · rate of ${row.rateDate}` : ''}
                          </>
                        ) : (
                          <span className="text-warning">
                            No rate to show this in {display}
                          </span>
                        ))}
                      {balance.creditLimitMinor && (
                        <>
                          {balance.currency !== display ? ' · ' : ''}includes an
                          overdraft of{' '}
                          <Money
                            minor={balance.creditLimitMinor}
                            currency={balance.currency}
                          />
                        </>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              This bank has not reported a balance yet.
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {freshest ? `Updated ${ageOf(freshest, now)}` : 'Never updated'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (session.isPending) return <p role="status">Loading balances…</p>;
  if (session.error) return <p role="alert">{session.error.message}</p>;

  const items: ArrangeItem[] = mine.map((account) => ({
    key: cardKey(account),
    node: card(account),
  }));
  const grid = 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Balances"
        description="What every account of the household holds, as the banks last reported it. Balances arrive with each scheduled import; nothing here asks a bank for money to move."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw />
              Refresh
            </Button>
            <Button
              variant={arranging ? 'default' : 'outline'}
              size="sm"
              onClick={() => setArranging(!arranging)}
              disabled={saving}
            >
              {arranging ? <Check /> : <GripVertical />}
              {arranging ? 'Done' : 'Arrange'}
            </Button>
          </>
        }
      />
      {error && (
        <p role="alert" className="text-sm text-warning">
          {error}
        </p>
      )}
      {query.error && (
        <p role="alert" className="text-sm text-warning">
          {query.error.message}
        </p>
      )}
      {arranging && (
        <p className="text-sm text-muted-foreground">
          Drag a card to move it. Your arrangement is yours alone and follows
          you to any device you sign in on.
        </p>
      )}
      <Tabs value={who} onValueChange={(next) => setTab(String(next))}>
        <TabsList variant="line" className="h-auto gap-1">
          {owners.map((owner) => (
            <TabsTrigger key={owner} value={owner} className="min-h-10 px-3">
              <span className="capitalize">{owner}</span>
              {owner === actor && (
                <span className="ml-1 text-xs opacity-60">(me)</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {owners.map((owner) => (
          <TabsContent key={owner} value={owner} className="mt-4 space-y-4">
            {owner === who && (
              <>
                <section aria-label="Total held" className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Total held · {display}
                  </p>
                  <Money
                    minor={total.minor}
                    currency={display}
                    className="text-2xl font-semibold tracking-tight break-all"
                  />
                  {total.missing > 0 && (
                    <p className="text-xs text-warning">
                      {total.missing}{' '}
                      {total.missing === 1 ? 'balance is' : 'balances are'} not
                      in this total: no rate, or the bank has not reported one.
                    </p>
                  )}
                </section>
                {query.isPending ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading balances…
                  </p>
                ) : mine.length === 0 ? (
                  <EmptyState
                    icon={Wallet}
                    title="No accounts yet"
                    text="Accounts appear here once a bank connection has imported from them."
                    action={
                      <Button render={<a href="/connections" />}>
                        View bank connections
                        <ArrowRight />
                      </Button>
                    }
                  />
                ) : arranging ? (
                  <Suspense
                    fallback={
                      <div className={grid}>{items.map((i) => i.node)}</div>
                    }
                  >
                    <CardArranger
                      items={items}
                      onReorder={(keys) => void persist(keys)}
                      className={grid}
                    />
                  </Suspense>
                ) : (
                  <div className={grid}>{items.map((item) => item.node)}</div>
                )}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
