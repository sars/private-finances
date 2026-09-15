import { randomUUID } from 'node:crypto';
import type { Executor } from './database.js';
import { readMcc } from './mcc.js';
import { MCC_CATEGORY } from './category-migration.js';
import {
  kindForPurpose,
  matchCounterparty,
  type CounterpartyMatch,
} from './counterparty-identity.js';
import { knownCounterparty } from './known-counterparties.js';

/**
 * Where a payment nobody has decided comes to rest (ADR 0008, decision C7).
 *
 * The owner's complaint was concrete: hundreds of payments sat unresolved, they
 * would not review them one by one, and their 2026 spending total was therefore
 * incomplete. Their reasoning for the fix was equally concrete — most money
 * leaving an account they have marked personal *is* personal spending, apart
 * from the few cases already known to be investments or business.
 *
 * So every outflow on a personal-purpose account that no earlier stage decided
 * becomes a personal expense on the most specific category its evidence
 * supports, and is marked **provisional**: counted in every total, shown as a
 * category, and flagged as undecided everywhere it appears. Provisional is the
 * honest half. Without it this would be a system that quietly invents
 * categories; with it the money is counted while the uncertainty stays
 * visible, which is what keeps `unresolved is shown as incompleteness, not
 * hidden` true in spirit as well as in letter.
 *
 * Nothing here overrides a person. Nothing here touches an account whose
 * purpose is still `unreviewed`, because "a personal account holds personal
 * spending" says nothing about an account nobody has described.
 *
 * A payment the bank is still holding is swept like any other. It used to be
 * skipped, on the reading that an unsettled amount is not yet spending. That is
 * false for Monobank: the money is deducted at authorisation, the balance in
 * the bank's own payload runs straight through these rows, and the `hold` flag
 * never flips back for foreign merchants — 99 of them had sat uncategorised for
 * up to a year waiting for a settlement that does not arrive. Where a hold is
 * genuinely revised later, the amount changes on the row and the placement
 * follows it, which is the same path a correction already took.
 */

export const RESTING_PLACE_POLICY = 'resting_place:v1';

/** Every way a payment's current classification came to be. `none` is an
 * undecided payment; `default` is the resting place with no better evidence. */
export const CLASSIFICATION_SOURCES = [
  'human',
  'identity',
  'rule',
  'memory',
  'model',
  'mcc',
  'account_policy',
  'default',
  'none',
] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export type RestingPlaceReport = {
  /** Placed as an internal transfer or the target account's kind, because the
   * counterparty is a household account. Not provisional: identity is evidence,
   * not a guess. */
  identified: number;
  /** Settled by a counterparty the bank names in its own words: the State
   * Treasury, or a movement between the household's own accounts. */
  bankWorded: number;
  /** Rested on the leaf the merchant category code implies. */
  byMcc: number;
  /** Rested on a category the model had already proposed with enough confidence. */
  byStoredModel: number;
  /** Rested in the root catch-all because nothing said anything. */
  byDefault: number;
  /** Examined and deliberately left alone, with the reason. */
  skipped: Record<string, number>;
};

/**
 * Payments the sweep must not touch, each for a different reason.
 *
 * A person's decision is final. A pending explanation means the owner is in the
 * middle of answering. Cash is entered by hand, so it was never undecided by
 * accident.
 *
 * A matched receipt is deliberately **not** a reason to skip a payment. An
 * earlier version of this held receipted payments back, on the reasoning that
 * their evidence was still arriving; the owner rejected the framing outright —
 * a receipt "is just additional source for categorisation", and if a payment was
 * already categorised then an arriving receipt simply updates it. Holding a
 * payment out of the totals until a photograph has been read is the opposite of
 * what they asked for. The payment rests on what is known now, and the receipt
 * improves that answer when it comes, because a provisional placement is an
 * automatic decision and `ReceiptCategorization` revisits those while leaving a
 * person's alone. A receipt that cannot be read tells the owner so rather than
 * leaving the payment in limbo.
 *
 * A credit absorbed by a refund is already counted through the purchase it
 * reduced, and classifying it would count the same money twice.
 */
const EXCLUSIONS = `
  AND t.source <> 'manual_cash'
  AND NOT EXISTS(SELECT 1 FROM audit_events a
                 WHERE a.transaction_id=t.id AND a.event='classified')
  AND NOT EXISTS(SELECT 1 FROM transaction_explanations e
                 WHERE e.transaction_id=t.id AND e.revision=t.revision
                   AND e.status='pending')
  AND NOT EXISTS(SELECT 1 FROM refund_links l
                 WHERE l.state='active' AND l.credit_id=t.id)`;

async function audit(
  tx: Executor,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  reason: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
     VALUES($1,$2,'resting_place','auto_classified',$3,$4,$5)`,
    [
      randomUUID(),
      id,
      JSON.stringify(before),
      JSON.stringify({ ...after, policy: RESTING_PLACE_POLICY }),
      reason,
    ],
  );
}

/**
 * Run the sweep. Idempotent: a payment it has already placed no longer matches,
 * because placing it stops it being undecided.
 *
 * `from` bounds it by booking date when the caller wants only recent money; the
 * owner asked for the whole ledger, so the default is everything.
 */
export async function restPlacements(
  tx: Executor,
  options: { from?: string } = {},
): Promise<RestingPlaceReport> {
  const report: RestingPlaceReport = {
    identified: 0,
    bankWorded: 0,
    byMcc: 0,
    byStoredModel: 0,
    byDefault: 0,
    skipped: {},
  };
  const from = options.from ?? null;

  const catchAll = (
    await tx.query("SELECT id FROM category_tree WHERE slug='unspecified'")
  ).rows[0];
  if (!catchAll) throw new Error('resting_place_catch_all_missing');
  const leaves = new Map(
    (
      await tx.query(
        `SELECT slug, id FROM category_tree
         WHERE NOT EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=category_tree.id)`,
      )
    ).rows.map((row) => [String(row.slug), String(row.id)]),
  );

  // Identity first: a counterparty that is one of the household's own accounts
  // settles the kind outright, and that is stronger than any category guess.
  const candidates = (
    await tx.query(
      `SELECT t.id, t.owner, t.source, t.account_id, t.source_details,
              t.amount_minor, t.revision, t.kind, t.description
       FROM transactions t
       JOIN own_accounts a
         ON a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id
       WHERE t.amount_minor < 0
         AND a.purpose='personal'
         AND t.kind='unresolved'
         AND ($1::timestamptz IS NULL OR t.booked_at >= $1)
         ${EXCLUSIONS}
       ORDER BY t.booked_at, t.id
       FOR UPDATE OF t`,
      [from],
    )
  ).rows;

  for (const row of candidates) {
    const id = String(row.id);
    const details = row.source_details as Record<string, unknown> | undefined;

    const identity = await identifiedKind(tx, row);
    if (identity) {
      await tx.query(
        `UPDATE transactions SET kind=$1, provisional=false,
           classification_source='identity', revision=revision+1, updated_at=now()
         WHERE id=$2`,
        [identity.kind, id],
      );
      await audit(
        tx,
        id,
        { kind: 'unresolved' },
        { kind: identity.kind, source: 'identity', via: identity.via },
        `${EVIDENCE[identity.via]}, so this is ${identity.kind.replaceAll('_', ' ')}`,
      );
      report.identified++;
      continue;
    }

    // A counterparty the bank names in its own words: the State Treasury, or a
    // movement between the household's own accounts. Both look like undecided
    // transfers to every earlier stage, and both would otherwise come to rest as
    // personal spending — which is how a tax payment became the largest expense
    // of the year.
    const worded = knownCounterparty(row.description, details);
    if (worded) {
      await tx.query(
        `UPDATE transactions SET kind=$1, provisional=$2,
           classification_source='rule', revision=revision+1, updated_at=now()
         WHERE id=$3`,
        [worded.kind, worded.provisional, id],
      );
      await audit(
        tx,
        id,
        { kind: 'unresolved' },
        {
          kind: worded.kind,
          source: 'rule',
          provisional: worded.provisional,
        },
        worded.reason,
      );
      report.bankWorded++;
      continue;
    }

    const mcc = readMcc(details);
    // A money-transfer code describes the rail, not a purchase, so it may set no
    // category — those are exactly the payments that rest in the catch-all.
    const mccLeaf =
      mcc && !mcc.financialTransfer
        ? leaves.get(MCC_CATEGORY[mcc.code] ?? '')
        : undefined;
    const stored = mccLeaf ? undefined : await storedModelLeaf(tx, row);

    const category = mccLeaf ?? stored?.id ?? String(catchAll.id);
    const source = mccLeaf ? 'mcc' : stored ? 'model' : 'default';
    const reason = mccLeaf
      ? `Merchant category ${mcc!.code} (${mcc!.meaning}) implies this category; nobody has confirmed it`
      : stored
        ? `A model proposal for this payment at confidence ${stored.confidence} placed it here; nobody has confirmed it`
        : 'Nothing in the payment says what it was for, so it rests in the catch-all as spending from a personal account';

    await tx.query(
      `UPDATE transactions SET kind='personal_expense', category_id=$1,
         provisional=true, classification_source=$2,
         revision=revision+1, updated_at=now()
       WHERE id=$3`,
      [category, source, id],
    );
    await audit(
      tx,
      id,
      { kind: 'unresolved', category: null },
      {
        kind: 'personal_expense',
        categoryId: category,
        source,
        provisional: true,
      },
      reason,
    );
    if (mccLeaf) report.byMcc++;
    else if (stored) report.byStoredModel++;
    else report.byDefault++;
  }

  // Counted for the report only: what the sweep declined to touch, and why.
  for (const [reason, clause] of [
    [
      'human_decision',
      "EXISTS(SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event='classified')",
    ],
    [
      'pending_explanation',
      "EXISTS(SELECT 1 FROM transaction_explanations e WHERE e.transaction_id=t.id AND e.revision=t.revision AND e.status='pending')",
    ],
    ['cash', "t.source='manual_cash'"],
  ] as const) {
    const counted = (
      await tx.query(
        `SELECT count(*)::int AS count FROM transactions t
         JOIN own_accounts a
           ON a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id
         WHERE t.amount_minor < 0 AND a.purpose='personal'
           AND t.kind='unresolved'
           AND ($1::timestamptz IS NULL OR t.booked_at >= $1)
           AND ${clause}`,
        [from],
      )
    ).rows[0];
    const count = Number(counted?.count ?? 0);
    if (count) report.skipped[reason] = count;
  }
  return report;
}

/**
 * Revisit what the sweep has already placed, now that two bank-worded
 * counterparties are recognised.
 *
 * The envelope is the one `reidentifyTransfers` establishes, and for the same
 * reason: only a decision a person made is protected. A confident automatic
 * placement used to be protected too, which meant a payment some earlier pass
 * had settled as a personal expense was permanently out of reach — even though
 * the bank names its counterparty in its own words, and that wording is not a
 * guess. Recognising the State Treasury on a payment the model had already
 * filed is exactly the correction this exists to make.
 */
export async function correctBankWordedPlacements(
  tx: Executor,
): Promise<{ treasury: number; ownAccount: number }> {
  const corrected = { treasury: 0, ownAccount: 0 };
  const candidates = await tx.query<{
    id: string;
    kind: string;
    description: string;
    source_details: Record<string, unknown> | undefined;
  }>(
    `SELECT t.id, t.kind, t.description, t.source_details
     FROM transactions t
     WHERE t.amount_minor < 0
       AND NOT EXISTS(SELECT 1 FROM audit_events a
                      WHERE a.transaction_id=t.id AND a.event='classified')
     ORDER BY t.booked_at, t.id`,
  );
  for (const row of candidates.rows) {
    const worded = knownCounterparty(row.description, row.source_details);
    if (!worded || worded.kind === row.kind) continue;
    await tx.query(
      `UPDATE transactions SET kind=$1, category_id=NULL, provisional=$2,
         classification_source='rule', revision=revision+1, updated_at=now()
       WHERE id=$3`,
      [worded.kind, worded.provisional, row.id],
    );
    await audit(
      tx,
      row.id,
      { kind: row.kind },
      { kind: worded.kind, source: 'rule', provisional: worded.provisional },
      worded.reason,
    );
    if (worded.kind === 'non_personal') corrected.treasury++;
    else corrected.ownAccount++;
  }
  return corrected;
}

/** The kind a registered household counterparty settles, or null when the
 * evidence is absent or ambiguous. Mirrors `Accounts.suggestions` deliberately:
 * the same hash, the same ambiguity rules, applied rather than merely offered. */
async function identifiedKind(
  tx: Executor,
  row: Record<string, unknown>,
): Promise<{
  kind: 'internal_transfer' | 'investment' | 'non_personal';
  via: CounterpartyMatch['via'];
} | null> {
  const match = await matchCounterparty(tx, row);
  // An identifier claimed by two accounts settles nothing, so the payment goes
  // on to rest on its evidence rather than being filed against a guess.
  if (!match?.account) return null;
  return { kind: kindForPurpose(match.account.purpose), via: match.via };
}

/** Why a transfer was taken to be household money, in the owner's terms. */
const EVIDENCE: Record<CounterpartyMatch['via'], string> = {
  iban: 'The counterparty account is one of ours',
  card: 'The card this went to is one of ours',
  name: 'This recipient has been shown to be one of our own accounts by transfers that matched on both sides',
};

/** A category the model already proposed for this exact revision, confident
 * enough to rest on. Reuses work already paid for rather than asking again. */
async function storedModelLeaf(
  tx: Executor,
  row: Record<string, unknown>,
): Promise<{ id: string; confidence: number } | null> {
  const stored = (
    await tx.query(
      `SELECT q.decision FROM transaction_triage q
       WHERE q.transaction_id=$1 AND q.revision=$2 AND q.state='ready'
       ORDER BY q.created_at DESC LIMIT 1`,
      [String(row.id), Number(row.revision)],
    )
  ).rows[0];
  const decision = stored?.decision as Record<string, unknown> | undefined;
  if (!decision || decision.kind !== 'personal_expense') return null;
  const confidence = Number(decision.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.7) return null;
  const path = decision.category;
  if (typeof path !== 'string' || !path.trim()) return null;
  const found = (
    await tx.query(
      `SELECT id FROM category_tree
       WHERE lower(category_path(id))=lower($1)
         AND NOT EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=category_tree.id)`,
      [path],
    )
  ).rows[0];
  if (!found) return null;
  return { id: String(found.id), confidence };
}

/**
 * Schema for provisional placement. Additive, so an existing database keeps
 * every classification it already had; `classification_source` is then
 * backfilled from the audit trail so the coverage figures mean something for
 * history too.
 */
export async function installRestingPlace(tx: Executor): Promise<void> {
  await tx.query(
    'ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false',
  );
  await tx.query(
    `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS classification_source text NOT NULL DEFAULT 'none'`,
  );
  const present = await tx.query(
    "SELECT 1 FROM pg_constraint WHERE conname='transactions_classification_source'",
  );
  if (!present.rows.length)
    await tx.query(
      `ALTER TABLE transactions ADD CONSTRAINT transactions_classification_source
       CHECK(classification_source IN (${CLASSIFICATION_SOURCES.map((s) => `'${s}'`).join(',')}))`,
    );
  // A provisional payment is a placement, never a decision, so it cannot be
  // provisional and unresolved at once, and a human decision is never
  // provisional.
  const guard = await tx.query(
    "SELECT 1 FROM pg_constraint WHERE conname='transactions_provisional_is_placed'",
  );
  if (!guard.rows.length)
    await tx.query(
      `ALTER TABLE transactions ADD CONSTRAINT transactions_provisional_is_placed
       CHECK(NOT provisional OR (kind <> 'unresolved' AND classification_source <> 'human'))`,
    );
  // Backfill provenance from the audit trail: the latest decision wins, a
  // person's beats a machine's, and the policy recorded on an automatic
  // decision says which machine it was.
  await tx.query(`UPDATE transactions t SET classification_source = CASE
      WHEN EXISTS(SELECT 1 FROM audit_events a
                  WHERE a.transaction_id=t.id AND a.event='classified') THEN 'human'
      WHEN t.kind='unresolved' THEN 'none'
      ELSE COALESCE((
        SELECT CASE
          WHEN a.actor='account_policy' THEN 'account_policy'
          WHEN a.actor='migration' THEN 'mcc'
          WHEN a.after_value->'provenance'->>'policy' LIKE 'receipt_categories%' THEN 'model'
          WHEN a.after_value->'provenance'->'decision'->>'source'='confirmed_rule' THEN 'rule'
          ELSE 'model' END
        FROM audit_events a
        WHERE a.transaction_id=t.id
          AND a.event IN ('auto_classified','account_policy_applied')
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1), 'model')
    END
    WHERE t.classification_source='none'`);
}
