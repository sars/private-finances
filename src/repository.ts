import {
  applySpendingPolicy,
  type SpendingPolicy,
  type StoredClassification,
} from './spending-policy.js';
import type { AccountPurpose } from './accounts.js';
import {
  SpendingPatterns,
  type SpendingPatternAnnotation,
} from './spending-pattern.js';
import { Conflict } from './errors.js';
import { backupHealth } from './backup-health.js';
import { rememberCounterparty } from './counterparty-identity.js';
import { attachRefunds, type RefundAnnotation } from './refunds.js';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import {
  validateTransaction,
  validateClassification,
  isSettlementOnly,
} from './domain.js';
import { resolveCategoryId } from './category-tree.js';
import type { ClassificationSource } from './resting-place.js';
import type { TransactionInput, Kind, Owner } from './domain.js';

export type Transaction = TransactionInput & {
  id: string;
  kind: Kind;
  /** Full display path, derived by the database from `categoryId`. Read-only:
   * writing it is rejected, because the tree is the truth (ADR 0006). */
  category: string | null;
  categoryId: string | null;
  /** True when no person and no confident rule decided this: the payment was
   * placed where its evidence pointed so the money is counted, and it still
   * needs review (ADR 0008). */
  provisional: boolean;
  classificationSource: ClassificationSource;
  revision: number;
  spendingPattern?: SpendingPatternAnnotation;
  storedClassification?: StoredClassification;
  spendingPolicy?: SpendingPolicy;
  /** Money that came back, reducing what this purchase cost (ADR 0007). */
  refund?: RefundAnnotation;
};
export { Conflict } from './errors.js';
function map(row: Row): Transaction {
  return {
    id: String(row.id),
    source: String(row.source),
    sourceId: String(row.source_id),
    accountId: String(row.account_id),
    owner: row.owner as Owner,
    bookedAt: (row.booked_at instanceof Date
      ? row.booked_at
      : new Date(String(row.booked_at))
    ).toISOString(),
    currency: String(row.currency),
    amountMinor: String(row.amount_minor),
    description: String(row.description),
    status: row.status as 'booked' | 'pending',
    kind: row.kind as Kind,
    category: row.category === null ? null : String(row.category),
    categoryId: row.category_id === null ? null : String(row.category_id),
    provisional: Boolean(row.provisional),
    classificationSource: (row.classification_source ??
      'none') as ClassificationSource,
    revision: Number(row.revision),
  };
}

export type WorkflowHealth = {
  availability: 'available' | 'unavailable';
  counts: Record<string, number> | null;
  total: number | null;
  latestCreatedAt: string | null;
  oldestOutstandingCreatedAt: string | null;
  expiredSendingCount: number | null;
};
const workflowTables = {
  telegramQuestions: {
    table: 'telegram_outbox',
    field: 'state',
    states: ['queued', 'sending', 'sent', 'uncertain'],
    outstanding: ['queued', 'sending', 'uncertain'],
    lease: 'lease_until',
  },
  telegramReplies: {
    table: 'telegram_proposal_inputs',
    field: 'status',
    states: ['pending'],
    outstanding: ['pending', 'processing', 'failed'],
    lease: null,
  },
  replyProposals: {
    table: 'telegram_reply_workflows',
    field: 'state',
    states: [
      'processing',
      'waiting',
      'ready',
      'sending',
      'sent',
      'confirmed',
      'rejected',
      'stale',
      'failed',
      'uncertain',
    ],
    outstanding: [
      'processing',
      'waiting',
      'ready',
      'sending',
      'sent',
      'failed',
      'uncertain',
    ],
    lease: 'lease_until',
  },
  replyReceipts: {
    table: 'telegram_reply_workflows',
    field: 'receipt_state',
    states: ['none', 'queued', 'sending', 'sent', 'uncertain'],
    outstanding: ['queued', 'sending', 'uncertain'],
    lease: 'receipt_lease_until',
  },
  reportDelivery: {
    table: 'report_delivery',
    field: 'state',
    states: ['queued', 'sending', 'sent', 'uncertain'],
    outstanding: ['queued', 'sending', 'uncertain'],
    lease: 'lease_until',
  },
  transactionTriage: {
    table: 'transaction_triage',
    field: 'state',
    states: ['processing', 'ready', 'deferred', 'uncertain'],
    outstanding: ['processing', 'deferred', 'uncertain'],
    lease: 'lease_until',
  },
  classifier: {
    table: 'classifier_proposals',
    field: 'state',
    states: ['reserved', 'proposed', 'failed', 'stale'],
    outstanding: ['reserved', 'failed'],
    lease: null,
  },
  credentialReminders: {
    table: 'credential_reminders',
    field: 'state',
    states: ['queued', 'sending', 'sent', 'uncertain', 'cancelled'],
    outstanding: ['queued', 'sending', 'uncertain'],
    lease: 'lease_until',
  },
} as const;

async function workflowHealth(
  db: Executor,
): Promise<Record<keyof typeof workflowTables, WorkflowHealth>> {
  const results = {} as Record<keyof typeof workflowTables, WorkflowHealth>;
  for (const name of Object.keys(workflowTables) as Array<
    keyof typeof workflowTables
  >) {
    const definition = workflowTables[name];
    const exists = await db.query('SELECT to_regclass($1)::text AS relation', [
      definition.table,
    ]);
    if (!exists.rows[0]?.relation) {
      results[name] = {
        availability: 'unavailable',
        counts: null,
        total: null,
        latestCreatedAt: null,
        oldestOutstandingCreatedAt: null,
        expiredSendingCount: null,
      };
      continue;
    }
    // All identifiers are fixed local constants. Project only counts and creation
    // timestamps, never financial content, model output or delivery identifiers.
    const rows = (
      await db.query(`SELECT ${definition.field} AS state,count(*)::int AS count,
      min(created_at) AS oldest_created_at,max(created_at) AS latest_created_at,
      ${definition.lease ? `count(*) FILTER (WHERE ${definition.field} IN ('sending','processing') AND ${definition.lease}<now())::int` : 'NULL::int'} AS expired_sending
      FROM ${definition.table} GROUP BY ${definition.field}`)
    ).rows;
    const counts: Record<string, number> = Object.fromEntries(
      definition.states.map((state) => [state, 0]),
    );
    let total = 0,
      latestCreatedAt: string | null = null,
      oldestOutstandingCreatedAt: string | null = null;
    let expiredSendingCount: number | null = definition.lease ? 0 : null;
    for (const row of rows) {
      const state = String(row.state),
        count = Number(row.count);
      counts[state] = count;
      total += count;
      const latest = new Date(String(row.latest_created_at)).toISOString();
      const oldest = new Date(String(row.oldest_created_at)).toISOString();
      if (latestCreatedAt === null || latest > latestCreatedAt)
        latestCreatedAt = latest;
      if (
        (definition.outstanding as readonly string[]).includes(state) &&
        (oldestOutstandingCreatedAt === null ||
          oldest < oldestOutstandingCreatedAt)
      )
        oldestOutstandingCreatedAt = oldest;
      if (expiredSendingCount !== null)
        expiredSendingCount += Number(row.expired_sending);
    }
    results[name] = {
      availability: 'available',
      counts,
      total,
      latestCreatedAt,
      oldestOutstandingCreatedAt,
      expiredSendingCount,
    };
  }
  return results;
}

export class Repository {
  constructor(readonly db: Database) {}
  /** Every column a listed payment needs, with the account policy beside it.
   * `t` is the payment and `sp` its spending pattern, so a caller's WHERE
   * clause may refer to both. */
  private static readonly projection = `SELECT t.*, a.label AS policy_account_label,a.purpose AS policy_account_purpose, to_jsonb(a)->>'revision' AS policy_account_revision
      FROM transactions t LEFT JOIN own_accounts a ON a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id
      LEFT JOIN spending_patterns sp ON sp.transaction_id=t.id`;
  async list(owner?: Owner): Promise<Transaction[]> {
    return this.select('($1::text IS NULL OR t.owner=$1)', [owner ?? null]);
  }
  /**
   * The payments a WHERE clause selects, newest first, enriched exactly as
   * `list` enriches them. The clause is written against `t` (the payment) and
   * `sp` (its spending pattern) with `$n` placeholders into `params`; a limit
   * cuts the page after ordering, so a caller pages with a keyset clause
   * rather than an offset.
   */
  async select(
    where: string,
    params: unknown[],
    limit?: number,
  ): Promise<Transaction[]> {
    const result = await this.db.query(
      `${Repository.projection} WHERE ${where} ORDER BY t.booked_at DESC,t.id${
        limit === undefined ? '' : ` LIMIT ${Math.trunc(limit)}`
      }`,
      params,
    );
    return this.enrich(result.rows);
  }
  /** How many payments a WHERE clause selects, for the clause `select` takes. */
  async count(where: string, params: unknown[]): Promise<number> {
    const result = await this.db.query(
      `SELECT count(*) AS total FROM transactions t
      LEFT JOIN own_accounts a ON a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id
      LEFT JOIN spending_patterns sp ON sp.transaction_id=t.id WHERE ${where}`,
      params,
    );
    return Number(result.rows[0]!.total);
  }
  private async enrich(raw: Row[]): Promise<Transaction[]> {
    const rows = raw.map((row) =>
      applySpendingPolicy(
        map(row),
        row.policy_account_purpose
          ? {
              label: String(row.policy_account_label),
              purpose: row.policy_account_purpose as AccountPurpose,
              revision: Number(row.policy_account_revision ?? 0),
            }
          : null,
      ),
    );
    const patterns = new SpendingPatterns(this.db);
    const enriched = (
      await Promise.all(
        (['rodion', 'katya'] as const).map((currentOwner) =>
          patterns.attach(
            currentOwner,
            rows.filter((row) => row.owner === currentOwner),
          ),
        ),
      )
    ).flat();
    const withRefunds = await attachRefunds(this.db, enriched);
    const byId = new Map(withRefunds.map((row) => [row.id, row]));
    return rows.map((row) => byId.get(row.id)!);
  }
  async history(id: string): Promise<Row[]> {
    const result = await this.db.query(
      `SELECT actor,event,reason,created_at,
       CASE WHEN jsonb_typeof(before_value)='object' THEN before_value - 'sourceDetails' ELSE NULL END AS before_value,
       after_value - 'sourceDetails' AS after_value
       FROM audit_events WHERE transaction_id=$1 ORDER BY created_at,id`,
      [id],
    );
    return result.rows;
  }
  async importBatch(raw: unknown[], tx?: Executor): Promise<number> {
    if (!tx) return this.db.transaction((db) => this.importBatch(raw, db));
    await tx.query('SELECT pg_advisory_xact_lock(7482392)');
    const batch = raw.map(validateTransaction);
    let changed = 0;
    for (const t of batch) {
      const existing = await tx.query(
        'SELECT * FROM transactions WHERE source=$1 AND account_id=$2 AND source_id=$3 FOR UPDATE',
        [t.source, t.accountId, t.sourceId],
      );
      const previous = existing.rows[0];
      if (previous && previous.owner !== t.owner)
        throw new Error('account_owner_mismatch');
      const after = {
        bookedAt: t.bookedAt,
        currency: t.currency,
        amountMinor: t.amountMinor,
        description: t.description,
        status: t.status ?? 'booked',
        sourceDetails: t.sourceDetails ?? {},
      };
      const before = previous
        ? {
            bookedAt: map(previous).bookedAt,
            currency: String(previous.currency),
            amountMinor: String(previous.amount_minor),
            description: String(previous.description),
            status: previous.status,
            sourceDetails: previous.source_details,
          }
        : null;
      if (isDeepStrictEqual(before, after)) continue;
      const id = previous ? String(previous.id) : randomUUID();
      await tx.query(
        `INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description,status,source_details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(source,account_id,source_id) DO UPDATE SET booked_at=excluded.booked_at,currency=excluded.currency,
        amount_minor=excluded.amount_minor,description=excluded.description,status=excluded.status,source_details=excluded.source_details,updated_at=now(),revision=transactions.revision+1`,
        [
          id,
          t.source,
          t.sourceId,
          t.accountId,
          t.owner,
          t.bookedAt,
          t.currency,
          t.amountMinor,
          t.description,
          t.status ?? 'booked',
          JSON.stringify(t.sourceDetails ?? {}),
        ],
      );
      const settlementOnly = isSettlementOnly(before, after);
      await tx.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason) VALUES($1,$2,'importer',$3,$4,$5,$6)`,
        [
          randomUUID(),
          id,
          !previous
            ? 'imported'
            : settlementOnly
              ? 'settled'
              : 'source_corrected',
          JSON.stringify(before),
          JSON.stringify(after),
          settlementOnly
            ? 'The card hold settled; the payment itself is unchanged'
            : 'Source import',
        ],
      );
      if (previous && previous.kind !== 'unresolved' && !settlementOnly) {
        const automatic = await tx.query(
          `SELECT 1 FROM audit_events WHERE transaction_id=$1 AND event='auto_classified'
          AND NOT EXISTS(SELECT 1 FROM audit_events h WHERE h.transaction_id=$1 AND h.event IN ('classified','refund_linked','refund_unlinked')) LIMIT 1`,
          [id],
        );
        if (automatic.rows.length) {
          await tx.query(
            "UPDATE transactions SET kind='unresolved',category_id=NULL WHERE id=$1",
            [id],
          );
          await tx.query(
            `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
            VALUES($1,$2,'importer','auto_classification_invalidated',$3,$4,'Bank corrected the evidence used by automatic classification')`,
            [
              randomUUID(),
              id,
              JSON.stringify({
                kind: previous.kind,
                category: previous.category,
                revision: Number(previous.revision),
              }),
              JSON.stringify({
                kind: 'unresolved',
                category: null,
                revision: Number(previous.revision) + 1,
              }),
            ],
          );
        }
      }
      changed++;
    }
    return changed;
  }
  /**
   * `actor` is the member who decided; `owner` is the member whose account the
   * payment sits on, and defaults to the actor. They differ when one member
   * decides the other's payment, which the household allows: the audit event
   * then records who actually decided.
   */
  async classify(
    id: string,
    revision: number,
    input: unknown,
    actor: Owner,
    owner: Owner = actor,
  ): Promise<void> {
    const c = validateClassification(input);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid_revision');
    await this.db.transaction(async (tx) => {
      const result = await tx.query(
        'SELECT * FROM transactions WHERE id=$1 FOR UPDATE',
        [id],
      );
      const row = result.rows[0];
      if (!row || row.owner !== owner) throw new Error('not_found');
      if (Number(row.revision) !== revision)
        throw new Conflict('stale_revision');
      if (
        c.kind === 'personal_expense' &&
        BigInt(String(row.amount_minor)) >= 0n
      )
        throw new Error('expense_must_be_outflow');
      // The form and the classifier both speak in paths; the ledger stores the
      // node, so that renaming a category never rewrites history.
      const categoryId = await resolveCategoryId(tx, c.category);
      if (c.category !== null && categoryId === null)
        throw new Error('unknown_category');
      await tx.query(
        `UPDATE transactions SET kind=$1,category_id=$2,provisional=false,
           classification_source='human',revision=revision+1,updated_at=now()
         WHERE id=$3`,
        [c.kind, categoryId, id],
      );
      await tx.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason) VALUES($1,$2,$3,'classified',$4,$5,$6)`,
        [
          randomUUID(),
          id,
          actor,
          JSON.stringify({
            kind: row.kind,
            category: row.category,
            revision: row.revision,
          }),
          JSON.stringify({
            kind: c.kind,
            category: c.category,
            revision: revision + 1,
          }),
          c.reason,
        ],
      );
      // The owner's plan for a transfer nothing could identify was "if any
      // problem — i can manually recategorize it". Remembering the counterparty
      // they just decided about means they do that once rather than every time
      // the same person is paid again.
      await rememberCounterparty(tx, row, c.kind);
    });
  }
  async enqueue(): Promise<string> {
    const id = randomUUID();
    await this.db.query("INSERT INTO jobs(id,state) VALUES($1,'queued')", [id]);
    return id;
  }
  async work(batch: unknown[]): Promise<string | null> {
    const token = randomUUID();
    const claimed = await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error_code='lease_expired',lease_token=NULL WHERE state='running' AND lease_until < now()",
      );
      return tx.query(
        `UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '60 seconds'
        WHERE id=(SELECT id FROM jobs WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`,
        [token],
      );
    });
    const id = claimed.rows[0]?.id;
    if (!id) return null;
    try {
      await this.db.transaction(async (tx) => {
        const lease = await tx.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [id, token],
        );
        if (!lease.rows.length) throw new Conflict('lease_lost');
        const imported = await this.importBatch(batch, tx);
        await tx.query(
          "UPDATE jobs SET state='succeeded',finished_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL,imported=$2 WHERE id=$1",
          [id, imported],
        );
        await tx.query(
          "INSERT INTO sync_state(source,last_success_at,job_id) VALUES('synthetic',now(),$1) ON CONFLICT(source) DO UPDATE SET last_success_at=excluded.last_success_at,job_id=excluded.job_id",
          [id],
        );
      });
    } catch (error) {
      await this.db.query(
        "UPDATE jobs SET state='failed',error_code='import_failed',finished_at=now(),lease_token=NULL WHERE id=$1 AND lease_token=$2",
        [id, token],
      );
      throw error;
    }
    return String(id);
  }
  async health(): Promise<Record<string, unknown>> {
    const sync = await this.db.query(
      "SELECT last_success_at FROM sync_state WHERE source='synthetic'",
    );
    const last = sync.rows[0]?.last_success_at;
    const lastSuccessAt = last ? new Date(String(last)).toISOString() : null;
    const state = !lastSuccessAt
      ? 'never_synced'
      : Date.now() - Date.parse(lastSuccessAt) > 86400000
        ? 'stale'
        : 'fresh';
    const jobs = await this.db.query(
      'SELECT state,count(*)::int AS count FROM jobs GROUP BY state',
    );
    return {
      database: 'ready',
      source: 'synthetic',
      freshness: state,
      lastSuccessAt,
      jobs: jobs.rows,
      backup: await backupHealth(this.db),
      workflows: await workflowHealth(this.db),
      bankConnections: (
        await this.db.query(
          'SELECT connection,state,last_success_at,error_code FROM bank_sync_runs ORDER BY connection',
        )
      ).rows,
    };
  }
}
