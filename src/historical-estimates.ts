import { createHash } from 'node:crypto';
import type { ClassificationProposal } from './classifier.js';
import type { Transaction } from './repository.js';
import type { StoredFxProvenance } from './fx-rates.js';
import { readMcc } from './mcc.js';

export const historicalEstimatePolicy = 'historical-estimates:v1';
export interface HistoricalEstimateInput {
  transaction: Transaction;
  /** Caller checks classification audit and refund links, including manual unresolved decisions. */
  hasHumanDecision: boolean;
  refundLinked: boolean;
  categoryPaths: readonly string[];
  sourceDetails: Record<string, unknown>;
  cachedProposal?: {
    id: string;
    revision: number;
    state: string;
    decision: ClassificationProposal;
  };
  /** Exact daily conversion from convertedSpending(..., 'UAH'), never a current spot rate. */
  uah: { amountMinor: string | null; provenance: StoredFxProvenance | null };
}
export interface HistoricalEstimateOptions {
  now?: Date;
  startDate?: string;
  /** Exclusive Riga calendar date; recent manual-review period is outside estimates. */
  cutoffDate?: string;
}
export interface HistoricalSpendingEstimate {
  transactionId: string;
  transactionRevision: number;
  policyVersion: string;
  evidenceFingerprint: string;
  status: 'estimated' | 'needs_review' | 'out_of_scope';
  category: string | null;
  method: 'cached_model' | 'mcc' | null;
  /** A heuristic/model score, not a calibrated probability of correctness. */
  confidence: number | null;
  reason: string;
  provenance: {
    mcc: number | null;
    proposalId: string | null;
    uahAmountMinor: string | null;
    fx: StoredFxProvenance | null;
    startDate: string;
    cutoffDate: string;
  };
}
const categoryByMcc: Readonly<Record<number, string>> = {
  5411: 'Food / Groceries',
  5499: 'Food / Groceries',
  5812: 'Food / Restaurants / Dining in',
  5814: 'Food / Restaurants / Dining in',
  5995: 'Pets',
  4814: 'Utilities / Mobile phone',
  5541: 'Transport / Car / Fuel',
  5542: 'Transport / Car / Fuel',
  8398: 'Donations',
};
function rigaDate(date: Date): string {
  if (!Number.isFinite(date.getTime()))
    throw new Error('invalid_estimate_date');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
function checkedDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error('invalid_estimate_date');
  return value;
}
export function historicalEstimateWindow(
  options: HistoricalEstimateOptions = {},
) {
  const today = rigaDate(options.now ?? new Date());
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return {
    startDate: checkedDate(options.startDate ?? '2026-01-01'),
    cutoffDate: checkedDate(
      options.cutoffDate ??
        `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}-01`,
    ),
  };
}
/** Recomputed view only: never changes ledger classifications or creates future rules. */
export function estimateHistoricalSpending(
  input: HistoricalEstimateInput,
  options: HistoricalEstimateOptions = {},
): HistoricalSpendingEstimate {
  const { transaction: tx, cachedProposal: cached } = input;
  const window = historicalEstimateWindow(options);
  const date = rigaDate(new Date(tx.bookedAt));
  const mcc = readMcc(input.sourceDetails)?.code ?? null;
  const currentProposal =
    cached?.revision === tx.revision && cached.state === 'ready'
      ? cached
      : undefined;
  const uah = tx.currency === 'UAH' ? tx.amountMinor : input.uah.amountMinor;
  const result: HistoricalSpendingEstimate = {
    transactionId: tx.id,
    transactionRevision: tx.revision,
    policyVersion: historicalEstimatePolicy,
    evidenceFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          policy: historicalEstimatePolicy,
          input,
          window,
        }),
      )
      .digest('hex'),
    status: 'out_of_scope',
    category: null,
    method: null,
    confidence: null,
    reason: 'outside_historical_scope',
    provenance: {
      ...window,
      mcc,
      proposalId: currentProposal?.id ?? null,
      uahAmountMinor: uah,
      fx: tx.currency === 'UAH' ? null : input.uah.provenance,
    },
  };
  if (
    date < '2026-01-01' ||
    date < window.startDate ||
    date >= window.cutoffDate ||
    tx.status !== 'booked' ||
    tx.kind !== 'unresolved' ||
    BigInt(tx.amountMinor) >= 0n ||
    tx.spendingPolicy?.excluded ||
    input.hasHumanDecision ||
    input.refundLinked
  )
    return result;
  result.status = 'needs_review';
  if (uah === null || BigInt(uah) >= 0n) {
    result.reason = 'missing_or_invalid_daily_uah_conversion';
    return result;
  }
  const words = tx.description
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  if (
    (mcc !== null &&
      [
        4829, 6010, 6011, 6012, 6051, 6211, 6530, 6536, 6537, 6538, 6540,
      ].includes(mcc)) ||
    words.some((word) =>
      [
        'transfer',
        'p2p',
        'iban',
        'investment',
        'переказ',
        'перекази',
        'перевод',
        'переводы',
        'картку',
        'картки',
        'банку',
        'фоп',
        'облігації',
        'інжур',
      ].includes(word),
    )
  ) {
    result.reason = 'transfer_or_investment_context_requires_evidence';
    return result;
  }
  const broadCategory = mcc === null ? undefined : categoryByMcc[mcc];
  const proposal = currentProposal?.decision;
  const validProposal =
    proposal?.kind === 'personal_expense' &&
    Number.isFinite(proposal.confidence) &&
    proposal.confidence >= 0.7 &&
    proposal.confidence <= 1 &&
    proposal.category !== null &&
    input.categoryPaths.includes(proposal.category) &&
    !/(?:^| \/ )Unspecified$/i.test(proposal.category);
  if (
    validProposal &&
    ((broadCategory && broadCategory !== proposal.category) ||
      (mcc === 5734 && /^Transport(?: \/ |$)/.test(proposal.category!)) ||
      (mcc === 5818 &&
        /(?:AI tools|Code tools|Coding tools)/i.test(proposal.category!)))
  ) {
    result.reason = 'conflicting_merchant_and_model_evidence';
    return result;
  }
  // The 3,000 UAH line that once demanded a specific merchant for a large
  // payment was retired at the owner's instruction on September 17, 2026: a
  // large payment is estimated from the same evidence as any other.
  if (validProposal) {
    return {
      ...result,
      status: 'estimated',
      category: proposal.category,
      confidence: proposal.confidence,
      method: 'cached_model',
      reason: 'unconfirmed_cached_model_estimate',
    };
  }
  if (broadCategory && input.categoryPaths.includes(broadCategory)) {
    return {
      ...result,
      status: 'estimated',
      category: broadCategory,
      confidence: 0.6,
      method: 'mcc',
      reason: 'merchant_business_category_estimate_not_item_identification',
    };
  }
  result.reason = 'insufficient_merchant_evidence';
  return result;
}
