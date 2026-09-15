import { createHash, randomUUID } from 'node:crypto';
import type { Executor } from './database.js';
import { readMcc } from './mcc.js';

/**
 * Who a transfer went to, when the bank says only a name.
 *
 * A transfer between the household's own accounts must not be counted as
 * spending. Three things can say that a payment is household money, and they
 * are tried strongest first.
 *
 * An **identifier the provider states** — an IBAN — is conclusive, but most of
 * these payments carry none: of 587 outgoing money-transfer payments on
 * production, only about a third have a counterparty IBAN, and those are
 * largely the business ones already settled by their account's purpose.
 *
 * A **masked card number in the payment's own text** identifies a card exactly.
 * This is real but small, and measurement is the only reason that is known: 38
 * payments in a ledger of 4,064 name a card, across 28 distinct cards, and 22 of
 * those cards appear exactly once. The number the bank prints is the *other*
 * party's card, and the other party is usually a stranger being paid once. One
 * card recurs, and it is the household's own. So this path is worth keeping —
 * it is a few lines and it is exactly right when it fires — but it settles a
 * handful of payments, not a category of them.
 *
 * A **recipient's name** is everything else, and it is the ordinary case. A name
 * cannot be verified, because the bank gives no account behind it. It is simply
 * a statement the owner has made: payments to this name are our own money. Those
 * statements come from two places, and neither asks the owner to do anything
 * new. The classification rules they already wrote supply the names they have
 * declared — on production two of them reach 127 payments. And whenever they
 * categorise a transfer by hand, the counterparty on it is remembered, so the
 * next payment to the same person is answered without them. That is the owner's
 * own plan for this: "if any problem — i can manually recategorize it."
 * Remembering it means they do so once rather than every month.
 *
 * Names and cards are remembered on a **normalised key** rather than the exact
 * string the bank printed, which is the point of holding them here instead of
 * leaving them to the rules. A rule matches `match_value = t.description`
 * exactly, so `Катерина Б.` and `КАТЕРИНА Б` would need two rules for one
 * person, and the rule list grows without bound — a problem the owner has
 * already raised. One normalised entry covers every spelling.
 *
 * What is deliberately **not** here is matching by amount. An earlier version
 * learned a recipient's identity by finding the same amount arrive on another of
 * our accounts. The owner had it removed, for a decisive reason: the system does
 * not hold all of the household's accounts. Kate has cards at banks it never
 * sees, so the other half of a genuine transfer is frequently absent, while a
 * pair that does turn up may be two unrelated payments that happen to match.
 * Evidence that is missing for the real cases and misleading for the rest is
 * worse than no evidence, because it takes real spending out of the totals.
 *
 * Nothing here is hidden from the owner. A name is stored as text, not a digest,
 * because the same text already sits in plain view on the payment's own bank
 * payload and because the owner asked to be able to see and correct how
 * classification decides. Card numbers registered against an account are stored
 * only as a digest, because the owner's rule is that account identifiers stay
 * private and carry no meaning worth reading back.
 */

/** What a payment to a counterparty the owner has identified turns out to be. */
export type TransferKind = 'internal_transfer' | 'investment' | 'non_personal';
const TRANSFER_KINDS: readonly string[] = [
  'internal_transfer',
  'investment',
  'non_personal',
];

/**
 * A matching key for a masked card number: the issuer digits and the last four,
 * which is all any statement discloses and enough to tell cards apart.
 *
 * `537541******1234` and `537541****1234` are the same card described with
 * different padding, so both reduce to the same key. Fewer than four leading
 * digits is not enough — the last four alone collide across cards — and such a
 * value is rejected rather than guessed at.
 */
export function cardKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match =
    /^\s*(\d{4,8})[^0-9A-Za-z]*[*xX•·]{2,}[^0-9A-Za-z]*(\d{4})\s*$/.exec(raw);
  if (!match) return null;
  const [, lead, tail] = match;
  return `${lead!.slice(0, 6)}-${tail!}`;
}

/**
 * A matching key for a recipient's name as the bank wrote it.
 *
 * Only case, punctuation and spacing are normalised away, which is what lets one
 * entry cover `Катерина Б.`, `КАТЕРИНА Б` and `Катерина  Б.`. Two different
 * spellings of a name are deliberately *not* merged any further — `катерина б`
 * stays distinct from a full surname — because merging two people would file one
 * person's money under another's, and the cost of missing a match is only that
 * the owner categorises it once more.
 */
export function recipientKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (cardKey(raw)) return null; // A card number goes through the card path.
  const key = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  // A single token is too weak to name a person, and an over-long string is a
  // payment narrative rather than a recipient.
  if (key.length < 4 || key.length > 120) return null;
  if (!/\p{L}/u.test(key)) return null;
  if (key.split(' ').length < 2) return null;
  return key;
}

/** Same digest shape as the account registry, so the two cannot drift apart. */
function cardHash(key: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['card', '', key]))
    .digest('hex');
}

export async function installCounterpartyIdentity(tx: Executor): Promise<void> {
  // One account owns several identifiers: an IBAN, and a card number for each
  // card on it. The key is the digest itself, so one identifier can never
  // resolve to two accounts — ambiguity is refused by the schema.
  await tx.query(`CREATE TABLE IF NOT EXISTS own_account_identifiers (
      identifier_hash text PRIMARY KEY CHECK(identifier_hash ~ '^[a-f0-9]{64}$'),
      scheme text NOT NULL CHECK(scheme IN ('iban','card','opaque')),
      source text NOT NULL, account_id text NOT NULL,
      registered_by text NOT NULL CHECK(registered_by IN ('provider','owner')),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(source,account_id) REFERENCES own_accounts(source,account_id) ON DELETE CASCADE
    )`);
  // Every IBAN already registered against an account becomes a row in the
  // registry, so matching has one place to look while the older column stays
  // what the owner sees in Accounts rather than a second matching path.
  await tx.query(`INSERT INTO own_account_identifiers(identifier_hash,scheme,source,account_id,registered_by)
    SELECT identifier_hash,'iban',source,account_id,'provider' FROM own_accounts
    WHERE identifier_hash IS NOT NULL
    ON CONFLICT DO NOTHING`);
}

/**
 * Register the card numbers a provider publishes for one of our accounts.
 *
 * Monobank states these per account, so the household's own cards are known
 * without anybody typing them. A value that is not a masked card number is
 * skipped rather than stored, and a key already registered to another account is
 * left alone, because a card cannot belong to two accounts and the first
 * registration is the one with a provider behind it.
 */
export async function registerCards(
  tx: Executor,
  account: { source: string; accountId: string },
  masked: readonly unknown[],
): Promise<number> {
  let registered = 0;
  for (const raw of masked) {
    const key = cardKey(raw);
    if (!key) continue;
    const result = await tx.query(
      `INSERT INTO own_account_identifiers(identifier_hash,scheme,source,account_id,registered_by)
       VALUES($1,'card',$2,$3,'provider') ON CONFLICT DO NOTHING
       RETURNING identifier_hash`,
      [cardHash(key), account.source, account.accountId],
    );
    registered += result.rows.length;
  }
  return registered;
}

/**
 * Remember what the owner just decided about a counterparty, as a rule.
 *
 * This used to write to a table of its own. The owner asked why, given that
 * rules already say "payments matching this text are of this kind", and they
 * were right: nine entries existed across nine distinct spellings, so the
 * spelling-insensitive matching that justified a second store was doing no work
 * at all, while a parallel store meant two places to look, two to edit and two
 * interfaces to build — in a system whose rule list the owner has already
 * complained is too long.
 *
 * So the knowledge lands in the one place that holds this kind of knowledge,
 * and becomes visible through the rule editor rather than needing a screen of
 * its own. Only money transfers teach anything: a name inside a purchase
 * narrative describes a shop, not a recipient. And deciding that a transfer is
 * ordinary spending after all retires the rule, so a mistake is undone by the
 * same action that made it.
 */
export async function rememberCounterparty(
  tx: Executor,
  row: { owner?: unknown; source_details?: unknown },
  kind: string,
): Promise<void> {
  const details = (row.source_details ?? {}) as Record<string, unknown>;
  if (readMcc(details)?.financialTransfer !== true) return;
  const description = details.description;
  if (typeof description !== 'string' || !description.trim()) return;
  // A payment has to name somebody for a rule about them to mean anything.
  if (!cardKey(description) && !recipientKey(description)) return;
  const owner = String(row.owner ?? '');
  if (owner !== 'rodion' && owner !== 'katya') return;

  const existing = (
    await tx.query<{ id: string; kind: string; active: boolean }>(
      `SELECT id, kind, active FROM classification_rules
       WHERE match_field='description'
         AND lower(btrim(regexp_replace(match_value, '[^[:alnum:]]+', ' ', 'g')))
           = lower(btrim(regexp_replace($1, '[^[:alnum:]]+', ' ', 'g')))
       ORDER BY (match_value = $1) DESC
       LIMIT 1`,
      [description],
    )
  ).rows[0];

  if (!TRANSFER_KINDS.includes(kind)) {
    // Not household money after all. The rule is retired rather than deleted,
    // so the audit trail still shows it once existed.
    if (existing && TRANSFER_KINDS.includes(existing.kind) && existing.active)
      await tx.query(
        'UPDATE classification_rules SET active=false WHERE id=$1',
        [existing.id],
      );
    return;
  }
  if (existing) {
    if (existing.kind === kind && existing.active) return;
    await tx.query(
      'UPDATE classification_rules SET kind=$1, category_id=NULL, active=true WHERE id=$2',
      [kind, existing.id],
    );
    return;
  }
  await tx.query(
    `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,category_id,active)
     VALUES($1,$2,1,'description',$3,$4,NULL,true)`,
    [randomUUID(), owner, description, kind],
  );
}

/**
 * Move what the short-lived counterparty store held into the owner's rules, and
 * drop it.
 *
 * Each entry was already a statement of theirs — taken from a rule they wrote,
 * or from a transfer they categorised — so each becomes a rule. An entry that
 * came from a rule in the first place finds its rule still there and adds
 * nothing. A name key was stored normalised, so the rule it produces carries
 * the spelling of a payment that actually matches it rather than the flattened
 * key, which is what a person reading the rule list needs to see. That lookup
 * must normalise with `btrim`: punctuation becomes a trailing space, so
 * "Катерина Б." flattens to "катерина б " and would match no stored key — the
 * rule then reads as "катерина б" rather than as the bank wrote it. The same
 * omission has now bitten this file three times, which is why every
 * normalisation here is spelled out the same way.
 */
export async function retireCounterpartyMemory(tx: Executor): Promise<number> {
  const present = await tx.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_name='counterparty_memory'`,
  );
  if (!present.rows.length) return 0;
  const entries = await tx.query<{
    match_key: string;
    kind: string;
    spelling: string | null;
    owner: string | null;
  }>(
    `SELECT m.match_key, m.kind,
            -- The wording of a payment this entry actually matches, and the
            -- account owner it belongs to, so the rule reads naturally.
            (SELECT coalesce(t.source_details->>'description', t.description)
             FROM transactions t
             WHERE lower(btrim(regexp_replace(
                     coalesce(t.source_details->>'description', t.description),
                     '[^[:alnum:]]+', ' ', 'g'))) = m.match_key
             ORDER BY t.booked_at DESC LIMIT 1) AS spelling,
            (SELECT t.owner FROM transactions t
             WHERE lower(btrim(regexp_replace(
                     coalesce(t.source_details->>'description', t.description),
                     '[^[:alnum:]]+', ' ', 'g'))) = m.match_key
             ORDER BY t.booked_at DESC LIMIT 1) AS owner
     FROM counterparty_memory m`,
  );
  let moved = 0;
  for (const entry of entries.rows) {
    const value = entry.spelling ?? entry.match_key;
    const owner = entry.owner === 'katya' ? 'katya' : 'rodion';
    // Compared the way matching compares, not by exact text. An exact check
    // would miss a rule that differs only in punctuation or case and create a
    // near-duplicate beside it — which is the rule proliferation this change
    // exists to avoid.
    const already = await tx.query(
      `SELECT 1 FROM classification_rules
       WHERE match_field='description'
         AND lower(btrim(regexp_replace(match_value, '[^[:alnum:]]+', ' ', 'g')))
           = lower(btrim(regexp_replace($1, '[^[:alnum:]]+', ' ', 'g')))`,
      [value],
    );
    if (already.rows.length) continue;
    await tx.query(
      `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,category_id,active)
       VALUES($1,$2,1,'description',$3,$4,NULL,true)`,
      [randomUUID(), owner, value, entry.kind],
    );
    moved++;
  }
  await tx.query('DROP TABLE counterparty_memory');
  return moved;
}

export type CounterpartyMatch = {
  /**
   * What a payment to this counterparty is, or `null` when two accounts claim
   * the same identifier.
   *
   * Ambiguity is reported rather than resolved. Picking whichever row came first
   * would file one account's money under another's, and the owner would have no
   * way of knowing it happened.
   */
  kind: TransferKind | null;
  /** Which evidence resolved it, for the audit trail the owner reads. */
  via: 'iban' | 'card' | 'name';
  /** Present only when an actual account of ours was identified. */
  account?: { source: string; accountId: string; purpose: string };
};

/**
 * What a payment's counterparty resolves to, if anything.
 *
 * Evidence is tried strongest first: an identifier the provider stated, then the
 * card digits in the payment's own text, then what the owner has said about the
 * counterparty. Only a money-transfer payment is matched by its text, because a
 * name in a purchase narrative describes a shop rather than a person.
 */
export async function matchCounterparty(
  tx: Executor,
  row: {
    source?: unknown;
    account_id?: unknown;
    amount_minor?: unknown;
    source_details?: unknown;
  },
): Promise<CounterpartyMatch | null> {
  const details = (row.source_details ?? {}) as Record<string, unknown>;
  // Money leaving names its creditor; money arriving names its debtor. Reading
  // the wrong side would match nothing, which is how this went unnoticed before.
  const amount = BigInt(String(row.amount_minor ?? 0));
  const side =
    amount < 0n
      ? details.creditor_account
      : amount > 0n
        ? details.debtor_account
        : undefined;
  const iban =
    details.counterIban ??
    (side && typeof side === 'object' && !Array.isArray(side)
      ? (side as Record<string, unknown>).iban
      : undefined);
  const { identifierHashFor } = await import('./accounts.js');
  const attempts: { via: CounterpartyMatch['via']; hash: string }[] = [];
  // An identifier a provider stated outright, whatever its scheme. This is the
  // strongest evidence there is and is tried first.
  if (details.counterpartyAccountIdentifier !== undefined) {
    try {
      attempts.push({
        via: 'iban',
        hash: identifierHashFor(details.counterpartyAccountIdentifier),
      });
    } catch {
      // Provider metadata that is not an identifier is not evidence.
    }
  }
  if (typeof iban === 'string') {
    try {
      attempts.push({
        via: 'iban',
        hash: identifierHashFor({ scheme: 'iban', value: iban }),
      });
    } catch {
      // A value in the IBAN position that is not an IBAN is not evidence.
    }
  }
  const transfer = readMcc(details)?.financialTransfer === true;
  const description = details.description;
  const card = transfer
    ? (cardKey(description) ?? cardKey(details.comment))
    : null;
  if (card) attempts.push({ via: 'card', hash: cardHash(card) });
  for (const attempt of attempts) {
    const found = await resolve(tx, row, attempt.via, attempt.hash);
    if (found) return found;
  }
  if (!transfer) return null;
  // Nothing the provider stated resolved it, so fall back to what the owner has
  // said in their rules about this counterparty. The comparison is on a
  // normalised key rather than the bank's exact string, which is the one thing
  // the short-lived separate store did better and is cheap to keep here.
  const key = card ?? recipientKey(description);
  if (!key) return null;
  const known = (
    await tx.query<{ kind: string }>(
      `SELECT r.kind FROM classification_rules r
       WHERE r.active AND r.match_field='description'
         AND r.kind IN ('internal_transfer','investment','non_personal')
         AND (r.match_value = $1
              -- btrim matters: the full stop in "Катерина Б." becomes a
              -- trailing space, which would never equal the trimmed key.
              OR lower(btrim(regexp_replace(r.match_value, '[^[:alnum:]]+', ' ', 'g')))
                 = $2)
       ORDER BY (r.match_value = $1) DESC
       LIMIT 1`,
      [description ?? '', normalise(String(description ?? ''))],
    )
  ).rows[0];
  if (!known) return null;
  return { kind: known.kind as TransferKind, via: card ? 'card' : 'name' };
}

/** The same normalisation `recipientKey` applies, for comparing a rule's text
 * to a payment's without either having to store a second copy of it. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function resolve(
  tx: Executor,
  row: { source?: unknown; account_id?: unknown },
  via: CounterpartyMatch['via'],
  hash: string,
): Promise<CounterpartyMatch | null> {
  // Both places are consulted and the results unioned. The registry refuses one
  // identifier twice, but an account row registered before it existed can still
  // carry the same identifier as another account — a genuine ambiguity the owner
  // needs to see, not something to be swallowed by a primary key.
  const candidates = (
    await tx.query<{ source: string; account_id: string }>(
      `SELECT source,account_id FROM own_account_identifiers WHERE identifier_hash=$1
       UNION
       SELECT source,account_id FROM own_accounts WHERE identifier_hash=$1`,
      [hash],
    )
  ).rows;
  if (!candidates.length) return null;
  if (candidates.length > 1) return { kind: null, via };
  const account = candidates[0]!;
  return own(tx, row, account.source, account.account_id, via);
}

async function own(
  tx: Executor,
  row: { source?: unknown; account_id?: unknown },
  source: string,
  accountId: string,
  via: CounterpartyMatch['via'],
): Promise<CounterpartyMatch | null> {
  // A payment whose counterparty is the account it already sits on is a provider
  // quirk, not a transfer.
  if (source === String(row.source) && accountId === String(row.account_id))
    return null;
  const account = (
    await tx.query<{ purpose: string }>(
      'SELECT purpose FROM own_accounts WHERE source=$1 AND account_id=$2',
      [source, accountId],
    )
  ).rows[0];
  if (!account || account.purpose === 'unreviewed') return null;
  return {
    kind: kindForPurpose(account.purpose),
    via,
    account: { source, accountId, purpose: account.purpose },
  };
}

export type ReidentifyReport = {
  /** Payments corrected to household money, by the evidence that resolved them. */
  byEvidence: Record<CounterpartyMatch['via'], number>;
  /** Payments looked at and left alone, because nothing identified them. */
  unchanged: number;
};

/**
 * Revisit transfers counted as spending and correct the ones that are household
 * money after all.
 *
 * Only a decision a person made is protected. Everything a machine decided may
 * be revisited, however confident it was and whether or not it was marked
 * provisional, because what the owner says about a counterparty is a statement
 * and a model's category is a guess.
 *
 * That envelope was narrower at first — `unresolved` or `provisional` only —
 * and it was wrong in a way that took a while to surface. The owner states who
 * a counterparty is *after* seeing their totals, which is to say after the
 * automatic passes have already run. A payment one of those passes had settled
 * confidently was therefore shielded from their answer permanently: they would
 * say "these are not personal", the newer payments would obey and the older
 * ones would silently not. Their word has to reach the whole ledger or it is
 * not really their word.
 *
 * Only payments that name a counterparty are examined, because a statement
 * about who was paid cannot speak to a payment that names nobody, and sweeping
 * the entire ledger every sync to learn that would be waste.
 *
 * A corrected payment loses its category as well as its kind, because moving
 * money between our own accounts is not spending on anything and a leftover
 * "Groceries" would be a lie.
 */
export async function reidentifyTransfers(
  tx: Executor,
): Promise<ReidentifyReport> {
  const report: ReidentifyReport = {
    byEvidence: { iban: 0, card: 0, name: 0 },
    unchanged: 0,
  };
  const candidates = await tx.query<{
    id: string;
    source: string;
    account_id: string;
    amount_minor: string;
    source_details: unknown;
    kind: string;
  }>(
    `SELECT t.id,t.source,t.account_id,t.amount_minor,t.source_details,t.kind
     FROM transactions t
     WHERE t.status='booked' AND t.amount_minor<>0
       AND NOT EXISTS (SELECT 1 FROM audit_events a
                       WHERE a.transaction_id=t.id AND a.event='classified')
       AND (coalesce(t.source_details->>'mcc',
                     t.source_details->>'merchant_category_code') = '4829'
            OR t.source_details ? 'counterIban'
            OR t.source_details ? 'counterpartyAccountIdentifier'
            OR t.source_details ? 'creditor_account'
            OR t.source_details ? 'debtor_account')
     ORDER BY t.booked_at DESC,t.id`,
  );
  for (const row of candidates.rows) {
    const match = await matchCounterparty(tx, row);
    if (!match?.kind) {
      report.unchanged++;
      continue;
    }
    // Idempotence has to be explicit now. While the envelope was "unresolved or
    // provisional", correcting a payment removed it from the candidate set by
    // itself; a payment that keeps naming its counterparty stays in scope
    // forever, so without this every run would rewrite it and bump its revision.
    if (row.kind === match.kind) {
      report.unchanged++;
      continue;
    }
    await tx.query(
      `UPDATE transactions SET kind=$1, category_id=NULL, provisional=false,
         classification_source='identity', revision=revision+1, updated_at=now()
       WHERE id=$2`,
      [match.kind, row.id],
    );
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'counterparty_identity','auto_classified',$3,$4,$5)`,
      [
        randomUUID(),
        row.id,
        JSON.stringify({ kind: row.kind }),
        JSON.stringify({
          kind: match.kind,
          source: 'identity',
          via: match.via,
        }),
        `${EVIDENCE[match.via]}, so this is ${match.kind.replaceAll('_', ' ')} rather than spending`,
      ],
    );
    report.byEvidence[match.via]++;
  }
  return report;
}

/** Why a transfer was taken to be household money, in the owner's terms. */
const EVIDENCE: Record<CounterpartyMatch['via'], string> = {
  iban: 'The counterparty account is one of ours',
  card: 'The card this names is one the owner has identified as ours',
  name: 'The owner has said that payments to this counterparty are our own money',
};

/** What a transfer to an account of this purpose is. */
export function kindForPurpose(purpose: string): TransferKind {
  if (purpose === 'investment') return 'investment';
  if (purpose === 'business') return 'non_personal';
  return 'internal_transfer';
}
