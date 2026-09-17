/**
 * The paged payment list: what `/api/transactions` returns and how a screen
 * asks for it. Filters live in the URL; this turns them into the request, and
 * the pages into lookups a row can read without searching an array.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiGet } from './query.ts';
import type { ReviewData, Transaction } from './transactions.ts';

export type PaymentPage = {
  transactions: Transaction[];
  total: number;
  nextCursor: string | null;
  reporting?: ReviewData['reporting'];
  historicalEstimates?: NonNullable<ReviewData['historicalEstimates']>;
  triage: NonNullable<ReviewData['triage']>;
  suggestions: ReviewData['suggestions'];
  tags: ReviewData['tags'];
  /** How many matched receipts each payment has; absent means none. */
  receipts: Record<string, number>;
};

/** The parameters the endpoint understands; anything else is left out. */
export const paymentParams = [
  'owner',
  'review',
  'from',
  'to',
  'category',
  'pattern',
  'scope',
  'currency',
  'q',
  'account',
  'kinds',
  'tag',
  'receipts',
  'refunds',
  'min',
  'max',
  'display',
  'includeNonPersonal',
  'includeTransfers',
  'includeRefunds',
  'includeZeroAmount',
] as const;
export type PaymentFilters = Partial<
  Record<(typeof paymentParams)[number], string>
>;

/** The request query for a set of filters, in a fixed key order so equal
 * filters give one cache entry. Empty values are dropped. */
export function paymentSearch(
  filters: PaymentFilters,
  cursor?: string,
  limit = 50,
): string {
  const params = new URLSearchParams();
  for (const key of paymentParams) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

/** An account as the household names it, for the account filter. */
export type HouseholdAccount = {
  source: string;
  accountId: string;
  owner: 'rodion' | 'katya';
  label: string;
  purpose: string;
};

/** Both members' accounts, once per session; the filter lists them by name. */
export function useHouseholdAccounts(actor: string | undefined) {
  return useQuery({
    queryKey: ['household-accounts', actor],
    enabled: Boolean(actor),
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) =>
      (await apiGet<{ household: HouseholdAccount[] }>('/api/accounts', signal))
        .household,
  });
}

/** Options for an account filter: every account, then each by its name and
 * whose it is, in the household's order. */
export function accountOptions(
  accounts: HouseholdAccount[] | undefined,
  names: Record<'rodion' | 'katya', string>,
) {
  return [
    { value: 'all', label: 'Every account' },
    ...(accounts ?? []).map((a) => ({
      value: a.accountId,
      label: `${a.label} · ${names[a.owner]}`,
    })),
  ];
}

export function usePaymentPages(
  actor: string | undefined,
  filters: PaymentFilters,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: ['payments', actor, filters],
    enabled: Boolean(actor) && enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: PaymentPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam, signal }) =>
      apiGet<PaymentPage>(
        '/api/transactions?' + paymentSearch(filters, pageParam),
        signal,
      ),
    placeholderData: (previous, query) =>
      query?.queryKey[1] === actor ? previous : undefined,
  });
}

/** How many of one member's payments still wait for a decision. */
export function useReviewCount(actor: string | undefined) {
  return useQuery({
    queryKey: ['review-count', actor],
    enabled: Boolean(actor),
    queryFn: async ({ signal }) =>
      (
        await apiGet<PaymentPage>(
          '/api/transactions?' +
            paymentSearch({ review: '1', owner: actor }, undefined, 1),
          signal,
        )
      ).total,
  });
}

export type PaymentContext = {
  reporting?: ReviewData['reporting'];
  estimate: Map<string, NonNullable<ReviewData['historicalEstimates']>[number]>;
  recognized: Map<string, NonNullable<ReviewData['triage']>[number]>;
  suggestions: ReviewData['suggestions'];
  tags: ReviewData['tags'];
  receipts: Record<string, number>;
};

/** One lookup per fact a row shows, built once per set of pages. */
export function buildPaymentContext(pages: PaymentPage[]): PaymentContext {
  const estimate: PaymentContext['estimate'] = new Map();
  const recognized: PaymentContext['recognized'] = new Map();
  const suggestions: ReviewData['suggestions'] = {};
  const tags: ReviewData['tags'] = {};
  const receipts: Record<string, number> = {};
  const rows: NonNullable<ReviewData['reporting']>['rows'] = [];
  let currency: string | undefined;
  const revision = new Map(
    pages.flatMap((page) => page.transactions.map((t) => [t.id, t.revision])),
  );
  for (const page of pages) {
    for (const e of page.historicalEstimates ?? [])
      if (e.status === 'estimated') estimate.set(e.transactionId, e);
    for (const item of page.triage)
      if (
        item.state === 'ready' &&
        item.decision &&
        revision.get(item.transaction_id) === item.revision
      )
        recognized.set(item.transaction_id, item);
    Object.assign(suggestions, page.suggestions);
    Object.assign(tags, page.tags);
    Object.assign(receipts, page.receipts);
    if (page.reporting) {
      currency = page.reporting.currency;
      rows.push(...page.reporting.rows);
    }
  }
  return {
    reporting: currency ? { currency, rows } : undefined,
    estimate,
    recognized,
    suggestions,
    tags,
    receipts,
  };
}

export function usePaymentContext(pages: PaymentPage[] | undefined) {
  return useMemo(() => buildPaymentContext(pages ?? []), [pages]);
}
