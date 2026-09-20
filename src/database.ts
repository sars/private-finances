import { initializePaymentExplanations } from './payment-explanations.js';
import {
  initializeAppSettings,
  migrateNonPersonalPreference,
} from './app-settings.js';
import {
  initializeReceipts,
  upgradeReceiptEvidence,
  upgradeReceiptPreview,
  upgradeReceiptAnswers,
  upgradeSettlementDifference,
} from './receipts.js';
import {
  initializeRefunds,
  restoreRefundedCredits,
  restoreRefundedPurchases,
  upgradeRefundReductions,
} from './refunds.js';
import {
  initializeRefundMatching,
  upgradeRefundRulesVersion,
} from './refund-automation.js';
import { initializeRefundQuestions } from './refund-questions.js';
import { initializeFxRates } from './fx-rates.js';
import { initializeFxCoverage } from './fx-coverage.js';
import { addHoldingFeeds, initializeHoldings } from './holdings.js';
import { initializeSpendingPatterns } from './spending-pattern.js';
import { initializeTransactionTriage } from './transaction-triage.js';
import { initializeLlmBudget } from './llm-budget.js';
import { initializeReplyWorkflow } from './reply-workflow.js';
import { initializeCredentialHealth } from './credential-health.js';
import { initializeBackupHealth } from './backup-health.js';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeLegacyCategories,
  migrateCategoryTree,
  migrateClassificationRules,
  migrateTags,
  rescueMigrationStrandedCatchAll,
  fileOwnerNamedMerchants,
  placeRootCatchAllByMerchantCode,
  restoreSettlementInvalidatedDecisions,
  fileDeliveryPlatformsAsDelivery,
  restoreRuleCategoriesLostToTheTree,
  applyOwnerRuleCorrections,
} from './category-migration.js';
import { createRuleMatchFunction } from './categories.js';
import { initializeTelegram } from './telegram.js';
import { initializeClassifier } from './classifier.js';
import { initializeReports } from './reports.js';
import { initializeAccounts } from './accounts.js';
import { initializeAccountBalances } from './account-balances.js';
import { initializeUiLayouts } from './ui-layout.js';
import {
  correctBankWordedPlacements,
  installRestingPlace,
  restPlacements,
} from './resting-place.js';
import { reconcileTree } from './tree-reconcile.js';
import {
  installCounterpartyIdentity,
  retireCounterpartyMemory,
  reidentifyTransfers,
} from './counterparty-identity.js';
import {
  moveHouseholdTaxToItsOwnLeaf,
  seedCategoryTree,
} from './category-tree.js';
import { initializeAuth } from './auth.js';

export type Row = Record<string, unknown>;
export interface Executor {
  query<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Executor {
  transaction<T>(action: (db: Executor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Booting PGlite runs initdb, which costs an order of magnitude more than the
// migration it is about to receive. `migrate` therefore snapshots the first
// migrated in-memory database of a test process and restores the rest from it
// (see `migrate` below); to make that possible the engine is created lazily,
// so a database that is handed a snapshot never pays for an unused initdb.
interface MemoryHandle {
  // Only unnamed (throwaway) databases may be replaced by a snapshot.
  readonly ephemeral: boolean;
  pristine(): boolean;
  engine(): Promise<PGlite>;
  adopt(engine: Promise<PGlite>): void;
}
const memoryHandles = new WeakMap<Database, MemoryHandle>();

/**
 * Whether this database is a local PGlite one rather than a PostgreSQL server.
 *
 * The showcase seeder asks before it writes, because it empties the ledger and
 * rewrites it: run against the household's own database it would destroy the
 * lot. The WeakMap is set when the database is constructed, so it answers from
 * what was actually built — an environment variable can be wrong and a
 * connection string can be edited, but this cannot.
 */
export function isMemoryDatabase(db: Database): boolean {
  return memoryHandles.has(db);
}

export function memoryDatabase(path?: string): Database {
  let engine: Promise<PGlite> | undefined;
  let pristine = true;
  const use = (): Promise<PGlite> => {
    pristine = false;
    return (engine ??= Promise.resolve(new PGlite(path)));
  };
  // PGlite serializes its transactions. Use the transaction handle for every statement.
  const database: Database = {
    query: async (sql, params) => (await use()).query(sql, params),
    transaction: async (action) =>
      (await use()).transaction((tx) => action(tx)),
    close: async () => {
      if (engine) await (await engine).close();
    },
  };
  memoryHandles.set(database, {
    ephemeral: path === undefined,
    pristine: () => pristine,
    engine: use,
    adopt: (replacement) => {
      engine = replacement;
    },
  });
  return database;
}

export function postgresDatabase(url: string): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
  return {
    query: async <T extends Row>(sql: string, params?: unknown[]) =>
      pool.query<T>(sql, params),
    transaction: async (action) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await action(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function applyMigrations(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    // Serializes concurrent startup migrations on both PostgreSQL and PGlite.
    await tx.query('SELECT pg_advisory_xact_lock(7482391)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await tx.query(
      'SELECT version FROM schema_versions WHERE version=1',
    );
    if (!applied.rows.length) {
      await tx.query(`CREATE TABLE transactions (
      id uuid PRIMARY KEY, source text NOT NULL, source_id text NOT NULL,
      account_id text NOT NULL, owner text NOT NULL CHECK(owner IN ('rodion','katya')),
      booked_at timestamptz NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
      amount_minor numeric(30,0) NOT NULL, description text NOT NULL,
      kind text NOT NULL DEFAULT 'unresolved' CHECK(kind IN ('personal_expense','internal_transfer','investment','non_personal','unresolved')),
      category text, revision integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(source,account_id,source_id),
      CHECK(kind != 'personal_expense' OR category IS NOT NULL)
    )`);
      await tx.query(`CREATE TABLE audit_events (
      id uuid PRIMARY KEY, transaction_id uuid REFERENCES transactions(id),
      actor text NOT NULL, event text NOT NULL, before_value jsonb,
      after_value jsonb NOT NULL, reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
      await tx.query(`CREATE TABLE jobs (
      id uuid PRIMARY KEY, state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
      attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
      error_code text, imported integer NOT NULL DEFAULT 0
    )`);
      await tx.query(`CREATE TABLE sync_state (
      source text PRIMARY KEY, last_success_at timestamptz NOT NULL, job_id uuid REFERENCES jobs(id)
    )`);
      await tx.query('INSERT INTO schema_versions(version) VALUES (1)');
    }
    const v2 = await tx.query(
      'SELECT version FROM schema_versions WHERE version=2',
    );
    if (!v2.rows.length) {
      await tx.query(
        "ALTER TABLE transactions ADD COLUMN status text NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','pending')), ADD COLUMN source_details jsonb NOT NULL DEFAULT '{}'::jsonb",
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (2)');
    }
    const v3 = await tx.query(
      'SELECT version FROM schema_versions WHERE version=3',
    );
    if (!v3.rows.length) {
      await tx.query(`CREATE TABLE bank_sync_runs (
        connection text PRIMARY KEY, state text NOT NULL CHECK(state IN ('running','succeeded','failed')),
        lease_token uuid, lease_until timestamptz, last_success_at timestamptz, error_code text
      )`);
      await tx.query(`CREATE TABLE bank_import_windows (
        id uuid PRIMARY KEY, connection text NOT NULL REFERENCES bank_sync_runs(connection),
        account_id text NOT NULL, owner text NOT NULL CHECK(owner IN ('rodion','katya')),
        currency text NOT NULL, from_at timestamptz NOT NULL, to_at timestamptz NOT NULL,
        changed integer NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(), CHECK(from_at<to_at)
      )`);
      await tx.query('INSERT INTO schema_versions(version) VALUES (3)');
    }
    const v4 = await tx.query(
      'SELECT version FROM schema_versions WHERE version=4',
    );
    if (!v4.rows.length) {
      await tx.query(`CREATE TABLE bank_consents (
        owner text NOT NULL CHECK(owner IN ('rodion','katya')),
        bank text NOT NULL CHECK(bank IN ('Wise','Revolut')), country text NOT NULL,
        state_hash text NOT NULL UNIQUE, state_expires_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        status text NOT NULL CHECK(status IN ('pending','processing','authorized','failed')),
        PRIMARY KEY(owner, bank)
      )`);
      await tx.query('INSERT INTO schema_versions(version) VALUES (4)');
    }
    const v5 = await tx.query(
      'SELECT version FROM schema_versions WHERE version=5',
    );
    if (!v5.rows.length) {
      await initializeAccounts(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (5)');
    }
    const v6 = await tx.query(
      'SELECT version FROM schema_versions WHERE version=6',
    );
    if (!v6.rows.length) {
      await initializeReports(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (6)');
    }
    const v7 = await tx.query(
      'SELECT version FROM schema_versions WHERE version=7',
    );
    if (!v7.rows.length) {
      await initializeLegacyCategories(tx);
      await initializeTelegram(tx);
      await initializeClassifier(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (7)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=8'))
        .rows.length
    ) {
      await initializeCredentialHealth(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (8)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=9'))
        .rows.length
    ) {
      await initializeReplyWorkflow(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (9)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=10'))
        .rows.length
    ) {
      await initializeLlmBudget(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (10)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=11'))
        .rows.length
    ) {
      await initializeTransactionTriage(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (11)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=12'))
        .rows.length
    ) {
      await initializeFxRates(tx);
      await initializeSpendingPatterns(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (12)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=13'))
        .rows.length
    ) {
      await initializeRefunds(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (13)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=14'))
        .rows.length
    ) {
      await initializeAccounts(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (14)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=15'))
        .rows.length
    ) {
      await initializeReceipts(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (15)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=16'))
        .rows.length
    ) {
      await tx.query(
        'ALTER TABLE telegram_outbox ADD COLUMN IF NOT EXISTS payment_snapshot jsonb',
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (16)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=17'))
        .rows.length
    ) {
      await initializeAppSettings(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (17)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=18'))
        .rows.length
    ) {
      await initializePaymentExplanations(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (18)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=19'))
        .rows.length
    ) {
      // Receipt deletion, Telegram feedback and duplicate detection add columns
      // and widen a CHECK constraint. They were first written inside
      // initializeReceipts, which only runs in the one-time version 15 block, so
      // every already-migrated database skipped them while tests, which always
      // build from scratch, passed. Existing databases get them here.
      await upgradeReceiptEvidence(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (19)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=20'))
        .rows.length
    ) {
      // A settled amount that differs from the receipt total is recorded, not a
      // reason to detach (ADR 0005). Additive and idempotent; no backfill,
      // because no existing row can carry a difference nobody has detected.
      await upgradeSettlementDifference(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (20)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=21'))
        .rows.length
    ) {
      // A PDF receipt stores the original document as evidence and a rendered
      // first page as the thumbnail. Additive and idempotent; no backfill,
      // because every existing row is a photo that is already its own preview.
      await upgradeReceiptPreview(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (21)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=22'))
        .rows.length
    ) {
      // Refund links become reductions of a purchase (ADR 0007). The columns are
      // additive; the data change restores purchases that the previous model
      // rewrote to `non_personal`, which is what made a refund erase a purchase
      // instead of shrinking it. Both steps are idempotent.
      await upgradeRefundReductions(tx);
      await restoreRefundedPurchases(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (22)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=23'))
        .rows.length
    ) {
      // What automatic refund matching decided about each incoming credit, so a
      // decision is not recomputed every pass and a question is asked once.
      await initializeRefundMatching(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (23)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=24'))
        .rows.length
    ) {
      // Telegram questions about money that came back, with the numbered answer
      // the owner gives. Kept apart from classification questions because the
      // reply decides which purchase shrinks, and no model reads it.
      await initializeRefundQuestions(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (24)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=25'))
        .rows.length
    ) {
      // ADR 0006. One shared household tree replaces the two per-owner ones, a
      // payment points at a node instead of carrying a path string, parents stop
      // being assignable, and the account-purpose rewrite that reporting applied
      // at display time is written down on the payments it was rewriting.
      // Every payment keeps its previous path in category_migration_log.
      // Runs after the refund steps, which still speak in path strings: from
      // here on the path is derived and writing it directly is rejected.
      await migrateCategoryTree(tx);
      await migrateTags(tx);
      await migrateClassificationRules(tx);
      await tx.query('DROP TABLE IF EXISTS category_nodes');
      await tx.query('INSERT INTO schema_versions(version) VALUES (25)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=26'))
        .rows.length
    ) {
      // A linked refund credit is counted through the purchase it reduced and is
      // left out of browsing, so the `non_personal` classification the link used
      // to write is taken back. Idempotent, and only where nothing changed since.
      await restoreRefundedCredits(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (26)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=27'))
        .rows.length
    ) {
      // A stored matching decision records which edition of the rules made it,
      // so a rule that has since learned something looks at it again instead of
      // leaving a question standing that it would now answer itself.
      await upgradeRefundRulesVersion(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (27)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=28'))
        .rows.length
    ) {
      // ADR 0008. A payment nobody has decided stops sitting in a queue the
      // owner will not work through and comes to rest on the best category its
      // evidence supports, counted but marked provisional. The columns are
      // additive and `classification_source` is backfilled from the audit trail;
      // the sweep then places the backlog, which is the change the owner asked
      // for — their 2026 total becomes complete without a review session.
      await installRestingPlace(tx);
      await restPlacements(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (28)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=29'))
        .rows.length
    ) {
      // ADR 0008, step D3. The owner groups utility bills with phone and
      // internet, and puts flights with transport. Almost all of it is
      // reparenting, which costs nothing because a payment points at a node and
      // the path is derived; only Travel transport's payments actually move, and
      // they move through the audited path.
      await reconcileTree(tx);
      await seedCategoryTree(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (29)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=30'))
        .rows.length
    ) {
      // Recognising a transfer between the household's own accounts depended on
      // the counterparty's IBAN, which most of these payments do not carry, so
      // money moving to Katya's cards was counted as spending. An account may
      // now hold several identifiers including its cards, and a counterparty the
      // bank only names is matched against what the owner has already declared
      // in their rules — on a normalised key, so one entry covers every spelling
      // of a name. The last step revisits payments the resting place had filed
      // as spending.
      await installCounterpartyIdentity(tx);
      await reidentifyTransfers(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (30)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=31'))
        .rows.length
    ) {
      // The resting place was sized against transfers to people and met two
      // payments it was not: sole-trader tax to the State Treasury, and money
      // moving to the household's own cards. 880,894 UAH of tax became the
      // largest personal expense of the year. Both are recognisable from the
      // bank's own wording, and this revisits every placement it already made.
      await correctBankWordedPlacements(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (31)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=32'))
        .rows.length
    ) {
      // The owner asked for `Home / Taxes`. The tree had no home for tax at all,
      // so the one treasury payment they had called personal — property tax on
      // the place they live, as opposed to the sole-trader tax that is business
      // and never reaches a category — was sitting in the catch-all for want of
      // anywhere better. The leaf is seeded and that payment moves onto it.
      await seedCategoryTree(tx);
      await moveHouseholdTaxToItsOwnLeaf(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (32)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=33'))
        .rows.length
    ) {
      // What the owner says about a counterparty belongs in their rules, not in
      // a store of its own. They asked why a second mechanism existed when rules
      // already say "payments matching this text are of this kind", and the
      // measurement agreed with them: nine entries across nine distinct
      // spellings, so the spelling-insensitive matching that justified the table
      // was doing no work, while a parallel store meant two places to look and
      // two to edit. Every entry becomes a rule and the table goes.
      await retireCounterpartyMemory(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (33)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=34'))
        .rows.length
    ) {
      // The owner's own message, so the bot can react to it and answer it in
      // place instead of posting a loose message. `initializeTelegram` creates
      // this column for a fresh database, but it is gated behind version 7 and
      // so never runs again on an existing one; the column has to be added
      // here or the insert that records a reply refers to nothing.
      await tx.query(
        'ALTER TABLE telegram_proposal_inputs ADD COLUMN IF NOT EXISTS message_id bigint',
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (34)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=35'))
        .rows.length
    ) {
      // The tree migration mapped legacy paths with no successor onto the root
      // catch-all, including paths people had chosen by hand. Those payments
      // then sat outside the review queue, which only listed work nobody had
      // decided, so the owner found a shoe shop filed as Unspecified with no way
      // to reach it. The merchant code says what most of them were; the rest
      // come back into the queue now that it lists the root catch-all too.
      await rescueMigrationStrandedCatchAll(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (35)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=36'))
        .rows.length
    ) {
      // A rule can now ask that its text appear somewhere in the description
      // rather than be the whole of it. Bank references force this: every
      // `TRANSFER-<number> Sent money to Rodion Salnik` is a new string, so an
      // exact rule answers one payment and the next needs another. 323 of the
      // owner's 520 rules match a single payment for reasons like this.
      await tx.query(
        'ALTER TABLE classification_rules DROP CONSTRAINT IF EXISTS classification_rules_match_field_check',
      );
      await tx.query(
        `ALTER TABLE classification_rules ADD CONSTRAINT classification_rules_match_field_check
         CHECK (match_field IN ('description','counterparty','description_contains'))`,
      );
      await createRuleMatchFunction(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (36)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=37'))
        .rows.length
    ) {
      // Seven merchants the owner identified while reading their July spending,
      // none of which any code could have worked out: the bank sent a
      // money-transfer code and a sole trader's name. Two categories they named
      // in the same pass — Utilities / Security and Transport / Car / Fines —
      // arrive with the seed above.
      await seedCategoryTree(tx);
      await fileOwnerNamedMerchants(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (37)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=38'))
        .rows.length
    ) {
      // Browsing defaults hid payments by the account they sat on, which the
      // rest of the application stopped doing at version 25: an account purpose
      // is a suggestion, the payment's kind is the decision. The preference now
      // hides non-personal payments themselves, and a second one hides payments
      // that came to nothing — a purchase refunded in full, above all.
      await migrateNonPersonalPreference(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (38)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=39'))
        .rows.length
    ) {
      // The owner could not find their own rent payment: it leaves Revolut, and
      // the account was called "USD account" while their Wise dollar account was
      // called "USD". Nothing on screen named the bank. New imports now say
      // "Revolut USD"; this renames the accounts already registered, and only
      // those still carrying a name the application generated.
      await nameTheBankOnAccounts(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (39)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=40'))
        .rows.length
    ) {
      // Money left Wise for a Swedbank account this application could not see,
      // so the spending it paid for was missing from every total. The consent
      // table has allowed exactly two banks since it was created; it now allows
      // the three in src/connectors/banks.ts. A bank added there later needs a
      // migration of its own — test/database.test.ts fails until it has one.
      await tx.query(
        'ALTER TABLE bank_consents DROP CONSTRAINT IF EXISTS bank_consents_bank_check',
      );
      await tx.query(
        `ALTER TABLE bank_consents ADD CONSTRAINT bank_consents_bank_check
         CHECK (bank IN ('Wise','Revolut','Swedbank'))`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (40)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=41'))
        .rows.length
    ) {
      // The first Swedbank account arrived holding several currencies, which
      // the provider reports as XXX, and it registered as "Swedbank XXX ·
      // CURRENT". Rename it to something the owner recognises.
      await nameTheMultiCurrencyAccounts(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (41)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=42'))
        .rows.length
    ) {
      // The owner opened their review queue and found a Rimi shop and an H&M
      // purchase waiting on them. Both had already been categorised — Rimi by
      // the model at 0.96, H&M by a rule the owner had confirmed themselves —
      // and both were thrown away two days later when the card hold settled,
      // because the importer read `hold: false` as the bank correcting its own
      // evidence. It never was: across the whole ledger every re-import had
      // changed nothing but the hold flag. The importer now says so, and this
      // puts back the decisions that were lost while nobody has decided since.
      //
      // Six merchant codes join the map in the same change, so that payments
      // the resting place could only leave on the catch-all — a photo shop, a
      // florist, a guesthouse, an airport shop, a caterer, a paint shop — rest
      // somewhere that says something about them instead.
      // And the three delivery platforms, which the merchant code cannot tell
      // apart from a restaurant because the money really does reach one. Both
      // leaves hang off Food / Restaurants, so no total moves; the breakdown
      // stops claiming the household ate out when it was ordering in.
      await restoreSettlementInvalidatedDecisions(tx);
      await placeRootCatchAllByMerchantCode(tx);
      await fileDeliveryPlatformsAsDelivery(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (42)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=43'))
        .rows.length
    ) {
      // Two of Katya's answers were consumed by the poller and vanished. Only
      // the update number had been kept, so afterwards nobody could say which
      // check had rejected them, the payments stayed unresolved and she was
      // never told. What became of each message is recorded from now on.
      // `initializeTelegram` adds these columns to a fresh database but is
      // gated behind version 7, so an existing one needs them here.
      await tx.query(
        'ALTER TABLE telegram_updates ADD COLUMN IF NOT EXISTS outcome text',
      );
      await tx.query(
        'ALTER TABLE telegram_updates ADD COLUMN IF NOT EXISTS detail text',
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (43)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=44'))
        .rows.length
    ) {
      // A question is addressed to whoever's card was used, but the chat is
      // shared and the owner settled what should happen when the other member
      // answers: it counts, and which of them answered is recorded. Rows
      // written before this are read as having been answered by the owner,
      // which is what the old rule guaranteed. `initializeTelegram` adds the
      // column to a fresh database but is gated behind version 7.
      await tx.query(
        `ALTER TABLE telegram_proposal_inputs ADD COLUMN IF NOT EXISTS answered_by text
         CHECK(answered_by IN ('rodion','katya'))`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (44)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=45'))
        .rows.length
    ) {
      // The list screens stop receiving the whole ledger: `transaction-page`
      // selects and cuts a page in SQL, newest first, so the table gets the
      // indexes that order and predicate need. Until now `transactions` had
      // only its primary key and the natural key led by `source`, and
      // `audit_events.transaction_id` was a foreign key with no index, so a
      // payment's history and the triage listing scanned the whole table.
      await tx.query(
        'CREATE INDEX IF NOT EXISTS transactions_booked ON transactions(booked_at DESC, id)',
      );
      await tx.query(
        'CREATE INDEX IF NOT EXISTS transactions_owner_booked ON transactions(owner, booked_at DESC, id)',
      );
      await tx.query(
        `CREATE INDEX IF NOT EXISTS transactions_needs_review ON transactions(booked_at DESC, id)
         WHERE amount_minor < 0 AND (kind='unresolved' OR provisional OR category='Unspecified')`,
      );
      await tx.query(
        'CREATE INDEX IF NOT EXISTS audit_events_transaction ON audit_events(transaction_id, created_at)',
      );
      await tx.query(
        'CREATE INDEX IF NOT EXISTS receipt_jobs_transaction ON receipt_jobs(transaction_id)',
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (45)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=46'))
        .rows.length
    ) {
      // Version 41 turned "Swedbank XXX · CURRENT" into "Swedbank current
      // account", which reads like a description rather than a name. The
      // household has one Swedbank account and calls it Swedbank.
      await tx.query(
        "UPDATE own_accounts SET label='Swedbank', revision=revision+1 WHERE label='Swedbank current account'",
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (46)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=47'))
        .rows.length
    ) {
      // Either member may now explain the other's payment in the application,
      // exactly as either may answer for the other in Telegram, so the row has
      // to say which of them wrote it — `owner` is the member whose account the
      // payment sits on. Rows written before this were written by the owner of
      // the payment, which is what the old rule guaranteed.
      // `initializePaymentExplanations` adds the column to a fresh database but
      // is gated behind version 18.
      await tx.query(
        `ALTER TABLE transaction_explanations ADD COLUMN IF NOT EXISTS answered_by text
         CHECK(answered_by IN ('rodion','katya'))`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (47)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=48'))
        .rows.length
    ) {
      // The owner opened an account at LHV and linked it to the provider
      // application. The consent table allows the banks in
      // src/connectors/banks.ts by the provider's own name, which for this
      // bank is "LHV Pank"; the owner sees "LHV" everywhere else.
      await tx.query(
        'ALTER TABLE bank_consents DROP CONSTRAINT IF EXISTS bank_consents_bank_check',
      );
      await tx.query(
        `ALTER TABLE bank_consents ADD CONSTRAINT bank_consents_bank_check
         CHECK (bank IN ('Wise','Revolut','Swedbank','LHV Pank'))`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (48)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=49'))
        .rows.length
    ) {
      // Starting a bank approval used to overwrite the row of a live one with
      // "pending" and the new attempt's requested expiry, before anything had
      // been approved. On September 17, 2026 an approval started for the
      // default bank in the form and abandoned did exactly that to Rodion's
      // Wise approval, whose reminders then had nothing to watch. The attempt's
      // bound now has its own column, and this puts that row back to what the
      // provider reports for its session.
      await tx.query(
        'ALTER TABLE bank_consents ADD COLUMN IF NOT EXISTS requested_expires_at timestamptz',
      );
      await tx.query(
        `UPDATE bank_consents SET status='authorized', expires_at='2026-09-21T17:46:06.825Z'
         WHERE owner='rodion' AND bank='Wise' AND status='pending'
           AND state_expires_at BETWEEN '2026-09-17T14:00:00Z' AND '2026-09-17T15:00:00Z'`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (49)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=50'))
        .rows.length
    ) {
      // The first LHV account arrived holding several currencies, with the
      // holder's own name as the provider's only descriptor, and registered
      // under a generated label made of the bank and that name. The owner
      // opened the account for the household's personal spending. Only a
      // label the importer generated and nobody has edited is renamed.
      await tx.query(
        `UPDATE own_accounts a SET label='LHV', purpose='personal', revision=a.revision+1
         WHERE a.source='enablebanking' AND a.revision=0 AND a.purpose='unreviewed'
           AND a.label LIKE 'LHV %' AND a.label NOT LIKE 'LHV ___'
           AND EXISTS (SELECT 1 FROM bank_import_windows w
                       WHERE w.account_id=a.account_id AND w.connection LIKE 'enablebanking:%:lhv')`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (50)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=51'))
        .rows.length
    ) {
      // What the household owns, snapshot by snapshot (PF-020): holdings,
      // their dated quantities and the prices that value them. Three new
      // tables, nothing existing touched; see docs/assets.md.
      await initializeHoldings(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (51)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=52'))
        .rows.length
    ) {
      // A loose note to a household member whose answer reached nothing: the
      // outbox holds a question about a payment and could not carry one, so
      // until now a lost answer was recorded and logged but never said in the
      // chat. `initializeTelegram` creates the table for a fresh database but
      // is gated behind version 7, so an existing one needs it here.
      await tx.query(`CREATE TABLE IF NOT EXISTS telegram_notes (
        id uuid PRIMARY KEY,chat_id text NOT NULL,message_id bigint NOT NULL,text text NOT NULL,
        state text NOT NULL CHECK(state IN ('queued','sending','sent','uncertain')),
        lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
        reply_message_id bigint
      )`);
      await tx.query('INSERT INTO schema_versions(version) VALUES (52)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=53'))
        .rows.length
    ) {
      // The household could see what it had spent and never what it had. Every
      // bank states an account's balance and this application threw the figure
      // away: Monobank sends it with the account listing the importer already
      // reads, and Enable Banking keeps it one request further on. Both are
      // stored from now on, per account and per currency, each with the moment
      // it was observed — a balance is evidence with an age, never a total this
      // code derives, because no opening figure exists to derive one from.
      //
      // Beside it, the first per-person view preference this application has
      // had. Card order is not household configuration: the settings store is
      // administrator-only and holds decisions that change what the figures
      // mean, and where somebody likes their accounts to sit changes nothing.
      //
      // Numbered 53 rather than 51: the assets tables took that number while
      // this was being built, and a migration number is a place in a sequence
      // every existing database has already walked, not a label to reuse.
      await initializeAccountBalances(tx);
      await initializeUiLayouts(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (53)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=54'))
        .rows.length
    ) {
      // A holding may name the feed that fills it — a bank account's stored
      // balance, the broker, the exchange or a wallet address — so the
      // monthly snapshot job knows what to read (PF-020, step two).
      await addHoldingFeeds(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (54)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=55'))
        .rows.length
    ) {
      // Each owner signs in with an address and a password of their own, and
      // the session that follows outlives a restart — Basic authentication
      // could do neither, and neither could grow a second factor (PF-021).
      await initializeAuth(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (55)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=56'))
        .rows.length
    ) {
      // The reminder table admitted the OpenAI key and bank approvals only. The
      // IBKR Flex token expires once a year, and when it does the holdings
      // snapshot stops reading the broker without anything else saying so — so
      // it is watched on the same 5/2/1-day ladder, which first requires the
      // check constraint to accept its name. The constraint is replaced, not
      // widened in place: PostgreSQL has no ALTER for a check's expression.
      // Nothing is written or deleted; every existing row already satisfies it.
      await tx.query(
        'ALTER TABLE credential_reminders DROP CONSTRAINT IF EXISTS credential_reminders_credential_check',
      );
      await tx.query(
        `ALTER TABLE credential_reminders ADD CONSTRAINT credential_reminders_credential_check
         CHECK(credential IN ('openai_api_key','bank_consent','ibkr_flex_token'))`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (56)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=57'))
        .rows.length
    ) {
      // The per-owner Enable Banking connection stopped importing when banks
      // were scheduled separately, but the dashboard still listed it as a
      // connection of its own — a card the owner never made, named after the
      // scheme it predates. Its import windows move to the bank that owns
      // those accounts today and the empty row goes.
      await retirePerOwnerBankConnections(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (57)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=58'))
        .rows.length
    ) {
      // The holdings run already decided whether each feed was read, skipped or
      // refused, and then only printed it. That was enough while somebody was
      // reading the output, and no use at all for saying so on a screen — which
      // matters most for the exchange, whose key has no expiry date to count
      // down to and fails by being revoked, unused or read from a new address.
      // One row per feed, overwritten each run: the last outcome is the only
      // one worth keeping, and a history here would be a second ledger of
      // something the logs already hold.
      await tx.query(`CREATE TABLE holding_feed_runs (
        feed text PRIMARY KEY CHECK(feed IN ('ibkr','binance','wallet')),
        status text NOT NULL CHECK(status IN ('ok','not_configured','failed')),
        code text, ran_at timestamptz NOT NULL DEFAULT now()
      )`);
      await tx.query('INSERT INTO schema_versions(version) VALUES (58)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=59'))
        .rows.length
    ) {
      // Every copy of this household's data has lived on one machine. The
      // off-server backup that changes it is worth nothing unread: a timer can
      // be left disabled and a bucket credential can expire without either
      // making a sound. One row per attempt, written by the backup script
      // itself, lets the operations page state plainly whether a copy exists
      // elsewhere and how old it is — and an empty table is the honest answer
      // that none ever has. See docs/backups.md.
      await initializeBackupHealth(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (59)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=60'))
        .rows.length
    ) {
      // An import that failed left one word behind — the `error_code` on its
      // connection, overwritten by the next attempt — and an import that never
      // started left nothing at all. `bank_import_windows` is the coverage
      // record and is written only when a window commits, so the screen built
      // over it listed successes and quietly omitted every bank that was in
      // trouble: exactly the banks worth looking at. One row per attempt, with
      // the requests it made and where it stopped, is what makes a failure
      // readable afterwards. The steps hold request shapes, statuses and
      // counts — never a payload, an amount, a description, or an identifier
      // the bank authenticates with. See docs/import-runs.md.
      await tx.query(`CREATE TABLE bank_sync_attempts (
        id uuid PRIMARY KEY, connection text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
        from_at timestamptz NOT NULL, to_at timestamptz NOT NULL,
        outcome text NOT NULL CHECK(outcome IN ('running','succeeded','failed')),
        error_code text, accounts integer NOT NULL DEFAULT 0,
        changed integer NOT NULL DEFAULT 0,
        steps jsonb NOT NULL DEFAULT '[]'::jsonb, CHECK(from_at<to_at)
      )`);
      await tx.query(
        'CREATE INDEX bank_sync_attempts_recent ON bank_sync_attempts (started_at DESC, id DESC)',
      );
      await tx.query(
        'CREATE INDEX bank_sync_attempts_connection ON bank_sync_attempts (connection, started_at DESC, id DESC)',
      );
      // Why nothing is happening right now is a different question from what
      // happened last time, and the scheduler alone could answer it: it keeps
      // the next-attempt time in a file the web process deliberately does not
      // read. A connection could sit a full day between attempts with the
      // screen saying only that the last one failed. One attempt in twelve
      // hours is worth a row; the hundred and thirty deferrals in between,
      // which never touched a bank, are not — they are this one fact.
      await tx.query(
        'ALTER TABLE bank_sync_runs ADD COLUMN retry_after timestamptz, ADD COLUMN retry_reason text',
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (60)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=61'))
        .rows.length
    ) {
      // The backup carries the server's configuration as well as its data now,
      // so a run can fail at a third place: the database export, the upload of
      // that export, or the upload of the configuration. A run that saved the
      // money and lost the credentials is not the same event as one that saved
      // neither, and the operations page should be able to say which.
      // PostgreSQL has no ALTER for a check's expression, so it is replaced;
      // every existing row already satisfies the wider one.
      await tx.query(
        'ALTER TABLE backup_runs DROP CONSTRAINT IF EXISTS backup_runs_stage_check',
      );
      await tx.query(
        `ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_stage_check
         CHECK(stage IN ('dump','upload','config'))`,
      );
      await tx.query('INSERT INTO schema_versions(version) VALUES (61)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=62'))
        .rows.length
    ) {
      // A day with no stored rate used to be one fact. It is two: a day nobody
      // published, which will never fill and is not a fault, and a day the sync
      // has not reached, which is. Only the first can be recorded here, because
      // only it is something a provider actually told us.
      await initializeFxCoverage(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (62)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=63'))
        .rows.length
    ) {
      // Confirmed rules the tree migration left pointing at the root catch-all.
      // Triage read them as decisions and asked nobody; the automatic write
      // refused to file anything under a catch-all. The payment came out
      // neither classified nor asked about, which is the one outcome the
      // review flow is supposed to make impossible.
      await restoreRuleCategoriesLostToTheTree(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (63)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=64'))
        .rows.length
    ) {
      // A receipt sent as a reply to one of the bot's questions is an answer
      // about that payment, and the reply says which payment far better than
      // the date and merchant search can work out.
      await upgradeReceiptAnswers(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (64)');
    }
    if (
      !(await tx.query('SELECT version FROM schema_versions WHERE version=65'))
        .rows.length
    ) {
      // What the owner said after reading what the repair had done: three more
      // shops whose name cannot file a payment, and one rule the repair could
      // only leave on a branch catch-all.
      await applyOwnerRuleCorrections(tx);
      await tx.query('INSERT INTO schema_versions(version) VALUES (65)');
    }
  });
}

/**
 * Put the bank's name on foreign accounts that never had one.
 *
 * The bank is not stored on the account; it is the third part of the connection
 * recorded against every import window, so it is read back from there. An
 * account whose label the owner has edited is left exactly as they wrote it —
 * only a label this application generated, the bare currency or the currency
 * followed by "account", is replaced.
 */
/**
 * An account that holds several currencies was registered as "Swedbank XXX ·
 * CURRENT". XXX is the ISO code for "no currency" and means nothing to the
 * owner, so the label is rewritten the way the connector writes it now. Only a
 * name this application generated can contain " XXX"; a name the owner typed
 * cannot match, and is left as they wrote it.
 */
export async function nameTheMultiCurrencyAccounts(
  tx: Executor,
): Promise<number> {
  const renamed = await tx.query(
    `UPDATE own_accounts SET
       label = CASE
         WHEN split_part(label, ' \u00b7 ', 2) = '' THEN split_part(label, ' ', 1) || ' multi-currency'
         WHEN upper(split_part(label, ' \u00b7 ', 2)) = 'CURRENT' THEN split_part(label, ' ', 1) || ' current account'
         ELSE split_part(label, ' ', 1) || ' ' || split_part(label, ' \u00b7 ', 2)
       END,
       revision = revision + 1
     WHERE source = 'enablebanking'
       AND label ~ '^[A-Za-z]+ XXX( \u00b7 .+)?$'
     RETURNING label`,
  );
  return renamed.rows.length;
}

export async function nameTheBankOnAccounts(tx: Executor): Promise<number> {
  const renamed = await tx.query(
    `UPDATE own_accounts a SET label = initcap(w.bank) || ' ' || w.currency,
                               revision = a.revision + 1
     FROM (SELECT DISTINCT account_id, split_part(connection,':',3) AS bank, currency
           FROM bank_import_windows
           WHERE connection LIKE 'enablebanking:%:%') w
     WHERE w.account_id = a.account_id
       AND a.source = 'enablebanking'
       AND w.bank IN ('wise','revolut')
       -- Only a name this application generated: the bare currency, or the
       -- currency followed by "account". Anything the owner wrote themselves
       -- fails this and is left exactly as they wrote it.
       AND a.label ~* ('^' || w.currency || '( account)?$')
     RETURNING a.label`,
  );
  return renamed.rows.length;
}

/**
 * Before banks were tracked separately, every Enable Banking import of an owner
 * leased one key: `enablebanking:<owner>`. Per-bank scheduling replaced it with
 * `enablebanking:<owner>:<bank>`, and the old row was left behind so the import
 * windows hanging off it kept their parent. It has recorded nothing since, but
 * it still reaches the screen as a connection the owner never made.
 *
 * A window already says which account and currency it covered; only its
 * connection is stale. The bank is recovered the way `nameTheBankOnAccounts`
 * already recovers it — from a per-bank window for the same account — so the
 * coverage moves to the connection that owns those accounts today rather than
 * being thrown away. An account that never imported under a per-bank key has no
 * bank to recover and is left alone.
 *
 * The delete is therefore conditional: a per-owner row still holding windows
 * keeps its children and stays on screen, which is the honest outcome. Both
 * statements are idempotent, so a re-run changes nothing.
 */
export async function retirePerOwnerBankConnections(
  tx: Executor,
): Promise<{ moved: number; removed: number }> {
  const moved = await tx.query(
    `UPDATE bank_import_windows w
     SET connection = 'enablebanking:' || w.owner || ':' || bank.slug
     FROM (SELECT account_id, min(split_part(connection, ':', 3)) AS slug
             FROM bank_import_windows
            WHERE connection LIKE 'enablebanking:%:%'
            GROUP BY account_id
           -- One account belongs to one bank. Anything else is a contradiction
           -- in the data, and guessing which half is right would be worse than
           -- leaving the windows where they are.
           HAVING count(DISTINCT split_part(connection, ':', 3)) = 1) bank
     WHERE bank.account_id = w.account_id
       AND w.connection ~ '^enablebanking:[^:]+$'
     RETURNING w.id`,
  );
  const removed = await tx.query(
    `DELETE FROM bank_sync_runs s
      WHERE s.connection ~ '^enablebanking:[^:]+$'
        AND NOT EXISTS (SELECT 1 FROM bank_import_windows w
                         WHERE w.connection = s.connection)
     RETURNING s.connection`,
  );
  return { moved: moved.rows.length, removed: removed.rows.length };
}

// Snapshot of a freshly migrated throwaway database, built once per process.
// Restoring it is byte-identical to running every migration, but skips initdb:
// ~140ms instead of ~720ms. `undefined` means "not built yet"; a promise that
// resolves to undefined means the build failed and callers must migrate for real.
let migratedSnapshot: Promise<Blob | File | undefined> | undefined;
let snapshotVersion = 0;

// The snapshot is also cached on disk, because `node --test` runs every test
// file in its own process. Without the cache each of the 57 files that need a
// database pays for its own initdb, measured at 2,953ms against 735ms to
// restore one through the cache — about 27% of the suite's total CPU.
//
// `dist/src/database.js` at run time, so the cache lives inside `dist` and is
// discarded with it. Each worktree therefore keeps its own.
const compiledSourceDir = dirname(fileURLToPath(import.meta.url));
const snapshotCacheDir = join(compiledSourceDir, '..', '.pglite-cache');

// A snapshot may only be reused by code that would produce the same schema, so
// the cache is keyed by the compiled sources that define the migrations. A
// rebuild that changes any of them yields a different key, and the snapshot is
// rebuilt rather than trusted.
async function compiledSourceDigest(): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) {
        hash.update(entry.name);
        hash.update(await readFile(full));
      }
    }
  };
  await walk(compiledSourceDir);
  return hash.digest('hex').slice(0, 16);
}

let cacheKey: Promise<string> | undefined;
const snapshotCacheKey = (): Promise<string> =>
  (cacheKey ??= compiledSourceDigest());

async function readCachedSnapshot(): Promise<
  { data: File; version: number } | undefined
> {
  try {
    const key = await snapshotCacheKey();
    // Written after the tar, so its presence means the tar is complete.
    const meta = JSON.parse(
      await readFile(join(snapshotCacheDir, `${key}.json`), 'utf8'),
    ) as { version: number };
    const bytes = await readFile(join(snapshotCacheDir, `${key}.tar`));
    return {
      data: new File([bytes], 'pgdata.tar', { type: 'application/x-tar' }),
      version: meta.version,
    };
  } catch {
    return undefined;
  }
}

async function writeCachedSnapshot(
  data: Blob | File,
  version: number,
): Promise<void> {
  const key = await snapshotCacheKey();
  await mkdir(snapshotCacheDir, { recursive: true });
  // Test files run concurrently, so two processes can race to fill an empty
  // cache. Both write complete files under private names and rename them into
  // place, which is atomic: a reader sees one whole snapshot or none at all.
  const stamp = `${process.pid}.${Date.now()}`;
  const publish = async (suffix: string, bytes: Buffer): Promise<void> => {
    const temporary = join(snapshotCacheDir, `${key}.${suffix}.${stamp}`);
    await writeFile(temporary, bytes);
    await rename(temporary, join(snapshotCacheDir, `${key}.${suffix}`));
  };
  await publish('tar', Buffer.from(await data.arrayBuffer()));
  await publish('json', Buffer.from(JSON.stringify({ version })));
  for (const name of await readdir(snapshotCacheDir)) {
    if (!name.startsWith(key)) {
      await rm(join(snapshotCacheDir, name), { force: true });
    }
  }
}

// Migrating a database of its own leaves the caller's untouched, so a cache hit
// and a cache miss both reach `migrate` below by exactly the same path.
async function buildSnapshot(): Promise<Blob | File> {
  const seed = memoryDatabase();
  const handle = memoryHandles.get(seed);
  if (!handle) throw new Error('seed database has no memory handle');
  try {
    await applyMigrations(seed);
    snapshotVersion = await schemaVersion(seed);
    return await (await handle.engine()).dumpDataDir('none');
  } finally {
    await seed.close();
  }
}
// Only `node --test` child processes take the fast path, so the application
// (PostgreSQL, and the demo's on-disk `memoryDatabase('data/demo')`) is untouched.
const snapshotsEnabled = process.env.NODE_TEST_CONTEXT !== undefined;

async function schemaVersion(db: Database): Promise<number> {
  const applied = await db.query<{ version: number | null }>(
    'SELECT max(version) AS version FROM schema_versions',
  );
  return Number(applied.rows[0]?.version ?? 0);
}

export async function migrate(db: Database): Promise<void> {
  const handle = memoryHandles.get(db);
  if (!snapshotsEnabled || !handle?.ephemeral || !handle.pristine()) {
    await applyMigrations(db);
    return;
  }
  // Other callers fall back to a real migration if this ever fails.
  migratedSnapshot ??= (async () => {
    const cached = await readCachedSnapshot();
    if (cached) {
      snapshotVersion = cached.version;
      return cached.data;
    }
    const built = await buildSnapshot();
    // A cache the process cannot write is a lost optimisation, not a failure.
    await writeCachedSnapshot(built, snapshotVersion).catch(() => {});
    return built;
  })().catch(() => undefined);
  const snapshot = await migratedSnapshot;
  if (!snapshot) {
    await applyMigrations(db);
    return;
  }
  // A restore is a brand new engine with its own storage, so the database is
  // as isolated as a freshly migrated one.
  handle.adopt(PGlite.create({ loadDataDir: snapshot }));
  if ((await schemaVersion(db)) !== snapshotVersion) await applyMigrations(db);
}
