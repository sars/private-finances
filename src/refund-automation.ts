import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import { Conflict } from './errors.js';
import { Refunds } from './refunds.js';
import {
  defaultRefundWindow,
  refundDecision,
  type RefundRow,
  type RefundWindow,
} from './refund-matching.js';

/**
 * Automatic refund matching (ADR 0007). The system works out what it can by
 * itself and only asks when the answer would change something, so most merchant
 * reversals resolve silently and questions are left for money from people.
 */

export type RefundReviewOutcome = 'linked' | 'asked' | 'unmatched';
export type RefundReview = {
  transactionId: string;
  revision: number;
  outcome: RefundReviewOutcome;
  reason: string;
  candidateIds: string[];
  decidedAt: string;
};

/**
 * Which edition of the matching rules produced a stored decision. Raise it for
 * anything that changes what a decision would be, including a change to what the
 * rules are allowed to see: edition 4 exists because holds began reaching the
 * matcher, not because a rule itself was rewritten. A decision is
 * only as good as the rules that made it, so raising this number re-opens every
 * earlier decision for one more look instead of leaving a question standing that
 * the current rules would answer by themselves.
 */
export const REFUND_RULES_VERSION = 9;

/** Version 23. What the matcher decided about one incoming credit. */
export async function initializeRefundMatching(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS refund_match_reviews (
    transaction_id uuid PRIMARY KEY REFERENCES transactions(id),
    revision integer NOT NULL CHECK(revision>=0),
    outcome text NOT NULL CHECK(outcome IN ('linked','asked','unmatched')),
    reason text NOT NULL,
    candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    decided_at timestamptz NOT NULL DEFAULT now()
  )`);
  await upgradeRefundRulesVersion(tx);
}

/** Version 27. Existing decisions default to edition 1 and are looked at again. */
export async function upgradeRefundRulesVersion(tx: Executor): Promise<void> {
  await tx.query(
    'ALTER TABLE refund_match_reviews ADD COLUMN IF NOT EXISTS rules_version integer NOT NULL DEFAULT 1',
  );
}

function matchingRow(row: Row): RefundRow {
  return {
    id: String(row.id),
    source: String(row.source),
    accountId: String(row.account_id),
    owner: String(row.owner),
    bookedAt: (row.booked_at instanceof Date
      ? row.booked_at
      : new Date(String(row.booked_at))
    ).toISOString(),
    currency: String(row.currency),
    amountMinor: String(row.amount_minor),
    description: String(row.description),
    status: row.status as 'booked' | 'pending',
    kind: String(row.kind),
    category: row.category === null ? null : String(row.category),
    sourceDetails: (row.source_details ?? {}) as Record<string, unknown>,
    reducedMinor: row.reduced_minor ? String(row.reduced_minor) : '0',
  };
}

const reduced =
  "(SELECT COALESCE(sum(r.reduction_minor),0) FROM refund_links r WHERE r.state='active' AND r.debit_id=t.id) AS reduced_minor";

export class RefundMatcher {
  private readonly window: RefundWindow;
  constructor(
    readonly db: Database,
    options: { window?: RefundWindow } = {},
  ) {
    this.window = options.window ?? defaultRefundWindow;
  }
  /**
   * Incoming money nobody has explained yet. A credit is reconsidered when the
   * bank revises it, and an unmatched recent one is retried because the charge
   * it returns may be imported after it.
   */
  private async pending(limit: number, now: Date): Promise<Row[]> {
    return (
      await this.db.query(
        `SELECT t.*,${reduced} FROM transactions t
         LEFT JOIN refund_match_reviews v ON v.transaction_id=t.id
         WHERE t.amount_minor>0 AND t.source<>'manual_cash'
           AND NOT EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND (r.credit_id=t.id OR r.debit_id=t.id))
           -- History is matched too, not only new money: the owner asked for
           -- every confident link to be made without being asked. What must not
           -- be touched is a decision a person made — a classification, or a
           -- link they confirmed by hand, even one since removed. The matcher's
           -- own past work is fair game, which is what lets a rule change
           -- correct it.
           AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id
                          AND a.event='classified')
           AND NOT EXISTS(SELECT 1 FROM refund_links m WHERE m.credit_id=t.id AND m.origin='manual')
           AND (v.transaction_id IS NULL OR v.revision<>t.revision
                -- A decision that says "linked" has reached this query, which
                -- only returns credits with no link: the link is gone and the
                -- decision has to be made again. Without this a released link
                -- is never replaced, which lost eighty of them in production.
                OR v.outcome='linked'
                OR v.rules_version<$3
                OR (v.outcome='unmatched' AND v.decided_at<$2::timestamptz-interval '6 hours'
                    AND t.booked_at>$2::timestamptz-interval '30 days'))
         ORDER BY t.booked_at DESC,t.id LIMIT $1`,
        [limit, now.toISOString(), REFUND_RULES_VERSION],
      )
    ).rows;
  }
  /**
   * Charges the credit could be returning. A hold counts: the rules decide what
   * a pending amount means, and excluding it here once hid the very ride a
   * cancellation belonged to.
   */
  private async candidates(credit: Row): Promise<Row[]> {
    return (
      await this.db.query(
        `SELECT t.*,${reduced} FROM transactions t
         WHERE t.owner=$1 AND t.source=$2 AND t.account_id=$3 AND t.currency=$4
           AND t.amount_minor<0
           AND t.booked_at<=$5::timestamptz+($6||' days')::interval
           AND t.booked_at>=$5::timestamptz-($7||' days')::interval
           AND NOT EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND r.credit_id=t.id)
         ORDER BY t.booked_at,t.id`,
        [
          credit.owner,
          credit.source,
          credit.account_id,
          credit.currency,
          credit.booked_at,
          String(this.window.forwardDays),
          String(this.window.backDays),
        ],
      )
    ).rows;
  }
  private async record(
    transactionId: string,
    revision: number,
    outcome: RefundReviewOutcome,
    reason: string,
    candidateIds: string[],
    now: Date,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO refund_match_reviews(transaction_id,revision,outcome,reason,candidate_ids,decided_at,rules_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(transaction_id) DO UPDATE SET revision=excluded.revision,outcome=excluded.outcome,
         reason=excluded.reason,candidate_ids=excluded.candidate_ids,decided_at=excluded.decided_at,
         rules_version=excluded.rules_version`,
      [
        transactionId,
        revision,
        outcome,
        reason,
        JSON.stringify(candidateIds.slice(0, 10)),
        now.toISOString(),
        REFUND_RULES_VERSION,
      ],
    );
  }
  /**
   * One pass over unexplained incoming money. Returns what it decided; questions
   * are only recorded here, because asking is a separate, rate-limited step.
   */
  async matchPending(
    limit = 25,
    now = new Date(),
  ): Promise<{ linked: number; asked: number; unmatched: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('invalid_refund_match_limit');
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_match_date');
    const result = { linked: 0, asked: 0, unmatched: 0 };
    await this.settleLinkedDecisions();
    const refunds = new Refunds(this.db);
    // Refunds are assigned as a set rather than one at a time in arrival order.
    // A credit that names its parent exactly claims it before any credit that
    // would only be guessing, because otherwise a partial refund takes the
    // charge an exact one needed and leaves it with nothing. The owner's ride
    // receipts showed the shape: two identical holds, one cancelled outright and
    // one partly refunded, where processing order alone decided which purchase
    // ended up wrong.
    const certain = new Set([
      'exact_original',
      'exact_ledger_and_original',
      'indistinguishable_nearest',
    ]);
    const queue = await this.pending(limit, now);
    const settled = new Set<string>();
    for (const phase of ['certain', 'guessing'] as const) {
      for (const credit of queue) {
        const id = String(credit.id);
        if (settled.has(id)) continue;
        const revision = Number(credit.revision);
        const debits = await this.candidates(credit);
        const decision = refundDecision(
          matchingRow(credit),
          debits.map(matchingRow),
          this.window,
        );
        if (
          phase === 'certain' &&
          !(decision.action === 'link' && certain.has(decision.rule))
        )
          continue;
        settled.add(id);
        if (decision.action === 'link') {
          const debit = debits.find(
            (row) => String(row.id) === decision.debitId,
          )!;
          try {
            await refunds.link({
              debitId: decision.debitId,
              creditId: id,
              expectedDebitRevision: Number(debit.revision),
              expectedCreditRevision: revision,
              owner: credit.owner as 'rodion' | 'katya',
              origin: 'automatic',
              rule: decision.rule,
              rulesVersion: REFUND_RULES_VERSION,
              reason: `Automatic refund match (${decision.rule})`,
            });
          } catch (error) {
            // Someone edited or linked one side first; the next pass sees the
            // current state. Never retry a money decision over a moving target.
            if (error instanceof Conflict) continue;
            // The rules wanted a link the service would not write. That is a
            // disagreement worth seeing, but one credit must never stop the
            // batch and repeat the same refusal every minute, so it is recorded
            // and the pass moves on.
            await this.record(
              id,
              revision,
              'asked',
              error instanceof Error
                ? `link_refused:${error.message.slice(0, 40)}`
                : 'link_refused',
              [decision.debitId],
              now,
            );
            result.asked++;
            continue;
          }
          await this.record(
            id,
            revision,
            'linked',
            decision.rule,
            [decision.debitId],
            now,
          );
          result.linked++;
          continue;
        }
        if (decision.action === 'ask') {
          await this.record(
            id,
            revision,
            'asked',
            decision.reason,
            decision.debitIds,
            now,
          );
          result.asked++;
          continue;
        }
        await this.record(id, revision, 'unmatched', decision.reason, [], now);
        result.unmatched++;
      }
    }
    return result;
  }

  /**
   * A link the matcher chose under older rules is released so the current rules
   * can choose again, and the pass that follows re-assigns the whole set at
   * once. Only the matcher's own work is touched: a link a person confirmed, or
   * a credit or purchase a person has classified, is left exactly as it is. The
   * owner approved this narrowly, after their ride receipts showed two links
   * that were the wrong way round and could not be corrected any other way.
   */
  async reassignOwnLinks(limit = 50): Promise<number> {
    const stale = (
      await this.db.query(
        `SELECT r.id,r.debit_id,r.credit_id,r.reduction_minor,r.revision,
                coalesce(r.evidence->>'rule','?') AS rule
         FROM refund_links r
         WHERE r.state='active' AND r.origin='automatic'
           AND coalesce((r.evidence->>'rulesVersion')::int,0) < $1
           -- Only a decision about the incoming money itself protects a link.
           -- Every purchase gets a category, and categorising the ride says
           -- nothing about which refund belongs to it; requiring both sides
           -- untouched protected all 45 links from ever being corrected.
           AND NOT EXISTS (SELECT 1 FROM audit_events a
             WHERE a.transaction_id=r.credit_id AND a.event='classified')
           AND NOT EXISTS (SELECT 1 FROM refund_links m
             WHERE m.credit_id=r.credit_id AND m.origin='manual')
         ORDER BY r.created_at LIMIT $2`,
        [REFUND_RULES_VERSION, limit],
      )
    ).rows;
    let released = 0;
    for (const row of stale) {
      await this.db.transaction(async (tx) => {
        const done = await tx.query(
          "UPDATE refund_links SET state='unlinked',revision=revision+1,unlinked_at=now() WHERE id=$1 AND state='active' RETURNING id",
          [row.id],
        );
        if (!done.rows.length) return;
        released++;
        // The decision that chose this parent goes with the link it made, so
        // the next pass decides the credit again instead of skipping it.
        await tx.query(
          'DELETE FROM refund_match_reviews WHERE transaction_id=$1',
          [row.credit_id],
        );
        await tx.query(
          `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
           VALUES($1,$2,'matcher','refund_reassigned',$3,$4,'Released so the current matching rules can choose the parent again')`,
          [
            randomUUID(),
            row.debit_id,
            JSON.stringify({
              reductionMinor: String(row.reduction_minor),
              rule: String(row.rule),
            }),
            JSON.stringify({
              reductionMinor: '0',
              refundLinkId: String(row.id),
              refundLinkRevision: Number(row.revision) + 1,
            }),
          ],
        );
      });
    }
    return released;
  }

  /**
   * A link made while the bank was still holding one of the amounts is checked
   * again after it settles: the reduction is recalculated from what the bank
   * finally recorded, and the link is removed when the hold turned out to be
   * nothing. This is the one case where a link is undone without a person,
   * because it was provisional by construction and the owner asked for exactly
   * that; a correction to two settled amounts is still only surfaced.
   */
  async reviewSettledLinks(): Promise<{
    recalculated: number;
    removed: number;
  }> {
    // Every parameter this pass sends is cast explicitly: an untyped boolean
    // reaches PostgreSQL as text and fails there while PGlite coerces it, which
    // is exactly the difference that took the worker down on 14 September.
    const rows = (
      await this.db.query(
        `SELECT r.id,r.revision,r.owner,r.debit_id,r.credit_id,r.reduction_minor,r.evidence,
                c.amount_minor AS credit_amount,c.status AS credit_status,
                d.amount_minor AS debit_amount,d.status AS debit_status
         FROM refund_links r JOIN transactions c ON c.id=r.credit_id JOIN transactions d ON d.id=r.debit_id
         WHERE r.state='active' AND r.evidence->>'provisional'='true'`,
      )
    ).rows;
    const result = { recalculated: 0, removed: 0 };
    for (const row of rows) {
      const evidence = (row.evidence ?? {}) as Record<string, unknown>;
      const creditAmount = BigInt(String(row.credit_amount));
      const settled =
        row.credit_status === 'booked' && row.debit_status === 'booked';
      const unchanged =
        String(row.credit_amount) === evidence.creditAmountMinor &&
        String(row.debit_amount) === evidence.debitAmountMinor;
      if (unchanged && !settled) continue;
      if (creditAmount <= 0n) {
        // The hold was released without any money coming back.
        await this.db.transaction(async (tx) => {
          await tx.query(
            "UPDATE refund_links SET state='unlinked',revision=revision+1,unlinked_at=now() WHERE id=$1 AND state='active'",
            [row.id],
          );
          await tx.query(
            `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
             VALUES($1,$2,'matcher','refund_unlinked',$3,$4,'The hold this refund was matched from was released without settling')`,
            [
              randomUUID(),
              row.debit_id,
              JSON.stringify({ reductionMinor: String(row.reduction_minor) }),
              JSON.stringify({
                reductionMinor: '0',
                refundLinkId: String(row.id),
                refundLinkRevision: Number(row.revision) + 1,
              }),
            ],
          );
        });
        result.removed++;
        continue;
      }
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE refund_links SET reduction_minor=$2::numeric,
             evidence=evidence
               || jsonb_build_object('creditAmountMinor',$3::text,'debitAmountMinor',$4::text)
               || (CASE WHEN $5::boolean THEN '{"provisional":false}'::jsonb ELSE '{}'::jsonb END)
           WHERE id=$1 AND state='active'`,
          [
            row.id,
            creditAmount.toString(),
            String(row.credit_amount),
            String(row.debit_amount),
            settled,
          ],
        );
        await tx.query(
          `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
           VALUES($1,$2,'matcher','refund_settled',$3,$4,'The bank settled an amount this refund was matched from')`,
          [
            randomUUID(),
            row.debit_id,
            JSON.stringify({ reductionMinor: String(row.reduction_minor) }),
            JSON.stringify({
              reductionMinor: creditAmount.toString(),
              settled,
              refundLinkId: String(row.id),
            }),
          ],
        );
      });
      result.recalculated++;
    }
    return result;
  }

  /**
   * A decision that produced a link is final under any edition of the rules: the
   * credit is linked and a link is never undone automatically, so it is marked
   * as read rather than left looking like unfinished work.
   */
  private async settleLinkedDecisions(): Promise<void> {
    await this.db.query(
      `UPDATE refund_match_reviews SET rules_version=$1
       WHERE outcome='linked' AND rules_version<$1`,
      [REFUND_RULES_VERSION],
    );
  }

  /** Credits the matcher could not settle on its own, newest first. */
  async questions(limit = 20): Promise<RefundReview[]> {
    return (
      await this.db.query(
        `SELECT v.* FROM refund_match_reviews v JOIN transactions t ON t.id=v.transaction_id
         WHERE v.outcome='asked' AND v.revision=t.revision
           AND NOT EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND r.credit_id=v.transaction_id)
         ORDER BY t.booked_at DESC,v.transaction_id LIMIT $1`,
        [limit],
      )
    ).rows.map((row) => ({
      transactionId: String(row.transaction_id),
      revision: Number(row.revision),
      outcome: row.outcome as RefundReviewOutcome,
      reason: String(row.reason),
      candidateIds: (row.candidate_ids as string[]) ?? [],
      decidedAt: new Date(String(row.decided_at)).toISOString(),
    }));
  }
}
