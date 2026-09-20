import { readMcc } from './mcc.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database, Executor, Row } from './database.js';
import type { Owner } from './domain.js';
import type { Classifier, ClassificationProposal } from './classifier.js';
import { Categories, categoryPath, listCategoryTree } from './categories.js';
import { inspectTransactionSignals } from './transaction-signals.js';
import {
  matchHistoricalKnowledge,
  validateHistoricalKnowledge,
  type HistoricalKnowledge,
} from './historical-knowledge.js';

/**
 * The leaf the automatic write refuses. A catch-all is where a payment rests
 * when nothing could place it, so it is a placement and never a decision, and
 * the same test has to answer for both halves of `finish`: the state it stores
 * and the classification it writes. They used to be two copies of this
 * expression, and while only the write knew about it a payment could come out
 * `ready` — decided, nothing to ask — with nothing written and no question
 * queued, because the question lane only ever sees `ready` rows that carry
 * their own question text. An owner-confirmed rule that had lost its category
 * to the tree migration landed exactly there and went silent.
 */
function unspecified(category: string | null | undefined): boolean {
  return category?.split(' / ').at(-1)?.toLowerCase() === 'unspecified';
}

export type TriageDecision = ClassificationProposal & {
  source:
    | 'confirmed_rule'
    | 'phone_signal'
    | 'model'
    | 'historical_evidence'
    | 'model_cache'
    | 'receipt_model';
  automaticReviewPolicy?: string;
  proposalId?: string;
  originalAuditId?: string;
  rules?: { id: string; version: number }[];
  evidence?: { id: string; sourceReference: string }[];
};
export type TriageClassifierFactory = (
  owner: Owner,
) =>
  | Pick<Classifier, 'propose'>
  | undefined
  | Promise<Pick<Classifier, 'propose'> | undefined>;

export async function initializeTransactionTriage(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS transaction_triage (
    transaction_id uuid NOT NULL REFERENCES transactions(id), revision integer NOT NULL CHECK(revision>=0),
    owner text NOT NULL CHECK(owner IN ('rodion','katya')),
    state text NOT NULL CHECK(state IN ('processing','ready','deferred','uncertain')),
    decision jsonb, question text, lease_until timestamptz, retry_after timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(transaction_id,revision)
  )`);
}

const reusableConsumerMcc = new Set([
  4814, 5411, 5499, 5812, 5814, 5995, 5942, 7997, 5541, 4121,
]);
function cacheSignature(row: Row) {
  return {
    owner: row.owner,
    source: row.source,
    accountId: row.account_id,
    description: row.description,
    mcc:
      readMcc(row.source_details as Record<string, unknown> | undefined)
        ?.code ?? null,
    accountPurpose: row.account_purpose ?? 'unreviewed',
  };
}

const automaticReviewPolicy = 'confirmed_rules_and_clear_expenses:v4';
function hasContradictorySignals(row: Row): boolean {
  if (
    readMcc(row.source_details as Record<string, unknown> | undefined)
      ?.financialTransfer
  )
    return true;
  const signals = inspectTransactionSignals({
    description: String(row.description),
    amountMinor: String(row.amount_minor),
    status: String(row.status),
    sourceDetails: (row.source_details ?? {}) as Record<string, unknown>,
  });
  if (signals.uncertainty && signals.uncertainty !== 'no_explicit_phone_top_up')
    return true;
  const words = String(row.description)
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  if (
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
      ].includes(word),
    )
  )
    return true;

  return false;
}
function hasSupportedConsumerEvidence(row: Row): boolean {
  const signature = cacheSignature(row);
  return (
    !hasContradictorySignals(row) &&
    typeof signature.mcc === 'number' &&
    reusableConsumerMcc.has(signature.mcc) &&
    signature.accountPurpose !== 'business' &&
    signature.accountPurpose !== 'investment'
  );
}
function hasBroadCategoryCorroboration(
  row: Row,
  category: string | null,
): boolean {
  const mcc = cacheSignature(row).mcc;
  return (
    (category === 'Food / Groceries' && (mcc === 5411 || mcc === 5499)) ||
    (category === 'Food / Restaurants / Dining in' &&
      (mcc === 5812 || mcc === 5814)) ||
    (category === 'Pets' && mcc === 5995)
  );
}
export function sufficientAutomaticConfidence(
  row: Row,
  decision: TriageDecision,
): boolean {
  if (
    (decision.source === 'model' || decision.source === 'model_cache') &&
    (hasContradictorySignals(row) ||
      (cacheSignature(row).mcc === 5734 &&
        /^Transport(?: \/ |$)/.test(decision.category ?? '')) ||
      (cacheSignature(row).mcc === 5818 &&
        /(?:AI tools|Code tools|Coding tools)/i.test(decision.category ?? '')))
  )
    return false;
  return (
    decision.confidence >= 0.95 ||
    (decision.confidence >= 0.9 &&
      hasSupportedConsumerEvidence(row) &&
      (![5499, 5995].includes(Number(cacheSignature(row).mcc)) ||
        hasBroadCategoryCorroboration(row, decision.category))) ||
    ((decision.source === 'model' || decision.source === 'model_cache') &&
      decision.kind === 'personal_expense' &&
      decision.confidence >= 0.7 &&
      hasBroadCategoryCorroboration(row, decision.category) &&
      hasSupportedConsumerEvidence(row))
  );
}

/**
 * The question to put to the member, or nothing when the decision speaks for
 * itself.
 *
 * Nothing is earned only by a decision the automatic write will actually take.
 * This used to keep its own confidence number, 0.9, while the write kept
 * another, 0.95 unless the merchant code corroborates it — so a model decision
 * between the two, or one at any confidence that the write refuses for a
 * contradictory signal, came out `ready` with no question text and nothing
 * written. The question lane cannot see such a row, and the payment was neither
 * classified nor asked about. Consulting the write's own test removes the
 * disagreement; the 0.9 floor stays, so this only ever adds a question and
 * never takes one away.
 */
function questionFor(row: Row, decision: TriageDecision): string | null {
  if (
    decision.source === 'confirmed_rule' ||
    (decision.kind === 'personal_expense' &&
      decision.confidence >= 0.9 &&
      sufficientAutomaticConfidence(row, decision))
  )
    return null;
  if (decision.kind === 'personal_expense')
    return `This looks like ${decision.category}. Is that the correct category, or was it for something else?`;
  if (decision.kind === 'internal_transfer')
    return 'Was this a transfer to another account you own, or a payment to someone else?';
  if (decision.kind === 'investment')
    return 'Was this money moved into an investment, or an ordinary purchase?';
  if (decision.kind === 'non_personal')
    return 'Was this for business or someone else, rather than your personal spending?';
  return decision.explanation
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 800);
}

/** Analyze before asking; automatic personal expenses require explicit runtime opt-in. */
export class TransactionTriage {
  private readonly historicalKnowledge?: HistoricalKnowledge;
  constructor(
    readonly db: Database,
    readonly classifierFor: TriageClassifierFactory,
    historicalKnowledge?: HistoricalKnowledge,
    readonly options: {
      autoCategorizeClearExpenses?: boolean;
      notBefore?: string;
    } = {},
  ) {
    if (options.notBefore && !Number.isFinite(Date.parse(options.notBefore)))
      throw new Error('invalid_triage_cutoff');
    if (historicalKnowledge)
      this.historicalKnowledge =
        validateHistoricalKnowledge(historicalKnowledge);
  }

  async processOne(): Promise<boolean> {
    const row = await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482410)');
      // A crashed request may already have cost money. Never blindly repeat it.
      await tx.query(
        "UPDATE transaction_triage SET state='uncertain',lease_until=NULL WHERE state='processing' AND lease_until<=now()",
      );
      const current = (
        await tx.query(
          `SELECT t.*, q.decision AS previous_decision, a.purpose AS account_purpose FROM transactions t
        LEFT JOIN own_accounts a ON a.source=t.source AND a.account_id=t.account_id AND a.owner=t.owner
        LEFT JOIN transaction_triage q ON q.transaction_id=t.id AND q.revision=t.revision
        WHERE t.source<>'manual_cash' AND NOT EXISTS(SELECT 1 FROM transaction_explanations e WHERE e.transaction_id=t.id AND e.revision=t.revision AND e.status='pending') AND (t.kind='unresolved' OR t.provisional) AND (t.status='booked' OR (t.status='pending' AND t.amount_minor<0)) AND ($3::timestamptz IS NULL OR t.booked_at >= $3)
        AND (NOT EXISTS(SELECT 1 FROM receipt_jobs r WHERE r.transaction_id=t.id AND r.state='matched')
          OR EXISTS(SELECT 1 FROM classification_rules rr WHERE rr.owner=t.owner AND rr.active=true
            AND rule_matches(rr.match_field, rr.match_value, t.description, t.source_details->>'counterpartyIdentifier')))
        AND (t.amount_minor<0 OR ($1=true AND t.amount_minor>0 AND EXISTS (
          SELECT 1 FROM classification_rules incoming_rule WHERE incoming_rule.owner=t.owner AND incoming_rule.active=true
          AND incoming_rule.kind IN ('investment','internal_transfer','non_personal')
          AND rule_matches(incoming_rule.match_field, incoming_rule.match_value, t.description, t.source_details->>'counterpartyIdentifier'))))
        AND (a.purpose IS NULL OR a.purpose NOT IN ('business','investment'))
        AND NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.transaction_id=t.id AND e.event IN ('classified','refund_linked','refund_unlinked'))
        AND (q.transaction_id IS NULL OR (q.state='deferred' AND q.retry_after<=now())
        OR ($1=true AND q.state IN ('ready','uncertain','deferred') AND EXISTS (
          SELECT 1 FROM classification_rules r WHERE r.owner=t.owner AND r.active=true
          AND rule_matches(r.match_field, r.match_value, t.description, t.source_details->>'counterpartyIdentifier')
          AND (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(q.decision->'rules','[]'::jsonb)) seen
            WHERE seen->>'id'=r.id::text AND (seen->>'version')::integer=r.version)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(q.decision->'rules','[]'::jsonb)) seen
              WHERE NOT EXISTS (SELECT 1 FROM classification_rules previous_rule
                WHERE previous_rule.id::text=seen->>'id' AND previous_rule.version=(seen->>'version')::integer
                AND previous_rule.owner=t.owner AND previous_rule.active=true
                AND rule_matches(previous_rule.match_field, previous_rule.match_value, t.description, t.source_details->>'counterpartyIdentifier'))))))
        OR ($1=true AND q.state='ready' AND q.decision->>'kind'='personal_expense'
        AND ((q.decision->>'confidence')::numeric>=0.90 OR
          ((q.decision->>'confidence')::numeric>=0.70 AND (
            (q.decision->>'category'='Food / Restaurants / Dining in' AND COALESCE(t.source_details->>'mcc',t.source_details->>'merchant_category_code') IN ('5812','5814')) OR
            (q.decision->>'category'='Food / Groceries' AND COALESCE(t.source_details->>'mcc',t.source_details->>'merchant_category_code') IN ('5411','5499')) OR
            (q.decision->>'category'='Pets' AND COALESCE(t.source_details->>'mcc',t.source_details->>'merchant_category_code')='5995'))))
        AND q.decision->>'automaticReviewPolicy' IS DISTINCT FROM $2
        AND lower(q.decision->>'category')<>'unspecified' AND lower(q.decision->>'category') NOT LIKE '% / unspecified'
        AND q.decision->>'source' IN ('model','model_cache','phone_signal','confirmed_rule')
        AND (a.purpose IS NULL OR a.purpose NOT IN ('business','investment'))))
        ORDER BY t.booked_at DESC,t.id LIMIT 1 FOR UPDATE OF t`,
          [
            this.options.autoCategorizeClearExpenses === true,
            automaticReviewPolicy,
            this.options.notBefore ?? null,
          ],
        )
      ).rows[0];
      if (!current) return undefined;
      await tx.query(
        `INSERT INTO transaction_triage(transaction_id,revision,owner,state,lease_until)
        VALUES($1,$2,$3,'processing',now()+interval '2 minutes')
        ON CONFLICT(transaction_id,revision) DO UPDATE SET state='processing',lease_until=excluded.lease_until,retry_after=NULL`,
        [current.id, current.revision, current.owner],
      );
      return current;
    });
    if (!row) return false;
    try {
      const owner = row.owner as Owner;
      const categories = new Categories(this.db);
      const nodes = await categories.listNodes();
      const rules = await categories.suggest(owner, String(row.id));
      let decision: TriageDecision | undefined;
      let question: string | null | undefined;
      if (!rules.ambiguous && rules.rules.length) {
        const rule = rules.rules[0]!;
        const path = rule.categoryId
          ? categoryPath(nodes, rule.categoryId)
          : null;
        if (rule.kind !== 'personal_expense' || path)
          decision = {
            kind: rule.kind,
            category: path,
            confidence: 1,
            explanation: 'Matches an explicit owner-confirmed rule.',
            source: 'confirmed_rule',
            rules: rules.rules.map(({ id, version }) => ({ id, version })),
          };
      }
      if (rules.ambiguous) {
        decision = {
          kind: 'unresolved',
          category: null,
          confidence: 0,
          explanation: 'Multiple confirmed rules disagree for this payment.',
          source: 'confirmed_rule',
          rules: rules.rules.map(({ id, version }) => ({ id, version })),
        };
        question =
          'Your saved rules disagree for this payment. Which category or payment type should apply?';
      }
      if (!decision && this.historicalKnowledge) {
        const evidence = matchHistoricalKnowledge(this.historicalKnowledge, {
          source: String(row.source),
          accountId: String(row.account_id),
          owner,
          description: String(row.description),
          currency: String(row.currency),
          amountMinor: String(row.amount_minor),
          bookedAt: new Date(String(row.booked_at)).toISOString(),
        });
        if (evidence.length) {
          const kinds = new Set(evidence.map((e) => e.proposedKind));
          const kind =
            kinds.size === 1 ? evidence[0]!.proposedKind : 'unresolved';
          decision = {
            kind,
            category: null,
            confidence: kind === 'unresolved' ? 0 : 1,
            source: 'historical_evidence',
            explanation:
              kinds.size > 1
                ? 'Your historical explanations disagree for this payment.'
                : evidence
                    .map((e) => e.statement)
                    .join(' ')
                    .slice(0, 1000),
            evidence: evidence.map((e) => ({
              id: e.id,
              sourceReference: e.sourceReference,
            })),
          };
          question =
            kind === 'unresolved'
              ? 'Historical evidence does not resolve this payment. Which payment type should apply?'
              : null;
        }
      }
      // Stored model proposals cannot outrank newly confirmed rules or historical evidence.
      if (!decision && row.previous_decision)
        decision = row.previous_decision as TriageDecision;
      const signals = inspectTransactionSignals({
        description: String(row.description),
        amountMinor: String(row.amount_minor),
        status: String(row.status),
        sourceDetails: (row.source_details ?? {}) as Record<string, unknown>,
      });
      if (!decision && signals.clearPhoneTopUp) {
        const mobile = nodes.filter(
          (n) => n.assignable && n.name === 'Mobile phone',
        );
        const path = mobile.length === 1 ? mobile[0]!.path : null;
        if (
          row.account_purpose === 'business' ||
          row.account_purpose === 'investment'
        ) {
          decision = {
            kind: 'unresolved',
            category: null,
            confidence: 0,
            explanation:
              'Explicit mobile-phone top-up on a business or investment account.',
            source: 'phone_signal',
          };
          question =
            'This is a mobile-phone top-up. Was it for your personal phone or for business?';
        } else if (path) {
          decision = {
            kind: 'personal_expense',
            category: path,
            confidence: 1,
            explanation:
              'The bank description explicitly identifies a mobile-phone top-up.',
            source: 'phone_signal',
          };
        }
      }
      if (!decision && this.options.autoCategorizeClearExpenses)
        decision = await this.cachedDecision(row, nodes);
      if (!decision) {
        const classifier = await this.classifierFor(owner);
        const result = classifier
          ? await classifier.propose(
              String(row.id),
              Number(row.revision),
              owner,
              '',
              'triage:v2',
            )
          : { status: 'disabled' };
        if (result.status === 'proposed' && 'proposal' in result)
          decision = {
            ...result.proposal,
            source: 'model',
            proposalId: result.id,
          };
        else if (result.status === 'already_requested') {
          const existing = (
            await this.db.query(
              "SELECT id,proposal FROM classifier_proposals WHERE transaction_id=$1 AND revision=$2 AND request_key='triage:v2' AND state='proposed'",
              [row.id, row.revision],
            )
          ).rows[0];
          if (existing?.proposal)
            decision = {
              ...(existing.proposal as ClassificationProposal),
              proposalId: String(existing.id),
              source: 'model',
            };
          else {
            await this.finish(row, 'uncertain');
            return true;
          }
        } else {
          await this.finish(
            row,
            result.status === 'disabled' || result.status === 'budget_exhausted'
              ? 'deferred'
              : 'uncertain',
          );
          return true;
        }
      }
      // A reused proposal may refer to a category renamed since its request.
      const currentNodes = await categories.listNodes();
      if (
        decision.kind === 'personal_expense' &&
        !currentNodes.some((n) => n.assignable && n.path === decision.category)
      ) {
        await this.finish(row, 'uncertain');
        return true;
      }
      await this.finish(
        row,
        'ready',
        decision,
        question === undefined ? questionFor(row, decision) : question,
      );
    } catch {
      // No provider or financial text belongs in worker logs. Inspection failure is visible and bounded.
      await this.finish(row, 'uncertain');
    }
    return true;
  }

  private async cachedDecision(
    row: Row,
    nodes: Awaited<ReturnType<Categories['listNodes']>>,
    tx: Executor = this.db,
  ): Promise<TriageDecision | undefined> {
    const signature = cacheSignature(row);
    if (!hasSupportedConsumerEvidence(row)) return undefined;
    // Reuse only original paid model decisions still current, never cache chains.
    const candidates = (
      await tx.query(
        `SELECT a.id,a.after_value FROM audit_events a
      JOIN transactions t ON t.id=a.transaction_id
      WHERE a.event='auto_classified' AND t.owner=$1 AND t.source=$2 AND t.account_id=$3 AND t.description=$4
      AND t.kind='personal_expense' AND t.status='booked' AND t.amount_minor<0
      AND NOT EXISTS(SELECT 1 FROM own_accounts a WHERE a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id AND a.purpose IN ('business','investment'))
      AND (a.after_value->>'revision')::integer=t.revision
      AND a.after_value->'provenance'->'decision'->>'source'='model'
      ORDER BY a.created_at DESC,a.id LIMIT 21 FOR SHARE OF t`,
        [row.owner, row.source, row.account_id, row.description],
      )
    ).rows;
    if (candidates.length > 20) return undefined;
    const eligible = candidates.filter((c) => {
      const after = c.after_value as {
        provenance?: { signature?: unknown; decision?: TriageDecision };
      };
      const decision = after.provenance?.decision;
      return (
        isDeepStrictEqual(after.provenance?.signature, signature) &&
        decision?.kind === 'personal_expense' &&
        decision.confidence >= 0.9 &&
        decision.category?.split(' / ').at(-1)?.toLowerCase() !==
          'unspecified' &&
        nodes.some((n) => n.assignable && n.path === decision.category)
      );
    });
    if (!eligible.length) return undefined;
    const decisions = eligible.map(
      (c) =>
        (c.after_value as { provenance: { decision: TriageDecision } })
          .provenance.decision,
    );
    if (new Set(decisions.map((d) => d.category)).size !== 1) return undefined;
    const decision = decisions[0]!;
    // Any owner correction for the same exact bank signature blocks disagreement.
    const conflicting = await tx.query(
      `SELECT 1 FROM transactions t JOIN audit_events a ON a.transaction_id=t.id
      WHERE t.owner=$1 AND t.source=$2 AND t.account_id=$3 AND t.description=$4
      AND COALESCE(t.source_details->>'mcc',t.source_details->>'merchant_category_code')=$5 AND a.event='classified'
      AND NOT EXISTS(SELECT 1 FROM audit_events r WHERE r.transaction_id=t.id AND r.event='refund_linked')
      AND (a.after_value->>'kind'<>'personal_expense' OR a.after_value->>'category' IS DISTINCT FROM $6) LIMIT 1`,
      [
        row.owner,
        row.source,
        row.account_id,
        row.description,
        String(signature.mcc),
        decision.category,
      ],
    );
    if (conflicting.rows.length) return undefined;
    return {
      ...decision,
      source: 'model_cache',
      originalAuditId: String(eligible[0]!.id),
      explanation:
        'Reuses a current high-confidence model decision for the same exact account, payment description, consumer MCC and account purpose.',
    };
  }

  private async finish(
    row: Row,
    state: 'ready' | 'deferred' | 'uncertain',
    decision?: TriageDecision,
    question: string | null = null,
  ) {
    await this.db.transaction(async (tx) => {
      // Account edits use 7482393; keep purpose stable through the automatic write.
      await tx.query('SELECT pg_advisory_xact_lock(7482393)');
      await tx.query('SELECT pg_advisory_xact_lock(7482394)');
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0];
      const fresh =
        current &&
        current.owner === row.owner &&
        Number(current.revision) === Number(row.revision) &&
        current.kind === 'unresolved';
      const human = await tx.query(
        "SELECT 1 FROM audit_events WHERE transaction_id=$1 AND event IN ('classified','refund_linked','refund_unlinked') LIMIT 1",
        [row.id],
      );
      const explicitReview = await tx.query(
        "SELECT 1 FROM transaction_explanations WHERE transaction_id=$1 AND revision=$2 AND status='pending' LIMIT 1",
        [row.id, row.revision],
      );
      if (
        !fresh ||
        human.rows.length ||
        explicitReview.rows.length ||
        current?.source === 'manual_cash'
      )
        state = 'uncertain';
      if (
        decision?.source !== 'confirmed_rule' &&
        (
          await tx.query(
            "SELECT 1 FROM receipt_jobs WHERE transaction_id=$1 AND state='matched' LIMIT 1",
            [row.id],
          )
        ).rows.length
      )
        state = 'uncertain';
      const nodes = await listCategoryTree(tx);
      if (
        decision?.kind === 'personal_expense' &&
        !nodes.some((n) => n.assignable && n.path === decision!.category)
      )
        state = 'uncertain';
      // `ready` has to mean the decision was written. A category the write
      // below refuses is not one, so it becomes a question instead of a
      // silence.
      if (unspecified(decision?.category)) state = 'uncertain';
      if (
        state === 'ready' &&
        decision &&
        (decision.kind === 'personal_expense' ||
          decision.source === 'confirmed_rule')
      ) {
        const scoped: Database = {
          query: (sql, params) => tx.query(sql, params),
          transaction: (action) => action(tx),
          close: async () => {},
        };
        const matches = await new Categories(scoped).suggest(
          row.owner as Owner,
          String(row.id),
        );
        if (
          matches.ambiguous ||
          (decision.source === 'confirmed_rule' && !matches.rules.length) ||
          matches.rules.some(
            (rule) =>
              rule.kind !== decision!.kind ||
              (rule.categoryId
                ? categoryPath(nodes, rule.categoryId)
                : null) !== decision!.category ||
              (decision!.source === 'confirmed_rule' &&
                !decision!.rules?.some(
                  (saved) =>
                    saved.id === rule.id && saved.version === rule.version,
                )),
          )
        )
          state = 'uncertain';
        else
          decision = {
            ...decision,
            rules: matches.rules.map(({ id, version }) => ({ id, version })),
          };
      }
      if (
        state === 'ready' &&
        decision &&
        this.options.autoCategorizeClearExpenses
      )
        decision = { ...decision, automaticReviewPolicy };
      const finished = await tx.query(
        `UPDATE transaction_triage SET state=$3,decision=$4,question=$5,lease_until=NULL,
        retry_after=CASE WHEN $3='deferred' THEN now()+interval '1 hour' ELSE NULL END
        WHERE transaction_id=$1 AND revision=$2 AND state='processing' RETURNING transaction_id`,
        [
          row.id,
          row.revision,
          state,
          decision ? JSON.stringify(decision) : null,
          question,
        ],
      );
      if (
        !finished.rows.length ||
        state !== 'ready' ||
        !decision ||
        !this.options.autoCategorizeClearExpenses ||
        !(
          decision.kind === 'personal_expense' ||
          (decision.source === 'confirmed_rule' &&
            ['investment', 'internal_transfer', 'non_personal'].includes(
              decision.kind,
            ))
        ) ||
        !sufficientAutomaticConfidence(row, decision) ||
        unspecified(decision.category) ||
        !['model', 'model_cache', 'phone_signal', 'confirmed_rule'].includes(
          decision.source,
        ) ||
        !['booked', 'pending'].includes(String(current!.status)) ||
        (current!.status === 'pending' &&
          BigInt(String(current!.amount_minor)) >= 0n) ||
        (BigInt(String(current!.amount_minor)) >= 0n &&
          !(
            BigInt(String(current!.amount_minor)) > 0n &&
            decision.source === 'confirmed_rule' &&
            ['investment', 'internal_transfer', 'non_personal'].includes(
              decision.kind,
            )
          ))
      )
        return;
      const account = (
        await tx.query(
          'SELECT purpose FROM own_accounts WHERE source=$1 AND account_id=$2 AND owner=$3',
          [current!.source, current!.account_id, row.owner],
        )
      ).rows[0];
      if (account?.purpose === 'business' || account?.purpose === 'investment')
        return;
      if (
        (account?.purpose ?? 'unreviewed') !==
        (row.account_purpose ?? 'unreviewed')
      )
        return;
      if (decision.source === 'model_cache') {
        const stillValid = await this.cachedDecision(row, nodes, tx);
        if (
          !stillValid ||
          stillValid.originalAuditId !== decision.originalAuditId ||
          stillValid.category !== decision.category
        ) {
          await tx.query(
            "UPDATE transaction_triage SET state='uncertain' WHERE transaction_id=$1 AND revision=$2",
            [row.id, row.revision],
          );
          return;
        }
      }
      await tx.query(
        `UPDATE transactions SET kind=$1,category_id=$2,provisional=false,
           classification_source=CASE WHEN $4::text='confirmed_rule' THEN 'rule' ELSE 'model' END,
           revision=revision+1,updated_at=now() WHERE id=$3`,
        [
          decision.kind,
          nodes.find((n) => n.assignable && n.path === decision!.category)
            ?.id ?? null,
          row.id,
          decision.source,
        ],
      );
      await tx.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
        VALUES($1,$2,'transaction_triage','auto_classified',$3,$4,$5)`,
        [
          randomUUID(),
          row.id,
          JSON.stringify({
            kind: current!.kind,
            category: current!.category,
            revision: current!.revision,
          }),
          JSON.stringify({
            kind: decision.kind,
            category: decision.category,
            revision: Number(row.revision) + 1,
            provenance: {
              policy: automaticReviewPolicy,
              signature: cacheSignature(row),
              inputRevision: Number(row.revision),
              decision,
            },
          }),
          decision.source === 'confirmed_rule'
            ? 'Applied an explicit owner-confirmed classification rule.'
            : 'Owner-enabled automatic categorization of a clear personal expense.',
        ],
      );
    });
  }

  async list(owner: Owner): Promise<Row[]> {
    if (owner !== 'rodion' && owner !== 'katya')
      throw new Error('invalid_owner');
    return (
      await this.db.query(
        `SELECT q.transaction_id,q.revision,q.state,q.decision,q.question
      FROM transaction_triage q JOIN transactions t ON t.id=q.transaction_id AND t.revision=q.revision
      WHERE q.owner=$1 AND (t.kind='unresolved' OR t.provisional)
      AND NOT EXISTS(SELECT 1 FROM own_accounts a WHERE a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id AND a.purpose IN ('business','investment'))
      AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event IN ('classified','refund_linked','refund_unlinked'))
      ORDER BY q.created_at DESC,q.transaction_id`,
        [owner],
      )
    ).rows;
  }
}
