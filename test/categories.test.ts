import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import {
  Categories,
  assignablePaths,
  categoryPath,
  initializeCategories,
} from '../src/categories.js';
import { Repository } from '../src/repository.js';

async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await initializeCategories(db);
  const repo = new Repository(db);
  await repo.importBatch(
    ['rodion', 'katya'].map((owner) => ({
      source: 'synthetic',
      sourceId: owner,
      accountId: owner,
      owner,
      bookedAt: '2026-09-01T12:00:00Z',
      currency: 'EUR',
      amountMinor: '-100',
      description: 'Same merchant',
      sourceDetails: { counterpartyIdentifier: 'synthetic:merchant-1' },
    })),
  );
  return { db, repo, categories: new Categories(db) };
}

async function nodeBySlug(c: Categories, slug: string) {
  const found = (await c.listNodes()).find((node) => node.slug === slug);
  assert.ok(found, `expected a seeded category ${slug}`);
  return found;
}

test('PF-005 the household shares one tree, and both members classify into it', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const nodes = await c.listNodes();
    // A per-owner tree makes a family total by category meaningless (ADR 0006),
    // so there is exactly one tree and no owner column to disagree about.
    assert.ok(!('owner' in nodes[0]!));
    const groceries = await nodeBySlug(c, 'food.groceries');
    for (const owner of ['rodion', 'katya'] as const) {
      const row = (await repo.list(owner))[0]!;
      await repo.classify(
        row.id,
        row.revision,
        {
          kind: 'personal_expense',
          category: groceries.path,
          reason: 'Weekly shop',
        },
        owner,
      );
      const after = (await repo.list(owner))[0]!;
      assert.equal(after.categoryId, groceries.id);
      assert.equal(after.category, 'Food / Groceries');
    }
  } finally {
    await db.close();
  }
});

test('PF-005 a payment is filed on a leaf; a heading is rejected by the database', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const food = await nodeBySlug(c, 'food');
    assert.equal(food.assignable, false);
    const row = (await repo.list('rodion'))[0]!;
    await assert.rejects(
      repo.classify(
        row.id,
        row.revision,
        { kind: 'personal_expense', category: 'Food', reason: 'Some food' },
        'rodion',
      ),
      /category_not_assignable/,
    );
    // Even a direct write cannot get around it: the invariant lives in the
    // database, not in the code paths that happen to remember it.
    await assert.rejects(
      db.query('UPDATE transactions SET category_id=$1 WHERE id=$2', [
        food.id,
        row.id,
      ]),
      /category_not_assignable/,
    );
    assert.ok(
      !assignablePaths(await c.listNodes()).includes('Food'),
      'a heading must never be offered as a classifier option',
    );
  } finally {
    await db.close();
  }
});

test('PF-005 the stored path is derived, so renaming a category never rewrites history', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const restaurants = await nodeBySlug(c, 'food.restaurants.dining');
    const row = (await repo.list('rodion'))[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'personal_expense',
        category: restaurants.path,
        reason: 'Dinner',
      },
      'rodion',
    );
    assert.equal(
      (await repo.list('rodion'))[0]!.category,
      'Food / Restaurants / Dining in',
    );

    const food = await nodeBySlug(c, 'food');
    await c.saveNode({ id: food.id, name: 'Eating' });
    const renamed = (await repo.list('rodion'))[0]!;
    assert.equal(renamed.category, 'Eating / Restaurants / Dining in');
    assert.equal(
      renamed.categoryId,
      restaurants.id,
      'the payment still points at the same category it always did',
    );

    // Writing the mirror directly is a bug, and fails loudly rather than
    // leaving the path and the category quietly disagreeing.
    await assert.rejects(
      db.query("UPDATE transactions SET category='Invented' WHERE id=$1", [
        row.id,
      ]),
      /category_is_derived_from_category_id/,
    );
  } finally {
    await db.close();
  }
});

test('PF-005 the same name may repeat under different parents', async () => {
  const { db, categories: c } = await setup();
  try {
    const paths = assignablePaths(await c.listNodes());
    assert.ok(paths.includes('Home / Services'));
    assert.ok(paths.includes('Beauty / Services'));
    assert.ok(paths.includes('Health / Unspecified'));
    assert.ok(paths.includes('Sport / Unspecified'));
    // Siblings, however, still cannot collide.
    const home = await nodeBySlug(c, 'home');
    await assert.rejects(
      c.saveNode({ name: 'services', parentId: home.id }),
      /duplicate key|unique/i,
    );
  } finally {
    await db.close();
  }
});

test('PF-005 giving a category children moves its payments to that branch Unspecified', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const clothes = await nodeBySlug(c, 'clothes');
    assert.equal(clothes.assignable, true);
    const row = (await repo.list('rodion'))[0]!;
    await repo.classify(
      row.id,
      row.revision,
      { kind: 'personal_expense', category: 'Clothes', reason: 'A coat' },
      'rodion',
    );
    await c.saveNode({ name: 'Shoes', parentId: clothes.id });
    const moved = (await repo.list('rodion'))[0]!;
    assert.equal(
      moved.category,
      'Clothes / Unspecified',
      'the payment is visibly unspecified within its branch, not silently on a heading',
    );
    const history = await repo.history(row.id);
    assert.ok(
      history.some((event) => event.event === 'category_moved'),
      'the move is recorded rather than applied invisibly',
    );
  } finally {
    await db.close();
  }
});

test('PF-005 removing a category reassigns its payments instead of orphaning them', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const volleyball = await nodeBySlug(c, 'sport.volleyball');
    const row = (await repo.list('rodion'))[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'personal_expense',
        category: volleyball.path,
        reason: 'Court hire',
      },
      'rodion',
    );
    assert.equal(await c.removeNode(volleyball.id, 'We stopped playing'), 1);
    assert.equal(
      (await repo.list('rodion'))[0]!.category,
      'Sport / Unspecified',
    );
    assert.ok(
      !(await c.listNodes()).some((n) => n.slug === 'sport.volleyball'),
    );
  } finally {
    await db.close();
  }
});

test('PF-005 categoryPath and assignablePaths report the tree as stored', async () => {
  const { db, categories: c } = await setup();
  try {
    const nodes = await c.listNodes();
    const fuel = nodes.find((n) => n.slug === 'transport.car.fuel')!;
    assert.equal(categoryPath(nodes, fuel.id), 'Transport / Car / Fuel');
    assert.equal(fuel.depth, 3);
    assert.equal(categoryPath(nodes, 'missing'), null);
    const paths = assignablePaths(nodes);
    assert.deepEqual(
      paths,
      [...paths].sort((a, b) => a.localeCompare(b)),
    );
    assert.ok(paths.every((path) => !path.endsWith(' / ')));
  } finally {
    await db.close();
  }
});

test('PF-005 depth stops at three', async () => {
  const { db, categories: c } = await setup();
  try {
    const fuel = await nodeBySlug(c, 'transport.car.fuel');
    await assert.rejects(
      c.saveNode({ name: 'Diesel', parentId: fuel.id }),
      /category_depth_exceeded/,
    );
  } finally {
    await db.close();
  }
});

test('PF-005 tags are their own household list, many per payment', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const holiday = await c.saveTag('Holiday');
    const shared = await c.saveTag('Shared');
    const row = (await repo.list('rodion'))[0]!;
    await c.setTags('rodion', row.id, [holiday.id, shared.id]);
    assert.deepEqual(
      (await c.tags('rodion', row.id)).map((t) => t.name),
      ['Holiday', 'Shared'],
    );
    // The other member sees the same tag vocabulary but not this payment.
    const other = (await repo.list('katya'))[0]!;
    assert.deepEqual(await c.tags('katya', other.id), []);
    await assert.rejects(
      c.setTags('rodion', other.id, [holiday.id]),
      /transaction_not_found/,
    );
    await assert.rejects(
      c.setTags('rodion', row.id, ['00000000-0000-0000-0000-000000000000']),
      /tag_not_found/,
    );
    // A tag is not a category, so it can never reach a category total.
    assert.ok(!assignablePaths(await c.listNodes()).includes('Holiday'));
  } finally {
    await db.close();
  }
});

test('PF-005/007 confirmed rules suggest, never overwrite, and keep their history', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const category = await nodeBySlug(c, 'food.groceries');
    const input = {
      matcher: { field: 'description' as const, value: 'Same merchant' },
      kind: 'personal_expense' as const,
      categoryId: category.id,
      confirmed: true,
      reason: 'Apply only as a suggestion for my exact merchant description',
    };
    await assert.rejects(
      c.saveRule('rodion', { ...input, confirmed: false }),
      /confirmation_required/,
    );
    // A heading is not a rule target either.
    const food = await nodeBySlug(c, 'food');
    await assert.rejects(
      c.saveRule('rodion', { ...input, categoryId: food.id }),
      /rule_category_not_found/,
    );
    const first = await c.saveRule('rodion', input);
    const r = (await repo.list('rodion'))[0]!;
    const k = (await repo.list('katya'))[0]!;
    assert.equal((await c.suggest('rodion', r.id)).rules.length, 1);
    assert.equal((await c.suggest('rodion', r.id)).requiresReview, true);
    await c.saveRule('rodion', {
      ...input,
      kind: 'non_personal',
      categoryId: null,
      reason: 'Sometimes the same merchant is studio spending; always review',
    });
    const ambiguous = await c.suggest('rodion', r.id);
    assert.equal(ambiguous.rules.length, 2);
    assert.equal(ambiguous.ambiguous, true);
    assert.equal((await repo.list('rodion'))[0]!.kind, 'unresolved');
    assert.deepEqual((await c.suggest('katya', k.id)).rules, []);
    assert.deepEqual((await c.suggest('katya', r.id)).rules, []);
    assert.deepEqual(await c.listRules('katya'), []);
    await assert.rejects(
      c.saveRule('katya', { ...input, id: first.id, expectedVersion: 1 }),
      /rule_not_found/,
    );
    const revised = await c.saveRule('rodion', {
      ...input,
      id: first.id,
      expectedVersion: 1,
      active: false,
      reason: 'Retire this exact suggestion',
    });
    assert.equal(revised.version, 2);
    assert.equal((await c.suggest('rodion', r.id)).rules.length, 1);
    await assert.rejects(
      c.saveRule('rodion', { ...input, id: first.id, expectedVersion: 1 }),
      /stale_rule_version/,
    );
    const history = await c.ruleHistory('rodion', first.id);
    assert.deepEqual(
      history.map((h) => h.version),
      [1, 2],
    );
    assert.equal((history[0]!.definition as { active: boolean }).active, true);
    assert.deepEqual(await c.ruleHistory('katya', first.id), []);
    // A human can deliberately keep an item unresolved; rules must still yield.
    await repo.classify(
      r.id,
      r.revision,
      { kind: 'unresolved', category: null, reason: 'Need more context' },
      'rodion',
    );
    assert.deepEqual((await c.suggest('rodion', r.id)).rules, []);
  } finally {
    await db.close();
  }
});

test('PF-007 descriptions match exactly and counterparty rules use explicit identifiers only', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    const r = (await repo.list('rodion'))[0]!;
    const base = {
      kind: 'non_personal' as const,
      categoryId: null,
      confirmed: true,
      reason: 'Exact identifier, review each match',
    };
    await c.saveRule('rodion', {
      ...base,
      matcher: { field: 'description', value: 'same merchant' },
    });
    assert.deepEqual((await c.suggest('rodion', r.id)).rules, []);
    await c.saveRule('rodion', {
      ...base,
      matcher: { field: 'counterparty', value: 'Same merchant' },
    });
    assert.deepEqual((await c.suggest('rodion', r.id)).rules, []);
    const matched = await c.saveRule('rodion', {
      ...base,
      matcher: { field: 'counterparty', value: 'synthetic:merchant-1' },
    });
    assert.deepEqual(
      (await c.suggest('rodion', r.id)).rules.map((x) => x.id),
      [matched.id],
    );
  } finally {
    await db.close();
  }
});

test('PF-005 seeding is idempotent and leaves a renamed category alone', async () => {
  const { db, categories: c } = await setup();
  try {
    const before = await c.listNodes();
    assert.ok(before.some((node) => node.name === 'Pets'));
    assert.ok(before.some((node) => node.name === 'Donations'));
    const pets = before.find((node) => node.slug === 'pets')!;
    await c.saveNode({ id: pets.id, name: 'Animals' });
    await initializeCategories(db);
    const after = await c.listNodes();
    assert.equal(after.length, before.length);
    assert.equal(
      after.find((node) => node.slug === 'pets')!.name,
      'Animals',
      'the seed repairs absence by slug, it does not undo a rename',
    );
    assert.equal((await c.listRules('rodion')).length, 0);
  } finally {
    await db.close();
  }
});

test('a confirmed decision can become a rule for later payments that repeat its bank description', async () => {
  const { db, repo, categories: c } = await setup();
  try {
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'blank',
        accountId: 'rodion',
        owner: 'rodion',
        bookedAt: '2026-09-02T12:00:00Z',
        currency: 'EUR',
        amountMinor: '-100',
        description: '',
      },
    ]);
    const rodion = await repo.list('rodion');
    const transfer = rodion.find((t) => t.description === 'Same merchant')!;
    const blank = rodion.find((t) => t.description === '')!;
    const rule = await c.saveRuleFromDescription('rodion', {
      transactionId: transfer.id,
      kind: 'internal_transfer',
      category: null,
      reason: 'Recipient is an account we own',
    });
    assert.ok(rule);
    assert.deepEqual(rule.matcher, {
      field: 'description',
      value: 'Same merchant',
    });
    assert.equal(rule.kind, 'internal_transfer');
    assert.equal(rule.active, true);
    // Rules stay owner scoped even when both owners see the same description.
    assert.deepEqual(await c.listRules('katya'), []);
    await assert.rejects(
      c.saveRuleFromDescription('katya', {
        transactionId: transfer.id,
        kind: 'internal_transfer',
        category: null,
        reason: 'Not my payment',
      }),
      /not_found/,
    );
    // A blank description identifies nothing, so no rule is invented for it.
    assert.equal(
      await c.saveRuleFromDescription('rodion', {
        transactionId: blank.id,
        kind: 'internal_transfer',
        category: null,
        reason: 'Nothing to match on',
      }),
      null,
    );
    // The absence of a decision is not a decision worth repeating.
    await assert.rejects(
      c.saveRuleFromDescription('rodion', {
        transactionId: transfer.id,
        kind: 'unresolved',
        category: null,
        reason: 'Undecided',
      }),
      /invalid_rule_kind/,
    );
    await assert.rejects(
      c.saveRuleFromDescription('rodion', {
        transactionId: transfer.id,
        kind: 'personal_expense',
        category: 'Food / Missing',
        reason: 'Unknown category',
      }),
      /rule_category_not_found/,
    );
    // Changing the decision replaces the rule instead of adding a rival to it.
    const groceries = await nodeBySlug(c, 'food.groceries');
    const replaced = await c.saveRuleFromDescription('rodion', {
      transactionId: transfer.id,
      kind: 'personal_expense',
      category: 'Food / Groceries',
      reason: 'It was a purchase after all',
    });
    assert.equal(replaced!.id, rule.id);
    assert.equal(replaced!.version, rule.version + 1);
    assert.equal(replaced!.categoryId, groceries.id);
    const rules = await c.listRules('rodion');
    assert.equal(rules.length, 1);
    assert.equal(
      (await c.suggest('rodion', transfer.id)).ambiguous,
      false,
      'one matcher keeps exactly one decision',
    );
  } finally {
    await db.close();
  }
});
