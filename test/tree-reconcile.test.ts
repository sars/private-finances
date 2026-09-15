import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import { Categories, assignablePaths } from '../src/categories.js';
import { Repository } from '../src/repository.js';

/**
 * The tree reshaped to the owner's own grouping (ADR 0008, step D3).
 *
 * The property that matters most is what does *not* happen: reparenting a node
 * changes paths without moving a single payment, because a payment points at the
 * node and the path text is derived from the tree. Only one change moves
 * payments, and the test insists it is audited.
 */

async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  return { db, repo: new Repository(db), categories: new Categories(db) };
}

test('ADR 0008 utility bills, phone and internet total together', async () => {
  const { db, categories } = await setup();
  try {
    const paths = assignablePaths(await categories.listNodes());
    assert.ok(paths.includes('Utilities / Housing utilities'));
    assert.ok(paths.includes('Utilities / Mobile phone'));
    assert.ok(paths.includes('Utilities / Internet'));
    // Home keeps what the owner called home expenses, "such as shelves".
    assert.ok(paths.includes('Home / Goods'));
    assert.ok(!paths.some((path) => path.startsWith('Home / Utilities')));
    // The Communication branch is gone rather than left empty.
    assert.ok(!paths.some((path) => path.startsWith('Communication')));
    assert.ok(
      !(await categories.listNodes()).some((n) => n.slug === 'communication'),
    );
  } finally {
    await db.close();
  }
});

test('ADR 0008 a reparented node keeps the payments already filed on it', async () => {
  const { db, repo, categories } = await setup();
  try {
    // `home.utilities` is the node that became `Utilities / Housing utilities`,
    // so a payment filed on it before the move must read the new path without
    // its category having changed.
    const housing = (await categories.listNodes()).find(
      (n) => n.slug === 'home.utilities',
    )!;
    assert.equal(housing.path, 'Utilities / Housing utilities');
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'bill',
        accountId: 'a',
        owner: 'rodion',
        bookedAt: '2026-08-01T10:00:00Z',
        currency: 'EUR',
        amountMinor: '-4500',
        description: 'Utility bill',
      },
    ]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'personal_expense',
        category: 'Utilities / Housing utilities',
        reason: 'The electricity bill',
      },
      'rodion',
    );
    const after = (await repo.list())[0]!;
    assert.equal(after.categoryId, housing.id);
    assert.equal(after.category, 'Utilities / Housing utilities');
  } finally {
    await db.close();
  }
});

test('ADR 0008 flights and carpool live under transport, and Travel transport is gone', async () => {
  const { db, categories } = await setup();
  try {
    const nodes = await categories.listNodes();
    const paths = assignablePaths(nodes);
    assert.ok(paths.includes('Transport / Long distance'));
    assert.ok(paths.includes('Travel / Accommodation'));
    assert.ok(!nodes.some((n) => n.slug === 'travel.transport'));
    assert.ok(!paths.includes('Travel / Travel transport'));
  } finally {
    await db.close();
  }
});

test('ADR 0008 the reshaped tree still satisfies every structural invariant', async () => {
  const { db, categories } = await setup();
  try {
    const nodes = await categories.listNodes();
    // Depth is capped at three by a trigger; Utilities must not have pushed
    // anything past it.
    assert.ok(nodes.every((n) => n.depth <= 3));
    // Sibling names are unique, which the two `Unspecified` leaves now sharing
    // the Utilities branch would break if the move had gone wrong.
    const siblings = new Map<string, number>();
    for (const node of nodes) {
      const key = `${node.parentId ?? 'root'}:${node.name.toLowerCase()}`;
      siblings.set(key, (siblings.get(key) ?? 0) + 1);
    }
    assert.ok(
      [...siblings.values()].every((count) => count === 1),
      'no two siblings share a name',
    );
    const broken = await db.query(
      `SELECT count(*)::int AS count FROM transactions t
       WHERE t.category_id IS NOT NULL
         AND EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=t.category_id)`,
    );
    assert.equal(Number(broken.rows[0]!.count), 0);
  } finally {
    await db.close();
  }
});

test('ADR 0008 the merchant-code map still resolves after the reshape', async () => {
  // 4900 (utilities) and 4814 (telecom) point at slugs that moved branch. If a
  // slug had been renamed instead of reparented, the resting place would
  // silently stop placing those payments.
  const { db, categories } = await setup();
  try {
    const { MCC_CATEGORY } = await import('../src/category-migration.js');
    const bySlug = new Map(
      (await categories.listNodes()).map((n) => [n.slug, n]),
    );
    for (const [code, slug] of Object.entries(MCC_CATEGORY)) {
      const node = bySlug.get(slug);
      assert.ok(node, `merchant code ${code} points at a missing slug ${slug}`);
      assert.equal(
        node.assignable,
        true,
        `merchant code ${code} points at a heading`,
      );
    }
    assert.equal(
      bySlug.get('home.utilities')!.path,
      'Utilities / Housing utilities',
    );
    assert.equal(
      bySlug.get('communication.mobile')!.path,
      'Utilities / Mobile phone',
    );
  } finally {
    await db.close();
  }
});
