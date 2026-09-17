import { Conflict } from './repository.js';
import { createHash } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import type { Kind, Owner } from './domain.js';
import {
  kindForPurpose,
  matchCounterparty,
  registerCards,
} from './counterparty-identity.js';

export type AccountPurpose =
  'personal' | 'business' | 'investment' | 'unreviewed';
export interface Account {
  source: string;
  accountId: string;
  owner: Owner;
  label: string;
  purpose: AccountPurpose;
  identifierRegistered: boolean;
  revision: number;
}
export interface TransferSuggestion {
  transactionId: string;
  proposedKind: Kind | null;
  reason: 'known_account' | 'cross_owner_account' | 'ambiguous_identifier';
  requiresReview: true;
}

function owner(value: unknown): Owner {
  if (value !== 'rodion' && value !== 'katya') throw new Error('invalid_owner');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_account');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('invalid_account_field');
  return value.trim();
}
// Scheme and namespace prevent opaque provider IDs from matching another provider.
// Digests are matching keys, not encryption or a substitute for database access control.
/** Exported as `identifierHashFor` so the resting place can match a
 * counterparty against registered accounts with exactly the same hash the
 * account registry stores, rather than a second implementation of it. */
export function identifierHashFor(raw: unknown): string {
  return identifierHash(raw);
}
function identifierHash(raw: unknown): string {
  const value = object(raw);
  const scheme = value.scheme;
  let identifier = text(value.value, 200);
  let namespace = '';
  if (scheme === 'iban') {
    identifier = identifier.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(identifier))
      throw new Error('invalid_identifier');
  } else if (scheme === 'opaque') {
    namespace = text(value.namespace, 64);
  } else throw new Error('invalid_identifier');
  return createHash('sha256')
    .update(JSON.stringify([scheme, namespace, identifier]))
    .digest('hex');
}
function map(row: Row): Account {
  return {
    source: String(row.source),
    accountId: String(row.account_id),
    owner: row.owner as Owner,
    label: String(row.label),
    purpose: row.purpose as AccountPurpose,
    identifierRegistered: row.identifier_hash !== null,
    revision: Number(row.revision ?? 0),
  };
}

export async function initializeAccounts(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS own_accounts (
      source text NOT NULL, account_id text NOT NULL,
      owner text NOT NULL CHECK(owner IN ('rodion','katya')),
      label text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('personal','business','investment','unreviewed')),
      identifier_hash text CHECK(identifier_hash ~ '^[a-f0-9]{64}$'),
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source,account_id)
    )`);
  await tx.query(`CREATE TABLE IF NOT EXISTS account_audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor text NOT NULL CHECK(actor IN ('rodion','katya')),
      source text NOT NULL, account_id text NOT NULL,
      before_value jsonb, after_value jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await tx.query(
    'ALTER TABLE own_accounts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0 CHECK(revision>=0)',
  );
  await tx.query(
    "ALTER TABLE account_audit_events ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT 'Account details updated'",
  );
}

export class Accounts {
  constructor(readonly db: Database) {}

  /**
   * Record an account a connector listed, and register its identifier when the
   * provider stated one.
   *
   * The identifier is what lets a transfer between the household's own accounts
   * be recognised as household money rather than counted as spending: a payment
   * carries its counterparty's IBAN, and matching that against a registered
   * account is the only evidence for it that does not rely on reading names.
   * Every account was previously unregistered, so that recognition never fired.
   *
   * An identifier the owner typed is never overwritten, and the hash is computed
   * by the same function the matching side uses, so the two cannot drift apart.
   * A provider that publishes no IBAN leaves the account as it was; the owner can
   * still enter one by hand.
   */
  async discover(account: {
    source: string;
    accountId: string;
    owner: Owner;
    label: string;
    iban?: string;
    cards?: readonly string[];
  }) {
    owner(account.owner);
    let hash: string | null = null;
    if (account.iban !== undefined) {
      try {
        hash = identifierHash({ scheme: 'iban', value: account.iban });
      } catch {
        hash = null; // Provider metadata that is not an IBAN is not evidence.
      }
    }
    await this.db.query(
      `INSERT INTO own_accounts(source,account_id,owner,label,purpose,identifier_hash)
      VALUES($1,$2,$3,$4,'unreviewed',$5)
      ON CONFLICT(source,account_id) DO UPDATE
        SET identifier_hash=COALESCE(own_accounts.identifier_hash,excluded.identifier_hash)
        WHERE own_accounts.identifier_hash IS NULL
          AND excluded.identifier_hash IS NOT NULL`,
      [
        text(account.source, 64),
        text(account.accountId, 200),
        account.owner,
        text(account.label, 200).slice(0, 100),
        hash,
      ],
    );
    // The account row must exist before an identifier can point at it, so both
    // registrations happen after the insert. A card-to-card transfer states the
    // masked card number and nothing else, so registering our own cards is what
    // makes those recognisable at all.
    if (hash !== null)
      await this.db.query(
        `INSERT INTO own_account_identifiers(scheme,identifier_hash,source,account_id,registered_by)
         VALUES('iban',$1,$2,$3,'provider') ON CONFLICT DO NOTHING`,
        [hash, account.source, account.accountId],
      );
    if (account.cards?.length)
      await registerCards(
        this.db,
        { source: account.source, accountId: account.accountId },
        account.cards,
      );
  }

  async list(actor: Owner): Promise<Account[]> {
    owner(actor);
    return (
      await this.db.query(
        'SELECT * FROM own_accounts WHERE owner=$1 ORDER BY source,account_id',
        [actor],
      )
    ).rows.map(map);
  }

  /** Both members' accounts, for a filter over the household's payments. */
  async household(): Promise<Account[]> {
    return (
      await this.db.query(
        'SELECT * FROM own_accounts ORDER BY owner,label,source,account_id',
      )
    ).rows.map(map);
  }

  async withImpact(actor: Owner) {
    const accounts = await this.list(actor);
    const history = (
      await this.db.query(
        `SELECT source,account_id,created_at,reason,before_value,after_value FROM (SELECT *,row_number() OVER(PARTITION BY source,account_id ORDER BY id DESC) AS position FROM account_audit_events WHERE actor=$1) recent WHERE position<=5 ORDER BY created_at DESC`,
        [actor],
      )
    ).rows;
    const rows = (
      await this.db.query(
        `SELECT source,account_id,currency,count(*) AS total,
      count(*) FILTER (WHERE kind='personal_expense' AND status='booked' AND amount_minor<0) AS personal_count,
      COALESCE(-sum(amount_minor) FILTER (WHERE kind='personal_expense' AND status='booked' AND amount_minor<0),0)::text AS personal_minor
      FROM transactions WHERE owner=$1 GROUP BY source,account_id,currency`,
        [actor],
      )
    ).rows;
    return accounts.map((a) => {
      const matching = rows.filter(
        (r) => r.source === a.source && r.account_id === a.accountId,
      );
      return {
        ...a,
        history: history
          .filter((h) => h.source === a.source && h.account_id === a.accountId)
          .slice(0, 5)
          .map((h) => ({
            createdAt: new Date(String(h.created_at)).toISOString(),
            reason: String(h.reason),
            beforePurpose:
              (h.before_value as Record<string, unknown> | null)?.purpose ??
              null,
            afterPurpose: String(
              (h.after_value as Record<string, unknown>).purpose,
            ),
            revision: Number(
              (h.after_value as Record<string, unknown>).revision ?? 0,
            ),
          })),
        impact: {
          transactionCount: matching.reduce((n, r) => n + Number(r.total), 0),
          personalExpenseCount: matching.reduce(
            (n, r) => n + Number(r.personal_count),
            0,
          ),
          byCurrency: matching
            .filter((r) => Number(r.personal_count) > 0)
            .map((r) => ({
              currency: String(r.currency),
              personalExpenseMinor: String(r.personal_minor),
            })),
        },
      };
    });
  }

  async upsert(input: unknown, actor: Owner): Promise<Account> {
    owner(actor);
    const value = object(input);
    if (owner(value.owner) !== actor) throw new Error('not_found');
    const source = text(value.source, 64);
    const accountId = text(value.accountId, 200);
    const label = text(value.label, 100);
    const purpose = value.purpose;
    if (
      purpose !== 'personal' &&
      purpose !== 'business' &&
      purpose !== 'investment'
    )
      throw new Error('invalid_purpose');
    const expectedRevision = value.expectedRevision;
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)
    )
      throw new Error('invalid_revision');
    const reason =
      value.reason === undefined
        ? 'Account details updated'
        : text(value.reason, 500);
    const hash =
      value.identifier === undefined ? null : identifierHash(value.identifier);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482393)');
      const previous = (
        await tx.query(
          'SELECT * FROM own_accounts WHERE source=$1 AND account_id=$2 FOR UPDATE',
          [source, accountId],
        )
      ).rows[0];
      if (previous && previous.owner !== actor) throw new Error('not_found');
      if (
        expectedRevision !== undefined &&
        Number(expectedRevision) !== Number(previous?.revision ?? 0)
      )
        throw new Conflict('stale_account_revision');
      // A known imported account cannot be claimed by a different owner.
      const imported = await tx.query(
        'SELECT 1 FROM transactions WHERE source=$1 AND account_id=$2 AND owner<>$3 LIMIT 1',
        [source, accountId, actor],
      );
      if (imported.rows.length) throw new Error('not_found');
      const result = await tx.query(
        `INSERT INTO own_accounts(source,account_id,owner,label,purpose,identifier_hash,revision)
        VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(source,account_id) DO UPDATE SET
        label=excluded.label,purpose=excluded.purpose,revision=own_accounts.revision+1,
        identifier_hash=COALESCE(excluded.identifier_hash,own_accounts.identifier_hash),updated_at=now() RETURNING *`,
        [source, accountId, actor, label, purpose, hash],
      );
      const account = map(result.rows[0]!);
      // An identifier the owner typed joins the same registry the matching side
      // reads, so a hand-entered IBAN works exactly like a provider-stated one.
      if (hash !== null)
        await tx.query(
          `INSERT INTO own_account_identifiers(identifier_hash,scheme,source,account_id,registered_by)
           VALUES($1,$2,$3,$4,'owner') ON CONFLICT DO NOTHING`,
          [
            hash,
            (value.identifier as { scheme?: unknown }).scheme === 'iban'
              ? 'iban'
              : 'opaque',
            source,
            accountId,
          ],
        );
      await tx.query(
        'INSERT INTO account_audit_events(actor,source,account_id,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor,
          source,
          accountId,
          previous ? JSON.stringify(map(previous)) : null,
          JSON.stringify(account),
          reason,
        ],
      );
      // Saving a business or investment purpose records that conclusion on the
      // account's unclassified payments; see `installAccountPolicyKinds`. The
      // database does it, so no caller can forget to.
      return account;
    });
  }

  async suggestions(actor: Owner): Promise<TransferSuggestion[]> {
    owner(actor);
    const result = await this.db.query(
      `SELECT t.id,t.source,t.account_id,t.source_details,t.amount_minor FROM transactions t
      WHERE t.owner=$1 AND t.kind='unresolved' AND t.status='booked'
      AND t.amount_minor<>0
      AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event='classified')
      ORDER BY t.booked_at DESC,t.id`,
      [actor],
    );
    const suggestions: TransferSuggestion[] = [];
    for (const row of result.rows) {
      // One matcher for every kind of counterparty evidence — a stated IBAN, the
      // card digits written into the payment's own text, or a recipient whose
      // identity two-sided transfers already established. Suggestions and the
      // resting place call the same function so they cannot disagree about who
      // a payment went to.
      const match = await matchCounterparty(this.db, row);
      if (!match) continue;
      if (!match.account) {
        // Two accounts claim the same identifier: the owner is shown that this
        // needs untangling rather than a kind nothing actually supports.
        suggestions.push({
          transactionId: String(row.id),
          proposedKind: null,
          reason: 'ambiguous_identifier',
          requiresReview: true,
        });
        continue;
      }
      const account = (
        await this.db.query<{ owner: string }>(
          'SELECT owner FROM own_accounts WHERE source=$1 AND account_id=$2',
          [match.account.source, match.account.accountId],
        )
      ).rows[0];
      suggestions.push({
        transactionId: String(row.id),
        proposedKind: kindForPurpose(match.account.purpose),
        reason:
          account && account.owner !== actor
            ? 'cross_owner_account'
            : 'known_account',
        requiresReview: true,
      });
    }
    return suggestions;
  }
}
