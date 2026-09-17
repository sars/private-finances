import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import type { Owner } from './domain.js';
import { Conflict } from './repository.js';

export type SpendingPattern = 'routine' | 'exceptional' | 'unreviewed';
export type SpendingPatternAnnotation = {
  transactionId: string;
  owner: Owner;
  pattern: SpendingPattern;
  /** Annotation revision; independent of the transaction revision. Zero means absent. */
  revision: number;
  /** Transaction revision reviewed by the owner, preserved across source corrections. */
  sourceRevision: number | null;
  currentTransactionRevision: number;
  explicit: boolean;
  needsReview: boolean;
  reason: string | null;
  updatedAt: string | null;
};

export async function initializeSpendingPatterns(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS spending_patterns (
    transaction_id uuid PRIMARY KEY REFERENCES transactions(id),
    owner text NOT NULL CHECK(owner IN ('rodion','katya')),
    pattern text NOT NULL CHECK(pattern IN ('routine','exceptional','unreviewed')),
    revision integer NOT NULL CHECK(revision>0),
    source_revision integer NOT NULL CHECK(source_revision>=0),
    reason text NOT NULL CHECK(length(btrim(reason))>0 AND length(reason)<=1000),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

function ownerCheck(owner: Owner) {
  if (owner !== 'rodion' && owner !== 'katya') throw new Error('invalid_owner');
}
function idCheck(id: string) {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error('invalid_transaction_id');
}
function revisionCheck(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('invalid_revision');
}
function annotation(transaction: Row, stored?: Row): SpendingPatternAnnotation {
  const currentTransactionRevision = Number(transaction.revision);
  return {
    transactionId: String(transaction.id),
    owner: transaction.owner as Owner,
    pattern: stored ? (stored.pattern as SpendingPattern) : 'unreviewed',
    revision: stored ? Number(stored.revision) : 0,
    sourceRevision: stored ? Number(stored.source_revision) : null,
    currentTransactionRevision,
    explicit: Boolean(stored),
    needsReview: stored
      ? Number(stored.source_revision) !== currentTransactionRevision
      : false,
    reason: stored ? String(stored.reason) : null,
    updatedAt: stored
      ? new Date(String(stored.updated_at)).toISOString()
      : null,
  };
}

/** Owner labels only: no category, amount or merchant heuristics. */
export class SpendingPatterns {
  constructor(readonly db: Database) {}

  /**
   * Pass the returned annotation revision on later edits; omitted means first
   * write. `owner` is the member whose account the payment sits on; `actor` is
   * the member labelling it, which the audit event records. Either member may
   * label the other's payment.
   */
  async set(
    transactionId: string,
    expectedTransactionRevision: number,
    owner: Owner,
    pattern: SpendingPattern,
    reason: string,
    expectedAnnotationRevision = 0,
    actor: Owner = owner,
  ): Promise<SpendingPatternAnnotation> {
    ownerCheck(owner);
    ownerCheck(actor);
    idCheck(transactionId);
    revisionCheck(expectedTransactionRevision);
    revisionCheck(expectedAnnotationRevision);
    if (!['routine', 'exceptional', 'unreviewed'].includes(pattern))
      throw new Error('invalid_spending_pattern');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000)
      throw new Error('invalid_spending_pattern_reason');
    return this.db.transaction(async (tx) => {
      const transaction = (
        await tx.query(
          'SELECT id,owner,revision FROM transactions WHERE id=$1 FOR UPDATE',
          [transactionId],
        )
      ).rows[0];
      if (!transaction || transaction.owner !== owner)
        throw new Error('not_found');
      if (Number(transaction.revision) !== expectedTransactionRevision)
        throw new Conflict('stale_revision');
      const previous = (
        await tx.query(
          'SELECT * FROM spending_patterns WHERE transaction_id=$1',
          [transactionId],
        )
      ).rows[0];
      if (Number(previous?.revision ?? 0) !== expectedAnnotationRevision)
        throw new Conflict('stale_annotation_revision');
      const saved = (
        await tx.query(
          `INSERT INTO spending_patterns(transaction_id,owner,pattern,revision,source_revision,reason)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(transaction_id) DO UPDATE SET
        pattern=excluded.pattern,revision=excluded.revision,source_revision=excluded.source_revision,reason=excluded.reason,updated_at=now()
        RETURNING *`,
          [
            transactionId,
            owner,
            pattern,
            expectedAnnotationRevision + 1,
            expectedTransactionRevision,
            reason,
          ],
        )
      ).rows[0]!;
      const result = annotation(transaction, saved);
      await tx.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
        VALUES($1,$2,$3,'spending_pattern_set',$4,$5,$6)`,
        [
          randomUUID(),
          transactionId,
          actor,
          JSON.stringify(annotation(transaction, previous)),
          JSON.stringify(result),
          reason,
        ],
      );
      return result;
    });
  }

  /** Missing annotations remain explicitly unreviewed in the response, without a write. */
  async list(
    owner: Owner,
    transactionIds?: readonly string[],
  ): Promise<SpendingPatternAnnotation[]> {
    ownerCheck(owner);
    if (
      transactionIds !== undefined &&
      (!Array.isArray(transactionIds) || transactionIds.length > 20000)
    )
      throw new Error('invalid_transaction_ids');
    transactionIds?.forEach(idCheck);
    if (transactionIds?.length === 0) return [];
    const rows = (
      await this.db.query(
        `SELECT t.id,t.owner,t.revision,
      p.transaction_id AS annotation_id,p.pattern,p.revision AS annotation_revision,p.source_revision,p.reason,p.updated_at
      FROM transactions t LEFT JOIN spending_patterns p ON p.transaction_id=t.id AND p.owner=t.owner
      WHERE t.owner=$1 AND ($2::uuid[] IS NULL OR t.id=ANY($2::uuid[])) ORDER BY t.booked_at DESC,t.id`,
        [owner, transactionIds ?? null],
      )
    ).rows;
    return rows.map((row) =>
      annotation(
        row,
        row.annotation_id
          ? { ...row, revision: row.annotation_revision }
          : undefined,
      ),
    );
  }

  /** Preserves caller order and fields while enforcing owner scope against the ledger. */
  async attach<T extends { id: string }>(
    owner: Owner,
    rows: readonly T[],
  ): Promise<Array<T & { spendingPattern: SpendingPatternAnnotation }>> {
    const annotations = new Map(
      (
        await this.list(
          owner,
          rows.map((row) => row.id),
        )
      ).map((value) => [value.transactionId, value]),
    );
    return rows.map((row) => {
      const spendingPattern = annotations.get(row.id);
      if (!spendingPattern) throw new Error('not_found');
      return { ...row, spendingPattern };
    });
  }
}
