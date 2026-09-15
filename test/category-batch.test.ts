import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate, type Database } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';

test('batched review context equals individual rule/tag reads while reducing queries and preserving owner boundaries', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const c = new Categories(db);
  try {
    // Listing orders by booked_at DESC, id. Identical timestamps left the order
    // decided by random UUIDs, so the inflow reached rows[1] about one run in ten
    // and classifying it as an expense failed. Distinct descending seconds make
    // the listing deterministic: rows[i] is always synthetic transaction i.
    await repo.importBatch(
      Array.from({ length: 10 }, (_, i) => ({
        source: 'synthetic',
        sourceId: String(i),
        accountId: 'a',
        owner: i === 9 ? 'katya' : 'rodion',
        bookedAt: new Date(Date.UTC(2026, 8, 12, 10, 0, 30 - i)).toISOString(),
        currency: 'EUR',
        amountMinor: i === 8 ? '100' : '-100',
        description: i === 7 ? 'Other' : 'Shared venue',
        sourceDetails: { counterpartyIdentifier: 'test:recipient' },
      })),
    );
    const category = (await c.listNodes()).find(
      (n) => n.slug === 'food.groceries',
    )!;
    const tag = await c.saveTag('Trip');
    await c.saveRule('rodion', {
      matcher: { field: 'description', value: 'Shared venue' },
      kind: 'personal_expense',
      categoryId: category.id,
      confirmed: true,
      reason: 'Synthetic',
    });
    await c.saveRule('rodion', {
      matcher: { field: 'counterparty', value: 'test:recipient' },
      kind: 'investment',
      categoryId: null,
      confirmed: true,
      reason: 'Synthetic',
    });
    await c.saveRule('rodion', {
      matcher: { field: 'description', value: 'Other' },
      kind: 'internal_transfer',
      categoryId: null,
      active: false,
      confirmed: true,
      reason: 'Synthetic disabled',
    });
    const rows = await repo.list('rodion');
    const foreign = (await repo.list('katya'))[0]!;
    await c.setTags('rodion', rows[0]!.id, [tag.id]);
    await repo.classify(
      rows[1]!.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Synthetic human decision',
      },
      'rodion',
    );
    const ids = [...rows.map((r) => r.id), foreign.id];
    let queries = 0;
    const counted: Database = {
      query: (sql, params) => {
        queries++;
        return db.query(sql, params);
      },
      transaction: (action) => db.transaction(action),
      close: async () => {},
    };
    const countedCategories = new Categories(counted);
    const expected: {
      suggestions: Record<string, unknown>;
      tags: Record<string, unknown>;
    } = { suggestions: {}, tags: {} };
    for (const id of ids) {
      expected.suggestions[id] = await countedCategories.suggest('rodion', id);
      expected.tags[id] = await countedCategories.tags('rodion', id);
    }
    const before = queries;
    queries = 0;
    const actual = await countedCategories.reviewContext('rodion', ids);
    assert.deepEqual(actual, expected);
    assert.equal(before, 28);
    assert.equal(queries, 3);
    assert.deepEqual(actual.tags[foreign.id], []);
    assert.deepEqual(actual.suggestions[foreign.id]!.rules, []);
    assert.equal(actual.suggestions[rows[1]!.id]!.rules.length, 0);
    assert.ok(Object.values(actual.suggestions).some((s) => s.ambiguous));
    queries = 0;
    assert.deepEqual(await countedCategories.reviewContext('rodion', []), {
      suggestions: {},
      tags: {},
    });
    assert.equal(queries, 0);
    await assert.rejects(
      countedCategories.reviewContext('invalid' as 'rodion', ids),
      /invalid_owner/,
    );
  } finally {
    await db.close();
  }
});
