import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';

/**
 * The version 25 migration, exercised against a database built the way version
 * 24 left it (ADR 0006).
 *
 * These are the checks that stand in for reading the migration's output by
 * hand: every payment keeps a category, the mapping it used is recorded, a
 * decision a person made survives, and nothing ends up filed on a heading.
 */

type Legacy = {
  path: string;
  kind?: string;
  mcc?: number;
  human?: boolean;
  owner?: 'rodion' | 'katya';
  /** Legacy tag names attached to this payment, as nodes in the old tree. */
  tags?: string[];
};

/** Build a version 24 database, then let `migrate` carry it to 25. */
async function migrated(rows: readonly Legacy[]) {
  const db = memoryDatabase();
  await migrate(db);
  // Return to the pre-migration shape so the real transition runs over real
  // rows, rather than testing a fresh database that never had the old columns.
  // 25 builds the shared tree; 35 repairs what 25 had to flatten. Both have to
  // run over these rows, and the first `migrate` above already recorded them
  // against the empty database.
  await db.query('DELETE FROM schema_versions WHERE version IN (25, 35)');
  await db.query(
    'DROP TRIGGER IF EXISTS transactions_category_sync ON transactions',
  );
  await db.query(
    'DROP TRIGGER IF EXISTS transactions_account_policy ON transactions',
  );
  await db.query(
    'DROP TRIGGER IF EXISTS transactions_account_policy_audit ON transactions',
  );
  await db.query(
    'DROP TRIGGER IF EXISTS own_accounts_apply_policy ON own_accounts',
  );
  await db.query(
    'ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_expense_has_category',
  );
  await db.query('ALTER TABLE transactions DROP COLUMN IF EXISTS category_id');
  await db.query('DROP TABLE IF EXISTS category_migration_log');
  await db.query('DROP TABLE IF EXISTS transaction_tags');
  await db.query('DROP TABLE IF EXISTS classification_rule_audit');
  await db.query('DROP TABLE IF EXISTS classification_rules');
  await db.query('DROP TABLE IF EXISTS category_tree CASCADE');
  await db.query('DROP TABLE IF EXISTS tags CASCADE');
  const { initializeLegacyCategories } =
    await import('../src/category-migration.js');
  await db.transaction(initializeLegacyCategories);

  const ids: string[] = [];
  for (const [index, row] of rows.entries()) {
    const id = randomUUID();
    ids.push(id);
    await db.query(
      `INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description,kind,category,source_details)
       VALUES($1,'synthetic',$2,'a',$3,'2026-08-01T10:00:00Z','EUR','-1000',$4,$5,$6,$7)`,
      [
        id,
        `legacy-${index}`,
        row.owner ?? 'rodion',
        `Legacy payment ${index}`,
        row.kind ?? 'personal_expense',
        row.path,
        JSON.stringify(row.mcc === undefined ? {} : { mcc: row.mcc }),
      ],
    );
    if (row.human)
      await db.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,after_value,reason)
         VALUES($1,$2,'rodion','classified','{}','Owner decided')`,
        [randomUUID(), id],
      );
    for (const tag of row.tags ?? []) {
      const owner = row.owner ?? 'rodion';
      const existing = await db.query(
        "SELECT id FROM category_nodes WHERE owner=$1 AND name=$2 AND node_type='tag'",
        [owner, tag],
      );
      const tagId = existing.rows.length
        ? String(existing.rows[0]!.id)
        : randomUUID();
      if (!existing.rows.length)
        await db.query(
          "INSERT INTO category_nodes(id,owner,name,node_type) VALUES($1,$2,$3,'tag')",
          [tagId, owner, tag],
        );
      await db.query(
        'INSERT INTO transaction_tags(transaction_id,owner,tag_id) VALUES($1,$2,$3)',
        [id, owner, tagId],
      );
    }
  }
  await migrate(db);
  return { db, repo: new Repository(db), ids };
}

test('PF-005 legacy paths move to the shared tree and the mapping is recorded', async () => {
  const { db, repo, ids } = await migrated([
    { path: 'Food / Groceries' },
    { path: 'Subscriptions' },
    // The legacy path as the old database really held it; version 29 later
    // moves that node under Utilities, so the expected reading differs.
    { path: 'Communication / Mobile phone' },
    { path: 'Transport / Car' },
    { path: 'Health / Psychotherapy', owner: 'katya' },
  ]);
  try {
    const rows = await repo.list();
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get(ids[0]!)!.category, 'Food / Groceries');
    // Subscriptions and Apps & services were one idea under two names.
    assert.equal(byId.get(ids[1]!)!.category, 'Apps & services');
    assert.equal(byId.get(ids[2]!)!.category, 'Utilities / Mobile phone');
    // A parent used as a leaf lands in its branch's Unspecified, where it is
    // countable, rather than silently resting on a heading.
    assert.equal(byId.get(ids[3]!)!.category, 'Transport / Car / Unspecified');
    // Both members classify into the same tree now.
    assert.equal(byId.get(ids[4]!)!.category, 'Health / Psychotherapy');

    const log = (
      await db.query(
        'SELECT transaction_id,legacy_path,method FROM category_migration_log',
      )
    ).rows;
    assert.equal(log.length, 5, 'every payment records where it came from');
    assert.ok(
      log.every((entry) => typeof entry.legacy_path === 'string'),
      'the original path is kept so a disagreement can be found, not recalled',
    );
  } finally {
    await db.close();
  }
});

test('PF-005 merchant evidence rescues payments that would be unspecified', async () => {
  const { db, repo, ids } = await migrated([
    { path: 'Shopping', mcc: 5411 },
    { path: 'Shopping', mcc: 7011 },
    { path: 'Other', mcc: 4121 },
    // A money-transfer code says nothing about what was bought.
    { path: 'Shopping', mcc: 4829 },
    { path: 'Shopping' },
    // A person did decide this one — but they decided `Shopping`, and the new
    // tree has no successor for it, so version 25 flattens their decision onto
    // the root catch-all and nothing they meant survives. Leaving it there in
    // deference to a decision that no longer exists is what hid these payments:
    // classified, so outside the review queue, and meaningless, so outside the
    // totals that matter. Version 35 reads the merchant code back. A decision
    // that still names something is never touched — see the version 35 test.
    { path: 'Shopping', mcc: 5411, human: true },
  ]);
  try {
    const byId = new Map((await repo.list()).map((row) => [row.id, row]));
    assert.equal(byId.get(ids[0]!)!.category, 'Food / Groceries');
    assert.equal(byId.get(ids[1]!)!.category, 'Travel / Accommodation');
    assert.equal(byId.get(ids[2]!)!.category, 'Transport / Ride-hailing');
    assert.equal(byId.get(ids[3]!)!.category, 'Unspecified');
    assert.equal(byId.get(ids[4]!)!.category, 'Unspecified');
    assert.equal(byId.get(ids[5]!)!.category, 'Food / Groceries');
    const rescued = (
      await db.query(
        "SELECT count(*)::int AS count FROM category_migration_log WHERE method='merchant_category'",
      )
    ).rows[0]!.count;
    assert.equal(rescued, 4);
  } finally {
    await db.close();
  }
});

test('PF-005 the migration leaves no payment on a heading and no expense without a category', async () => {
  const { db, repo } = await migrated([
    { path: 'Food' },
    { path: 'Health' },
    { path: 'A category nobody recognises' },
    { path: 'Shopping / Something odd' },
  ]);
  try {
    const headings = (
      await db.query(
        `SELECT count(*)::int AS count FROM transactions t
         WHERE t.category_id IS NOT NULL
           AND EXISTS(SELECT 1 FROM category_tree c WHERE c.parent_id=t.category_id)`,
      )
    ).rows[0]!.count;
    assert.equal(headings, 0);
    const uncategorised = (
      await db.query(
        "SELECT count(*)::int AS count FROM transactions WHERE kind='personal_expense' AND category_id IS NULL",
      )
    ).rows[0]!.count;
    assert.equal(uncategorised, 0);
    // Every row still reads as a path, and every path resolves in the tree.
    for (const row of await repo.list()) {
      assert.ok(row.category, 'a migrated expense keeps a readable category');
      assert.ok(row.categoryId);
    }
  } finally {
    await db.close();
  }
});

test('PF-005 the account-purpose rewrite reporting used to apply is written down', async () => {
  const { db, repo, ids } = await migrated([
    { path: 'Shopping', kind: 'unresolved' },
    { path: 'Food / Groceries', kind: 'personal_expense', human: true },
  ]);
  try {
    // The account existed before the migration, so its purpose was only ever
    // applied while drawing a report.
    await db.query(
      "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','a','rodion','Work','business')",
    );
    const byId = new Map((await repo.list()).map((row) => [row.id, row]));
    assert.equal(byId.get(ids[0]!)!.kind, 'non_personal');
    assert.equal(
      byId.get(ids[1]!)!.kind,
      'personal_expense',
      'a decision a person made is not overruled by the account it sits on',
    );
    const events = (
      await db.query(
        "SELECT transaction_id FROM audit_events WHERE event='account_policy_applied'",
      )
    ).rows;
    assert.deepEqual(
      events.map((event) => String(event.transaction_id)),
      [ids[0]],
    );
  } finally {
    await db.close();
  }
});

test('PF-005 tags already attached to payments survive the move and merge by name', async () => {
  // The first rehearsal against a copy of production failed here: tag ids were
  // repointed at the new table while the old composite foreign key into
  // category_nodes was still in place, so any household that actually used tags
  // could not migrate. A fixture without attached tags never showed it.
  const { db, repo, ids } = await migrated([
    { path: 'Food / Groceries', tags: ['Trip'] },
    { path: 'Food / Groceries', tags: ['Trip', 'Shared'] },
    // The same name owned by the other member becomes the same household tag.
    { path: 'Food / Groceries', owner: 'katya', tags: ['trip'] },
    // Two spellings on one payment merge to one row rather than colliding.
    { path: 'Food / Groceries', tags: ['Shared', 'shared'] },
  ]);
  try {
    const tags = (
      await db.query('SELECT id,name FROM tags ORDER BY lower(name)')
    ).rows;
    assert.deepEqual(
      tags.map((t) => String(t.name).toLowerCase()),
      ['shared', 'trip'],
      'names differing only in case are one household tag',
    );
    const links = (
      await db.query(
        'SELECT transaction_id,tag_id FROM transaction_tags ORDER BY transaction_id',
      )
    ).rows;
    assert.equal(links.length, 5, 'every attachment survives, deduplicated');
    const categories = new Categories(db);
    assert.deepEqual(
      (await categories.tags('rodion', ids[1]!)).map((t) =>
        t.name.toLowerCase(),
      ),
      ['shared', 'trip'],
    );
    assert.deepEqual(
      (await categories.tags('katya', ids[2]!)).map((t) =>
        t.name.toLowerCase(),
      ),
      ['trip'],
    );
    assert.equal((await categories.tags('rodion', ids[3]!)).length, 1);
    assert.equal((await repo.list()).length, 4);
  } finally {
    await db.close();
  }
});

test('PF-005 legacy tags and confirmed rules survive the move', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const categories = new Categories(db);
    const nodes = await categories.listNodes();
    const leaf = nodes.find((n) => n.slug === 'food.groceries')!;
    const rule = await categories.saveRule('rodion', {
      matcher: { field: 'description', value: 'Synthetic merchant' },
      kind: 'personal_expense',
      categoryId: leaf.id,
      confirmed: true,
      reason: 'Owner rule',
    });
    assert.equal((await categories.listRules('rodion'))[0]!.id, rule.id);
    // Tags are a household list now, not nodes in the category tree, so the
    // same name cannot exist twice and can never reach a category total.
    const first = await categories.saveTag('Trip');
    const again = await categories.saveTag('trip');
    assert.equal(first.id, again.id);
    assert.equal((await categories.listTags()).length, 1);
  } finally {
    await db.close();
  }
});

test('version 35 repairs human decisions the migration flattened onto the root catch-all', async () => {
  const { db, repo, ids } = await migrated([
    // A legacy path with no successor in the new tree. Version 25 maps it onto
    // the root catch-all, so the person's decision stops saying anything — and
    // because the payment is neither unresolved nor provisional it never came
    // back to the review queue to be corrected either.
    { path: 'Shopping', human: true, mcc: 5661 },
    { path: 'Shopping', human: true, mcc: 5977 },
    { path: 'Apps & services / AI tools', human: true, mcc: 5734 },
    // Money-transfer codes say nothing about what was bought, so this one has
    // to stay in the catch-all and come back through the review queue instead.
    { path: 'Shopping', human: true, mcc: 4829 },
    { path: 'Shopping', human: true },
    // A decision that still means something is never touched, whoever made it.
    { path: 'Food / Groceries', human: true, mcc: 5661 },
  ]);
  try {
    const byId = new Map((await repo.list()).map((row) => [row.id, row]));
    assert.equal(byId.get(ids[0]!)!.category, 'Clothes');
    assert.equal(byId.get(ids[1]!)!.category, 'Beauty / Cosmetics');
    assert.equal(byId.get(ids[2]!)!.category, 'Apps & services');
    assert.equal(byId.get(ids[3]!)!.category, 'Unspecified');
    assert.equal(byId.get(ids[4]!)!.category, 'Unspecified');
    assert.equal(byId.get(ids[5]!)!.category, 'Food / Groceries');
    // The repair says which merchant code made the decision, so the owner can
    // see why a payment they had filed by hand moved.
    const repaired = (
      await db.query(
        `SELECT reason FROM audit_events WHERE transaction_id=$1 AND actor='migration'
         ORDER BY created_at DESC LIMIT 1`,
        [ids[0]],
      )
    ).rows[0];
    assert.match(String(repaired!.reason), /5661/);
    assert.match(String(repaired!.reason), /root catch-all/);
    // The mapping record is updated too, so the log never disagrees with the
    // category the payment actually holds.
    const log = (
      await db.query(
        'SELECT method FROM category_migration_log WHERE transaction_id=$1',
        [ids[0]],
      )
    ).rows[0];
    assert.equal(String(log!.method), 'merchant_category');
  } finally {
    await db.close();
  }
});

/**
 * Version 42: the two repairs that follow from the importer no longer reading a
 * settled card hold as the bank correcting itself.
 */
test('version 42 restores decisions a settling hold discarded, and reads the new merchant codes', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);

    // Two payments that a card hold settled under. One had been categorised by
    // a rule the owner confirmed, the other by the model; the importer threw
    // both away and they fell back to the catch-all, provisional.
    const lost: Array<{ id: string; path: string; source: string }> = [];
    for (const [sourceId, path, source] of [
      ['settled-rule', 'Clothes', 'confirmed_rule'],
      ['settled-model', 'Food / Groceries', 'model_cache'],
    ] as const) {
      await repo.importBatch([
        {
          source: 'synthetic',
          sourceId,
          accountId: 'rodion-uah',
          owner: 'rodion',
          bookedAt: '2026-09-13T12:00:00.000Z',
          currency: 'UAH',
          amountMinor: '-6296',
          description: sourceId,
          status: 'booked',
          sourceDetails: { mcc: 5651, hold: false },
        },
      ]);
      const id = String(
        (
          await db.query('SELECT id FROM transactions WHERE source_id=$1', [
            sourceId,
          ])
        ).rows[0]!.id,
      );
      lost.push({ id, path, source });
      await db.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
         VALUES($1,$2,'transaction_triage','auto_classified','{}',$3,'Automatic decision')`,
        [
          randomUUID(),
          id,
          JSON.stringify({ provenance: { decision: { source } } }),
        ],
      );
      await db.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
         VALUES($1,$2,'importer','source_corrected',$3,$4,'Source import')`,
        [
          randomUUID(),
          id,
          JSON.stringify({ status: 'pending', sourceDetails: { hold: true } }),
          JSON.stringify({ status: 'booked', sourceDetails: { hold: false } }),
        ],
      );
      await db.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
         VALUES($1,$2,'importer','auto_classification_invalidated',$3,'{}','Bank corrected the evidence used by automatic classification')`,
        [
          randomUUID(),
          id,
          JSON.stringify({ kind: 'personal_expense', category: path }),
        ],
      );
      await db.query(
        `UPDATE transactions SET kind='personal_expense', provisional=true,
         classification_source='default',
         category_id=(SELECT id FROM category_tree WHERE slug='unspecified') WHERE id=$1`,
        [id],
      );
    }

    // A payment nothing could read until 5946 joined the merchant-code map.
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'photo-shop',
        accountId: 'katya-uah',
        owner: 'katya',
        bookedAt: '2026-09-14T11:00:00.000Z',
        currency: 'UAH',
        amountMinor: '-6240',
        description: 'A photo shop',
        status: 'booked',
        sourceDetails: { mcc: 5946, hold: false },
      },
    ]);
    const photo = String(
      (
        await db.query(
          "SELECT id FROM transactions WHERE source_id='photo-shop'",
        )
      ).rows[0]!.id,
    );
    await db.query(
      `UPDATE transactions SET kind='personal_expense', provisional=true,
       classification_source='default',
       category_id=(SELECT id FROM category_tree WHERE slug='unspecified') WHERE id=$1`,
      [photo],
    );

    await db.query('DELETE FROM schema_versions WHERE version=42');
    await migrate(db);

    for (const { id, path, source } of lost) {
      const row = (
        await db.query('SELECT * FROM transactions WHERE id=$1', [id])
      ).rows[0]!;
      assert.equal(row.category, path, `${path} was not restored`);
      assert.equal(row.provisional, false);
      assert.equal(
        row.classification_source,
        source === 'confirmed_rule' ? 'rule' : 'model',
      );
    }

    const placed = (
      await db.query('SELECT * FROM transactions WHERE id=$1', [photo])
    ).rows[0]!;
    assert.equal(placed.category, 'Entertainment / Hobbies');
    assert.equal(placed.classification_source, 'mcc');
    // A merchant code is evidence about the shop, not proof about the purchase,
    // so it still owes the owner a review.
    assert.equal(placed.provisional, true);
  } finally {
    await db.close();
  }
});

test('version 42 leaves alone a payment a person decided, or one already re-answered', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'owner-decided',
        accountId: 'rodion-uah',
        owner: 'rodion',
        bookedAt: '2026-09-13T12:00:00.000Z',
        currency: 'UAH',
        amountMinor: '-6296',
        description: 'Decided by a person',
        status: 'booked',
        sourceDetails: { mcc: 5651, hold: false },
      },
    ]);
    const id = String(
      (
        await db.query(
          "SELECT id FROM transactions WHERE source_id='owner-decided'",
        )
      ).rows[0]!.id,
    );
    for (const [event, after, reason] of [
      [
        'auto_classified',
        JSON.stringify({ provenance: { decision: { source: 'model' } } }),
        'Automatic decision',
      ],
      [
        'source_corrected',
        JSON.stringify({ status: 'booked', sourceDetails: { hold: false } }),
        'Source import',
      ],
      ['classified', '{}', 'The owner decided this themselves'],
    ] as const) {
      await db.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
         VALUES($1,$2,'rodion',$3,$4,$5,$6)`,
        [
          randomUUID(),
          id,
          event,
          JSON.stringify({ status: 'pending', sourceDetails: { hold: true } }),
          after,
          reason,
        ],
      );
    }
    await db.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'importer','auto_classification_invalidated',$3,'{}','Bank corrected the evidence used by automatic classification')`,
      [
        randomUUID(),
        id,
        JSON.stringify({ kind: 'personal_expense', category: 'Clothes' }),
      ],
    );
    await db.query(
      `UPDATE transactions SET kind='personal_expense', provisional=false,
       classification_source='human',
       category_id=(SELECT id FROM category_tree WHERE slug='pets') WHERE id=$1`,
      [id],
    );

    await db.query('DELETE FROM schema_versions WHERE version=42');
    await migrate(db);

    const row = (await db.query('SELECT * FROM transactions WHERE id=$1', [id]))
      .rows[0]!;
    assert.equal(row.category, 'Pets');
    assert.equal(row.classification_source, 'human');
  } finally {
    await db.close();
  }
});
