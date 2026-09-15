import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import { validateClassification, type Kind, type Owner } from './domain.js';
import {
  UNSPECIFIED,
  initializeCategoryTree,
  listCategoryTree,
  resolveCategoryId,
  unspecifiedLeafFor,
  type CategoryNode,
} from './category-tree.js';

export type { CategoryNode } from './category-tree.js';
export {
  initializeCategoryTree,
  listCategoryTree,
  resolveCategoryId,
  CATEGORY_SEED,
} from './category-tree.js';

/** The node's full display path, or null when the id is not in the tree. */
export function categoryPath(
  nodes: readonly CategoryNode[],
  id: string,
): string | null {
  return nodes.find((node) => node.id === id)?.path ?? null;
}

/** The vocabulary a classifier may propose from: leaves only, because a parent
 * is not assignable (ADR 0006). */
export function assignablePaths(nodes: readonly CategoryNode[]): string[] {
  return nodes
    .filter((node) => node.assignable)
    .map((node) => node.path)
    .sort((a, b) => a.localeCompare(b));
}

/** How a rule is compared against a payment.
 *
 * `description` and `counterparty` are exact equality. `description_contains`
 * asks only that the text appear somewhere in the description, case-insensitively,
 * which is what a bank reference number forces: `TRANSFER-2262675011 Sent money
 * to Rodion Salnik` is a new string every time, so an exact rule matches one
 * payment and the next transfer needs another rule. There is no pattern syntax
 * on purpose — the owner types the part that stays the same and nothing else,
 * so there is no wildcard to place, escape, or get silently wrong. */
export type RuleMatcher = {
  field: 'description' | 'counterparty' | 'description_contains';
  value: string;
};
/** Kept as the old name so existing callers and stored rules read unchanged. */
export type ExactMatcher = RuleMatcher;
export const RULE_MATCH_FIELDS: readonly RuleMatcher['field'][] = [
  'description',
  'counterparty',
  'description_contains',
];
/** The single decision of whether one rule describes one payment. Mirrored by
 * the `rule_matches` SQL function, which the queries that select work to do
 * must use; `test/classification-rules.test.ts` holds both to the same table of
 * cases so they cannot drift apart. */
export function ruleMatches(
  matcher: RuleMatcher,
  description: string,
  counterparty: unknown,
): boolean {
  if (matcher.field === 'description') return description === matcher.value;
  if (matcher.field === 'description_contains')
    return description.toLowerCase().includes(matcher.value.toLowerCase());
  return typeof counterparty === 'string' && counterparty === matcher.value;
}
export type ConfirmedRule = {
  id: string;
  owner: Owner;
  version: number;
  matcher: ExactMatcher;
  kind: Kind;
  categoryId: string | null;
  active: boolean;
};

function ownerCheck(owner: Owner) {
  if (owner !== 'rodion' && owner !== 'katya') throw new Error('invalid_owner');
}
function label(value: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error('invalid_category_value');
  return value;
}
function rule(row: Row): ConfirmedRule {
  return {
    id: String(row.id),
    owner: row.owner as Owner,
    version: Number(row.version),
    matcher: {
      field: row.match_field as ExactMatcher['field'],
      value: String(row.match_value),
    },
    kind: row.kind as Kind,
    categoryId: row.category_id === null ? null : String(row.category_id),
    active: Boolean(row.active),
  };
}

export async function initializeCategories(db: Executor): Promise<void> {
  await initializeCategoryTree(db);
  await db.query(`CREATE TABLE IF NOT EXISTS tags (
    id uuid PRIMARY KEY, name text NOT NULL CHECK(btrim(name) <> '' AND length(name) <= 80)
  )`);
  await db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS tags_name ON tags (lower(name))',
  );
  await db.query(`CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id uuid NOT NULL REFERENCES transactions(id),
    tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(transaction_id,tag_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS classification_rules (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK(owner IN ('rodion','katya')), version integer NOT NULL CHECK(version>0),
    match_field text NOT NULL CHECK(match_field IN ('description','counterparty','description_contains')), match_value text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('personal_expense','internal_transfer','investment','non_personal','unresolved')),
    category_id uuid REFERENCES category_tree(id), active boolean NOT NULL, UNIQUE(owner,id),
    CHECK(kind<>'personal_expense' OR category_id IS NOT NULL)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS classification_rule_audit (
    id uuid PRIMARY KEY, owner text NOT NULL, rule_id uuid NOT NULL, version integer NOT NULL,
    definition jsonb NOT NULL, reason text NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(rule_id,version), FOREIGN KEY(owner,rule_id) REFERENCES classification_rules(owner,id)
  )`);
  await createRuleMatchFunction(db);
}

/** The SQL half of `ruleMatches`. The predicate used to be written out at every
 * point in the triage query that asks "is there a rule for this payment", four
 * copies of the same boolean in one statement; adding a second way to match
 * meant editing all four and hoping none drifted. It lives here once instead.
 * (The lookups in `counterparty-identity.ts` deliberately still read exact
 * description rules only: they resolve a counterparty's name, and the value of
 * a contains rule is a fragment rather than a name.) */
export async function createRuleMatchFunction(db: Executor): Promise<void> {
  await db.query(`CREATE OR REPLACE FUNCTION rule_matches(
    field text, value text, description text, counterparty text
  ) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE field
      WHEN 'description' THEN description = value
      WHEN 'counterparty' THEN counterparty IS NOT NULL AND counterparty = value
      WHEN 'description_contains' THEN description ILIKE
        '%' || replace(replace(replace(value, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
      ELSE false
    END
  $$`);
}

const TREE_LOCK = 7482394;

export class Categories {
  constructor(readonly db: Database) {}

  /** The whole household tree. There is one, shared: a per-owner tree makes a
   * family total by category meaningless (ADR 0006). */
  async listNodes(): Promise<CategoryNode[]> {
    return listCategoryTree(this.db);
  }

  async resolve(reference: string | null): Promise<string | null> {
    return resolveCategoryId(this.db, reference);
  }

  async saveNode(input: {
    id?: string;
    slug?: string;
    name: string;
    parentId?: string | null;
  }): Promise<CategoryNode> {
    label(input.name, 80);
    const parent = input.parentId ?? null;
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [TREE_LOCK]);
      const id = input.id ?? randomUUID();
      if (input.id) {
        const current = await tx.query(
          'SELECT id FROM category_tree WHERE id=$1',
          [id],
        );
        if (!current.rows.length) throw new Error('category_not_found');
        if (parent) {
          const cycle = await tx.query(
            `WITH RECURSIVE ancestors AS (
               SELECT id,parent_id FROM category_tree WHERE id=$1
               UNION SELECT n.id,n.parent_id FROM category_tree n JOIN ancestors a ON n.id=a.parent_id
             ) SELECT id FROM ancestors WHERE id=$2`,
            [parent, id],
          );
          if (cycle.rows.length) throw new Error('category_cycle');
        }
      } else if (parent) {
        const exists = await tx.query(
          'SELECT id FROM category_tree WHERE id=$1',
          [parent],
        );
        if (!exists.rows.length) throw new Error('category_parent_not_found');
      }
      // Giving a node children makes it a branch, and a branch is not
      // assignable. Rather than refusing, move whatever was filed on it into
      // the branch's own Unspecified leaf, visibly and auditably: that is the
      // intended friction of ADR 0006, not a wall.
      if (parent && !input.id) await vacateForBranch(tx, parent);
      const slug =
        input.slug ??
        (input.id
          ? undefined
          : `${await slugPrefix(tx, parent)}${slugify(input.name)}`);
      const saved = input.id
        ? await tx.query(
            'UPDATE category_tree SET name=$2,parent_id=$3 WHERE id=$1 RETURNING *',
            [id, input.name, parent],
          )
        : await tx.query(
            'INSERT INTO category_tree(id,slug,name,parent_id,depth,sort_order) VALUES($1,$2,$3,$4,1,$5) RETURNING *',
            [id, slug, input.name, parent, await nextOrder(tx, parent)],
          );
      if (!saved.rows.length) throw new Error('category_not_found');
      const nodes = await listCategoryTree(tx);
      return nodes.find((node) => node.id === id)!;
    });
  }

  /** Removing a category never orphans its payments: they move to the parent
   * branch's Unspecified leaf, or to the root one. */
  async removeNode(id: string, reason: string): Promise<number> {
    label(reason, 500);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [TREE_LOCK]);
      const node = (
        await tx.query('SELECT id,parent_id FROM category_tree WHERE id=$1', [
          id,
        ])
      ).rows[0];
      if (!node) throw new Error('category_not_found');
      if (
        (await tx.query('SELECT 1 FROM category_tree WHERE parent_id=$1', [id]))
          .rows.length
      )
        throw new Error('category_has_children');
      const target = await unspecifiedLeafFor(
        tx,
        node.parent_id === null ? null : String(node.parent_id),
      );
      if (target === id) throw new Error('category_is_branch_catch_all');
      const moved = await moveTransactions(tx, id, target, reason);
      await tx.query(
        'UPDATE classification_rules SET category_id=$1 WHERE category_id=$2',
        [target, id],
      );
      await tx.query('DELETE FROM category_tree WHERE id=$1', [id]);
      return moved;
    });
  }

  async setTags(
    owner: Owner,
    transactionId: string,
    tagIds: string[],
  ): Promise<void> {
    ownerCheck(owner);
    if (tagIds.length > 50 || new Set(tagIds).size !== tagIds.length)
      throw new Error('invalid_tags');
    await this.db.transaction(async (tx) => {
      const transaction = await tx.query(
        'SELECT id FROM transactions WHERE owner=$1 AND id=$2 FOR UPDATE',
        [owner, transactionId],
      );
      if (!transaction.rows.length) throw new Error('transaction_not_found');
      for (const id of tagIds) {
        const tags = await tx.query('SELECT id FROM tags WHERE id=$1', [id]);
        if (!tags.rows.length) throw new Error('tag_not_found');
      }
      await tx.query('DELETE FROM transaction_tags WHERE transaction_id=$1', [
        transactionId,
      ]);
      for (const id of tagIds)
        await tx.query(
          'INSERT INTO transaction_tags(transaction_id,tag_id) VALUES($1,$2)',
          [transactionId, id],
        );
    });
  }

  async listTags(): Promise<Array<{ id: string; name: string }>> {
    return (
      await this.db.query('SELECT id,name FROM tags ORDER BY lower(name),id')
    ).rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
  }

  async saveTag(name: string): Promise<{ id: string; name: string }> {
    label(name, 80);
    const saved = await this.db.query(
      `INSERT INTO tags(id,name) VALUES($1,$2)
       ON CONFLICT (lower(name)) DO UPDATE SET name=excluded.name RETURNING id,name`,
      [randomUUID(), name],
    );
    return {
      id: String(saved.rows[0]!.id),
      name: String(saved.rows[0]!.name),
    };
  }

  async tags(
    owner: Owner,
    transactionId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    ownerCheck(owner);
    const result = await this.db.query(
      `SELECT g.id,g.name FROM tags g JOIN transaction_tags t ON g.id=t.tag_id
       JOIN transactions x ON x.id=t.transaction_id
       WHERE x.owner=$1 AND t.transaction_id=$2 ORDER BY lower(g.name),g.id`,
      [owner, transactionId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
    }));
  }

  async saveRule(
    owner: Owner,
    input: {
      id?: string;
      expectedVersion?: number;
      matcher: ExactMatcher;
      kind: Kind;
      categoryId: string | null;
      confirmed: boolean;
      reason: string;
      active?: boolean;
    },
  ): Promise<ConfirmedRule> {
    ownerCheck(owner);
    if (input.confirmed !== true) throw new Error('rule_confirmation_required');
    if (!input.matcher || !RULE_MATCH_FIELDS.includes(input.matcher.field))
      throw new Error('invalid_rule_matcher');
    label(input.matcher.value, 2000);
    label(input.reason, 500);
    validateClassification({
      kind: input.kind,
      category: input.categoryId,
      reason: input.reason,
    });
    if (input.active !== undefined && typeof input.active !== 'boolean')
      throw new Error('invalid_rule_active');
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [TREE_LOCK]);
      let version = 1;
      const id = input.id ?? randomUUID();
      if (input.id) {
        const existing = await tx.query(
          'SELECT * FROM classification_rules WHERE owner=$1 AND id=$2',
          [owner, id],
        );
        if (!existing.rows.length) throw new Error('rule_not_found');
        if (input.expectedVersion !== Number(existing.rows[0]!.version))
          throw new Error('stale_rule_version');
        version = Number(existing.rows[0]!.version) + 1;
      }
      if (input.categoryId) {
        const category = await tx.query(
          `SELECT id FROM category_tree WHERE id=$1
           AND NOT EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=category_tree.id)`,
          [input.categoryId],
        );
        if (!category.rows.length) throw new Error('rule_category_not_found');
      }
      const saved = await tx.query(
        `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,category_id,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version,match_field=excluded.match_field,match_value=excluded.match_value,kind=excluded.kind,category_id=excluded.category_id,active=excluded.active RETURNING *`,
        [
          id,
          owner,
          version,
          input.matcher.field,
          input.matcher.value,
          input.kind,
          input.categoryId,
          input.active ?? true,
        ],
      );
      const result = rule(saved.rows[0]!);
      await tx.query(
        'INSERT INTO classification_rule_audit(id,owner,rule_id,version,definition,reason) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          owner,
          id,
          version,
          JSON.stringify(result),
          input.reason,
        ],
      );
      return result;
    });
  }

  async listRules(owner: Owner): Promise<ConfirmedRule[]> {
    ownerCheck(owner);
    const result = await this.db.query(
      'SELECT * FROM classification_rules WHERE owner=$1 ORDER BY id',
      [owner],
    );
    return result.rows.map(rule);
  }

  async ruleHistory(owner: Owner, id: string): Promise<Row[]> {
    ownerCheck(owner);
    return (
      await this.db.query(
        'SELECT version,definition,reason,confirmed_at FROM classification_rule_audit WHERE owner=$1 AND rule_id=$2 ORDER BY version',
        [owner, id],
      )
    ).rows;
  }

  /** Batch the review screen's read-only context; individual methods remain the semantics oracle. */
  async reviewContext(owner: Owner, transactionIds: string[]) {
    ownerCheck(owner);
    const ids = [...new Set(transactionIds)];
    const suggestions: Record<
      string,
      { requiresReview: true; ambiguous: boolean; rules: ConfirmedRule[] }
    > = {};
    const tags: Record<string, Array<{ id: string; name: string }>> = {};
    for (const id of ids) {
      suggestions[id] = { requiresReview: true, ambiguous: false, rules: [] };
      tags[id] = [];
    }
    if (!ids.length) return { suggestions, tags };
    const eligible = (
      await this.db.query(
        `SELECT t.* FROM transactions t WHERE t.owner=$1 AND t.id=ANY($2::uuid[])
      AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event='classified')`,
        [owner, ids],
      )
    ).rows;
    const rules = eligible.length ? await this.listRules(owner) : [];
    for (const transaction of eligible) {
      const matches = matchingRules(rules, transaction);
      suggestions[String(transaction.id)] = {
        requiresReview: true,
        ambiguous: ambiguous(matches),
        rules: matches,
      };
    }
    const tagged = (
      await this.db.query(
        `SELECT g.id,g.name,t.transaction_id FROM tags g JOIN transaction_tags t ON g.id=t.tag_id
      JOIN transactions x ON x.id=t.transaction_id WHERE x.owner=$1 AND t.transaction_id=ANY($2::uuid[]) ORDER BY lower(g.name),g.id`,
        [owner, ids],
      )
    ).rows;
    for (const row of tagged)
      tags[String(row.transaction_id)]!.push({
        id: String(row.id),
        name: String(row.name),
      });
    return { suggestions, tags };
  }

  async suggest(
    owner: Owner,
    transactionId: string,
  ): Promise<{
    requiresReview: true;
    ambiguous: boolean;
    rules: ConfirmedRule[];
  }> {
    ownerCheck(owner);
    const result = await this.db.query(
      `SELECT t.* FROM transactions t WHERE t.owner=$1 AND t.id=$2
      AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event='classified')`,
      [owner, transactionId],
    );
    const transaction = result.rows[0];
    if (!transaction)
      return { requiresReview: true, ambiguous: false, rules: [] };
    const matches = matchingRules(await this.listRules(owner), transaction);
    return {
      requiresReview: true,
      ambiguous: ambiguous(matches),
      rules: matches,
    };
  }
  /** Turn one confirmed decision into a rule for future payments that repeat the
   * same bank description. The match text is read from the stored transaction, never
   * typed, so an exact-match rule cannot drift from what the bank actually sends.
   * Re-confirming a different decision for the same description replaces the earlier
   * rule instead of adding a second one that would only disagree with it. */
  async saveRuleFromDescription(
    owner: Owner,
    input: {
      transactionId: string;
      kind: Kind;
      category: string | null;
      reason: string;
    },
  ): Promise<ConfirmedRule | null> {
    ownerCheck(owner);
    if (input.kind === 'unresolved') throw new Error('invalid_rule_kind');
    const transaction = (
      await this.db.query(
        'SELECT description FROM transactions WHERE owner=$1 AND id=$2',
        [owner, input.transactionId],
      )
    ).rows[0];
    if (!transaction) throw new Error('not_found');
    const description = String(transaction.description ?? '');
    // A blank bank description identifies nothing; a rule on it would claim every
    // other payment that arrives without one.
    if (!description.trim()) return null;
    const nodes = await this.listNodes();
    // Only a leaf: a parent is not assignable, so a rule pointing at one could
    // never be applied.
    const categoryId = input.category
      ? (nodes.find((n) => n.assignable && n.path === input.category)?.id ??
        null)
      : null;
    if (input.category && !categoryId)
      throw new Error('rule_category_not_found');
    const existing = (await this.listRules(owner)).find(
      (r) =>
        r.active &&
        r.matcher.field === 'description' &&
        r.matcher.value === description,
    );
    return this.saveRule(owner, {
      ...(existing
        ? { id: existing.id, expectedVersion: existing.version }
        : {}),
      matcher: { field: 'description', value: description },
      kind: input.kind,
      categoryId,
      confirmed: true,
      reason: input.reason,
    });
  }
}

function matchingRules(
  rules: readonly ConfirmedRule[],
  transaction: Row,
): ConfirmedRule[] {
  // Only an explicitly structured identifier is eligible; never infer one from
  // merchant names or free text. Upstream adapters may populate this later.
  const counterparty = (transaction.source_details as Record<string, unknown>)
    ?.counterpartyIdentifier;
  const description = String(transaction.description ?? '');
  const matched = rules.filter(
    (r) => r.active && ruleMatches(r.matcher, description, counterparty),
  );
  // Specific beats general, so a rule naming this payment exactly is never
  // outvoted by one naming a fragment, and among fragments the longest wins.
  // Without this a broad rule would turn every exact decision into a conflict.
  const exact = matched.filter(
    (r) => r.matcher.field !== 'description_contains',
  );
  if (exact.length) return exact;
  const longest = Math.max(...matched.map((r) => r.matcher.value.length), 0);
  return matched.filter((r) => r.matcher.value.length === longest);
}
function ambiguous(matches: readonly ConfirmedRule[]): boolean {
  return (
    new Set(matches.map((r) => JSON.stringify([r.kind, r.categoryId]))).size > 1
  );
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  return base || `c${randomUUID().slice(0, 8).replaceAll('-', '')}`;
}
async function slugPrefix(
  tx: Executor,
  parentId: string | null,
): Promise<string> {
  if (parentId === null) return '';
  const parent = await tx.query('SELECT slug FROM category_tree WHERE id=$1', [
    parentId,
  ]);
  return parent.rows.length ? `${String(parent.rows[0]!.slug)}.` : '';
}
async function nextOrder(
  tx: Executor,
  parentId: string | null,
): Promise<number> {
  const result = await tx.query(
    'SELECT coalesce(max(sort_order),0)+10 AS next FROM category_tree WHERE parent_id IS NOT DISTINCT FROM $1',
    [parentId],
  );
  return Number(result.rows[0]!.next);
}

/** Payments filed directly on a node that is about to become a branch move to
 * that branch's Unspecified leaf. */
async function vacateForBranch(
  tx: Executor,
  branchId: string,
): Promise<number> {
  const occupied = await tx.query(
    'SELECT 1 FROM transactions WHERE category_id=$1 LIMIT 1',
    [branchId],
  );
  if (!occupied.rows.length) return 0;
  const target = await unspecifiedLeafFor(tx, branchId);
  return moveTransactions(
    tx,
    branchId,
    target,
    'The category gained subcategories, so a parent is no longer assignable',
  );
}

async function moveTransactions(
  tx: Executor,
  from: string,
  to: string,
  reason: string,
): Promise<number> {
  const moved = await tx.query(
    'UPDATE transactions SET category_id=$2,revision=revision+1,updated_at=now() WHERE category_id=$1 RETURNING id',
    [from, to],
  );
  for (const row of moved.rows)
    await tx.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'system','category_moved',$3,$4,$5)`,
      [
        randomUUID(),
        String(row.id),
        JSON.stringify({ categoryId: from }),
        JSON.stringify({ categoryId: to }),
        reason,
      ],
    );
  return moved.rows.length;
}

/** A functioning classifier needs a category vocabulary before its first call.
 * The seed is idempotent and repairs by slug, so a renamed category is left
 * alone and only a genuinely missing one is restored. */
export async function ensureStarterCategories(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [TREE_LOCK]);
    await initializeCategoryTree(tx);
  });
}

export { UNSPECIFIED };
