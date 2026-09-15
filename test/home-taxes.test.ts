import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { moveHouseholdTaxToItsOwnLeaf } from '../src/category-tree.js';

/**
 * `Home / Taxes`, at the owner's request.
 *
 * The tree had nowhere for tax, so the one treasury payment they had called
 * personal — tax on the place they live, as against the sole-trader tax paid
 * from the business accounts — sat in the catch-all for want of anywhere
 * better.
 */

const base = {
  source: 'monobank',
  accountId: 'personal',
  owner: 'rodion' as const,
  bookedAt: '2025-10-28T10:00:00Z',
  currency: 'UAH',
  amountMinor: '-1322699',
  description: 'ГУК Сум.обл/Сумська МТГ/18010200',
};

async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  return { db, repo: new Repository(db) };
}

test('the tree has a home for household tax', async () => {
  const { db } = await setup();
  try {
    const leaf = await db.query(
      "SELECT category_path(id) AS path FROM category_tree WHERE slug='home.taxes'",
    );
    assert.equal(leaf.rows[0]?.path, 'Home / Taxes');
  } finally {
    await db.close();
  }
});

test('tax resting in the catch-all moves onto it, and nothing else does', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'tax' },
      {
        ...base,
        sourceId: 'sofa',
        description: 'JYSK',
        amountMinor: '-500000',
      },
    ]);
    const catchAll = String(
      (
        await db.query(
          "SELECT id FROM category_tree WHERE slug='home.unspecified'",
        )
      ).rows[0]!.id,
    );
    for (const row of await repo.list())
      await db.query(
        "UPDATE transactions SET kind='personal_expense', category_id=$1 WHERE id=$2",
        [catchAll, row.id],
      );

    const moved = await db.transaction((tx) =>
      moveHouseholdTaxToItsOwnLeaf(tx),
    );
    assert.equal(moved, 1);
    const rows = await repo.list();
    assert.equal(
      rows.find((r) => r.sourceId === 'tax')!.category,
      'Home / Taxes',
    );
    assert.equal(
      rows.find((r) => r.sourceId === 'sofa')!.category,
      'Home / Unspecified',
      'a sofa is not a tax',
    );
    const history = await repo.history(
      rows.find((r) => r.sourceId === 'tax')!.id,
    );
    assert.ok(
      history.some((event) =>
        /category of its own/.test(String(event.reason ?? '')),
      ),
      'the move is on the record, in the owner’s terms',
    );
    // Re-runnable: nothing is left in the catch-all to move a second time.
    assert.equal(
      await db.transaction((tx) => moveHouseholdTaxToItsOwnLeaf(tx)),
      0,
    );
  } finally {
    await db.close();
  }
});

test('tax a person filed somewhere else on purpose is left alone', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([{ ...base, sourceId: 'tax' }]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'personal_expense',
        category: 'Home / Services',
        reason: 'Owner filed it here deliberately',
      },
      'rodion',
    );
    assert.equal(
      await db.transaction((tx) => moveHouseholdTaxToItsOwnLeaf(tx)),
      0,
    );
    assert.equal((await repo.list())[0]!.category, 'Home / Services');
  } finally {
    await db.close();
  }
});
