import { useQuery } from '@tanstack/react-query';
import { apiGet, useSession, invalidateFinancialData } from './lib/query';
import { useUrlSearch, useSearchPatch } from './lib/navigation';
import { reviewSearch } from './lib/navigation-state';
import { useDisplayCurrency } from './lib/display-currency';
import { kinds, type Action, type ReviewData } from './lib/transactions';
import { useState } from 'react';
import {
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Inbox,
  MessageCircle,
  RefreshCw,
  Repeat2,
  ShieldCheck,
  Sparkles,
  Tag,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Choice,
  Field,
  FilterBar,
  PageHeader,
  TransactionRow,
} from '@/components/finance';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TransactionDetail } from '@/components/transaction/detail';
import type {
  CategoryNode,
  Step,
  Tag as TagRow,
} from '@/components/transaction/decision-card';
import {
  DirectionMark,
  DisplayAmount,
  HistoryLink,
  ReplyCard,
} from '@/components/transaction/pieces';

function Empty({
  icon,
  title,
  text,
}: {
  icon: 'inbox' | 'message' | 'sparkles';
  title: string;
  text: string;
}) {
  const Icon =
    icon === 'inbox' ? Inbox : icon === 'message' ? MessageCircle : Sparkles;
  return (
    <div className="rounded-lg border border-dashed px-6 py-12 text-center">
      <Icon className="mx-auto mb-3 size-7 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        {text}
      </p>
    </div>
  );
}

export default function Review() {
  const url = reviewSearch(useUrlSearch());
  const patch = useSearchPatch();
  const all = url.all !== '0';
  const windowFilter = url.window;

  const exceptionalOnly = url.exceptional === '1';
  const search = url.q ?? '';
  const selectedId = url.id ?? null;
  const setAll = (value: boolean) =>
    patch({ all: value ? '1' : '0', id: undefined });
  const setWindowFilter = (value: string) =>
    patch({ window: value, id: undefined });
  const setIncludeRefunds = (value: boolean) =>
    patch({ includeRefunds: value ? '1' : '0' });
  const setExceptionalOnly = (value: boolean) =>
    patch({ exceptional: value ? '1' : undefined });
  const setSearch = (value: string) => patch({ q: value || undefined }, true);
  const setSelectedId = (value: string | null) =>
    patch({ id: value ?? undefined }, value === null);
  const session = useSession();
  const identity = session.data;
  const includeRefunds =
    url.includeRefunds !== undefined
      ? url.includeRefunds === '1'
      : !(identity?.reviewDefaults?.hideRefunds ?? true);
  const includeNonPersonal =
    url.includeNonPersonal !== undefined
      ? url.includeNonPersonal === '1'
      : !(identity?.reviewDefaults?.hideNonPersonal ?? true);
  const includeZeroAmount =
    url.includeZeroAmount !== undefined
      ? url.includeZeroAmount === '1'
      : !(identity?.reviewDefaults?.hideZeroAmount ?? true);
  const includeTransfers =
    url.includeTransfers !== undefined
      ? url.includeTransfers === '1'
      : !(identity?.reviewDefaults?.hideInternalTransfers ?? true);
  const actor = identity?.actor;
  const { currency: displayCurrency } = useDisplayCurrency();
  const filters = {
    window: windowFilter,
    all: all ? '1' : '0',
    display: displayCurrency,
    ...(url.includeRefunds !== undefined
      ? { includeRefunds: url.includeRefunds }
      : {}),
    ...(url.includeNonPersonal !== undefined
      ? { includeNonPersonal: url.includeNonPersonal }
      : {}),
    ...(url.includeZeroAmount !== undefined
      ? { includeZeroAmount: url.includeZeroAmount }
      : {}),
    ...(url.includeTransfers !== undefined
      ? { includeTransfers: url.includeTransfers }
      : {}),
  };
  const review = useQuery({
    queryKey: ['review', actor, filters],
    enabled: Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<ReviewData>('/api/review?' + new URLSearchParams(filters), signal),
    placeholderData: (previous, query) =>
      query?.queryKey[1] === actor ? previous : undefined,
  });
  const detail = useQuery({
    queryKey: ['review-detail', actor, selectedId, displayCurrency],
    enabled: Boolean(actor && selectedId),
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      apiGet<ReviewData>(
        '/api/review?detailOnly=1&id=' +
          encodeURIComponent(selectedId!) +
          '&display=' +
          displayCurrency,
        signal,
      ),
  });
  // The tree endpoint returns nodes carrying `path` and `assignable`, and tags
  // as their own list. Reading it as anything else leaves the category picker
  // and the tag picker silently empty.
  const categories = useQuery({
    queryKey: ['categories', actor],
    enabled: Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<{ nodes: CategoryNode[]; tags: TagRow[] }>(
        '/api/categories',
        signal,
      ),
  });
  const data = review.data;
  const nodes = categories.data?.nodes ?? [];
  const allTags = categories.data?.tags ?? [];
  const loading = session.isPending || review.isPending;
  const fetching = review.isFetching;
  const error =
    [session.error, review.error, categories.error].find(Boolean)?.message ??
    '';
  const [notice, setNotice] = useState('');
  const [limit, setLimit] = useState(12);
  const [historyLimit, setHistoryLimit] = useState(12);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const refresh = () => {
    void invalidateFinancialData();
  };
  const visible = (data?.transactions ?? []).filter(
    (t) =>
      (!exceptionalOnly || t.spendingPattern?.pattern === 'exceptional') &&
      t.description.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const selectedData = detail.data ?? data;
  const selected =
    detail.data?.transactions.find((t) => t.id === selectedId) ??
    data?.transactions.find((t) => t.id === selectedId);

  /**
   * Several saves can make up one decision. They run in order because a
   * confirmed classification raises the payment's revision, and the first
   * failure stops the rest rather than leaving a half-applied decision.
   */
  async function submitSteps(steps: Step[], message: string) {
    if (!identity || busy) return;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      for (const step of steps) {
        const response = await fetch(step.action, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            ...step.values,
            csrf: identity.csrf,
            owner: identity.actor,
          }),
        });
        if (!response.ok)
          throw new Error(
            response.status === 409
              ? 'This payment changed. Refresh this payment before saving again.'
              : 'The action could not be confirmed. Refresh and check the latest state before trying again.',
          );
      }
      setNotice(message);
      await invalidateFinancialData();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm the action. Refresh before trying again.',
      );
    } finally {
      setBusy(false);
    }
  }
  const messages: Record<Action, string> = {
    '/classify': 'Your decision was saved.',
    '/spending-pattern': 'Spending pattern saved.',
    '/refund/link':
      'Refund linked. It reduces what the purchase cost; both bank records are unchanged.',
    '/refund/unlink':
      'Refund link removed. Both bank transactions remain in your history.',
    '/tags': 'Tags saved.',
    '/propose':
      'AI request processed. Check the proposal history for its result.',
    '/telegram/queue':
      'The question was sent to Telegram. Answer it there and it will appear here.',
  };
  const submit = (action: Action, values: Record<string, string>) =>
    submitSteps([{ action, values }], messages[action]);

  if (selectedId)
    return selected && identity && selectedData ? (
      <TransactionDetail
        transaction={selected}
        data={selectedData}
        identity={identity}
        nodes={nodes}
        allTags={allTags}
        displayCurrency={displayCurrency}
        busy={busy}
        actionError={actionError}
        notice={notice}
        detailError={Boolean(detail.error)}
        refreshing={detail.isFetching}
        onBack={() => setSelectedId(null)}
        onRefresh={() => void detail.refetch()}
        submit={submit}
        submitSteps={submitSteps}
      />
    ) : (
      <section className="space-y-3 rounded-lg border p-5">
        <h1 className="text-lg font-semibold tracking-tight">Payment review</h1>
        <p>
          {detail.isPending
            ? 'Loading payment…'
            : (detail.error?.message ??
              'This payment is not available to this account.')}
        </p>
        {detail.error && (
          <Button onClick={() => void detail.refetch()}>Retry</Button>
        )}
        <Button variant="ghost" onClick={() => setSelectedId(null)}>
          Back to transactions
        </Button>
      </section>
    );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        description="Your payments, including pending card charges. Needs review lists the ones still waiting for a decision."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              render={<a href={'/cash?display=' + displayCurrency} />}
            >
              Add cash expense
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={fetching || busy}
              onClick={() => refresh()}
            >
              <RefreshCw className={fetching ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </>
        }
      />
      <div className="flex items-start gap-2.5 rounded-lg border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <p>
          Only your payments appear here. Uncertain suggestions need your
          confirmation; clear expenses can be categorized automatically.
          {identity && !identity.features.ai
            ? ' AI suggestions are not configured yet.'
            : ''}
        </p>
      </div>
      {fetching && data && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating payments…
        </p>
      )}
      {notice && (
        <div
          role="status"
          className="flex gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"
        >
          <CheckCheck className="size-4 shrink-0" />
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4 text-sm"
        >
          <span className="flex items-center gap-2">
            <CircleAlert className="size-4 shrink-0" />
            {error}
          </span>
          <Button variant="outline" size="sm" onClick={() => refresh()}>
            Retry
          </Button>
        </div>
      )}
      <Tabs
        value={
          ['payments', 'replies', 'proposals'].includes(url.tab ?? '')
            ? url.tab
            : 'payments'
        }
        onValueChange={(tab) => {
          patch({ tab });
          setHistoryLimit(12);
        }}
      >
        <TabsList className="mb-4 h-auto w-full justify-start gap-1 overflow-x-auto sm:w-auto">
          <TabsTrigger value="payments" className="min-h-10">
            Payments{' '}
            {data && (
              <span className="ml-1 text-xs opacity-60">{visible.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="replies" className="min-h-10">
            <MessageCircle className="size-4" />
            <span>Explanations</span>
            {data && (
              <span className="text-xs opacity-60">{data.replies.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="proposals" className="min-h-10">
            <Sparkles className="size-4" />
            <span>AI history</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="payments" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="inline-flex rounded-lg border p-1"
              aria-label="Transaction view"
            >
              {[true, false].map((value) => (
                <Button
                  key={String(value)}
                  size="sm"
                  variant={all === value ? 'secondary' : 'ghost'}
                  aria-pressed={all === value}
                  disabled={busy}
                  onClick={() => {
                    setAll(value);
                    setLimit(12);
                  }}
                >
                  {value ? 'All transactions' : 'Needs review'}
                </Button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              Amounts in {displayCurrency} · original bank amounts shown below
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border p-4">
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeNonPersonal}
                disabled={busy}
                onCheckedChange={(checked) =>
                  patch({ includeNonPersonal: checked ? '1' : '0' })
                }
              />
              Show non-personal payments
            </Label>
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeZeroAmount}
                disabled={busy}
                onCheckedChange={(checked) => {
                  patch({ includeZeroAmount: checked ? '1' : '0' });
                  setLimit(12);
                }}
              />
              Show payments that came to nothing
            </Label>
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeTransfers}
                disabled={busy}
                onCheckedChange={(checked) =>
                  patch({ includeTransfers: checked ? '1' : '0' })
                }
              />
              Show confirmed transfers
            </Label>
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeRefunds}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setIncludeRefunds(Boolean(checked));
                  setLimit(12);
                }}
              />
              Show linked refund credits
            </Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                patch({
                  includeNonPersonal: undefined,
                  includeTransfers: undefined,
                  includeRefunds: undefined,
                  includeZeroAmount: undefined,
                })
              }
            >
              Use household defaults
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A purchase refunded in full came to nothing, so both it and its
            refund credit are hidden by default. Both remain in your history.
          </p>
          <FilterBar>
            <Field label="Period" htmlFor="review-period">
              <Choice
                id="review-period"
                className="w-full sm:w-56"
                value={windowFilter}
                onChange={(value) => {
                  setWindowFilter(value);
                  setLimit(12);
                  setSelectedId(null);
                }}
                options={[
                  { value: 'previous_month', label: 'Previous calendar month' },
                  {
                    value: 'current_month',
                    label: 'This month · new payments',
                  },
                  { value: 'historical', label: 'Older 2026 history' },
                  { value: '2026', label: 'Since January 2026' },
                  { value: 'all', label: 'All history · includes 2025' },
                ]}
              />
            </Field>
            <Field
              label="Find a merchant or recipient"
              htmlFor="review-search"
              className="sm:flex-1"
            >
              <Input
                id="review-search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLimit(12);
                }}
                placeholder="Search descriptions"
              />
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Button
                size="sm"
                variant={exceptionalOnly ? 'secondary' : 'outline'}
                onClick={() => {
                  setExceptionalOnly(!exceptionalOnly);
                  setLimit(12);
                }}
                aria-pressed={exceptionalOnly}
              >
                <Repeat2 />
                Exceptional only
              </Button>
            </div>
          </FilterBar>
          <p className="text-xs text-muted-foreground">
            Calendar periods use Europe/Riga. Historical estimates remain
            separate from confirmed spending.
          </p>
          {loading ? (
            <div
              role="status"
              aria-label="Loading payments"
              className="space-y-3"
            >
              {[0, 1, 2, 3].map((n) => (
                <Skeleton key={n} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : (
            data && (
              <>
                {visible.length === 0 && (
                  <Empty
                    icon="inbox"
                    title={
                      exceptionalOnly
                        ? 'No exceptional payments in this window'
                        : all
                          ? 'No payments yet'
                          : 'Nothing waiting for a decision'
                    }
                    text={
                      exceptionalOnly
                        ? 'Payments you mark as exceptional while reviewing them appear here. Widen the period to look further back.'
                        : all
                          ? 'Imported payments will appear here for review.'
                          : 'Every outflow in this window already has a decision. Payments that are still settling keep theirs and stay under All transactions, and the other owner reviews their own payments from their sign-in. Widen the window to look further back.'
                    }
                  />
                )}
                <Card className="gap-0 py-0 shadow-xs">
                  <CardContent className="px-4 py-0 sm:px-5">
                    {visible.slice(0, limit).map((t) => {
                      const suggestions = data.suggestions[t.id];
                      const estimate = data.historicalEstimates?.find(
                        (e) =>
                          e.transactionId === t.id && e.status === 'estimated',
                      );
                      const recognized = data.triage?.find(
                        (item) =>
                          item.transaction_id === t.id &&
                          item.revision === t.revision &&
                          item.state === 'ready',
                      );
                      return (
                        <TransactionRow
                          key={t.id}
                          mark={<DirectionMark amountMinor={t.amountMinor} />}
                          description={
                            t.description || 'Payment without a description'
                          }
                          meta={
                            <>
                              {t.bookedAt.slice(0, 10)} ·{' '}
                              {t.category ||
                                (BigInt(t.amountMinor) >= 0n
                                  ? 'Money in · not spending'
                                  : 'No category')}
                            </>
                          }
                          amount={
                            <DisplayAmount
                              transaction={t}
                              reporting={data?.reporting}
                              requested={displayCurrency}
                              className="text-sm font-semibold"
                            />
                          }
                          badges={
                            <>
                              <Badge
                                variant={
                                  t.kind === 'unresolved'
                                    ? 'secondary'
                                    : 'outline'
                                }
                              >
                                {BigInt(t.amountMinor) >= 0n &&
                                t.kind === 'unresolved'
                                  ? 'Money in · not spending'
                                  : kinds[t.kind]}
                              </Badge>
                              {t.spendingPattern?.pattern === 'exceptional' && (
                                <Badge variant="outline">
                                  <Repeat2 className="size-3" />
                                  Exceptional
                                </Badge>
                              )}
                              {estimate && (
                                <Badge variant="outline">
                                  Estimated: {estimate.category} ·{' '}
                                  {estimate.method === 'mcc'
                                    ? 'MCC'
                                    : 'AI suggestion'}
                                </Badge>
                              )}
                              {t.status === 'pending' && (
                                <Badge variant="outline">Bank processing</Badge>
                              )}
                              {recognized?.decision && (
                                <Badge variant="secondary">
                                  Suggested:{' '}
                                  {recognized.decision.category ??
                                    kinds[recognized.decision.kind]}
                                </Badge>
                              )}
                              {suggestions?.rules.length > 0 && (
                                <Badge variant="outline">
                                  {suggestions.ambiguous
                                    ? 'Conflicting suggestions'
                                    : `${suggestions.rules.length} rule suggestion${suggestions.rules.length === 1 ? '' : 's'}`}
                                </Badge>
                              )}
                              {(data.tags[t.id] || []).map((tag) => (
                                <Badge
                                  key={tag.id}
                                  variant="secondary"
                                  className="max-w-full break-words whitespace-normal"
                                >
                                  <Tag className="size-3" />
                                  {tag.name}
                                </Badge>
                              ))}
                            </>
                          }
                          history={<HistoryLink id={t.id} />}
                          action={
                            <Button
                              size="sm"
                              onClick={() => {
                                setSelectedId(t.id);
                                setActionError('');
                              }}
                            >
                              {BigInt(t.amountMinor) >= 0n
                                ? 'View details'
                                : 'Review payment'}
                            </Button>
                          }
                        />
                      );
                    })}
                  </CardContent>
                </Card>
                {visible.length > limit && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setLimit((n) => n + 12)}
                  >
                    Show more payments <ChevronDown className="size-4" />
                  </Button>
                )}
              </>
            )
          )}
        </TabsContent>
        <TabsContent value="replies" className="space-y-3">
          <p className="mb-4 text-sm text-muted-foreground">
            All your saved explanations from Telegram and this app, including
            confirmed and rejected suggestions. Your original explanation stays
            in the payment history. Use Refresh to check the latest processing
            status.
          </p>
          {loading ? (
            <Skeleton className="h-32" />
          ) : data?.replies.length ? (
            <>
              {data.replies.slice(0, historyLimit).map((r) => (
                <ReplyCard
                  key={r.id}
                  reply={r}
                  openPayment={() => setSelectedId(r.transaction_id)}
                />
              ))}
              {data.replies.length > historyLimit && (
                <Button
                  variant="outline"
                  onClick={() => setHistoryLimit((n) => n + 12)}
                >
                  Show more explanations
                </Button>
              )}
            </>
          ) : (
            !error && (
              <Empty
                icon="message"
                title="No saved explanations yet"
                text="Reply to a payment question in Telegram, then refresh this view. Your explanation will remain here after review."
              />
            )
          )}
        </TabsContent>
        <TabsContent value="proposals" className="space-y-3">
          <p className="mb-4 text-sm text-muted-foreground">
            AI suggestions are a starting point. Your decision is always final.
          </p>
          {loading ? (
            <Skeleton className="h-32" />
          ) : data?.proposals.length ? (
            <>
              {data.proposals.slice(0, historyLimit).map((p) => (
                <Card key={p.id} className="py-0 shadow-xs">
                  <CardContent className="p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {p.state.replaceAll('_', ' ')}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {p.created_at?.slice(0, 10)} · payment revision{' '}
                        {p.revision}
                      </span>
                    </div>
                    <p className="text-sm font-medium">
                      {p.proposal?.kind
                        ? kinds[p.proposal.kind]
                        : 'No suggestion'}
                      {p.proposal?.category ? ` · ${p.proposal.category}` : ''}
                    </p>
                    {p.proposal?.explanation && (
                      <p className="mt-2 text-sm break-words whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                        {p.proposal.explanation}
                      </p>
                    )}
                    <HistoryLink id={p.transaction_id} />
                  </CardContent>
                </Card>
              ))}
              {data.proposals.length > historyLimit && (
                <Button
                  variant="outline"
                  onClick={() => setHistoryLimit((n) => n + 12)}
                >
                  Show more suggestions
                </Button>
              )}
            </>
          ) : (
            !error && (
              <Empty
                icon="sparkles"
                title="No AI suggestions yet"
                text={
                  identity?.features.ai
                    ? 'Open a payment to request a suggestion with optional context.'
                    : 'AI suggestions are not configured yet. You can review payments yourself.'
                }
              />
            )
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
