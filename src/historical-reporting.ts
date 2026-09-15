import { reviewPriority } from './review-window.js';
import { Categories, assignablePaths, categoryPath } from './categories.js';
import { convertedSpending } from './analytics.js';
import {
  estimateHistoricalSpending,
  historicalEstimateWindow,
  type HistoricalEstimateInput,
} from './historical-estimates.js';
import type { Repository, Transaction } from './repository.js';
import { needsSpendingReview } from './spending-review.js';

/** Read-only estimates. Caller supplies the same filtered rows and reporting conversion. */
export async function historicalReporting(
  repo: Repository,
  rows: Transaction[],
  reporting: Awaited<ReturnType<typeof convertedSpending>>,
) {
  const eligible = rows.filter((row) => needsSpendingReview(row));
  const uah =
    reporting.currency === 'UAH'
      ? reporting
      : await convertedSpending(repo, eligible, 'UAH');
  const evidence = eligible.length
    ? (
        await repo.db.query(
          `SELECT t.id,t.revision,t.source_details,q.decision,q.state,q.revision AS proposal_revision,
    EXISTS(SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event IN ('classified','refund_linked','refund_unlinked')) AS human,
    EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND (r.debit_id=t.id OR r.credit_id=t.id)) AS refund
    FROM transactions t LEFT JOIN transaction_triage q ON q.transaction_id=t.id AND q.revision=t.revision AND q.owner=t.owner WHERE t.id=ANY($1::uuid[])`,
          [eligible.map((t) => t.id)],
        )
      ).rows
    : [];
  const nodes = new Map<string, string[]>();
  for (const owner of new Set(eligible.map((t) => t.owner))) {
    // One shared tree, so the vocabulary no longer varies by owner.
    nodes.set(
      owner,
      assignablePaths(await new Categories(repo.db).listNodes()),
    );
  }
  const projections = eligible.map((transaction) => {
    const data = evidence.find((e) => e.id === transaction.id);
    const fx = uah.rows.find((r) => r.id === transaction.id);
    const fresh = Number(data?.revision) === transaction.revision;
    const projection = estimateHistoricalSpending({
      transaction,
      hasHumanDecision: !fresh || data?.human === true,
      refundLinked: data?.refund === true,
      categoryPaths: nodes.get(transaction.owner) ?? [],
      sourceDetails: (data?.source_details ?? {}) as Record<string, unknown>,
      uah: {
        // What the payment finally cost, after money that came back.
        amountMinor: fx?.netAmountMinor ?? null,
        provenance: fx?.provenance ?? null,
      },
      ...(data?.decision
        ? {
            cachedProposal: {
              id: `${transaction.id}:${transaction.revision}`,
              revision: Number(data.proposal_revision),
              state: String(data.state),
              decision: data.decision as NonNullable<
                HistoricalEstimateInput['cachedProposal']
              >['decision'],
            },
          }
        : {}),
    });
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Riga',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(transaction.bookedAt));
    const window = historicalEstimateWindow();
    if (
      projection.status === 'out_of_scope' &&
      day >= '2026-01-01' &&
      day >= window.startDate &&
      day < window.cutoffDate
    ) {
      projection.status = 'needs_review';
      projection.reviewPriority = reviewPriority(
        fx?.convertedAmountMinor ?? null,
      );
      projection.reason = 'protected_manual_decision_or_stale_evidence';
    }
    return projection;
  });
  let estimated = 0n,
    unknown = 0n,
    estimatedCount = 0,
    unknownCount = 0,
    missing = 0;
  for (const projection of projections) {
    if (projection.status === 'out_of_scope') continue;
    // What the payment finally cost, after money that came back: a fully
    // refunded payment still needs explaining but adds nothing to a total.
    const amount = reporting.rows.find(
      (r) => r.id === projection.transactionId,
    )?.netAmountMinor;
    if (projection.status === 'estimated') estimatedCount++;
    else unknownCount++;
    if (amount === null || amount === undefined) {
      missing++;
      continue;
    }
    if (projection.status === 'estimated') estimated -= BigInt(amount);
    else unknown -= BigInt(amount);
  }
  return {
    estimatedMinor: estimated.toString(),
    unknownMinor: unknown.toString(),
    estimatedCount,
    unknownCount,
    missing,
    rows: projections.filter((p) => p.status !== 'out_of_scope'),
  };
}
