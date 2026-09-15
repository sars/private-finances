import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, postgresDatabase, migrate } from '../src/database.js';
import { Repository, Conflict } from '../src/repository.js';
import { synthetic } from '../src/synthetic.js';
import { expenseSummary } from '../src/domain.js';

test('migration replay, duplicate import, audit, ownership, corrections and stale edits', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await migrate(db);
    const repo = new Repository(db);
    assert.equal(await repo.importBatch(synthetic), 5);
    assert.equal(await repo.importBatch(synthetic), 0);
    const first = (await repo.list()).find((t) => t.sourceId === 'demo-1')!;
    const decision = {
      kind: 'personal_expense',
      category: 'Food / Groceries',
      reason: 'Confirmed by owner',
    };
    await assert.rejects(
      repo.classify(first.id, 0, decision, 'katya'),
      /not_found/,
    );
    await repo.classify(first.id, 0, decision, 'rodion');
    await assert.rejects(
      repo.classify(first.id, 0, decision, 'rodion'),
      Conflict,
    );
    assert.equal(
      await repo.importBatch([{ ...synthetic[0], amountMinor: '-130000' }]),
      1,
    );
    const updated = (await repo.list()).find((t) => t.id === first.id)!;
    assert.equal(updated.kind, 'personal_expense');
    assert.equal(updated.category, 'Food / Groceries');
    assert.equal(updated.revision, 2);
    assert.equal(
      expenseSummary(await repo.list()).byCurrency.find(
        (t) => t.currency === 'UAH',
      )?.personalExpenseMinor,
      '130000',
    );
    assert.equal(
      (
        await db.query('SELECT * FROM audit_events WHERE transaction_id=$1', [
          first.id,
        ])
      ).rows.length,
      3,
    );
    await assert.rejects(
      repo.importBatch([{ ...synthetic[0], owner: 'katya' }]),
      /account_owner_mismatch/,
    );
    assert.equal((await repo.list()).length, 5);
  } finally {
    await db.close();
  }
});

test('bank corrections invalidate automatic decisions but preserve explicit human decisions', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    await repo.importBatch([synthetic[0]]);
    const t = (await repo.list())[0]!;
    await db.query(
      `UPDATE transactions SET kind='personal_expense',revision=revision+1,
       category_id=(SELECT id FROM category_tree WHERE slug='food.groceries') WHERE id=$1`,
      [t.id],
    );
    await db.query(
      "INSERT INTO audit_events(id,transaction_id,actor,event,after_value,reason) VALUES('11111111-1111-4111-8111-111111111111',$1,'transaction_triage','auto_classified','{}','Synthetic automatic decision')",
      [t.id],
    );
    assert.equal(await repo.importBatch([synthetic[0]]), 0);
    assert.equal((await repo.list())[0]!.kind, 'personal_expense');
    await repo.importBatch([
      { ...synthetic[0], description: 'Corrected payment purpose' },
    ]);
    const corrected = (await repo.list())[0]!;
    assert.equal(corrected.kind, 'unresolved');
    assert.equal(corrected.category, null);
    assert.equal(corrected.revision, 2);
    assert.ok(
      (await repo.history(t.id)).some(
        (e) => e.event === 'auto_classification_invalidated',
      ),
    );
    await repo.classify(
      t.id,
      2,
      { kind: 'non_personal', category: null, reason: 'Owner correction' },
      'rodion',
    );
    await repo.importBatch([
      { ...synthetic[0], description: 'Another provider correction' },
    ]);
    assert.equal((await repo.list())[0]!.kind, 'non_personal');
  } finally {
    await db.close();
  }
});

test('jobs recover expired leases, preserve live leases, and retry import without duplicates', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    assert.equal((await repo.health()).freshness, 'never_synced');
    const id = await repo.enqueue();
    await db.query(
      "UPDATE jobs SET state='running',attempts=1,lease_until=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
    assert.equal(await repo.work(synthetic), id);
    assert.equal((await repo.health()).freshness, 'fresh');
    await repo.enqueue();
    await repo.work(synthetic);
    assert.equal((await repo.list()).length, 5);
    const live = await repo.enqueue();
    await db.query(
      "UPDATE jobs SET state='running',lease_until=now()+interval '1 minute' WHERE id=$1",
      [live],
    );
    assert.equal(await repo.work(synthetic), null);
    const failed = await repo.enqueue();
    await assert.rejects(repo.work([{ broken: true }]));
    assert.equal(
      (await db.query('SELECT state FROM jobs WHERE id=$1', [failed])).rows[0]
        ?.state,
      'failed',
    );
    await db.query(
      "UPDATE sync_state SET last_success_at=now()-interval '2 days'",
    );
    assert.equal((await repo.health()).freshness, 'stale');
  } finally {
    await db.close();
  }
});

test('an import rollback leaves neither partial transactions nor audit records', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    await assert.rejects(
      db.transaction(async (tx) => {
        await repo.importBatch(synthetic, tx);
        throw new Error('simulated crash before commit');
      }),
    );
    assert.equal((await repo.list()).length, 0);
    assert.equal((await db.query('SELECT * FROM audit_events')).rows.length, 0);
  } finally {
    await db.close();
  }
});

test(
  'real PostgreSQL migrations and concurrent idempotent imports',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    // Dedicated disposable CI database only. Never point this at production.
    const db = postgresDatabase(process.env.TEST_DATABASE_URL!);
    try {
      await migrate(db);
      await migrate(db);
      const repo = new Repository(db);
      await Promise.all([
        repo.importBatch(synthetic),
        repo.importBatch(synthetic),
      ]);
      assert.equal((await repo.list()).length, 5);
      assert.equal(
        (await db.query('SELECT * FROM audit_events')).rows.length,
        5,
      );
    } finally {
      await db.close();
    }
  },
);

test('pending settlement preserves decisions and source provenance without duplicate spend', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const pending = {
      ...synthetic[0],
      status: 'pending',
      sourceDetails: { hold: true, metadata: { b: 2, a: 1 } },
    };
    await repo.importBatch([pending]);
    const first = (await repo.list())[0]!;
    await repo.classify(
      first.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Owner confirmed',
      },
      'rodion',
    );
    // The bank has already taken the money, so the decision counts straight
    // away; the hold is still declared, as a share of that same total.
    assert.equal(
      expenseSummary(await repo.list()).byCurrency[0]!.personalExpenseMinor,
      '128050',
    );
    assert.equal(
      expenseSummary(await repo.list()).byCurrency[0]!.pendingCount,
      1,
    );
    assert.equal(
      await repo.importBatch([
        { ...pending, sourceDetails: { metadata: { a: 1, b: 2 }, hold: true } },
      ]),
      0,
    );
    assert.equal(
      await repo.importBatch([
        { ...pending, status: 'booked', sourceDetails: { hold: false } },
      ]),
      1,
    );
    const settled = (await repo.list())[0]!;
    assert.equal(settled.id, first.id);
    assert.equal(settled.kind, 'personal_expense');
    assert.equal(settled.status, 'booked');
    assert.equal(
      expenseSummary(await repo.list()).byCurrency[0]!.personalExpenseMinor,
      (-BigInt(settled.amountMinor)).toString(),
    );
    assert.deepEqual(
      (await db.query('SELECT source_details FROM transactions')).rows[0]!
        .source_details,
      { hold: false },
    );
    assert.equal('sourceDetails' in settled, false);
    const history = await repo.history(settled.id);
    assert.equal(history.length, 3);
    assert.equal(JSON.stringify(history).includes('sourceDetails'), false);
    assert.equal(history.filter((e) => e.event === 'classified').length, 1);
    await assert.rejects(repo.importBatch([{ ...pending, status: 'unknown' }]));
    assert.equal((await repo.list()).length, 1);
  } finally {
    await db.close();
  }
});
