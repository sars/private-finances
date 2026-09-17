import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import type { Kind, Owner } from './domain.js';
import { Conflict } from './errors.js';
import {
  closeAmounts,
  originalAmount,
  provisionalPair,
  refundCandidates,
  remainingMinor,
  type RefundRow,
} from './refund-matching.js';
import { convertWithDailyRates, type DailyFxRate } from './fx-rates.js';

/**
 * Refund links as ADR 0007 defines them: money that comes back reduces what a
 * purchase cost, without erasing or rewriting the purchase. The expense keeps the
 * amount the bank recorded and carries the reduction beside it.
 *
 * A linked credit is not classified and is not listed. It is already counted,
 * through the purchase it reduced, and asking anyone to categorise it would be
 * asking about the same money twice. The purchase still needs its category: what
 * it was for does not change because part of the money came back.
 */

type PriorClassification = {
  kind: Kind;
  category: string | null;
  revision: number;
};
export type RefundOrigin = 'manual' | 'automatic';
export type RefundEvidence = {
  /** Which ADR 0007 rule produced the link. */
  rule: string;
  debitAmountMinor: string;
  creditAmountMinor: string;
  originalDebitMinor?: string;
  originalCreditMinor?: string;
  originalCurrency?: string;
  /** The currency the result is counted in: the purchase's own. */
  purchaseCurrency?: string;
  /** The refund exceeded the purchase because the exchange rate moved. */
  fxSurplus?: boolean;
  /** One side was still a hold when the link was made, so the amount above is
   * what the bank said at the time and is recalculated when it settles. */
  provisional?: boolean;
  /** Which edition of the rules chose this parent. A link the matcher made
   * under older rules is re-decided once; a link a person made never is. */
  rulesVersion?: number;
};
export type RefundLink = {
  id: string;
  owner: Owner;
  state: 'active' | 'unlinked';
  revision: number;
  debitId: string;
  creditId: string;
  reductionMinor: string;
  currency: string;
  origin: RefundOrigin;
  evidence: RefundEvidence;
  debitBefore: PriorClassification;
  creditBefore: PriorClassification;
  appliedDebitRevision: number;
  appliedCreditRevision: number;
  reason: string;
  createdAt: string;
  unlinkedAt: string | null;
};
export type RefundCandidate = {
  id: string;
  revision: number;
  bookedAt: string;
  amountMinor: string;
  currency: string;
  description: string;
  source: string;
  accountId: string;
  kind: Kind;
  category: string | null;
  /** Still unreduced part of the purchase, in ledger minor units. */
  remainingMinor: string;
  originalAmountMinor: string;
  originalCurrency: string;
  exactOriginal: boolean;
};
/** One credit reducing one purchase, as shown beside the purchase. */
export type RefundReduction = {
  linkId: string;
  linkRevision: number;
  peerId: string;
  peerBookedAt: string;
  /** What came back, in the currency the credit arrived in. */
  reductionMinor: string;
  currency: string;
  /** The same money in the purchase's currency: equal when the currencies agree,
   * a daily-rate conversion when they do not, null when no rate covers that day. */
  convertedMinor: string | null;
  /** True when the figure above came from a rate rather than from the bank. */
  approximate: boolean;
  /** The bank has not settled one of the two amounts yet. */
  provisional: boolean;
  origin: RefundOrigin;
  rule: string;
  /** What the merchant charged and returned, in the currency it used. */
  originalChargeMinor: string | null;
  originalReturnedMinor: string | null;
  originalCurrency: string | null;
  /** A later correction changed an amount the link was made from. Surfaced,
   * never repaired by undoing the link (ADR 0007). */
  discrepancy: string | null;
};
export type RefundAnnotation = {
  role: 'reduced' | 'refund';
  /** A reduction whose amount the bank has not settled yet. */
  provisional?: boolean;
  /** Everything that came back, in the purchase's own currency. */
  reducedMinor: string;
  /** What the purchase finally cost, in its own currency. Converted onwards from
   * here exactly like any other transaction. */
  netMinor: string;
  currency: string;
  /** A reduction had to be converted, so the result is close, not exact. */
  approximate: boolean;
  fullyReduced: boolean;
  reductions: RefundReduction[];
};

export async function initializeRefunds(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS refund_links (
    id uuid PRIMARY KEY,owner text NOT NULL CHECK(owner IN ('rodion','katya')),
    state text NOT NULL CHECK(state IN ('active','unlinked')),revision integer NOT NULL CHECK(revision>0),
    debit_id uuid NOT NULL REFERENCES transactions(id),credit_id uuid NOT NULL REFERENCES transactions(id),
    debit_before jsonb NOT NULL,credit_before jsonb NOT NULL,
    applied_debit_revision integer NOT NULL CHECK(applied_debit_revision>0),
    applied_credit_revision integer NOT NULL CHECK(applied_credit_revision>0),
    reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),unlinked_at timestamptz,
    CHECK(debit_id<>credit_id)
  )`);
  await upgradeRefundReductions(tx);
}

/**
 * Version 22. A link stops being an all-or-nothing pairing of equal ledger
 * amounts and becomes a reduction of a known size, so a partial refund and an
 * exchange-rate difference both fit. Additive; existing links keep their meaning
 * because a full refund is a reduction equal to the whole credit.
 */
export async function upgradeRefundReductions(tx: Executor): Promise<void> {
  await tx.query(`ALTER TABLE refund_links
    ADD COLUMN IF NOT EXISTS reduction_minor numeric(30,0),
    ADD COLUMN IF NOT EXISTS currency text,
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await tx.query(`UPDATE refund_links r SET
    reduction_minor=COALESCE(r.reduction_minor,c.amount_minor),
    currency=COALESCE(r.currency,c.currency),
    evidence=CASE WHEN r.evidence='{}'::jsonb THEN jsonb_build_object(
      'rule','manual','debitAmountMinor',d.amount_minor::text,'creditAmountMinor',c.amount_minor::text)
      ELSE r.evidence END
    FROM transactions d,transactions c WHERE d.id=r.debit_id AND c.id=r.credit_id
      AND (r.reduction_minor IS NULL OR r.currency IS NULL OR r.evidence='{}'::jsonb)`);
  // A row whose credit somehow carries no positive amount cannot express a
  // reduction; leaving it NULL would fail the NOT NULL below, so it is rejected
  // loudly here rather than silently dropped.
  const unusable = await tx.query(
    'SELECT count(*)::int AS count FROM refund_links WHERE reduction_minor IS NULL OR currency IS NULL OR reduction_minor<=0',
  );
  if (Number(unusable.rows[0]?.count ?? 0) > 0)
    throw new Error('refund_link_without_reduction');
  await tx.query(
    'ALTER TABLE refund_links ALTER COLUMN reduction_minor SET NOT NULL, ALTER COLUMN currency SET NOT NULL',
  );
  for (const [name, check] of [
    ['refund_links_reduction_positive', 'reduction_minor>0'],
    ['refund_links_origin', "origin IN ('manual','automatic')"],
  ] as const) {
    const present = await tx.query(
      "SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid='refund_links'::regclass",
      [name],
    );
    if (!present.rows.length)
      await tx.query(
        `ALTER TABLE refund_links ADD CONSTRAINT ${name} CHECK(${check})`,
      );
  }
  // A link now records the revisions it observed rather than revisions it wrote,
  // and a freshly imported transaction is at revision 0.
  await tx.query(
    'ALTER TABLE refund_links DROP CONSTRAINT IF EXISTS refund_links_applied_debit_revision_check, DROP CONSTRAINT IF EXISTS refund_links_applied_credit_revision_check',
  );
  // One credit explains at most one purchase; a purchase may be reduced by many.
  await tx.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS refund_links_active_credit ON refund_links(credit_id) WHERE state='active'",
  );
  await tx.query(
    "CREATE INDEX IF NOT EXISTS refund_links_active_debit ON refund_links(debit_id) WHERE state='active'",
  );
  // Membership was a separate table only to keep one transaction inside one link.
  // A partial unique index states that directly, and a purchase now legitimately
  // appears in several links, which the old primary key forbade.
  await tx.query('DROP TABLE IF EXISTS refund_link_transactions');
}

/**
 * Puts a stored classification back on a payment. The category column is a
 * derived mirror from schema version 25 onwards, so this restores the node
 * rather than the text; the refund migrations run before that column exists and
 * are also called directly by tests on a fully migrated database, so it has to
 * be right in both eras.
 */
async function restoreClassification(
  tx: Executor,
  transactionId: string,
  before: PriorClassification,
): Promise<void> {
  const identified = (
    await tx.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name='transactions' AND column_name='category_id'`,
    )
  ).rows.length;
  await tx.query(
    identified
      ? `UPDATE transactions SET kind=$1,revision=revision+1,updated_at=now(),
           category_id=(SELECT id FROM category_tree WHERE lower(category_path(id))=lower($2))
         WHERE id=$3`
      : 'UPDATE transactions SET kind=$1,category=$2,revision=revision+1,updated_at=now() WHERE id=$3',
    [before.kind, before.category, transactionId],
  );
}

/**
 * Version 22 data change. Links made under the old model rewrote the purchase to
 * `non_personal`, which is exactly what ADR 0007 rejects: the purchase keeps its
 * own classification and carries the reduction. Only links whose purchase has not
 * changed since are restored; anything already edited is left for a human.
 */
export async function restoreRefundedPurchases(tx: Executor): Promise<number> {
  const rows = (
    await tx.query(
      `SELECT r.id,r.debit_id,r.debit_before,d.kind,d.category,d.revision FROM refund_links r
       JOIN transactions d ON d.id=r.debit_id
       WHERE r.state='active' AND d.revision=r.applied_debit_revision
         AND d.kind='non_personal' AND d.category IS NULL
         AND r.debit_before->>'kind' IS DISTINCT FROM 'non_personal'`,
    )
  ).rows;
  for (const row of rows) {
    const before = row.debit_before as PriorClassification;
    await restoreClassification(tx, String(row.debit_id), before);
    await tx.query(
      'UPDATE refund_links SET applied_debit_revision=$2 WHERE id=$1',
      [row.id, Number(row.revision) + 1],
    );
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','refund_purchase_restored',$3,$4,'ADR 0007: a refund reduces a purchase instead of rewriting it')`,
      [
        randomUUID(),
        row.debit_id,
        JSON.stringify({
          kind: row.kind,
          category: row.category,
          revision: Number(row.revision),
        }),
        JSON.stringify({ ...before, revision: Number(row.revision) + 1 }),
      ],
    );
  }
  return rows.length;
}

/** Daily quotes for the days a set of refunds arrived on. */
async function ratesFor(
  tx: Executor | Database,
  days: string[],
): Promise<DailyFxRate[]> {
  if (!days.length) return [];
  const sorted = [...new Set(days)].sort();
  return (
    await tx.query(
      'SELECT *,as_of::text AS calendar_date FROM daily_fx_rates WHERE as_of>=$1 AND as_of<=$2 ORDER BY as_of,source,base,target,version DESC',
      [sorted[0]!, sorted.at(-1)!],
    )
  ).rows.map(
    (row) =>
      ({
        source: String(row.source),
        base: String(row.base),
        target: String(row.target),
        rate: String(row.rate),
        asOf: String(row.calendar_date),
        retrievedAt: new Date(String(row.retrieved_at)).toISOString(),
        version: Number(row.version),
        provenance: String(row.provenance),
      }) as DailyFxRate,
  );
}

/**
 * A refund in another currency, expressed in the purchase's currency, using the
 * ordinary daily rate for the day it arrived. Null when no rate covers that day;
 * nothing is guessed.
 */
async function convertedReduction(
  tx: Executor | Database,
  input: { amountMinor: string; from: string; to: string; occurredAt: string },
  rates?: DailyFxRate[],
): Promise<bigint | null> {
  if (input.from === input.to) return BigInt(input.amountMinor);
  const day = new Date(input.occurredAt).toISOString().slice(0, 10);
  const result = convertWithDailyRates(
    {
      amountMinor: input.amountMinor,
      currency: input.from,
      targetCurrency: input.to,
      occurredAt: input.occurredAt,
    },
    rates ?? (await ratesFor(tx, [day])),
  );
  return result.status === 'converted' ? BigInt(result.amountMinor) : null;
}

/**
 * Version 26 data change. A linked credit used to be classified `non_personal`.
 * It is now left alone and hidden instead, because it is already counted through
 * the purchase it reduced, so the classification the link wrote is taken back.
 * Only credits still exactly as the link left them are touched.
 */
export async function restoreRefundedCredits(tx: Executor): Promise<number> {
  const rows = (
    await tx.query(
      `SELECT r.id,r.credit_id,r.credit_before,c.kind,c.category,c.revision FROM refund_links r
       JOIN transactions c ON c.id=r.credit_id
       WHERE r.state='active' AND c.revision=r.applied_credit_revision
         AND c.kind='non_personal' AND c.category IS NULL
         AND r.credit_before->>'kind' IS DISTINCT FROM 'non_personal'`,
    )
  ).rows;
  for (const row of rows) {
    const before = row.credit_before as PriorClassification;
    await restoreClassification(tx, String(row.credit_id), before);
    await tx.query(
      'UPDATE refund_links SET applied_credit_revision=$2 WHERE id=$1',
      [row.id, Number(row.revision) + 1],
    );
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','refund_credit_restored',$3,$4,'A linked refund is counted through its purchase, so the credit is not classified')`,
      [
        randomUUID(),
        row.credit_id,
        JSON.stringify({
          kind: row.kind,
          category: row.category,
          revision: Number(row.revision),
        }),
        JSON.stringify({ ...before, revision: Number(row.revision) + 1 }),
      ],
    );
  }
  return rows.length;
}

function ownerCheck(owner: Owner) {
  if (owner !== 'rodion' && owner !== 'katya') throw new Error('invalid_owner');
}
function idCheck(id: string) {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error('invalid_refund_id');
}
function revisionCheck(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('invalid_revision');
}
function reasonCheck(reason: string) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000)
    throw new Error('invalid_refund_reason');
}
function classification(row: Row): PriorClassification {
  return {
    kind: row.kind as Kind,
    category: row.category === null ? null : String(row.category),
    revision: Number(row.revision),
  };
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
function linkRow(row: Row): RefundLink {
  return {
    id: String(row.id),
    owner: row.owner as Owner,
    state: row.state as RefundLink['state'],
    revision: Number(row.revision),
    debitId: String(row.debit_id),
    creditId: String(row.credit_id),
    reductionMinor: String(row.reduction_minor),
    currency: String(row.currency),
    origin: row.origin as RefundOrigin,
    evidence: row.evidence as RefundEvidence,
    debitBefore: row.debit_before as PriorClassification,
    creditBefore: row.credit_before as PriorClassification,
    appliedDebitRevision: Number(row.applied_debit_revision),
    appliedCreditRevision: Number(row.applied_credit_revision),
    reason: String(row.reason),
    createdAt: new Date(String(row.created_at)).toISOString(),
    unlinkedAt: row.unlinked_at
      ? new Date(String(row.unlinked_at)).toISOString()
      : null,
  };
}
async function lockPair(
  tx: Executor,
  debitId: string,
  creditId: string,
  owner: Owner,
): Promise<[Row, Row]> {
  const rows = (
    await tx.query(
      'SELECT * FROM transactions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[debitId, creditId]],
    )
  ).rows;
  const debit = rows.find(
    (row) => String(row.id).toLowerCase() === debitId.toLowerCase(),
  );
  const credit = rows.find(
    (row) => String(row.id).toLowerCase() === creditId.toLowerCase(),
  );
  if (!debit || !credit || debit.owner !== owner || credit.owner !== owner)
    throw new Error('not_found');
  return [debit, credit];
}
async function audit(
  tx: Executor,
  transactionId: string,
  owner: string,
  event: 'refund_linked' | 'refund_unlinked',
  before: unknown,
  after: unknown,
  reason: string,
) {
  await tx.query(
    `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      transactionId,
      owner,
      event,
      JSON.stringify(before),
      JSON.stringify(after),
      reason,
    ],
  );
}

/**
 * Whether more money came back than went out. The question is answered in the
 * currency the merchant charged in, because that is the only place the two
 * amounts are comparable: a ride charged at 5.20 and refunded at 5.19 returns
 * less than it took, even though the hryvnia figure is larger after the rate
 * moved between the two days. Only when the original amounts cannot be compared
 * does the ledger have to answer it.
 */
function exceedsPurchase(
  link: RefundLink,
  debitAmountMinor: string,
  convertedMinor: bigint,
): boolean {
  const charged = link.evidence?.originalDebitMinor;
  const returned = link.evidence?.originalCreditMinor;
  if (charged !== undefined && returned !== undefined)
    return BigInt(returned) > -BigInt(charged);
  return (
    convertedMinor > -BigInt(debitAmountMinor) &&
    link.evidence?.fxSurplus !== true
  );
}

function discrepancyOf(
  link: RefundLink,
  debitAmountMinor: string,
  creditAmountMinor: string,
  convertedMinor: bigint | null,
): string | null {
  const problems: string[] = [];
  if (
    link.evidence?.debitAmountMinor &&
    link.evidence.debitAmountMinor !== debitAmountMinor
  )
    problems.push('purchase_amount_changed');
  if (
    link.evidence?.creditAmountMinor &&
    link.evidence.creditAmountMinor !== creditAmountMinor
  )
    problems.push('refund_amount_changed');
  if (convertedMinor === null) problems.push('conversion_unavailable');
  else if (exceedsPurchase(link, debitAmountMinor, convertedMinor))
    problems.push('reduction_exceeds_purchase');
  return problems.length ? problems.join(',') : null;
}

/**
 * Whether the merchant gave back everything it charged, measured in the currency
 * it charged in. A ledger residual can remain after a complete reversal because
 * the exchange rate moved, and that residual is a real cost but nothing anyone
 * still has to explain (ADR 0007).
 */
function returnedInFull(reductions: RefundReduction[]): boolean {
  let charged = 0n;
  let returned = 0n;
  const currencies = new Set<string>();
  for (const item of reductions) {
    if (
      item.originalChargeMinor === null ||
      item.originalReturnedMinor === null ||
      item.originalCurrency === null
    )
      return false;
    currencies.add(item.originalCurrency);
    returned += BigInt(item.originalReturnedMinor);
    // Every link on one purchase records that purchase's own original amount.
    charged = -BigInt(item.originalChargeMinor);
  }
  return currencies.size === 1 && charged > 0n && returned >= charged;
}

/**
 * Attaches each purchase's reductions and each refund credit's parent. Reading
 * the annotation is how totals become net without any stored amount changing.
 */
export async function attachRefunds<
  T extends { id: string; amountMinor: string; currency?: string },
>(db: Database, rows: T[]): Promise<(T & { refund?: RefundAnnotation })[]> {
  if (!rows.length) return rows;
  const ids = rows.map((row) => row.id);
  const links = (
    await db.query(
      `SELECT r.*,d.amount_minor AS debit_amount_minor,c.amount_minor AS credit_amount_minor,
        d.currency AS debit_currency,c.currency AS credit_currency,
        d.status AS debit_status,c.status AS credit_status,
        c.booked_at AS credit_booked_at,d.booked_at AS debit_booked_at
       FROM refund_links r JOIN transactions d ON d.id=r.debit_id JOIN transactions c ON c.id=r.credit_id
       WHERE r.state='active' AND (r.debit_id=ANY($1::uuid[]) OR r.credit_id=ANY($1::uuid[]))
       ORDER BY c.booked_at,r.id`,
      [ids],
    )
  ).rows;
  const time = (value: unknown) =>
    (value instanceof Date ? value : new Date(String(value))).toISOString();
  // One rate lookup covers every refund that needs converting.
  const crossCurrency = links.filter(
    (row) => String(row.debit_currency) !== String(row.credit_currency),
  );
  const rates = crossCurrency.length
    ? await ratesFor(
        db,
        crossCurrency.map((row) => time(row.credit_booked_at).slice(0, 10)),
      )
    : [];
  const byDebit = new Map<string, RefundReduction[]>();
  const byCredit = new Map<string, RefundReduction[]>();
  for (const row of links) {
    const link = linkRow(row);
    const purchaseCurrency = String(row.debit_currency);
    const sameCurrency = purchaseCurrency === String(row.credit_currency);
    const converted = sameCurrency
      ? BigInt(link.reductionMinor)
      : await convertedReduction(
          db,
          {
            amountMinor: link.reductionMinor,
            from: link.currency,
            to: purchaseCurrency,
            occurredAt: time(row.credit_booked_at),
          },
          rates,
        );
    const discrepancy = discrepancyOf(
      link,
      String(row.debit_amount_minor),
      String(row.credit_amount_minor),
      converted,
    );
    const shared = {
      linkId: link.id,
      linkRevision: link.revision,
      reductionMinor: link.reductionMinor,
      currency: link.currency,
      convertedMinor: converted === null ? null : converted.toString(),
      approximate: !sameCurrency,
      provisional:
        link.evidence?.provisional === true ||
        row.credit_status === 'pending' ||
        row.debit_status === 'pending',
      origin: link.origin,
      rule: link.evidence?.rule ?? 'manual',
      originalChargeMinor: link.evidence?.originalDebitMinor ?? null,
      originalReturnedMinor: link.evidence?.originalCreditMinor ?? null,
      originalCurrency: link.evidence?.originalCurrency ?? null,
      discrepancy,
    };
    byDebit.set(link.debitId, [
      ...(byDebit.get(link.debitId) ?? []),
      {
        ...shared,
        peerId: link.creditId,
        peerBookedAt: time(row.credit_booked_at),
      },
    ]);
    byCredit.set(link.creditId, [
      ...(byCredit.get(link.creditId) ?? []),
      {
        ...shared,
        peerId: link.debitId,
        peerBookedAt: time(row.debit_booked_at),
      },
    ]);
  }
  return rows.map((row) => {
    const reductions = byDebit.get(row.id);
    if (reductions) {
      // A reduction nobody can convert counts as nothing, which leaves the
      // purchase at its full price rather than quietly understating spending.
      // The unconvertible link is flagged instead.
      const reduced = reductions.reduce(
        (total, item) =>
          item.convertedMinor === null
            ? total
            : total + BigInt(item.convertedMinor),
        0n,
      );
      const net = BigInt(row.amountMinor) + reduced;
      return {
        ...row,
        refund: {
          role: 'reduced' as const,
          reducedMinor: reduced.toString(),
          netMinor: net.toString(),
          currency: row.currency ?? reductions[0]!.currency,
          approximate: reductions.some((item) => item.approximate),
          provisional: reductions.some((item) => item.provisional),
          fullyReduced: net >= 0n || returnedInFull(reductions),
          reductions,
        },
      };
    }
    const parents = byCredit.get(row.id);
    if (parents)
      return {
        ...row,
        refund: {
          role: 'refund' as const,
          reducedMinor: '0',
          netMinor: row.amountMinor,
          currency: row.currency ?? parents[0]!.currency,
          approximate: false,
          provisional: parents.some((item) => item.provisional),
          fullyReduced: false,
          reductions: parents,
        },
      };
    return row;
  });
}

/** Refund links are changed only by a household member's explicit confirmation. */
export class Refunds {
  constructor(readonly db: Database) {}
  /**
   * `owner` is the member whose account both payments sit on; `actor` is the
   * member confirming the link, and defaults to the owner. Either member may
   * link the other's refund, so the audit event records who actually did.
   */
  async link(input: {
    debitId: string;
    creditId: string;
    expectedDebitRevision: number;
    expectedCreditRevision: number;
    owner: Owner;
    actor?: Owner;
    reason: string;
    origin?: RefundOrigin;
    rule?: string;
    rulesVersion?: number;
    tx?: Executor;
  }): Promise<RefundLink> {
    const {
      debitId,
      creditId,
      expectedDebitRevision,
      expectedCreditRevision,
      owner,
      reason,
    } = input;
    const decidedBy = input.actor ?? owner;
    const origin = input.origin ?? 'manual';
    ownerCheck(owner);
    ownerCheck(decidedBy);
    idCheck(debitId);
    idCheck(creditId);
    revisionCheck(expectedDebitRevision);
    revisionCheck(expectedCreditRevision);
    reasonCheck(reason);
    if (origin !== 'manual' && origin !== 'automatic')
      throw new Error('invalid_refund_origin');
    if (debitId.toLowerCase() === creditId.toLowerCase())
      throw new Error('invalid_refund_pair');
    const run = async (tx: Executor): Promise<RefundLink> => {
      const [debit, credit] = await lockPair(tx, debitId, creditId, owner);
      if (
        Number(debit.revision) !== expectedDebitRevision ||
        Number(credit.revision) !== expectedCreditRevision
      )
        throw new Conflict('stale_revision');
      const reduction = BigInt(String(credit.amount_minor));
      if (BigInt(String(debit.amount_minor)) >= 0n || reduction <= 0n)
        throw new Error('invalid_refund_pair');
      // Automatic matching never crosses accounts or currencies: a reversal lands
      // on the card that was charged, and that is what keeps one member's refund
      // away from the other's identical subscription (ADR 0007). A person may
      // confirm a repayment that arrived elsewhere, in another currency.
      if (
        origin === 'automatic' &&
        (debit.source !== credit.source ||
          debit.account_id !== credit.account_id ||
          debit.currency !== credit.currency)
      )
        throw new Error('invalid_refund_pair');
      const held = await tx.query(
        `SELECT debit_id,credit_id FROM refund_links
         WHERE state='active' AND (credit_id=ANY($1::uuid[]) OR debit_id=$2::uuid)`,
        [[debitId, creditId], creditId],
      );
      if (held.rows.length) throw new Conflict('refund_already_linked');
      // Reductions already attached, measured in the purchase's currency.
      const reduced = (
        await Promise.all(
          (
            await tx.query(
              `SELECT r.reduction_minor,r.currency,c.booked_at FROM refund_links r
               JOIN transactions c ON c.id=r.credit_id
               WHERE r.state='active' AND r.debit_id=$1`,
              [debitId],
            )
          ).rows.map(async (row) =>
            String(row.currency) === String(debit.currency)
              ? BigInt(String(row.reduction_minor))
              : ((await convertedReduction(tx, {
                  amountMinor: String(row.reduction_minor),
                  from: String(row.currency),
                  to: String(debit.currency),
                  occurredAt: String(
                    row.booked_at instanceof Date
                      ? row.booked_at.toISOString()
                      : row.booked_at,
                  ),
                })) ?? 0n),
          ),
        )
      ).reduce((total, item) => total + item, 0n);
      const originalDebit = originalAmount(matchingRow(debit));
      const originalCredit = originalAmount(matchingRow(credit));
      // The guard has to speak the same language as the matcher: a reversal it
      // accepted as belonging to this purchase — the same original amount, or a
      // whisker from it — may still be a few kopiyky more in ledger terms once
      // the rate has moved, and refusing it here would leave the two disagreeing.
      const comparableOriginals =
        originalDebit.currency === originalCredit.currency;
      const charge = -BigInt(originalDebit.amountMinor);
      const returned = BigInt(originalCredit.amountMinor);
      const sameOriginal = comparableOriginals && charge === returned;
      const closeOriginal =
        comparableOriginals && closeAmounts(charge, returned);
      const charged = -BigInt(String(debit.amount_minor));
      // Across currencies the comparison has to happen in the purchase's own
      // currency, which is where the result is counted.
      const converted =
        debit.currency === credit.currency
          ? reduction
          : await convertedReduction(tx, {
              amountMinor: reduction.toString(),
              from: String(credit.currency),
              to: String(debit.currency),
              occurredAt: String(
                credit.booked_at instanceof Date
                  ? credit.booked_at.toISOString()
                  : credit.booked_at,
              ),
            });
      if (converted === null) throw new Error('refund_conversion_unavailable');
      // Money back may exceed the ledger charge when the rate moved between the
      // two dates, or by the whisker a merchant's own rounding leaves behind;
      // anything beyond that would be netting unrelated money.
      if (
        reduced + converted > charged &&
        !sameOriginal &&
        !closeOriginal &&
        !closeAmounts(reduced + converted, charged)
      )
        throw new Error('refund_exceeds_purchase');
      const evidence: RefundEvidence = {
        rule:
          input.rule ??
          (origin === 'manual' ? 'owner_confirmed' : 'exact_original'),
        debitAmountMinor: String(debit.amount_minor),
        creditAmountMinor: String(credit.amount_minor),
        originalDebitMinor: originalDebit.amountMinor,
        originalCreditMinor: originalCredit.amountMinor,
        originalCurrency: originalCredit.currency,
        purchaseCurrency: String(debit.currency),
        ...(input.rulesVersion === undefined
          ? {}
          : { rulesVersion: input.rulesVersion }),
        // A surplus only exists if the merchant gave back more than it took.
        ...((
          comparableOriginals
            ? returned > charge
            : reduced + converted > charged
        )
          ? { fxSurplus: true }
          : {}),
        ...(provisionalPair(matchingRow(credit), matchingRow(debit))
          ? { provisional: true }
          : {}),
      };
      const id = randomUUID();
      const saved = (
        await tx.query(
          `INSERT INTO refund_links(id,owner,state,revision,debit_id,credit_id,reduction_minor,currency,origin,evidence,
            debit_before,credit_before,applied_debit_revision,applied_credit_revision,reason)
          VALUES($1,$2,'active',1,$3,$4,$5::numeric,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            id,
            owner,
            debitId,
            creditId,
            reduction.toString(),
            String(credit.currency),
            origin,
            JSON.stringify(evidence),
            JSON.stringify(classification(debit)),
            JSON.stringify(classification(credit)),
            expectedDebitRevision,
            expectedCreditRevision,
            reason,
          ],
        )
      ).rows[0]!;
      // The purchase is untouched: it keeps the amount the bank recorded and its
      // own classification, and carries the reduction beside it.
      // The actor is who decided: the matcher when it matched, the member who
      // confirmed it otherwise — either of them may confirm the household's
      // link. Reading the history later depends on that difference.
      const actor = origin === 'automatic' ? 'matcher' : decidedBy;
      await audit(
        tx,
        String(debit.id),
        actor,
        'refund_linked',
        {
          amountMinor: String(debit.amount_minor),
          reducedMinor: reduced.toString(),
        },
        {
          amountMinor: String(debit.amount_minor),
          reducedMinor: (reduced + converted).toString(),
          netMinor: (
            BigInt(String(debit.amount_minor)) +
            reduced +
            converted
          ).toString(),
          refundLinkId: id,
          refundLinkRevision: 1,
          origin,
        },
        reason,
      );
      // The credit is not classified. It is explained by the link, counted
      // through the purchase, and left out of browsing, so a classification
      // would only invite the same money to be judged twice.
      await audit(
        tx,
        String(credit.id),
        actor,
        'refund_linked',
        classification(credit),
        {
          ...classification(credit),
          reducesTransactionId: debitId,
          reductionMinor: reduction.toString(),
          reductionCurrency: String(credit.currency),
          refundLinkId: id,
          refundLinkRevision: 1,
          origin,
        },
        reason,
      );
      return linkRow(saved);
    };
    return input.tx ? run(input.tx) : this.db.transaction(run);
  }
  /**
   * `actor` is the member undoing the link. The link belongs to whichever
   * member's account the two payments sit on, and either member may undo the
   * other's, so the owner is read from the link and the audit records the actor.
   */
  async unlink(
    linkId: string,
    expectedLinkRevision: number,
    actor: Owner,
    reason: string,
  ): Promise<RefundLink> {
    ownerCheck(actor);
    idCheck(linkId);
    revisionCheck(expectedLinkRevision);
    reasonCheck(reason);
    return this.db.transaction(async (tx) => {
      const stored = (
        await tx.query('SELECT * FROM refund_links WHERE id=$1 FOR UPDATE', [
          linkId,
        ])
      ).rows[0];
      if (!stored) throw new Error('not_found');
      const owner = String(stored.owner) as Owner;
      if (Number(stored.revision) !== expectedLinkRevision)
        throw new Conflict('stale_refund_revision');
      if (stored.state !== 'active') throw new Conflict('refund_not_active');
      const link = linkRow(stored);
      const [debit, credit] = await lockPair(
        tx,
        link.debitId,
        link.creditId,
        owner,
      );
      // Nothing was written to the credit when it was linked, so nothing has to
      // be restored: it simply becomes unexplained incoming money again.
      await audit(
        tx,
        String(credit.id),
        actor,
        'refund_unlinked',
        {
          ...classification(credit),
          reducesTransactionId: link.debitId,
          reductionMinor: link.reductionMinor,
        },
        {
          ...classification(credit),
          refundLinkId: link.id,
          refundLinkRevision: link.revision + 1,
        },
        reason,
      );
      const remaining = BigInt(
        String(
          (
            await tx.query(
              "SELECT COALESCE(sum(reduction_minor),0) AS total FROM refund_links WHERE state='active' AND debit_id=$1 AND id<>$2 AND currency=$3",
              [link.debitId, link.id, String(debit.currency)],
            )
          ).rows[0]!.total,
        ),
      );
      await audit(
        tx,
        String(debit.id),
        actor,
        'refund_unlinked',
        {
          amountMinor: String(debit.amount_minor),
          reducedMinor: (remaining + BigInt(link.reductionMinor)).toString(),
        },
        {
          amountMinor: String(debit.amount_minor),
          reducedMinor: remaining.toString(),
          netMinor: (BigInt(String(debit.amount_minor)) + remaining).toString(),
          refundLinkId: link.id,
          refundLinkRevision: link.revision + 1,
        },
        reason,
      );
      return linkRow(
        (
          await tx.query(
            "UPDATE refund_links SET state='unlinked',revision=revision+1,unlinked_at=now() WHERE id=$1 RETURNING *",
            [linkId],
          )
        ).rows[0]!,
      );
    });
  }
  async list(owner: Owner): Promise<RefundLink[]> {
    ownerCheck(owner);
    return (
      await this.db.query(
        'SELECT * FROM refund_links WHERE owner=$1 ORDER BY created_at DESC,id',
        [owner],
      )
    ).rows.map(linkRow);
  }
  /**
   * Purchases an incoming credit could be returning. The same rules that link
   * automatically produce this list, so a manual decision sees what the matcher
   * saw, including the original amounts it compared.
   */
  async candidates(owner: Owner, creditId: string): Promise<RefundCandidate[]> {
    ownerCheck(owner);
    idCheck(creditId);
    const credit = (
      await this.db.query(
        `SELECT t.*,(SELECT COALESCE(sum(r.reduction_minor),0) FROM refund_links r WHERE r.state='active' AND r.debit_id=t.id) AS reduced_minor
         FROM transactions t WHERE t.id=$1 AND t.owner=$2`,
        [creditId, owner],
      )
    ).rows[0];
    if (!credit) throw new Error('not_found');
    if (BigInt(String(credit.amount_minor)) <= 0n) return [];
    const debits = (
      await this.db.query(
        `SELECT t.*,(SELECT COALESCE(sum(r.reduction_minor),0) FROM refund_links r WHERE r.state='active' AND r.debit_id=t.id) AS reduced_minor
         FROM transactions t
         WHERE t.owner=$1 AND t.source=$2 AND t.account_id=$3 AND t.currency=$4
           AND t.amount_minor<0 AND t.booked_at<=$5::timestamptz+interval '3 days'
           AND t.booked_at>=$5::timestamptz-interval '120 days'
           AND NOT EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND r.credit_id=t.id)
         ORDER BY t.booked_at,t.id`,
        [
          owner,
          credit.source,
          credit.account_id,
          credit.currency,
          credit.booked_at,
        ],
      )
    ).rows;
    return refundCandidates(matchingRow(credit), debits.map(matchingRow)).map(
      (match) => {
        const row = debits.find((item) => String(item.id) === match.debit.id)!;
        return {
          id: match.debit.id,
          revision: Number(row.revision),
          bookedAt: match.debit.bookedAt,
          amountMinor: match.debit.amountMinor,
          currency: match.debit.currency,
          description: match.debit.description,
          source: match.debit.source,
          accountId: match.debit.accountId,
          kind: match.debit.kind as Kind,
          category: match.debit.category,
          remainingMinor: remainingMinor(match.debit).toString(),
          originalAmountMinor: match.original.amountMinor,
          originalCurrency: match.original.currency,
          exactOriginal: match.exactOriginal,
        };
      },
    );
  }
}
