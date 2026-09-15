import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import type { Owner } from './domain.js';
import type { Classifier, ClassificationResult } from './classifier.js';
import { Conflict, Repository } from './repository.js';
import type { Kind } from './domain.js';
export async function initializePaymentExplanations(tx: Executor) {
  await tx.query(`CREATE TABLE IF NOT EXISTS transaction_explanations (
 id uuid PRIMARY KEY, owner text NOT NULL CHECK(owner IN ('rodion','katya')),
 request_id uuid NOT NULL,transaction_id uuid NOT NULL REFERENCES transactions(id), revision integer NOT NULL CHECK(revision>=0),
 input_text text NOT NULL CHECK(length(input_text)>0 AND length(input_text)<=2000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
 workflow_state text NOT NULL DEFAULT 'processing' CHECK(workflow_state IN ('processing','ready','disabled','budget_exhausted','failed','stale','confirmed')),
 proposal_id uuid REFERENCES classifier_proposals(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner,request_id))`);
}
function actorCheck(actor: Owner) {
  if (actor !== 'rodion' && actor !== 'katya') throw new Error('invalid_owner');
}
function uuid(value: string) {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
  )
    throw new Error('invalid_explanation_id');
  return value.toLowerCase();
}
export class PaymentExplanations {
  constructor(readonly db: Database) {}
  async saveAndPropose(
    actor: Owner,
    input: {
      transactionId: string;
      revision: number;
      text: string;
      requestId: string;
    },
    classifier?: Pick<Classifier, 'propose'>,
  ): Promise<Row> {
    actorCheck(actor);
    const transactionId = uuid(input.transactionId),
      requestId = uuid(input.requestId);
    if (
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 2000
    )
      throw new Error('invalid_explanation');
    const text = input.text.trim();
    const saved = await this.db.transaction(async (tx) => {
      const prior = (
        await tx.query(
          'SELECT * FROM transaction_explanations WHERE owner=$1 AND request_id=$2',
          [actor, requestId],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.transaction_id !== transactionId ||
          Number(prior.revision) !== input.revision ||
          prior.input_text !== text
        )
          throw new Conflict('explanation_request_reused');
        return { row: prior, created: false };
      }
      const transaction = (
        await tx.query(
          'SELECT owner,revision FROM transactions WHERE id=$1 FOR UPDATE',
          [transactionId],
        )
      ).rows[0];
      if (!transaction || transaction.owner !== actor)
        throw new Error('not_found');
      if (Number(transaction.revision) !== input.revision)
        throw new Conflict('stale_revision');
      const inserted = (
        await tx.query(
          `INSERT INTO transaction_explanations(id,owner,request_id,transaction_id,revision,input_text)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner,request_id) DO NOTHING RETURNING *`,
          [randomUUID(), actor, requestId, transactionId, input.revision, text],
        )
      ).rows[0];
      if (inserted) return { row: inserted, created: true };
      const existing = (
        await tx.query(
          'SELECT * FROM transaction_explanations WHERE owner=$1 AND request_id=$2',
          [actor, requestId],
        )
      ).rows[0]!;
      if (
        existing.transaction_id !== transactionId ||
        Number(existing.revision) !== input.revision ||
        existing.input_text !== text
      )
        throw new Conflict('explanation_request_reused');
      return { row: existing, created: false };
    });
    if (saved.created) {
      let result: ClassificationResult = { status: 'disabled' };
      try {
        if (classifier)
          result = await classifier.propose(
            transactionId,
            input.revision,
            actor,
            text,
            'app:' + saved.row.id,
          );
      } catch {
        result = { status: 'failed' };
      }
      const proposalId = result.status === 'proposed' ? result.id : null;
      const state =
        result.status === 'proposed'
          ? 'ready'
          : result.status === 'already_requested'
            ? 'processing'
            : result.status;
      await this.db.query(
        "UPDATE transaction_explanations SET workflow_state=$1,proposal_id=$2 WHERE id=$3 AND status='pending'",
        [state, proposalId, saved.row.id],
      );
    }
    return (await this.list(actor, transactionId)).find(
      (row) => row.id === saved.row.id,
    )!;
  }
  async confirm(
    actor: Owner,
    input: {
      explanationId: string;
      transactionId: string;
      revision: number;
      kind: Kind;
      category: string | null;
      reason: string;
    },
  ): Promise<void> {
    actorCheck(actor);
    const explanationId = uuid(input.explanationId),
      transactionId = uuid(input.transactionId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0)
      throw new Error('invalid_revision');
    await this.db.transaction(async (tx) => {
      const explanation = (
        await tx.query(
          'SELECT * FROM transaction_explanations WHERE id=$1 AND owner=$2 FOR UPDATE',
          [explanationId, actor],
        )
      ).rows[0];
      if (!explanation || explanation.transaction_id !== transactionId)
        throw new Error('not_found');
      if (
        Number(explanation.revision) !== input.revision ||
        explanation.status !== 'pending'
      )
        throw new Conflict('stale_revision');
      const scoped: Database = {
        query: (sql, params) => tx.query(sql, params),
        transaction: (action) => action(tx),
        close: async () => {},
      };
      await new Repository(scoped).classify(
        transactionId,
        input.revision,
        { kind: input.kind, category: input.category, reason: input.reason },
        actor,
      );
      await tx.query(
        "UPDATE transaction_explanations SET status='confirmed',workflow_state='confirmed' WHERE id=$1",
        [explanationId],
      );
    });
  }
  async list(actor: Owner, transactionId?: string): Promise<Row[]> {
    actorCheck(actor);
    if (transactionId !== undefined) transactionId = uuid(transactionId);
    return (
      await this.db.query(
        `SELECT e.id,e.owner,e.input_text,e.status,e.created_at,e.transaction_id,e.revision,
    CASE WHEN e.status='confirmed' THEN 'confirmed' WHEN t.revision<>e.revision THEN 'stale' WHEN p.state='proposed' THEN 'ready' WHEN p.state IN ('failed','stale') THEN p.state ELSE e.workflow_state END AS workflow_state,
    'app' AS source,t.description AS transaction_description,p.id AS proposal_id,p.proposal,
    e.request_id FROM transaction_explanations e JOIN transactions t ON t.id=e.transaction_id AND t.owner=e.owner
    LEFT JOIN classifier_proposals p ON p.transaction_id=e.transaction_id AND p.owner=e.owner AND p.revision=e.revision AND p.request_key='app:'||e.id::text
    WHERE e.owner=$1 AND ($2::uuid IS NULL OR e.transaction_id=$2) ORDER BY e.created_at DESC,e.id`,
        [actor, transactionId ?? null],
      )
    ).rows;
  }
}
