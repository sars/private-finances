import { randomUUID } from 'node:crypto';
import type { Executor } from './database.js';

/**
 * The household category tree (ADR 0006).
 *
 * One shared tree, not one per owner: a per-owner tree makes a family total by
 * category meaningless. Owner stays on the payment as a filter attribute.
 *
 * Structure is the truth (`transactions.category_id`); the `transactions.category`
 * path text is a database-maintained mirror so that renaming a category never
 * rewrites history and every existing reader keeps working unchanged.
 */
export type SeedNode = {
  /** Stable machine key. Set once at seed time and never changed, so a rename
   * cannot break a mapping, a test or a rule that refers to a category. */
  slug: string;
  name: string;
  children?: SeedNode[];
};

/** The branch catch-all leaf. Kept, and deliberately visible: the owner's
 * objection to a catch-all is that it says nothing, not that it should not
 * exist, so the aim is to shrink its use rather than remove the bucket. */
export const UNSPECIFIED = 'Unspecified';

/**
 * Seeded from ADR 0006, reshaped by ADR 0008 where the owner's own grouping
 * differed:
 *
 * - **Utilities** is a branch of its own holding housing bills, phone and
 *   internet. The owner listed those together and home goods separately, which
 *   neither the original tree (Utilities as a leaf inside Home) nor its first
 *   revision (a separate Communication branch) could total. The leaves keep the
 *   slugs they were created with, so the nodes that already hold those payments
 *   are the ones that moved.
 * - **Travel transport** is gone: flights and carpool are
 *   `Transport / Long distance`, where the owner places them. The accepted cost
 *   is that a Travel total excludes flights until the trip tag exists.
 * - Every branch carries its own `Unspecified` leaf, because parents are not
 *   assignable and something has to hold "known to be health, nothing more".
 */
export const CATEGORY_SEED: readonly SeedNode[] = [
  {
    slug: 'food',
    name: 'Food',
    children: [
      { slug: 'food.groceries', name: 'Groceries' },
      {
        slug: 'food.restaurants',
        name: 'Restaurants',
        // Ordering a meal is eating out by another route (ADR 0006).
        children: [
          { slug: 'food.restaurants.delivery', name: 'Delivery' },
          { slug: 'food.restaurants.dining', name: 'Dining in' },
        ],
      },
      { slug: 'food.alcohol', name: 'Alcohol' },
      { slug: 'food.unspecified', name: UNSPECIFIED },
    ],
  },
  {
    slug: 'home',
    name: 'Home',
    children: [
      { slug: 'home.rent', name: 'Rent' },
      { slug: 'home.goods', name: 'Goods' },
      { slug: 'home.services', name: 'Services' },
      { slug: 'home.repairs', name: 'Repairs' },
      // Property tax and the like, at the owner's request. Sole-trader tax is
      // business and never reaches a category at all; this is for the tax a
      // household pays on the place it lives.
      { slug: 'home.taxes', name: 'Taxes' },
      { slug: 'home.unspecified', name: UNSPECIFIED },
    ],
  },
  {
    slug: 'utilities',
    name: 'Utilities',
    // The owner listed utility bills "including all utilities — possibly
    // communications such as a phone top-up" as one thing, and home goods as
    // another. Housing utilities keeps the `home.utilities` slug so the node
    // that already holds those payments is the one that moved here.
    children: [
      { slug: 'home.utilities', name: 'Housing utilities' },
      { slug: 'communication.mobile', name: 'Mobile phone' },
      { slug: 'communication.internet', name: 'Internet' },
      // The owner named this while reviewing `ТОВ 'Явір-2000'`: a standing
      // charge for guarding the building, which is a utility bill of its own
      // rather than part of housing utilities.
      { slug: 'utilities.security', name: 'Security' },
      { slug: 'communication.unspecified', name: UNSPECIFIED },
    ],
  },
  {
    slug: 'transport',
    name: 'Transport',
    children: [
      {
        slug: 'transport.car',
        name: 'Car',
        // The one place the owner asked for a distinction inside a distinction:
        // fuel must read on its own, as part of car costs, and as all transport.
        children: [
          { slug: 'transport.car.fuel', name: 'Fuel' },
          { slug: 'transport.car.maintenance', name: 'Maintenance' },
          { slug: 'transport.car.parking', name: 'Parking' },
          { slug: 'transport.car.insurance', name: 'Insurance' },
          // Speeding fines arrive through the state app and are a cost of
          // running the car, not a category of their own elsewhere.
          { slug: 'transport.car.fines', name: 'Fines' },
          { slug: 'transport.car.unspecified', name: UNSPECIFIED },
        ],
      },
      { slug: 'transport.ride_hailing', name: 'Ride-hailing' },
      { slug: 'transport.public', name: 'Public transport' },
      { slug: 'transport.long_distance', name: 'Long distance' },
      { slug: 'transport.unspecified', name: UNSPECIFIED },
    ],
  },
  {
    slug: 'health',
    name: 'Health',
    children: [
      { slug: 'health.psychotherapy', name: 'Psychotherapy' },
      { slug: 'health.medical', name: 'Medical' },
      { slug: 'health.pharmacy', name: 'Pharmacy' },
      { slug: 'health.unspecified', name: UNSPECIFIED },
    ],
  },
  {
    slug: 'sport',
    name: 'Sport',
    children: [
      { slug: 'sport.gym', name: 'Gym' },
      { slug: 'sport.racket', name: 'Racket sports' },
      { slug: 'sport.volleyball', name: 'Volleyball' },
      { slug: 'sport.dance', name: 'Dance' },
      { slug: 'sport.equipment', name: 'Equipment' },
      { slug: 'sport.unspecified', name: UNSPECIFIED },
    ],
  },
  {
    slug: 'beauty',
    name: 'Beauty',
    children: [
      { slug: 'beauty.cosmetics', name: 'Cosmetics' },
      { slug: 'beauty.services', name: 'Services' },
      { slug: 'beauty.unspecified', name: UNSPECIFIED },
    ],
  },
  { slug: 'clothes', name: 'Clothes' },
  { slug: 'electronics', name: 'Electronics' },

  // Absorbs the former `Subscriptions`, which was the same idea under two names.
  { slug: 'apps_services', name: 'Apps & services' },
  {
    slug: 'education',
    name: 'Education',
    children: [
      { slug: 'education.courses', name: 'Courses' },
      { slug: 'education.materials', name: 'Materials' },
      { slug: 'education.unspecified', name: UNSPECIFIED },
    ],
  },
  {
    slug: 'entertainment',
    name: 'Entertainment',
    children: [
      { slug: 'entertainment.events', name: 'Events' },
      { slug: 'entertainment.hobbies', name: 'Hobbies' },
      { slug: 'entertainment.unspecified', name: UNSPECIFIED },
    ],
  },
  { slug: 'pets', name: 'Pets' },
  { slug: 'gifts', name: 'Gifts' },
  {
    slug: 'family',
    name: 'Family',
    children: [
      { slug: 'family.parents_support', name: 'Parents support' },
      { slug: 'family.unspecified', name: UNSPECIFIED },
    ],
  },
  { slug: 'donations', name: 'Donations' },
  // Parcels and courier shipments, never food delivery.
  { slug: 'post_logistics', name: 'Post & logistics' },
  {
    slug: 'travel',
    name: 'Travel',
    // Purchases that exist only because of travelling. A trip's food and taxis
    // stay in their own categories; the trip attribute carries that grouping.
    children: [
      { slug: 'travel.accommodation', name: 'Accommodation' },
      { slug: 'travel.other', name: 'Travel other' },
    ],
  },
  { slug: 'unspecified', name: UNSPECIFIED },
];

export type CategoryNode = {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  /** A payment may only be filed on a leaf (ADR 0006). */
  assignable: boolean;
  path: string;
};

export function mapNode(row: Record<string, unknown>): CategoryNode {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    depth: Number(row.depth),
    sortOrder: Number(row.sort_order),
    assignable: Boolean(row.assignable),
    path: String(row.path),
  };
}

/**
 * Schema, invariants and seed for the shared tree.
 *
 * The invariants live in the database rather than in review prose, because a
 * constraint cannot drift between sessions and a convention can:
 *
 * - `category_path()` derives a node's full path from the tree.
 * - `transactions.category` is re-derived on every write and re-synced whenever
 *   the tree changes, so the mirror can never disagree with `category_id`.
 * - Filing a payment on a node that has children is rejected outright.
 * - Depth is computed from the parent and capped at three.
 */
export async function initializeCategoryTree(tx: Executor): Promise<void> {
  await createCategoryTree(tx);
  await seedCategoryTree(tx);
}

/** Tables, functions and triggers, without the seed. The migration needs these
 * before `transactions.category_id` exists, and the seed only afterwards. */
export async function createCategoryTree(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS category_tree (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)*$'),
    name text NOT NULL CHECK(btrim(name) <> '' AND length(name) <= 80),
    parent_id uuid REFERENCES category_tree(id),
    depth integer NOT NULL CHECK(depth BETWEEN 1 AND 3),
    sort_order integer NOT NULL DEFAULT 0,
    archived boolean NOT NULL DEFAULT false,
    CHECK(parent_id IS NULL OR parent_id <> id)
  )`);
  // Sibling names are unique, but the same name may repeat under different
  // parents: Home / Services and Beauty / Services are different categories,
  // and every branch needs its own Unspecified. The old schema forbade both.
  await tx.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS category_tree_sibling_name ON category_tree
     (COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(name))`,
  );
  await tx.query(`CREATE OR REPLACE FUNCTION category_path(node uuid) RETURNS text LANGUAGE sql STABLE AS $fn$
    WITH RECURSIVE up AS (
      SELECT id, parent_id, name, 1 AS level FROM category_tree WHERE id = node
      UNION ALL
      SELECT p.id, p.parent_id, p.name, up.level + 1
      FROM category_tree p JOIN up ON p.id = up.parent_id
    )
    SELECT string_agg(name, ' / ' ORDER BY level DESC) FROM up
  $fn$`);
  await tx.query(`CREATE OR REPLACE FUNCTION category_tree_depth() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE parent_depth integer;
    BEGIN
      IF NEW.parent_id IS NULL THEN
        NEW.depth := 1;
      ELSE
        SELECT depth INTO parent_depth FROM category_tree WHERE id = NEW.parent_id;
        IF parent_depth IS NULL THEN RAISE EXCEPTION 'category_parent_not_found'; END IF;
        NEW.depth := parent_depth + 1;
      END IF;
      IF NEW.depth > 3 THEN RAISE EXCEPTION 'category_depth_exceeded'; END IF;
      RETURN NEW;
    END $fn$`);
  await tx.query('DROP TRIGGER IF EXISTS category_tree_depth ON category_tree');
  await tx.query(`CREATE TRIGGER category_tree_depth BEFORE INSERT OR UPDATE ON category_tree
    FOR EACH ROW EXECUTE FUNCTION category_tree_depth()`);
  // A rename or a reparent changes the canonical path of every descendant. The
  // tree is tens of rows and renames are rare, so a full re-sync is cheaper to
  // trust than an incremental one.
  // EXECUTE rather than a planned statement: the trigger is created before the
  // column it maintains exists, and a planned body would fail to parse at the
  // first seed insert.
  await tx.query(`CREATE OR REPLACE FUNCTION category_tree_resync() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='transactions' AND column_name='category_id') THEN
        EXECUTE 'UPDATE transactions SET category = category_path(category_id)
                 WHERE category_id IS NOT NULL AND category IS DISTINCT FROM category_path(category_id)';
      END IF;
      RETURN NULL;
    END $fn$`);
  await tx.query(
    'DROP TRIGGER IF EXISTS category_tree_resync ON category_tree',
  );
  await tx.query(`CREATE TRIGGER category_tree_resync AFTER INSERT OR UPDATE OR DELETE ON category_tree
    FOR EACH STATEMENT EXECUTE FUNCTION category_tree_resync()`);
}

/**
 * The payment side of the invariant: the stored path mirror is always derived,
 * never written, and a parent is never assignable.
 *
 * Installed separately from the tree because `transactions` and `category_tree`
 * are created by different migration steps.
 */
export async function installCategoryAssignmentGuard(
  tx: Executor,
): Promise<void> {
  await tx.query(`CREATE OR REPLACE FUNCTION transactions_category_sync() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE derived text;
    BEGIN
      IF NEW.category_id IS NULL THEN
        derived := NULL;
      ELSE
        IF EXISTS (SELECT 1 FROM category_tree WHERE parent_id = NEW.category_id) THEN
          RAISE EXCEPTION 'category_not_assignable';
        END IF;
        derived := category_path(NEW.category_id);
        IF derived IS NULL THEN RAISE EXCEPTION 'category_not_found'; END IF;
      END IF;
      -- Writing the mirror directly is a bug, not a shortcut: fail loudly rather
      -- than let a stale writer believe it changed a category.
      IF TG_OP = 'UPDATE'
         AND NEW.category IS DISTINCT FROM OLD.category
         AND NEW.category IS DISTINCT FROM derived THEN
        RAISE EXCEPTION 'category_is_derived_from_category_id';
      END IF;
      NEW.category := derived;
      RETURN NEW;
    END $fn$`);
  await tx.query(
    'DROP TRIGGER IF EXISTS transactions_category_sync ON transactions',
  );
  await tx.query(`CREATE TRIGGER transactions_category_sync BEFORE INSERT OR UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_category_sync()`);
  await installAccountPolicyKinds(tx);
}

/**
 * Record what a business or investment account implies about a payment nobody
 * has classified.
 *
 * Reporting used to decide this as it drew each figure, which meant the ledger
 * never said what the totals were doing, and the owner could not disagree with
 * it for a single payment. That matters here: most spending on the business
 * card is business spending, but some of it is personal, and only a person can
 * say which.
 *
 * So the conclusion is written down instead — once, when a payment arrives or
 * when the account's purpose changes — with a reason in the audit trail. Totals
 * are unchanged, every payment stays individually correctable, and because the
 * rule lives in the database no caller can forget to apply it.
 *
 * A payment that any person has classified is never touched.
 */
export async function installAccountPolicyKinds(tx: Executor): Promise<void> {
  await tx.query(`CREATE OR REPLACE FUNCTION account_policy_kind(purpose text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE purpose WHEN 'investment' THEN 'investment' WHEN 'business' THEN 'non_personal' END
  $fn$`);
  await tx.query(`CREATE OR REPLACE FUNCTION transactions_account_policy() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE implied text;
    BEGIN
      IF NEW.kind <> 'unresolved' THEN RETURN NEW; END IF;
      SELECT account_policy_kind(a.purpose) INTO implied FROM own_accounts a
        WHERE a.owner=NEW.owner AND a.source=NEW.source AND a.account_id=NEW.account_id;
      IF implied IS NOT NULL THEN NEW.kind := implied; END IF;
      RETURN NEW;
    END $fn$`);
  await tx.query(
    'DROP TRIGGER IF EXISTS transactions_account_policy ON transactions',
  );
  // Insert only. On update the trigger would overwrite a person who had just
  // deliberately set this payment back to unresolved, and their audit record is
  // written a statement later, so it cannot tell the two apart.
  await tx.query(`CREATE TRIGGER transactions_account_policy BEFORE INSERT ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_account_policy()`);
  // The row does not exist yet in the BEFORE trigger, so the reason is recorded
  // immediately afterwards. Importers always insert at the default kind, so a
  // payment that arrives already classified was classified by the policy.
  await tx.query(`CREATE OR REPLACE FUNCTION transactions_account_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE purpose text;
    BEGIN
      IF NEW.kind = 'unresolved' THEN RETURN NULL; END IF;
      SELECT a.purpose INTO purpose FROM own_accounts a
        WHERE a.owner=NEW.owner AND a.source=NEW.source AND a.account_id=NEW.account_id;
      IF purpose IS NULL OR account_policy_kind(purpose) IS DISTINCT FROM NEW.kind THEN
        RETURN NULL;
      END IF;
      INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
      VALUES(gen_random_uuid(), NEW.id, 'account_policy', 'account_policy_applied',
             jsonb_build_object('kind','unresolved'), jsonb_build_object('kind',NEW.kind),
             'Account purpose is ' || purpose || '; change this payment if it was personal');
      RETURN NULL;
    END $fn$`);
  await tx.query(
    'DROP TRIGGER IF EXISTS transactions_account_policy_audit ON transactions',
  );
  await tx.query(`CREATE TRIGGER transactions_account_policy_audit AFTER INSERT ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_account_policy_audit()`);
  await tx.query(`CREATE OR REPLACE FUNCTION own_accounts_apply_policy() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE implied text;
    BEGIN
      implied := account_policy_kind(NEW.purpose);
      IF implied IS NOT NULL THEN
        -- Every payment nobody has decided on, whatever an automatic pass had
        -- guessed: marking the card a business card is a statement about all of
        -- them. A payment a person classified is left exactly as they left it,
        -- which is how "most of this card is business, but some of it is
        -- personal" gets expressed. The category is not disturbed: a business
        -- lunch is still lunch, it simply is not household spending.
        INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
        SELECT gen_random_uuid(), t.id, 'account_policy', 'account_policy_applied',
               jsonb_build_object('kind', t.kind), jsonb_build_object('kind', implied),
               'Account purpose is ' || NEW.purpose || '; change this payment if it was personal'
        FROM transactions t
        WHERE t.owner=NEW.owner AND t.source=NEW.source AND t.account_id=NEW.account_id
          AND t.kind IS DISTINCT FROM implied
          -- An investment bought from the work card is still an investment.
          -- Both kinds stay out of the headline figure, so the distinction
          -- costs no accuracy and keeps the attribution the owner can see.
          AND NOT (t.kind='investment' AND implied='non_personal')
          AND NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.transaction_id=t.id AND e.event='classified');
        UPDATE transactions t SET kind=implied, updated_at=now()
        WHERE t.owner=NEW.owner AND t.source=NEW.source AND t.account_id=NEW.account_id
          AND t.kind IS DISTINCT FROM implied
          -- An investment bought from the work card is still an investment.
          -- Both kinds stay out of the headline figure, so the distinction
          -- costs no accuracy and keeps the attribution the owner can see.
          AND NOT (t.kind='investment' AND implied='non_personal')
          AND NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.transaction_id=t.id AND e.event='classified');
        RETURN NULL;
      END IF;
      -- Calling the account personal again undoes what the policy did, and only
      -- that: the kind each payment carried before any policy touched it. An
      -- exclusion the owner can set but not unset would be a trap.
      INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
      SELECT gen_random_uuid(), t.id, 'account_policy', 'account_policy_reverted',
             jsonb_build_object('kind', t.kind), jsonb_build_object('kind', p.previous),
             'Account purpose is ' || NEW.purpose || ' again'
      FROM transactions t JOIN LATERAL (
        SELECT e.before_value->>'kind' AS previous FROM audit_events e
        WHERE e.transaction_id=t.id AND e.event='account_policy_applied'
        ORDER BY e.created_at, e.id LIMIT 1
      ) p ON true
      WHERE t.owner=NEW.owner AND t.source=NEW.source AND t.account_id=NEW.account_id
        AND t.kind IS DISTINCT FROM p.previous
        AND NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.transaction_id=t.id AND e.event='classified');
      UPDATE transactions t SET kind=p.previous, updated_at=now()
      FROM (
        SELECT t2.id, (SELECT e.before_value->>'kind' FROM audit_events e
                       WHERE e.transaction_id=t2.id AND e.event='account_policy_applied'
                       ORDER BY e.created_at, e.id LIMIT 1) AS previous
        FROM transactions t2
        WHERE t2.owner=NEW.owner AND t2.source=NEW.source AND t2.account_id=NEW.account_id
          AND NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.transaction_id=t2.id AND e.event='classified')
      ) p
      WHERE t.id=p.id AND p.previous IS NOT NULL AND t.kind IS DISTINCT FROM p.previous;
      RETURN NULL;
    END $fn$`);
  await tx.query(
    'DROP TRIGGER IF EXISTS own_accounts_apply_policy ON own_accounts',
  );
  await tx.query(`CREATE TRIGGER own_accounts_apply_policy AFTER INSERT OR UPDATE OF purpose ON own_accounts
    FOR EACH ROW EXECUTE FUNCTION own_accounts_apply_policy()`);
}

/** Idempotent: adds any seed node the database does not have yet, by slug.
 * Renames the owner has made are left alone; only absence is repaired. */
export async function seedCategoryTree(tx: Executor): Promise<void> {
  const insert = async (
    nodes: readonly SeedNode[],
    parentId: string | null,
  ): Promise<void> => {
    let order = 0;
    for (const seed of nodes) {
      order += 10;
      const existing = await tx.query(
        'SELECT id FROM category_tree WHERE slug=$1',
        [seed.slug],
      );
      const id = existing.rows.length
        ? String(existing.rows[0]!.id)
        : randomUUID();
      if (!existing.rows.length)
        await tx.query(
          'INSERT INTO category_tree(id,slug,name,parent_id,depth,sort_order) VALUES($1,$2,$3,$4,1,$5)',
          [id, seed.slug, seed.name, parentId, order],
        );
      if (seed.children) await insert(seed.children, id);
    }
  };
  await insert(CATEGORY_SEED, null);
}

export async function listCategoryTree(tx: Executor): Promise<CategoryNode[]> {
  const result = await tx.query(
    `SELECT n.*, category_path(n.id) AS path,
       NOT EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=n.id) AS assignable
     FROM category_tree n ORDER BY n.depth, n.sort_order, n.name`,
  );
  return result.rows.map(mapNode);
}

/** Resolve a display path such as `Transport / Car / Fuel`, or a slug, to a node
 * id. Returns null when nothing matches; the caller decides whether that is an
 * error, because the classifier and the review form treat it differently. */
export async function resolveCategoryId(
  tx: Executor,
  reference: string | null,
): Promise<string | null> {
  if (reference === null) return null;
  const trimmed = reference.trim();
  if (!trimmed) return null;
  const result = await tx.query(
    `SELECT id FROM category_tree WHERE slug=$1 OR lower(category_path(id))=lower($2) LIMIT 1`,
    [trimmed, trimmed.replaceAll(/\s*\/\s*/g, ' / ')],
  );
  return result.rows.length ? String(result.rows[0]!.id) : null;
}

/** The `Unspecified` leaf of the branch a node belongs to, creating it if the
 * branch does not have one yet. Used when a payment can no longer stay where it
 * is — because its category gained children, or because a migration could not
 * place it more precisely. */
export async function unspecifiedLeafFor(
  tx: Executor,
  branchId: string | null,
): Promise<string> {
  if (branchId === null) {
    const root = await tx.query('SELECT id FROM category_tree WHERE slug=$1', [
      'unspecified',
    ]);
    if (root.rows.length) return String(root.rows[0]!.id);
    const id = randomUUID();
    await tx.query(
      'INSERT INTO category_tree(id,slug,name,parent_id,depth,sort_order) VALUES($1,$2,$3,NULL,1,9999)',
      [id, 'unspecified', UNSPECIFIED],
    );
    return id;
  }
  const existing = await tx.query(
    'SELECT id FROM category_tree WHERE parent_id=$1 AND lower(name)=lower($2)',
    [branchId, UNSPECIFIED],
  );
  if (existing.rows.length) return String(existing.rows[0]!.id);
  const branch = await tx.query('SELECT slug FROM category_tree WHERE id=$1', [
    branchId,
  ]);
  if (!branch.rows.length) throw new Error('category_not_found');
  const id = randomUUID();
  await tx.query(
    'INSERT INTO category_tree(id,slug,name,parent_id,depth,sort_order) VALUES($1,$2,$3,$4,1,9999)',
    [id, `${String(branch.rows[0]!.slug)}.unspecified`, UNSPECIFIED, branchId],
  );
  return id;
}

/**
 * Move household tax off the catch-all and onto `Home / Taxes`.
 *
 * The owner had already decided that one treasury payment was personal — tax on
 * the place they live, as against the sole-trader tax paid from the business
 * accounts, which is `non_personal` and carries no category at all. It rested in
 * `Home / Unspecified` only because the tree had nowhere for tax.
 *
 * Matched on the payee rather than on an identifier, so it is re-runnable and
 * catches any later household tax the same way. Only the catch-all is emptied:
 * a payment a person has deliberately filed elsewhere is left where it is.
 */
export async function moveHouseholdTaxToItsOwnLeaf(
  tx: Executor,
): Promise<number> {
  const leaf = (
    await tx.query("SELECT id FROM category_tree WHERE slug='home.taxes'")
  ).rows[0];
  const catchAll = (
    await tx.query("SELECT id FROM category_tree WHERE slug='home.unspecified'")
  ).rows[0];
  if (!leaf || !catchAll) return 0;
  const moved = await tx.query(
    `UPDATE transactions SET category_id=$1, revision=revision+1, updated_at=now()
     WHERE kind='personal_expense' AND category_id=$2
       AND (description LIKE 'ГУК%' OR description ILIKE '%казначейс%')
     RETURNING id`,
    [String(leaf.id), String(catchAll.id)],
  );
  for (const row of moved.rows)
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'migration','auto_classified',$3,$4,$5)`,
      [
        randomUUID(),
        String(row.id),
        JSON.stringify({ category: 'Home / Unspecified' }),
        JSON.stringify({ category: 'Home / Taxes', source: 'rule' }),
        'Tax on the household home now has a category of its own, at the owner’s request',
      ],
    );
  return moved.rows.length;
}
