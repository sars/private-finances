import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import type { Owner } from './domain.js';
import { Categories, UNSPECIFIED } from './categories.js';
import type {
  ClassificationProposal,
  ClassificationResult,
} from './classifier.js';
import {
  sufficientAutomaticConfidence,
  type TriageClassifierFactory,
} from './transaction-triage.js';
import { loadReceiptEvidence } from './receipt-evidence.js';
import { readMcc } from './mcc.js';

const policy = 'receipt_categories:v2';
const humanSql =
  "SELECT 1 FROM audit_events WHERE transaction_id=$1 AND event IN ('classified','refund_linked','refund_unlinked') LIMIT 1";

/** A moved receipt must not leave its old automatic category asserted as current. */
export async function invalidateReceiptCategory(tx: Executor, id: string) {
  const current = (
    await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [id])
  ).rows[0];
  if (!current || (await tx.query(humanSql, [id])).rows.length) return;
  const last = (
    await tx.query(
      "SELECT after_value FROM audit_events WHERE transaction_id=$1 AND event='auto_classified' ORDER BY created_at DESC,id DESC LIMIT 1",
      [id],
    )
  ).rows[0];
  const after = last?.after_value as Record<string, unknown> | undefined;
  if (
    !['receipt_categories:v1', policy].includes(
      String(
        (after?.provenance as Record<string, unknown> | undefined)?.policy,
      ),
    ) ||
    Number(after?.revision) !== Number(current.revision)
  )
    return;
  await tx.query(
    `UPDATE transactions SET kind='unresolved',category_id=NULL,provisional=false,
       classification_source='none',revision=revision+1,updated_at=now()
     WHERE id=$1`,
    [id],
  );
  await tx.query(
    `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
    VALUES($1,$2,'receipt_categorization','auto_classification_invalidated',$3,$4,'Receipt attachment changed; reassess its category')`,
    [
      randomUUID(),
      id,
      JSON.stringify({
        kind: current.kind,
        category: current.category,
        revision: current.revision,
      }),
      JSON.stringify({
        kind: 'unresolved',
        category: null,
        revision: Number(current.revision) + 1,
      }),
    ],
  );
}

/** One bounded assessment per receipt snapshot and bank revision; shared classifier budget. */
export class ReceiptCategorization {
  constructor(
    readonly db: Database,
    readonly classifierFor: TriageClassifierFactory,
  ) {}
  async processOne(): Promise<boolean> {
    const row = (
      await this.db
        .query(`SELECT t.*, a.purpose AS account_purpose FROM transactions t
      LEFT JOIN own_accounts a ON a.source=t.source AND a.account_id=t.account_id AND a.owner=t.owner
      LEFT JOIN LATERAL (SELECT created_at,after_value FROM audit_events e
        WHERE e.transaction_id=t.id AND e.event='receipt_categorization_checked' ORDER BY created_at DESC,id DESC LIMIT 1) checked ON true
      WHERE t.owner IN ('rodion','katya') AND t.amount_minor<0 AND t.status IN ('booked','pending')
        AND t.source<>'manual_cash'
        AND NOT EXISTS(SELECT 1 FROM transaction_explanations e WHERE e.transaction_id=t.id AND e.revision=t.revision AND e.status='pending')
        AND t.kind IN ('unresolved','personal_expense')
        AND (a.purpose IS NULL OR a.purpose NOT IN ('business','investment'))
        AND NOT EXISTS(SELECT 1 FROM audit_events h WHERE h.transaction_id=t.id AND h.event IN ('classified','refund_linked','refund_unlinked'))
        AND EXISTS(SELECT 1 FROM receipt_jobs r WHERE r.transaction_id=t.id AND r.state='matched')
        AND (checked.created_at IS NULL OR checked.after_value->>'policy' IS DISTINCT FROM 'receipt_categories:v2' OR checked.after_value->>'revision' IS DISTINCT FROM t.revision::text
          OR EXISTS(SELECT 1 FROM receipt_jobs r WHERE r.transaction_id=t.id AND r.state='matched' AND r.updated_at>checked.created_at))
      ORDER BY t.booked_at DESC,t.id LIMIT 1`)
    ).rows[0];
    if (!row) return false;
    const evidence = await loadReceiptEvidence(this.db, String(row.id));
    if (!evidence) return false;
    const classifier = await this.classifierFor(row.owner as Owner);
    if (!classifier) return false;
    let result: ClassificationResult = { status: 'failed' };
    if (evidence.receipts.length === 1 && !evidence.receipts[0]!.truncated) {
      try {
        result = await classifier.propose(
          String(row.id),
          Number(row.revision),
          row.owner as Owner,
          '',
          evidence.key,
        );
      } catch (error) {
        // An oversized basket/description needs review, not a worker crash or paid retry.
        if (
          !(error instanceof Error) ||
          error.message !== 'classifier_input_limit'
        )
          throw error;
      }
    }
    if (result.status === 'disabled' || result.status === 'budget_exhausted')
      return false;
    let proposal: ClassificationProposal | undefined;
    let proposalId: string | undefined;
    if (result.status === 'proposed') {
      proposal = result.proposal;
      proposalId = result.id;
    }
    if (result.status === 'already_requested') {
      const saved = (
        await this.db.query(
          'SELECT id,state,proposal FROM classifier_proposals WHERE transaction_id=$1 AND revision=$2 AND request_key=$3',
          [row.id, row.revision, evidence.key],
        )
      ).rows[0];
      if (!saved || saved.state === 'reserved') return false;
      if (saved.state === 'proposed') {
        proposal = saved.proposal as ClassificationProposal;
        proposalId = String(saved.id);
      }
    }
    await this.db.transaction(async (tx) => {
      // Same ordering as bank imports/receipt attachment, then account and rule edits.
      await tx.query('SELECT pg_advisory_xact_lock(7482392)');
      await tx.query('SELECT pg_advisory_xact_lock(7482393)');
      await tx.query('SELECT pg_advisory_xact_lock(7482394)');
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0];
      if (
        !current ||
        current.owner !== row.owner ||
        Number(current.revision) !== Number(row.revision) ||
        (await loadReceiptEvidence(tx, String(row.id)))?.key !== evidence.key
      )
        return;
      // Two workers may reuse the same paid proposal; only one may apply/check it.
      if (
        (
          await tx.query(
            "SELECT 1 FROM audit_events WHERE transaction_id=$1 AND event='receipt_categorization_checked' AND after_value->>'key'=$2 AND after_value->>'revision'=$3 AND after_value->>'policy'='receipt_categories:v2' LIMIT 1",
            [row.id, evidence.key, String(row.revision)],
          )
        ).rows.length
      )
        return;
      const account = (
        await tx.query(
          'SELECT purpose FROM own_accounts WHERE source=$1 AND account_id=$2 AND owner=$3',
          [current.source, current.account_id, current.owner],
        )
      ).rows[0];
      const scoped: Database = {
        query: (sql, params) => tx.query(sql, params),
        transaction: (action) => action(tx),
        close: async () => {},
      };
      const categories = new Categories(scoped);
      const nodes = await categories.listNodes();
      const rules = await categories.suggest(
        row.owner as Owner,
        String(row.id),
      );
      const explicitReview = await tx.query(
        "SELECT 1 FROM transaction_explanations WHERE transaction_id=$1 AND revision=$2 AND status='pending' LIMIT 1",
        [row.id, current.revision],
      );
      const protectedDecision =
        current.source === 'manual_cash' ||
        explicitReview.rows.length > 0 ||
        (await tx.query(humanSql, [row.id])).rows.length > 0 ||
        ['business', 'investment'].includes(String(account?.purpose)) ||
        rules.ambiguous ||
        rules.rules.length > 0;
      // A parent is not assignable, and the catch-all says nothing worth
      // applying automatically, so neither is a category worth acting on.
      const proposedNode = nodes.find(
        (n) => n.assignable && n.path === proposal?.category,
      );
      const validCategory =
        proposal?.kind === 'personal_expense' &&
        proposedNode !== undefined &&
        proposedNode.name.toLowerCase() !== UNSPECIFIED.toLowerCase();
      const apply =
        !protectedDecision &&
        validCategory &&
        sufficientAutomaticConfidence(
          // A linked receipt can establish category before bank settlement; reporting still uses actual status.
          { ...current, status: 'booked', account_purpose: account?.purpose },
          { ...proposal!, source: 'model' },
        ) &&
        evidence.receipts.length === 1 &&
        !evidence.receipts[0]!.truncated &&
        !readMcc(current.source_details as Record<string, unknown>)
          ?.financialTransfer &&
        ['unresolved', 'personal_expense'].includes(String(current.kind)) &&
        ['booked', 'pending'].includes(String(current.status)) &&
        BigInt(String(current.amount_minor)) < 0n;
      let revision = Number(current.revision);
      if (apply) {
        await tx.query(
          `UPDATE transactions SET kind=$1,category_id=$2,provisional=false,
             classification_source='model',revision=revision+1,updated_at=now()
           WHERE id=$3`,
          [proposal!.kind, proposedNode!.id, row.id],
        );
        revision++;
        await tx.query(
          `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
          VALUES($1,$2,'receipt_categorization','auto_classified',$3,$4,'Category supported by attached receipt evidence')`,
          [
            randomUUID(),
            row.id,
            JSON.stringify({
              kind: current.kind,
              category: current.category,
              revision: current.revision,
            }),
            JSON.stringify({
              kind: proposal!.kind,
              category: proposal!.category,
              revision,
              provenance: {
                policy,
                inputRevision: row.revision,
                receiptEvidenceKey: evidence.key,
                proposalId,
                decision: { ...proposal, source: 'receipt_model' },
              },
            }),
          ],
        );
      }
      if (!apply && !protectedDecision && current.kind === 'unresolved') {
        const question =
          proposal?.explanation ??
          'The attached receipt does not identify a clear spending category. What was this purchase for?';
        await tx.query(
          `INSERT INTO transaction_triage(transaction_id,revision,owner,state,decision,question)
          VALUES($1,$2,$3,'ready',$4,$5) ON CONFLICT(transaction_id,revision) DO UPDATE
          SET state='ready',decision=excluded.decision,question=excluded.question,lease_until=NULL
          WHERE transaction_triage.state<>'processing'`,
          [
            row.id,
            row.revision,
            row.owner,
            JSON.stringify({
              ...proposal,
              kind: proposal?.kind ?? 'unresolved',
              category: proposal?.category ?? null,
              confidence: proposal?.confidence ?? 0,
              explanation: question,
              source: 'receipt_model',
            }),
            question,
          ],
        );
      }
      await tx.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,after_value,reason)
        VALUES($1,$2,'receipt_categorization','receipt_categorization_checked',$3,$4)`,
        [
          randomUUID(),
          row.id,
          JSON.stringify({
            policy,
            key: evidence.key,
            revision,
            proposalId: proposalId ?? null,
            outcome: apply
              ? 'applied'
              : protectedDecision
                ? 'protected'
                : 'needs_review',
          }),
          apply
            ? 'Receipt category applied'
            : protectedDecision
              ? 'Preserved owner decision, rule or account policy'
              : 'Receipt evidence was insufficient for an automatic category; review the receipt and category',
        ],
      );
    });
    return true;
  }
}
