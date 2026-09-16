import type { SavedReply } from './reply-history';

export type Owner = 'rodion' | 'katya';
export type Kind =
  | 'unresolved'
  | 'personal_expense'
  | 'internal_transfer'
  | 'investment'
  | 'non_personal';
export type SpendingPattern = 'routine' | 'exceptional' | 'unreviewed';
export type Transaction = {
  source?: string;
  id: string;
  owner: Owner;
  bookedAt: string;
  currency: string;
  amountMinor: string;
  description: string;
  kind: Kind;
  category: string | null;
  status?: 'booked' | 'pending';
  revision: number;
  spendingPolicy?: {
    excluded: boolean;
    accountLabel: string | null;
    accountPurpose: 'personal' | 'business' | 'investment' | 'unreviewed';
    reason: 'business_account' | 'investment_account' | null;
    accountRevision: number;
  };
  storedClassification?: { kind: Kind; category: string | null };
  spendingPattern?: {
    pattern: SpendingPattern;
    revision: number;
    needsReview: boolean;
    explicit: boolean;
    reason: string | null;
  };
  refund?: {
    role: 'reduced' | 'refund';
    reducedMinor: string;
    netMinor: string;
    currency: string;
    approximate: boolean;
    provisional?: boolean;
    fullyReduced: boolean;
    reductions: Array<{
      linkId: string;
      linkRevision: number;
      peerId: string;
      peerBookedAt: string;
      reductionMinor: string;
      currency: string;
      convertedMinor: string | null;
      approximate: boolean;
      provisional?: boolean;
      origin: 'manual' | 'automatic';
      rule: string;
      discrepancy: string | null;
    }>;
  };
};
export type Node = {
  id: string;
  name: string;
  parentId: string | null;
  type: 'category' | 'tag';
};
export type Rule = {
  id: string;
  kind: Kind;
  categoryId: string | null;
  version: number;
};
export type Proposal = {
  id: string;
  transaction_id: string;
  state: string;
  revision: number;
  created_at: string;
  proposal: {
    kind?: Kind;
    category?: string | null;
    explanation?: string;
    confidence?: number;
  } | null;
};
export type TriageDecision = {
  kind: Kind;
  category: string | null;
  explanation: string;
  source: string;
};
export type ReviewData = {
  reporting?: {
    currency: string;
    rows: Array<{
      id: string;
      convertedAmountMinor: string | null;
      /** What the payment finally cost, after money that came back. */
      netAmountMinor: string | null;
      method: string | null;
    }>;
  };
  historicalEstimates?: Array<{
    transactionId: string;
    status: string;
    category: string | null;
    method: string | null;
    reason: string;
    confidence: number | null;
  }>;
  priorities?: Record<string, 'large' | 'missing_fx' | 'normal'>;
  triage?: Array<{
    transaction_id: string;
    revision: number;
    state: string;
    decision: TriageDecision | null;
    question: string | null;
  }>;
  transactions: Transaction[];
  suggestions: Record<string, { ambiguous: boolean; rules: Rule[] }>;
  tags: Record<string, Node[]>;
  proposals: Proposal[];
  replies: SavedReply[];
};
export type Bootstrap = {
  actor: Owner;
  csrf: string;
  features: { ai: boolean; telegram: boolean };
};
export type Action =
  | '/classify'
  | '/propose'
  | '/tags'
  | '/telegram/queue'
  | '/spending-pattern'
  | '/refund/link'
  | '/refund/unlink';
export type Submit = (
  action: Action,
  values: Record<string, string>,
) => Promise<void>;

/** The bank facts worth showing in their own right, beside the raw field list. */
export type DetailSummary = {
  originalAmount: string | null;
  purpose: string | null;
  mcc: { code: string; meaning: string; note: string } | null;
  counterparty: {
    role: string;
    name: string | null;
    iban: string | null;
    card: string | null;
    cardNetwork: string | null;
    bank: string | null;
    bankSource: string | null;
  };
  cashback: string | null;
  bankTransactionType: string | null;
  valueDate: string | null;
};
export type TransactionDetails = {
  fields: Array<{ label: string; value: string }>;
  summary: DetailSummary;
  counterpartyAvailable: boolean;
  cardReferenceAvailable: boolean;
};

export const kinds: Record<Kind, string> = {
  unresolved: 'Unresolved',
  personal_expense: 'Personal expense',
  internal_transfer: 'Internal transfer',
  investment: 'Investment',
  non_personal: 'Non-personal',
};
// Node runs this file directly in tests, so the extension is explicit.
export { money } from './format.ts';
export function path(nodes: Node[], id: string) {
  const parts: string[] = [],
    seen = new Set<string>();
  let node = nodes.find((n) => n.id === id);
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    parts.unshift(node.name);
    node = nodes.find((n) => n.id === node!.parentId);
  }
  return parts.join(' / ');
}
/**
 * The day and the clock time, in the household's own timezone. A statement
 * date carries no meaningful time of day, so only the day is shown for those.
 */
export function bookedMoment(
  value: string,
  source: string | undefined,
): { day: string; time: string | null; iso: string } {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()))
    return { day: value.slice(0, 10), time: null, iso: value };
  const dayOnly = source === 'manual_cash' || source === 'enablebanking';
  return {
    day: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Riga',
      dateStyle: 'medium',
    }).format(instant),
    time: dayOnly
      ? null
      : new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Riga',
          timeStyle: 'short',
        }).format(instant),
    iso: instant.toISOString(),
  };
}
