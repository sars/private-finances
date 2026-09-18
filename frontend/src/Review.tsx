import { useQuery } from '@tanstack/react-query';
import { apiGet, useSession, invalidateFinancialData } from './lib/query';
import { useUrlSearch, useSearchPatch } from './lib/navigation';
import { useDisplayCurrency } from './lib/display-currency';
import {
  accountOptions,
  useHouseholdAccounts,
  usePaymentContext,
  usePaymentPages,
  type PaymentFilters,
} from './lib/payments';
import { kinds, type Action, type ReviewData } from './lib/transactions';
import { owners } from './lib/account-visuals';
import { useEffect, useState } from 'react';
import {
  CheckCheck,
  CircleAlert,
  Inbox,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Choice,
  EmptyState,
  Field,
  FilterBar,
  PageHeader,
  PagedList,
  RefreshButton,
} from '@/components/finance';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TransactionDetail } from '@/components/transaction/detail';
import type {
  CategoryNode,
  Step,
  Tag as TagRow,
} from '@/components/transaction/decision-card';
import { HistoryLink, ReplyCard } from '@/components/transaction/pieces';
import { PaymentRow } from '@/components/transaction/payment-row';

/** The search box writes to the URL only once typing pauses. */
function useDebouncedField(
  value: string,
  onCommit: (value: string) => void,
  delay = 250,
) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onCommit(draft), delay);
    return () => clearTimeout(timer);
  }, [draft, value, onCommit, delay]);
  return [draft, setDraft] as const;
}

export default function Review() {
  const url = useUrlSearch();
  const patch = useSearchPatch();
  const selectedId = url.id ?? null;
  const setSelectedId = (value: string | null) =>
    patch({ id: value ?? undefined }, value === null);
  const session = useSession();
  const identity = session.data;
  const actor = identity?.actor;
  const { currency: displayCurrency } = useDisplayCurrency();

  // Whose payments: the signed-in member's by default, either's or both.
  const who =
    url.who === 'rodion' || url.who === 'katya' || url.who === 'all'
      ? url.who
      : (actor ?? 'all');
  const search = url.q ?? '';
  const account = url.account ?? '';
  const householdAccounts = useHouseholdAccounts(actor);
  const [draft, setDraft] = useDebouncedField(search, (value) =>
    patch({ q: value || undefined }, true),
  );
  const filters: PaymentFilters = {
    review: '1',
    display: displayCurrency,
    ...(who === 'all' ? {} : { owner: who }),
    ...(account ? { account } : {}),
    ...(search ? { q: search } : {}),
  };
  const pages = usePaymentPages(actor, filters, !selectedId);
  const context = usePaymentContext(pages.data?.pages);
  const payments = pages.data?.pages.flatMap((page) => page.transactions) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;

  const tab = ['payments', 'replies', 'proposals'].includes(url.tab ?? '')
    ? url.tab!
    : 'payments';
  // Saved explanations and AI history are the reviewer's record; they are
  // fetched only when their tab is open, since the review endpoint still
  // reads the whole ledger to answer.
  const record = useQuery({
    queryKey: ['review', actor, { window: 'all', all: '0' }],
    enabled: Boolean(actor) && tab !== 'payments' && !selectedId,
    queryFn: ({ signal }) =>
      apiGet<ReviewData>('/api/review?window=all&all=0', signal),
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
  const nodes = categories.data?.nodes ?? [];
  const allTags = categories.data?.tags ?? [];
  const loading = session.isPending || (pages.isPending && !selectedId);
  const error =
    [session.error, pages.error, categories.error].find(Boolean)?.message ?? '';
  const [notice, setNotice] = useState('');
  const [historyLimit, setHistoryLimit] = useState(12);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const refresh = () => {
    void invalidateFinancialData();
  };
  const selected = detail.data?.transactions.find((t) => t.id === selectedId);

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
    return selected && identity && detail.data ? (
      <TransactionDetail
        transaction={selected}
        data={detail.data}
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
          Back to review
        </Button>
      </section>
    );

  const whoOptions = [
    ...(['rodion', 'katya'] as const).map((member) => ({
      value: member,
      label:
        member === actor ? `${owners[member].name} (me)` : owners[member].name,
    })),
    { value: 'all', label: 'Both of us' },
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Review"
        description="Payments still waiting for a decision, newest first. Decide each one here or answer in Telegram."
        actions={<RefreshButton />}
      />
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
        value={tab}
        onValueChange={(next) => {
          patch({ tab: next });
          setHistoryLimit(12);
        }}
      >
        <TabsList className="mb-4 h-auto w-full justify-start gap-1 overflow-x-auto sm:w-auto">
          <TabsTrigger value="payments" className="min-h-10">
            Payments
            {pages.data && (
              <span className="ml-1 text-xs opacity-60">{total}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="replies" className="min-h-10">
            <MessageCircle className="size-4" />
            <span>Explanations</span>
            {record.data && (
              <span className="text-xs opacity-60">
                {record.data.replies.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="proposals" className="min-h-10">
            <Sparkles className="size-4" />
            <span>AI history</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="payments" className="space-y-4">
          <FilterBar>
            <Field label="Whose" htmlFor="review-who">
              <Choice
                id="review-who"
                className="w-full sm:w-44"
                value={who}
                onChange={(value) => patch({ who: value })}
                options={whoOptions}
              />
            </Field>
            <Field label="Account" htmlFor="review-account">
              <Choice
                id="review-account"
                className="w-full sm:w-56"
                value={account || 'all'}
                onChange={(value) =>
                  patch({ account: value === 'all' ? undefined : value })
                }
                options={accountOptions(householdAccounts.data, {
                  rodion: owners.rodion.name,
                  katya: owners.katya.name,
                })}
              />
            </Field>
            <Field label="Search" htmlFor="review-search" className="sm:flex-1">
              <Input
                id="review-search"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Search descriptions"
              />
            </Field>
          </FilterBar>
          {pages.isFetching && pages.data && !pages.isFetchingNextPage && (
            <p role="status" className="text-xs text-muted-foreground">
              Updating payments…
            </p>
          )}
          <PagedList
            items={payments}
            keyOf={(t) => t.id}
            loading={loading}
            hasMore={Boolean(pages.hasNextPage)}
            loadingMore={pages.isFetchingNextPage}
            onLoadMore={() => void pages.fetchNextPage()}
            empty={
              !error && (
                <EmptyState
                  icon={Inbox}
                  className="rounded-lg border border-dashed"
                  title={
                    search
                      ? 'Nothing waiting matches that search'
                      : 'Nothing waiting for a decision'
                  }
                  text={
                    search
                      ? 'Every payment still waiting has a different description. Clear the search to see them all.'
                      : who === 'all'
                        ? 'Every outflow already has a decision. New payments appear here as the banks deliver them.'
                        : 'Every outflow on these accounts already has a decision. Choose “Both of us” to see the other member’s payments.'
                  }
                />
              )
            }
            footer={
              payments.length && !pages.hasNextPage
                ? `All ${total} payments waiting for a decision are listed.`
                : payments.length
                  ? `${payments.length} of ${total} listed`
                  : undefined
            }
            renderRow={(t) => (
              <PaymentRow
                transaction={t}
                context={context}
                displayCurrency={displayCurrency}
                showKind={false}
                href={`/review?id=${encodeURIComponent(t.id)}&display=${displayCurrency}`}
                action={
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelectedId(t.id);
                      setActionError('');
                    }}
                  >
                    Review
                  </Button>
                }
              />
            )}
          />
        </TabsContent>
        <TabsContent value="replies" className="space-y-3">
          <p className="mb-4 text-sm text-muted-foreground">
            All your saved explanations from Telegram and this app, including
            confirmed and rejected suggestions. Your original explanation stays
            in the payment history. Use Refresh to check the latest processing
            status.
          </p>
          {record.isPending ? (
            <Skeleton className="h-32" />
          ) : record.data?.replies.length ? (
            <>
              {record.data.replies.slice(0, historyLimit).map((r) => (
                <ReplyCard
                  key={r.id}
                  reply={r}
                  openPayment={() => setSelectedId(r.transaction_id)}
                />
              ))}
              {record.data.replies.length > historyLimit && (
                <Button
                  variant="outline"
                  onClick={() => setHistoryLimit((n) => n + 12)}
                >
                  Show more explanations
                </Button>
              )}
            </>
          ) : (
            !record.error && (
              <EmptyState
                icon={MessageCircle}
                className="rounded-lg border border-dashed"
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
          {record.isPending ? (
            <Skeleton className="h-32" />
          ) : record.data?.proposals.length ? (
            <>
              {record.data.proposals.slice(0, historyLimit).map((p) => (
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
              {record.data.proposals.length > historyLimit && (
                <Button
                  variant="outline"
                  onClick={() => setHistoryLimit((n) => n + 12)}
                >
                  Show more suggestions
                </Button>
              )}
            </>
          ) : (
            !record.error && (
              <EmptyState
                icon={Sparkles}
                className="rounded-lg border border-dashed"
                title="No AI suggestions yet"
                text="Suggestions appear here after a payment is sent for AI review. Your decisions always take precedence."
              />
            )
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
