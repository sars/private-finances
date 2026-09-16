import { randomUUID } from 'node:crypto';
import type { Executor } from './database.js';
import { readMcc } from './mcc.js';
import { isSettlementOnly } from './domain.js';
import type { ClassificationSource } from './resting-place.js';
import {
  installCategoryAssignmentGuard,
  createCategoryTree,
  seedCategoryTree,
} from './category-tree.js';

/**
 * Moving the ledger from per-owner path strings to the one shared tree of
 * ADR 0006.
 *
 * Nothing is discarded. Every payment keeps the path it used to carry in
 * `category_migration_log`, so a mapping the owner disagrees with can be found
 * and corrected rather than argued about from memory.
 */

/**
 * The category schema exactly as version 7 created it, frozen.
 *
 * A migration step must keep producing what it originally produced, or a fresh
 * database reaches version 25 with nothing to migrate while an existing one
 * still has the old tables — and only the second would ever be tested. Keeping
 * the old shape here means every test run exercises the real transition.
 */
export async function initializeLegacyCategories(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS category_nodes (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK(owner IN ('rodion','katya')),
    name text NOT NULL, parent_id uuid, node_type text NOT NULL CHECK(node_type IN ('category','tag')),
    UNIQUE(owner,id), UNIQUE(owner,node_type,name),
    FOREIGN KEY(owner,parent_id) REFERENCES category_nodes(owner,id)
  )`);
  await tx.query(`CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id uuid NOT NULL REFERENCES transactions(id), owner text NOT NULL,
    tag_id uuid NOT NULL, PRIMARY KEY(transaction_id,tag_id),
    FOREIGN KEY(owner,tag_id) REFERENCES category_nodes(owner,id)
  )`);
  await tx.query(`CREATE TABLE IF NOT EXISTS classification_rules (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK(owner IN ('rodion','katya')), version integer NOT NULL CHECK(version>0),
    match_field text NOT NULL CHECK(match_field IN ('description','counterparty','description_contains')), match_value text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('personal_expense','internal_transfer','investment','non_personal','unresolved')),
    category_id uuid, active boolean NOT NULL, UNIQUE(owner,id),
    FOREIGN KEY(owner,category_id) REFERENCES category_nodes(owner,id), CHECK(kind!='personal_expense' OR category_id IS NOT NULL)
  )`);
  await tx.query(`CREATE TABLE IF NOT EXISTS classification_rule_audit (
    id uuid PRIMARY KEY, owner text NOT NULL, rule_id uuid NOT NULL, version integer NOT NULL,
    definition jsonb NOT NULL, reason text NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(rule_id,version), FOREIGN KEY(owner,rule_id) REFERENCES classification_rules(owner,id)
  )`);
}

/** Old canonical paths, lower-cased, to the slug that now holds them. */
const LEGACY_PATHS: Readonly<Record<string, string>> = {
  food: 'food.unspecified',
  'food / groceries': 'food.groceries',
  'food / restaurants': 'food.restaurants.dining',
  'food / delivery': 'food.restaurants.delivery',
  delivery: 'food.restaurants.delivery',
  'food / alcohol': 'food.alcohol',
  home: 'home.unspecified',
  'home / rent': 'home.rent',
  'home / utilities': 'home.utilities',
  'home / goods': 'home.goods',
  'home / services': 'home.services',
  'home / repairs': 'home.repairs',
  communication: 'communication.unspecified',
  'communication / mobile phone': 'communication.mobile',
  'communication / internet': 'communication.internet',
  transport: 'transport.unspecified',
  'transport / public transport': 'transport.public',
  'transport / car': 'transport.car.unspecified',
  'transport / car / fuel': 'transport.car.fuel',
  'transport / taxi': 'transport.ride_hailing',
  'transport / ride-hailing': 'transport.ride_hailing',
  sport: 'sport.unspecified',
  'sport / racket sports': 'sport.racket',
  'sport / gym': 'sport.gym',
  health: 'health.unspecified',
  'health / psychotherapy': 'health.psychotherapy',
  'health / medical': 'health.medical',
  'health / pharmacy': 'health.pharmacy',
  // Named a shop rather than a purpose, so it carries no meaning to preserve.
  // The merchant-category pass below rescues what the bank data can explain.
  shopping: 'unspecified',
  travel: 'travel.other',
  'travel / accommodation': 'travel.accommodation',
  // One idea that had been split in two.
  subscriptions: 'apps_services',
  'apps & services': 'apps_services',
  'apps and services': 'apps_services',
  education: 'education.unspecified',
  'education / courses': 'education.courses',
  'education / materials': 'education.materials',
  entertainment: 'entertainment.unspecified',
  gifts: 'gifts',
  pets: 'pets',
  donations: 'donations',
  clothes: 'clothes',
  electronics: 'electronics',
  beauty: 'beauty.unspecified',
  family: 'family.unspecified',
  'family / parents support': 'family.parents_support',
  other: 'unspecified',
  unspecified: 'unspecified',
};

/**
 * Merchant category code to category, used only to rescue payments that would
 * otherwise sit in an Unspecified leaf and that no person has ever classified.
 *
 * An MCC describes the merchant's business, never the individual item bought,
 * so this is evidence and not proof. It is applied in one direction only —
 * Unspecified to something more precise — where it cannot make a classification
 * worse than the one it replaces. Codes whose business does not imply a single
 * household purpose are deliberately absent.
 */
export const MCC_CATEGORY: Readonly<Record<number, string>> = {
  742: 'pets',
  4111: 'transport.public',
  4112: 'transport.long_distance',
  4121: 'transport.ride_hailing',
  4131: 'transport.public',
  4214: 'post_logistics',
  4215: 'post_logistics',
  4511: 'transport.long_distance',
  4722: 'travel.other',
  4784: 'transport.car.unspecified',
  4814: 'communication.mobile',
  4816: 'apps_services',
  4899: 'communication.internet',
  4900: 'home.utilities',
  5045: 'electronics',
  5192: 'entertainment.hobbies',
  5200: 'home.goods',
  5211: 'home.repairs',
  5231: 'home.repairs',
  5251: 'home.repairs',
  5261: 'home.goods',
  5309: 'travel.other',
  5310: 'food.groceries',
  5311: 'home.goods',
  5411: 'food.groceries',
  5412: 'food.groceries',
  5422: 'food.groceries',
  5441: 'food.groceries',
  5451: 'food.groceries',
  5462: 'food.groceries',
  5499: 'food.groceries',
  5533: 'transport.car.maintenance',
  5541: 'transport.car.fuel',
  5542: 'transport.car.fuel',
  5611: 'clothes',
  5621: 'clothes',
  5631: 'clothes',
  5641: 'clothes',
  5651: 'clothes',
  5655: 'clothes',
  5661: 'clothes',
  5691: 'clothes',
  5699: 'clothes',
  5712: 'home.goods',
  5719: 'home.goods',
  5722: 'electronics',
  5732: 'electronics',
  5734: 'apps_services',
  5735: 'entertainment.hobbies',
  5811: 'food.restaurants.dining',
  5812: 'food.restaurants.dining',
  5813: 'food.restaurants.dining',
  5814: 'food.restaurants.dining',
  5815: 'apps_services',
  5912: 'health.pharmacy',
  5921: 'food.alcohol',
  5941: 'sport.equipment',
  5942: 'entertainment.hobbies',
  5945: 'entertainment.hobbies',
  5946: 'entertainment.hobbies',
  5947: 'gifts',
  5977: 'beauty.cosmetics',
  5992: 'gifts',
  5995: 'pets',
  6513: 'home.rent',
  7011: 'travel.accommodation',
  7033: 'travel.accommodation',
  7217: 'home.services',
  7230: 'beauty.services',
  7523: 'transport.car.parking',
  7538: 'transport.car.maintenance',
  7832: 'entertainment.events',
  7922: 'entertainment.events',
  7997: 'sport.gym',
  7991: 'entertainment.events',
  8011: 'health.medical',
  8021: 'health.medical',
  8031: 'health.medical',
  8042: 'health.medical',
  8049: 'health.medical',
  8062: 'health.medical',
  8071: 'health.medical',
  8099: 'health.medical',
  8211: 'education.courses',
  8220: 'education.courses',
  8299: 'education.courses',
  8398: 'donations',
  9402: 'post_logistics',
};

export type CategoryMigrationReport = {
  mapped: number;
  byMcc: number;
  unspecified: number;
  kindsMaterialized: number;
  unmappedPaths: string[];
};

async function slugIds(tx: Executor): Promise<Map<string, string>> {
  const rows = (await tx.query('SELECT id,slug FROM category_tree')).rows;
  return new Map(rows.map((row) => [String(row.slug), String(row.id)]));
}

/**
 * Best effort placement for a path the explicit map does not list, so that an
 * owner-invented category is not flattened into the root catch-all when the
 * tree plainly has a home for it.
 */
function fallbackSlug(
  path: string,
  byPath: Map<string, string>,
  byLeafName: Map<string, string>,
  branchUnspecified: Map<string, string>,
): string | null {
  const normalized = path.toLowerCase().trim();
  const direct = byPath.get(normalized);
  if (direct) return direct;
  const segments = normalized.split(' / ').map((part) => part.trim());
  const leaf = byLeafName.get(segments.at(-1)!);
  if (leaf) return leaf;
  const branch = branchUnspecified.get(segments[0]!);
  if (branch) return branch;
  return null;
}

export async function migrateCategoryTree(
  tx: Executor,
): Promise<CategoryMigrationReport> {
  // Structure first, then the column that points into it, then the seed: the
  // seed's inserts re-derive every payment's path, so the column must exist.
  await createCategoryTree(tx);
  await tx.query(
    'ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES category_tree(id)',
  );
  await seedCategoryTree(tx);
  await tx.query(`CREATE TABLE IF NOT EXISTS category_migration_log (
    transaction_id uuid PRIMARY KEY REFERENCES transactions(id),
    legacy_path text, category_id uuid REFERENCES category_tree(id),
    method text NOT NULL CHECK(method IN ('explicit_map','fallback','merchant_category','catch_all')),
    migrated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await installCategoryAssignmentGuard(tx);

  const ids = await slugIds(tx);
  const nodes = (
    await tx.query(
      `SELECT id, slug, lower(category_path(id)) AS path,
         NOT EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=category_tree.id) AS assignable
       FROM category_tree`,
    )
  ).rows;
  const byPath = new Map<string, string>();
  const byLeafName = new Map<string, string>();
  const branchUnspecified = new Map<string, string>();
  for (const row of nodes) {
    const slug = String(row.slug);
    const path = String(row.path);
    if (row.assignable) {
      byPath.set(path, slug);
      const leaf = path.split(' / ').at(-1)!;
      // "Unspecified" and "Services" repeat across branches; an ambiguous leaf
      // name is no evidence at all, so it is withheld rather than guessed.
      if (byLeafName.has(leaf)) byLeafName.set(leaf, '');
      else byLeafName.set(leaf, slug);
    }
    if (slug.endsWith('.unspecified'))
      branchUnspecified.set(path.split(' / ')[0]!, slug);
  }
  for (const [name, slug] of [...byLeafName])
    if (!slug) byLeafName.delete(name);

  const report: CategoryMigrationReport = {
    mapped: 0,
    byMcc: 0,
    unspecified: 0,
    kindsMaterialized: 0,
    unmappedPaths: [],
  };
  const catchAll = ids.get('unspecified')!;

  const legacy = (
    await tx.query(
      'SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL AND category_id IS NULL',
    )
  ).rows.map((row) => String(row.category));
  for (const path of legacy) {
    const explicit = LEGACY_PATHS[path.toLowerCase().trim()];
    const slug =
      explicit ?? fallbackSlug(path, byPath, byLeafName, branchUnspecified);
    if (!slug) report.unmappedPaths.push(path);
    const target = (slug && ids.get(slug)) || catchAll;
    const method = explicit ? 'explicit_map' : slug ? 'fallback' : 'catch_all';
    const moved = await tx.query(
      `UPDATE transactions SET category_id=$1 WHERE category_id IS NULL AND category=$2 RETURNING id, $3::text AS legacy_path, $4::text AS method`,
      [target, path, path, method],
    );
    report.mapped += moved.rows.length;
    for (const row of moved.rows)
      await tx.query(
        `INSERT INTO category_migration_log(transaction_id,legacy_path,category_id,method) VALUES($1,$2,$3,$4)
         ON CONFLICT(transaction_id) DO NOTHING`,
        [String(row.id), path, target, method],
      );
  }

  report.byMcc = await rescueUnspecifiedByMcc(tx, ids);
  report.kindsMaterialized = await materializeAccountPolicyKinds(tx);
  report.unspecified = Number(
    (
      await tx.query(
        `SELECT count(*)::int AS count FROM transactions t JOIN category_tree n ON n.id=t.category_id
         WHERE lower(n.name)='unspecified'`,
      )
    ).rows[0]!.count,
  );

  await tx.query(
    `ALTER TABLE transactions ADD CONSTRAINT transactions_expense_has_category
     CHECK(kind <> 'personal_expense' OR category_id IS NOT NULL)`,
  );
  return report;
}

/**
 * Pull payments out of an Unspecified leaf when the bank told us what kind of
 * business was paid. Only ever applied to a payment no person has classified,
 * and only when it replaces Unspecified, so it cannot overwrite a decision or
 * make an existing answer less accurate.
 */
/** Read the merchant code of each candidate and file it where the code says,
 * recording why. Shared by both rescue passes so the mapping, the log update and
 * the audit trail can never drift apart between them. */
async function applyMerchantCategory(
  tx: Executor,
  ids: Map<string, string>,
  candidates: readonly Record<string, unknown>[],
  describe: (code: number, meaning: string) => string,
): Promise<number> {
  let rescued = 0;
  for (const row of candidates) {
    const mcc = readMcc(row.source_details as Record<string, unknown>);
    // A money-transfer code says nothing about what was bought.
    if (!mcc || mcc.financialTransfer) continue;
    const target = ids.get(MCC_CATEGORY[mcc.code] ?? '');
    if (!target) continue;
    await tx.query('UPDATE transactions SET category_id=$1 WHERE id=$2', [
      target,
      String(row.id),
    ]);
    await tx.query(
      'UPDATE category_migration_log SET category_id=$1, method=$2 WHERE transaction_id=$3',
      [target, 'merchant_category', String(row.id)],
    );
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','account_policy_applied',$3,$4,$5)`,
      [
        randomUUID(),
        String(row.id),
        JSON.stringify({ category: null }),
        JSON.stringify({ categoryId: target }),
        describe(mcc.code, mcc.meaning),
      ],
    );
    rescued++;
  }
  return rescued;
}

async function rescueUnspecifiedByMcc(
  tx: Executor,
  ids: Map<string, string>,
): Promise<number> {
  const candidates = (
    await tx.query(
      `SELECT t.id, t.source_details FROM transactions t
       JOIN category_tree n ON n.id=t.category_id
       WHERE lower(n.name)='unspecified'
         AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event='classified')`,
    )
  ).rows;
  return applyMerchantCategory(
    tx,
    ids,
    candidates,
    (code, meaning) =>
      `Merchant category ${code} (${meaning}) placed a previously unspecified payment`,
  );
}

/**
 * Payments the tree migration stranded on the root catch-all.
 *
 * `rescueUnspecifiedByMcc` deliberately leaves a human decision alone, which is
 * right whenever that decision still says something. It is wrong here. These
 * people did classify the payment; the migration then mapped the path they chose
 * — `Shopping`, `Apps & services / AI tools` — onto the catch-all because the new
 * tree had no successor for it. Nothing about the money survived, and because the
 * payment is neither unresolved nor provisional it never returned to the review
 * queue either, so nobody was ever asked to repair it. Reading the merchant code
 * back repairs a decision the migration discarded; it does not override one that
 * stands.
 *
 * Only the root catch-all qualifies. `Food / Unspecified` still names a branch,
 * so a payment sitting there keeps whatever the person meant by it.
 */
export async function rescueMigrationStrandedCatchAll(
  tx: Executor,
): Promise<number> {
  const ids = await slugIds(tx);
  const candidates = (
    await tx.query(
      `SELECT t.id, t.source_details FROM transactions t
       JOIN category_tree n ON n.id=t.category_id
       JOIN category_migration_log l ON l.transaction_id=t.id
       WHERE n.parent_id IS NULL AND lower(n.name)='unspecified'`,
    )
  ).rows;
  return applyMerchantCategory(
    tx,
    ids,
    candidates,
    (code, meaning) =>
      `Merchant category ${code} (${meaning}) repaired a payment the category-tree migration left on the root catch-all`,
  );
}

/**
 * Account purpose used to rewrite a payment's kind every time it was displayed,
 * which meant the ledger never recorded what the totals were actually doing and
 * a grocery run on a business card could not be marked personal.
 *
 * The rewrite is written down once, here, so that totals are unchanged on the
 * day of the migration and each payment becomes individually correctable —
 * which is what the owner asked for, since not everything on a business account
 * is business spending.
 *
 * Only payments nobody has classified are touched. An explicit human decision
 * that the display layer had been quietly overriding is left standing.
 */
async function materializeAccountPolicyKinds(tx: Executor): Promise<number> {
  const rows = (
    await tx.query(
      `SELECT t.id, t.kind, a.purpose FROM transactions t
       JOIN own_accounts a ON a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id
       WHERE a.purpose IN ('business','investment') AND t.kind='unresolved'`,
    )
  ).rows;
  for (const row of rows) {
    const kind = row.purpose === 'investment' ? 'investment' : 'non_personal';
    await tx.query('UPDATE transactions SET kind=$1 WHERE id=$2', [
      kind,
      String(row.id),
    ]);
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','auto_classified',$3,$4,$5)`,
      [
        randomUUID(),
        String(row.id),
        JSON.stringify({ kind: 'unresolved' }),
        JSON.stringify({ kind }),
        `Recorded the ${String(row.purpose)} account policy that reporting had been applying at display time`,
      ],
    );
  }
  return rows.length;
}

/** Tags become a household list of their own, no longer nodes in the category
 * tree. Two owners who both used "vacation" were keeping the same tag twice. */
export async function migrateTags(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS tags (
    id uuid PRIMARY KEY, name text NOT NULL CHECK(btrim(name) <> '' AND length(name) <= 80)
  )`);
  await tx.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS tags_name ON tags (lower(name))',
  );
  const legacyTags = (
    await tx.query(
      "SELECT id, name FROM category_nodes WHERE node_type='tag' ORDER BY name,id",
    )
  ).rows;
  const mapping: Array<{ old: string; next: string }> = [];
  const byName = new Map<string, string>();
  for (const row of legacyTags) {
    const name = String(row.name);
    const key = name.toLowerCase();
    if (!byName.has(key)) {
      const id = randomUUID();
      await tx.query('INSERT INTO tags(id,name) VALUES($1,$2)', [id, name]);
      byName.set(key, id);
    }
    mapping.push({ old: String(row.id), next: byName.get(key)! });
  }
  // The owner column carries the composite foreign key into category_nodes, and
  // dropping the column takes the constraint with it whatever Postgres named it.
  // This must happen before any tag_id is repointed: a new tags row is not in
  // category_nodes, so remapping first fails that foreign key on every household
  // that actually has tags — which the migration rehearsal against a copy of
  // production is how we found out.
  await tx.query('ALTER TABLE transaction_tags DROP COLUMN IF EXISTS owner');
  // Rebuilt from a DISTINCT select rather than updated in place, because two
  // legacy tags differing only in case merge into one and could otherwise
  // collide on the primary key when both were on the same payment.
  await tx.query(
    'CREATE TEMP TABLE remapped_transaction_tags(transaction_id uuid NOT NULL, tag_id uuid NOT NULL) ON COMMIT DROP',
  );
  for (const entry of mapping)
    await tx.query(
      `INSERT INTO remapped_transaction_tags(transaction_id,tag_id)
       SELECT DISTINCT t.transaction_id, $2::uuid FROM transaction_tags t WHERE t.tag_id=$1`,
      [entry.old, entry.next],
    );
  await tx.query('DELETE FROM transaction_tags');
  await tx.query(
    `INSERT INTO transaction_tags(transaction_id,tag_id)
     SELECT DISTINCT transaction_id, tag_id FROM remapped_transaction_tags`,
  );
  await tx.query(
    'ALTER TABLE transaction_tags ADD CONSTRAINT transaction_tags_tag_fkey FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE',
  );
}

/** Confirmed rules keep their matchers and their history; only the category
 * they point at moves to the shared tree. */
export async function migrateClassificationRules(tx: Executor): Promise<void> {
  await tx.query(
    'ALTER TABLE classification_rules ADD COLUMN IF NOT EXISTS tree_category_id uuid REFERENCES category_tree(id)',
  );
  const ids = await slugIds(tx);
  const rules = (
    await tx.query(
      `SELECT r.id, n.owner, n.id AS node_id FROM classification_rules r
       JOIN category_nodes n ON n.id=r.category_id WHERE r.category_id IS NOT NULL`,
    )
  ).rows;
  for (const rule of rules) {
    const path = (
      await tx.query(
        `WITH RECURSIVE up AS (
           SELECT id,parent_id,name,1 AS level FROM category_nodes WHERE id=$1
           UNION ALL SELECT p.id,p.parent_id,p.name,up.level+1 FROM category_nodes p JOIN up ON p.id=up.parent_id
         ) SELECT string_agg(name,' / ' ORDER BY level DESC) AS path FROM up`,
        [String(rule.node_id)],
      )
    ).rows[0]?.path;
    const slug = path
      ? LEGACY_PATHS[String(path).toLowerCase().trim()]
      : undefined;
    const target = (slug && ids.get(slug)) || ids.get('unspecified')!;
    await tx.query(
      'UPDATE classification_rules SET tree_category_id=$1 WHERE id=$2',
      [target, String(rule.id)],
    );
  }
  await tx.query('ALTER TABLE classification_rules DROP COLUMN category_id');
  await tx.query(
    'ALTER TABLE classification_rules RENAME COLUMN tree_category_id TO category_id',
  );
  await tx.query(
    `ALTER TABLE classification_rules ADD CONSTRAINT classification_rules_expense_has_category
     CHECK(kind <> 'personal_expense' OR category_id IS NOT NULL)`,
  );
}

/**
 * The merchants the owner named while reviewing their July spending.
 *
 * Each of these was sitting in the root catch-all because the bank sent a
 * money-transfer code and a sole trader's name, which no merchant code and no
 * model can resolve — only the household knows that `ФОП Величко Степан
 * Андрійович` is the mechanic. The owner said what each one was, so the
 * decision is theirs and it is written down here rather than re-derived.
 *
 * `Sent money to Rodion Salnik` is the reason rules can now match a fragment:
 * every one of those transfers carries a different `TRANSFER-<number>` prefix,
 * so an exact rule answers one payment and the next needs another.
 *
 * Only that one becomes a standing rule. The owner asked for a rule there and
 * nowhere else — "i told about one rule only. others were just to categorise
 * once" — and the difference is reach: filing answers the payments that exist,
 * while a rule answers every future payment without asking again. Turning a
 * decision about six payments into a standing policy is the silent
 * generalisation this project already forbids.
 */
const OWNER_NAMED_MERCHANTS: readonly {
  field: 'description' | 'description_contains';
  value: string;
  kind: string;
  slug: string | null;
  /** True only where the owner asked for future payments to be answered too. */
  standingRule: boolean;
  reason: string;
}[] = [
  {
    field: 'description',
    value: 'hotline.finance',
    kind: 'personal_expense',
    slug: 'transport.car.insurance',
    standingRule: false,
    reason: 'Car insurance (страховка авто), named by the owner',
  },
  {
    field: 'description',
    value: 'ТОВ "БМ Фікс"',
    kind: 'personal_expense',
    slug: 'transport.car.maintenance',
    standingRule: false,
    reason: 'Car repair (ремонт авто), named by the owner',
  },
  {
    field: 'description',
    value: 'ФОП Величко Степан Андрійович',
    kind: 'personal_expense',
    slug: 'transport.car.maintenance',
    standingRule: false,
    reason: 'Car repair (ремонт авто), named by the owner',
  },
  {
    field: 'description',
    value: 'ФОП Петраков Євгеній Сергійович',
    kind: 'personal_expense',
    slug: 'sport.racket',
    standingRule: false,
    reason: 'Padel court hire (оренда корта падел), named by the owner',
  },
  {
    field: 'description',
    value: "ТОВ 'Явір-2000'",
    kind: 'personal_expense',
    slug: 'utilities.security',
    standingRule: false,
    reason: 'Building security, named by the owner',
  },
  {
    field: 'description',
    value: 'Дія | Штрафи',
    kind: 'personal_expense',
    slug: 'transport.car.fines',
    standingRule: false,
    reason:
      'Speeding fine (штраф за перевищення швидкості), named by the owner',
  },
  {
    field: 'description_contains',
    value: 'Sent money to Rodion Salnik',
    kind: 'internal_transfer',
    slug: null,
    standingRule: true,
    reason: 'The owner moving money between their own accounts',
  },
];

/**
 * Write those decisions down as rules, and apply them to the payments already
 * in the ledger.
 *
 * A rule is written only for the entry the owner asked to become one, and it
 * covers both members: a transfer to one of them is household money moving
 * whoever sent it. Everything else is filed and left alone, so naming a
 * merchant answers the payments in the ledger without also deciding every
 * future payment in silence.
 *
 * Only payments that are still undecided are touched: unresolved, provisional,
 * or filed on the root catch-all. A payment either of them has since filed
 * somewhere meaningful is left exactly as it is.
 *
 * A merchant is skipped entirely unless the ledger already holds a payment to
 * it. These are observations about this household's spending, not part of the
 * schema, so a database that has never seen the merchant — a fresh install, a
 * test fixture — must come out of this migration unchanged. Writing them
 * unconditionally put seven rules per member into every database and broke the
 * tests that assert a new ledger starts with none.
 */
export async function fileOwnerNamedMerchants(tx: Executor): Promise<number> {
  const ids = await slugIds(tx);
  let filed = 0;
  for (const merchant of OWNER_NAMED_MERCHANTS) {
    const categoryId = merchant.slug ? (ids.get(merchant.slug) ?? null) : null;
    if (merchant.slug && !categoryId)
      throw new Error(`category_not_found:${merchant.slug}`);
    const seen = await tx.query(
      `SELECT 1 FROM transactions t
       WHERE rule_matches($1, $2, t.description, t.source_details->>'counterpartyIdentifier')
       LIMIT 1`,
      [merchant.field, merchant.value],
    );
    if (!seen.rows.length) continue;
    // Both members, not only the one whose rows are in the ledger today. Money
    // arriving in Rodion's account has not been spent by anyone whichever of
    // them sent it, and the ledger does not hold every account the household
    // has, so the absence of Katya's side is not evidence it never happens.
    const holders = merchant.standingRule
      ? (['rodion', 'katya'] as const)
      : ([] as const);
    for (const owner of holders) {
      const ruleId = randomUUID();
      const existing = await tx.query(
        `SELECT id FROM classification_rules
         WHERE owner=$1 AND match_field=$2 AND match_value=$3`,
        [owner, merchant.field, merchant.value],
      );
      if (existing.rows.length) {
        await tx.query(
          `UPDATE classification_rules SET kind=$1, category_id=$2, active=true
           WHERE id=$3`,
          [merchant.kind, categoryId, String(existing.rows[0]!.id)],
        );
      } else {
        await tx.query(
          `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,category_id,active)
           VALUES($1,$2,1,$3,$4,$5,$6,true)`,
          [
            ruleId,
            owner,
            merchant.field,
            merchant.value,
            merchant.kind,
            categoryId,
          ],
        );
        await tx.query(
          `INSERT INTO classification_rule_audit(id,owner,rule_id,version,definition,reason)
           VALUES($1,$2,$3,1,$4,$5)`,
          [
            randomUUID(),
            owner,
            ruleId,
            JSON.stringify({
              matcher: { field: merchant.field, value: merchant.value },
              kind: merchant.kind,
              categoryId,
            }),
            merchant.reason,
          ],
        );
      }
    }
    const applied = await tx.query(
      `UPDATE transactions t SET kind=$1, category_id=$2, provisional=false,
         classification_source='rule'
       WHERE rule_matches($3, $4, t.description, t.source_details->>'counterpartyIdentifier')
         AND (t.kind='unresolved' OR t.provisional
              OR t.category_id=(SELECT id FROM category_tree WHERE parent_id IS NULL AND slug='unspecified'))
       RETURNING t.id`,
      [merchant.kind, categoryId, merchant.field, merchant.value],
    );
    for (const row of applied.rows) {
      await tx.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
         VALUES($1,$2,'migration','classified',$3,$4,$5)`,
        [
          randomUUID(),
          String(row.id),
          JSON.stringify({ category: 'Unspecified' }),
          JSON.stringify({ kind: merchant.kind, categoryId }),
          merchant.reason,
        ],
      );
    }
    filed += applied.rows.length;
  }
  return filed;
}

/**
 * Payments left on the root catch-all that the bank's own merchant code can
 * explain.
 *
 * The resting place files a payment it cannot read on the root catch-all so the
 * money is still counted (ADR 0008), and marks it provisional so it comes back
 * for review. That is the right resting place, but the owner's objection stands:
 * the catch-all says nothing. Where a merchant code has since been added to
 * `MCC_CATEGORY`, reading it again moves the payment somewhere that does say
 * something.
 *
 * It stays provisional. A merchant code is evidence about the shop, never proof
 * about the purchase, so nobody has confirmed anything and the payment is still
 * owed a review — it is simply resting somewhere more honest while it waits.
 * Anything a person has decided is left alone.
 */
export async function placeRootCatchAllByMerchantCode(
  tx: Executor,
): Promise<number> {
  const ids = await slugIds(tx);
  const candidates = (
    await tx.query(
      `SELECT t.id, t.source_details FROM transactions t
       JOIN category_tree n ON n.id=t.category_id
       WHERE n.parent_id IS NULL AND lower(n.name)='unspecified'
         AND t.kind='personal_expense' AND t.provisional
         AND NOT EXISTS(SELECT 1 FROM audit_events a
                        WHERE a.transaction_id=t.id AND a.event='classified')`,
    )
  ).rows;
  let placed = 0;
  for (const row of candidates) {
    const mcc = readMcc(row.source_details as Record<string, unknown>);
    // A money-transfer code says nothing about what was bought.
    if (!mcc || mcc.financialTransfer) continue;
    const target = ids.get(MCC_CATEGORY[mcc.code] ?? '');
    if (!target) continue;
    await tx.query(
      "UPDATE transactions SET category_id=$1, classification_source='mcc' WHERE id=$2",
      [target, String(row.id)],
    );
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','auto_classified',$3,$4,$5)`,
      [
        randomUUID(),
        String(row.id),
        JSON.stringify({ category: 'Unspecified' }),
        JSON.stringify({ categoryId: target, provisional: true }),
        `Merchant category ${mcc.code} (${mcc.meaning}) moved this off the catch-all; nobody has confirmed it`,
      ],
    );
    placed++;
  }
  return placed;
}

/** What decided a payment, as the automatic pass recorded it, in the vocabulary
 * the `transactions` row uses. Sources this does not know about are left out,
 * because guessing the provenance of a restored decision would be worse than
 * leaving the payment in the review queue where it already is. */
const RESTORED_SOURCE: Readonly<Record<string, ClassificationSource>> = {
  confirmed_rule: 'rule',
  rule: 'rule',
  memory: 'memory',
  identity: 'identity',
  mcc: 'mcc',
  model: 'model',
  model_cache: 'model',
  receipt_model: 'model',
};

/**
 * Decisions that a settling card hold threw away.
 *
 * Monobank publishes a card purchase twice, and the importer treated the second
 * copy as the bank correcting itself: it discarded the classification and the
 * payment fell back to whatever its merchant code alone implied, marked
 * provisional, which put it in front of the owner as though nothing had ever
 * decided it. Every one of the thirty re-imports in the ledger was a settlement
 * of this kind — not once had an amount, a description, a date or a merchant
 * code actually moved — so the rule had only ever destroyed correct answers.
 *
 * `isSettlementOnly` now stops that happening again. This puts back what was
 * lost, reading the decision out of the audit trail that recorded it, and only
 * where the payment is still waiting: a payment a person has since decided, or
 * one a later automatic pass already answered, is left exactly as it is.
 */
export async function restoreSettlementInvalidatedDecisions(
  tx: Executor,
): Promise<number> {
  const rows = (
    await tx.query(
      `SELECT inv.transaction_id, inv.before_value AS lost,
              correction.before_value AS was, correction.after_value AS became,
              decision.after_value AS provenance
       FROM audit_events inv
       JOIN LATERAL (
         SELECT * FROM audit_events s WHERE s.transaction_id=inv.transaction_id
           AND s.event='source_corrected' AND s.created_at<=inv.created_at
         ORDER BY s.created_at DESC, s.id DESC LIMIT 1) correction ON true
       LEFT JOIN LATERAL (
         SELECT * FROM audit_events d WHERE d.transaction_id=inv.transaction_id
           AND d.event='auto_classified' AND d.created_at<=inv.created_at
         ORDER BY d.created_at DESC, d.id DESC LIMIT 1) decision ON true
       JOIN transactions t ON t.id=inv.transaction_id
       WHERE inv.event='auto_classification_invalidated' AND inv.actor='importer'
         AND (t.kind='unresolved' OR t.provisional)
         AND NOT EXISTS(SELECT 1 FROM audit_events h WHERE h.transaction_id=t.id
                        AND h.event IN ('classified','refund_linked','refund_unlinked'))
       ORDER BY inv.created_at`,
    )
  ).rows;
  let restored = 0;
  for (const row of rows) {
    if (
      !isSettlementOnly(
        row.was as Record<string, unknown>,
        row.became as Record<string, unknown>,
      )
    )
      continue;
    const lost = row.lost as Record<string, unknown> | null;
    const kind = typeof lost?.kind === 'string' ? lost.kind : null;
    if (!kind || kind === 'unresolved') continue;
    const provenance = row.provenance as Record<string, unknown> | null;
    const decided = (provenance?.provenance as Record<string, unknown>)
      ?.decision as Record<string, unknown> | undefined;
    const source = RESTORED_SOURCE[String(decided?.source ?? '')];
    if (!source) continue;
    const path = typeof lost?.category === 'string' ? lost.category : null;
    const target = path
      ? (
          await tx.query(
            'SELECT id FROM category_tree WHERE lower(category_path(id))=lower($1) LIMIT 1',
            [path],
          )
        ).rows[0]
      : undefined;
    if (kind === 'personal_expense' && !target) continue;
    await tx.query(
      'UPDATE transactions SET kind=$1, category_id=$2, classification_source=$3, provisional=false WHERE id=$4',
      [
        kind,
        target ? String(target.id) : null,
        source,
        String(row.transaction_id),
      ],
    );
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','auto_classified',$3,$4,$5)`,
      [
        randomUUID(),
        String(row.transaction_id),
        JSON.stringify({ provisional: true }),
        JSON.stringify({
          kind,
          category: path,
          source,
          provisional: false,
        }),
        'Restoring the decision a settling card hold discarded; the payment itself never changed',
      ],
    );
    restored++;
  }
  return restored;
}

/**
 * The three delivery platforms, which had been filed as eating out.
 *
 * Wolt, Bolt Food and Glovo bring food to the door; the tree has had
 * `Food / Restaurants / Delivery` for exactly that since the reshape. They were
 * filed under `Dining in` because the merchant code they send is a restaurant
 * code — 5812, 5814, and for the delivery arms 5811 — and a code describes the
 * business the money reached, which really is a restaurant. Only the merchant's
 * name distinguishes the two, so no merchant-code table can tell them apart.
 *
 * Both leaves hang off `Food / Restaurants`, so no total moves; what changes is
 * that the breakdown stops claiming the household ate out twenty-four times
 * when it was ordering in. Payments a person has decided are left alone, and no
 * standing rule is created: naming a merchant here is a correction to these
 * payments, not a licence to answer every future one without being asked.
 */
export async function fileDeliveryPlatformsAsDelivery(
  tx: Executor,
): Promise<number> {
  const target = (
    await tx.query(
      "SELECT id FROM category_tree WHERE slug='food.restaurants.delivery'",
    )
  ).rows[0];
  if (!target) return 0;
  const moved = await tx.query(
    `UPDATE transactions t SET category_id=$1
     WHERE t.kind='personal_expense'
       AND t.category_id IS DISTINCT FROM $1
       AND (t.description ILIKE 'Wolt' OR t.description ILIKE 'Wolt %'
            OR t.description ILIKE 'Bolt Food%' OR t.description ILIKE 'Glovo%')
       AND NOT EXISTS(SELECT 1 FROM audit_events a
                      WHERE a.transaction_id=t.id AND a.event='classified')
     RETURNING t.id`,
    [String(target.id)],
  );
  for (const row of moved.rows) {
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','auto_classified',$3,$4,$5)`,
      [
        randomUUID(),
        String(row.id),
        JSON.stringify({ category: 'Food / Restaurants / Dining in' }),
        JSON.stringify({ categoryId: String(target.id) }),
        'The merchant is a delivery platform, which its restaurant merchant code cannot show',
      ],
    );
  }
  return moved.rows.length;
}
