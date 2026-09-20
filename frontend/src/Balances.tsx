import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { owners as household } from './lib/account-visuals';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, GripVertical, Wallet } from 'lucide-react';
import { apiGet, useSession, queryClient } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import { useUrlField } from './lib/navigation';
import { ownMoneyMinor } from './lib/own-money';
import {
  AccountBadge,
  EmptyState,
  Money,
  PageHeader,
  RefreshButton,
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
type Purpose = 'personal' | 'business' | 'investment' | 'unreviewed';
type BalanceAccount = {
  source: string;
  accountId: string;
  owner: Owner;
  label: string;
  /**
   * The whole name of the account — holder, bank and the owner's own name for
   * it, e.g. "Rodion · Monobank · Iron UAH". Older servers do not send it, so
   * the screen falls back to the label they do send.
   */
  displayName?: string | null;
  purpose: Purpose;
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
/** What the account is called on this screen: the server's name, else its label. */
const nameOf = (account: BalanceAccount) =>
  (account.displayName ?? '').trim() || account.label;

/**
 * Three questions a reader has about an account, in the order they ask them:
 * is this our spending money, is it money set aside for something that is not
 * spending, and is it an account nobody has decided about yet. The last
 * section only appears when something is in it — an empty "to review" heading
 * is a chore that does not exist.
 */
const sectionsInOrder: { id: string; title: string; holds: Purpose[] }[] = [
  { id: 'personal', title: 'Personal', holds: ['personal'] },
  {
    id: 'non-personal',
    title: 'Non-personal',
    holds: ['business', 'investment'],
  },
  { id: 'unreviewed', title: 'Purpose to review', holds: ['unreviewed'] },
];

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

/**
 * One of the two figures at the top: a label, the money, and a count of what
 * could not be converted. The warning is the only sentence here, and it earns
 * its place — a total that silently leaves a balance out is the one number on
 * this screen a reader could not catch being wrong.
 */
function Total({
  label,
  total,
  currency,
  muted = false,
}: {
  label: string;
  total: { minor: string; missing: number };
  currency: string;
  muted?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <Money
        minor={total.minor}
        currency={currency}
        className={`block break-all text-2xl font-semibold tracking-tight${
          muted ? ' text-muted-foreground' : ''
        }`}
      />
      {total.missing > 0 && (
        <p className="text-xs text-warning">{total.missing} without a rate</p>
      )}
    </div>
  );
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

  const reporting = query.data?.reporting;

  /**
   * Two figures for the person whose tab is open: their spending money, and
   * everything that is not spending money.
   *
   * The server converts each balance with the agreed overdraft already taken
   * out of it — that subtraction happens before the rate is applied, so it
   * stays exact — and then adds every balance in the household into one total.
   * That total was what this screen printed under the heading "Own money",
   * which made it wrong twice over: it held both members' accounts, and it held
   * the business and investment ones. The owner read the label the way anyone
   * would, as the money that is theirs to spend, and said so.
   *
   * So the sums are taken here, over the rows the server already converted.
   * Nothing is subtracted again; a row without a rate is counted as missing
   * rather than treated as zero, which is what lets the screen say a total is
   * incomplete instead of quietly reporting a smaller one.
   */
  const totals = useMemo(() => {
    const sum = (purposes: Purpose[]) => {
      let minor = 0n;
      let missing = 0;
      let accounts = 0;
      for (const account of mine) {
        if (!purposes.includes(account.purpose)) continue;
        accounts += 1;
        for (const balance of account.balances) {
          const row = converted.get(rowKey(balance));
          if (row?.convertedMinor) minor += BigInt(row.convertedMinor);
          else missing += 1;
        }
      }
      return { minor: minor.toString(), missing, accounts };
    };
    return {
      // An account nobody has classified yet is not counted as spending money
      // on a guess; it waits with the rest until somebody says what it is.
      own: sum(['personal']),
      other: sum(['business', 'investment', 'unreviewed']),
    };
  }, [mine, converted]);

  /** That person's cards, split into the sections the screen shows them in. */
  const sections = useMemo(
    () =>
      sectionsInOrder
        .map((section) => ({
          ...section,
          accounts: mine.filter((account) =>
            section.holds.includes(account.purpose),
          ),
        }))
        .filter((section) => section.accounts.length > 0),
    [mine],
  );

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
              <p
                className="truncate text-sm font-medium"
                title={nameOf(account)}
              >
                {nameOf(account)}
              </p>
              {/* Said only when it is worth saying. Most accounts are the
                  household's own spending, and a card repeating "Personal"
                  nine times teaches nobody anything; money that is not personal
                  spending is exactly what a reader needs pointing out. An
                  undecided account says nothing either: it sits under the
                  "Purpose to review" heading, which has already said it. */}
              {(account.purpose === 'business' ||
                account.purpose === 'investment') && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {account.purpose === 'business' ? 'Business' : 'Investment'}
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
                // The bank counts the agreed overdraft inside the figure it
                // states, so the only number the card shows is what is left
                // after it: the household's own money, the part anybody can
                // spend without borrowing. The limit is nobody's business here.
                const held = ownMoneyMinor(
                  balance.amountMinor,
                  balance.creditLimitMinor,
                );
                return (
                  <div key={balance.currency}>
                    <Money
                      minor={held}
                      currency={balance.currency}
                      className={`text-2xl font-semibold tracking-tight break-all${
                        BigInt(held) < 0n ? ' text-negative' : ''
                      }`}
                    />
                    {balance.currency !== display && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {row?.convertedMinor ? (
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
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No balance reported
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

  const grid = 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3';
  const laidOut = sections.map((section) => ({
    ...section,
    items: section.accounts.map((account): ArrangeItem => ({
      key: cardKey(account),
      node: card(account),
    })),
  }));

  /**
   * A drag moves a card within its own section, and what gets saved is every
   * section end to end in the order they are shown. The grouping is part of
   * the arrangement now, so storing it that way keeps the saved order and the
   * screen the same thing — and `merged` still slots the result back into the
   * positions this person's cards hold among both members'.
   */
  function orderWithin(sectionId: string, keys: string[]): string[] {
    return laidOut.flatMap((section) =>
      section.id === sectionId ? keys : section.items.map((item) => item.key),
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Balances"
        actions={
          <>
            <RefreshButton />
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
        <p className="text-sm text-muted-foreground">Drag a card to move it.</p>
      )}
      <Tabs value={who} onValueChange={(next) => setTab(String(next))}>
        <TabsList variant="line" className="h-auto gap-1">
          {owners.map((owner) => (
            <TabsTrigger key={owner} value={owner} className="min-h-10 px-3">
              <span>{household[owner].name}</span>
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
                {reporting && (
                  <section
                    aria-label="Totals"
                    className="flex flex-wrap items-start gap-x-10 gap-y-4"
                  >
                    <Total
                      label={`Own money · ${reporting.currency}`}
                      total={totals.own}
                      currency={reporting.currency}
                    />
                    {totals.other.accounts > 0 && (
                      <Total
                        label={`Non-personal · ${reporting.currency}`}
                        total={totals.other}
                        currency={reporting.currency}
                        muted
                      />
                    )}
                  </section>
                )}
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
                ) : (
                  <div className="space-y-5">
                    {laidOut.map((section) => (
                      <section key={section.id} className="space-y-2">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          {section.title} · {section.items.length}
                        </h3>
                        {arranging ? (
                          <Suspense
                            fallback={
                              <div className={grid}>
                                {section.items.map((i) => i.node)}
                              </div>
                            }
                          >
                            <CardArranger
                              items={section.items}
                              onReorder={(keys) =>
                                void persist(orderWithin(section.id, keys))
                              }
                              className={grid}
                            />
                          </Suspense>
                        ) : (
                          <div className={grid}>
                            {section.items.map((item) => item.node)}
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
