import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';
import { FxRates } from '../src/fx-rates.js';
import { Refunds } from '../src/refunds.js';
import { convertedSpending } from '../src/analytics.js';
import { historicalReporting } from '../src/historical-reporting.js';
const base = {
  source: 'synthetic',
  accountId: 'synthetic',
  owner: 'rodion',
  bookedAt: '2026-07-12T12:00:00Z',
  currency: 'UAH',
  amountMinor: '-10000',
  description: 'Synthetic shop',
  sourceDetails: { mcc: 5411 },
};
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db),
    categories = new Categories(db);
  return { db, repo, categories };
}
test('historical reporting uses exact per-row target conversions, exposes unknown/missing and respects owner-filtered input', async (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-09-12T12:00:00Z'),
  });
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'estimated-one' },
      { ...base, sourceId: 'estimated-two', amountMinor: '-10001' },
      {
        ...base,
        sourceId: 'unknown-large',
        amountMinor: '-300004',
        sourceDetails: { mcc: 4829 },
      },
      { ...base, sourceId: 'missing-fx', currency: 'GBP', amountMinor: '-100' },
      { ...base, sourceId: 'other-owner', owner: 'katya' },
      { ...base, sourceId: 'recent', bookedAt: '2026-08-12T12:00:00Z' },
      { ...base, sourceId: 'income', amountMinor: '10000' },
      { ...base, sourceId: 'pending', status: 'pending' },
      { ...base, sourceId: 'archive', bookedAt: '2025-07-12T12:00:00Z' },
    ]);
    await new FxRates(db).insert({
      source: 'synthetic-market',
      base: 'EUR',
      target: 'UAH',
      rate: '4',
      asOf: '2026-07-12',
      retrievedAt: '2026-07-13T00:00:00Z',
      version: 1,
      provenance: 'Synthetic daily rate',
    });
    const rows = await repo.list('rodion');
    const before = structuredClone(rows);
    const reporting = await convertedSpending(repo, rows, 'EUR');
    const result = await historicalReporting(repo, rows, reporting);
    assert.equal(result.estimatedMinor, '5000');
    assert.equal(result.unknownMinor, '75001');
    assert.equal(result.estimatedCount, 2);
    assert.equal(result.unknownCount, 2);
    assert.equal(result.missing, 1);
    assert.equal(result.rows.length, 4);
    assert.equal(reporting.confirmedMinor, '0');
    assert.deepEqual(
      await repo.list('rodion'),
      before,
      'projection must not change ledger',
    );
    const katya = await repo.list('katya');
    const other = await historicalReporting(
      repo,
      katya,
      await convertedSpending(repo, katya, 'UAH'),
    );
    // The category vocabulary is the household's now, not each owner's, so the
    // same merchant evidence estimates either member's payment. What keeps the
    // two apart is ownership of the rows and of any cached proposal, which the
    // next test covers directly.
    assert.equal(other.estimatedCount, 1);
    assert.equal(other.unknownMinor, '0');
    assert.equal(other.rows.length, 1);
    assert.equal(other.rows[0]!.transactionId, katya[0]!.id);
  } finally {
    await db.close();
  }
});
test('manual unresolved and stale ledger snapshots stay unknown without acquiring historical estimates', async (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-09-12T12:00:00Z'),
  });
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'manual' },
      { ...base, sourceId: 'stale' },
    ]);
    const initial = await repo.list();
    const manual = initial.find((row) => row.sourceId === 'manual')!;
    await repo.classify(
      manual.id,
      manual.revision,
      {
        kind: 'unresolved',
        category: null,
        reason: 'Owner deliberately left unknown',
      },
      'rodion',
    );
    const rows = await repo.list();
    const reporting = await convertedSpending(repo, rows, 'UAH');
    await repo.importBatch([
      { ...base, sourceId: 'stale', description: 'Changed synthetic source' },
    ]);
    const result = await historicalReporting(repo, rows, reporting);
    assert.equal(result.estimatedCount, 0);
    assert.equal(result.unknownCount, 2);
    assert.equal(result.unknownMinor, '20000');
    assert.ok(
      result.rows.every(
        (row) => row.status === 'needs_review' && row.category === null,
      ),
    );
  } finally {
    await db.close();
  }
});
test('stale cached proposals are rejected and a refunded payment adds no inferred spending', async (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-09-12T12:00:00Z'),
  });
  const { db, repo, categories } = await setup();
  try {
    await categories.saveNode({ name: 'Software' });
    await repo.importBatch([
      { ...base, sourceId: 'cached', sourceDetails: { mcc: 0 } },
      { ...base, sourceId: 'debit' },
      { ...base, sourceId: 'credit', amountMinor: '10000' },
    ]);
    let rows = await repo.list();
    const cached = rows.find((row) => row.sourceId === 'cached')!;
    await db.query(
      `INSERT INTO transaction_triage(transaction_id,revision,owner,state,decision) VALUES($1,$2,'rodion','ready',$3)`,
      [
        cached.id,
        cached.revision,
        {
          kind: 'personal_expense',
          category: 'Software',
          confidence: 0.99,
          reason: 'Synthetic cached proposal',
        },
      ],
    );
    await repo.importBatch([
      {
        ...base,
        sourceId: 'cached',
        description: 'Updated source',
        sourceDetails: { mcc: 0 },
      },
    ]);
    const debit = rows.find((row) => row.sourceId === 'debit')!,
      credit = rows.find((row) => row.sourceId === 'credit')!;
    const refunds = new Refunds(db);
    const link = await refunds.link({
      debitId: debit.id,
      creditId: credit.id,
      expectedDebitRevision: debit.revision,
      expectedCreditRevision: credit.revision,
      owner: 'rodion',
      reason: 'Synthetic full cancellation',
    });
    rows = await repo.list();
    const result = await historicalReporting(
      repo,
      rows,
      await convertedSpending(repo, rows, 'UAH'),
    );
    assert.equal(result.estimatedCount, 0);
    // A refunded purchase still has to be explained, so it stays an unknown
    // payment — but one that cost nothing, so it adds nothing to the total.
    assert.equal(result.unknownCount, 2);
    assert.equal(result.unknownMinor, '10000');
    assert.ok(result.rows.some((row) => row.transactionId === cached.id));
    assert.equal(
      result.rows.find((row) => row.transactionId === cached.id)!.provenance
        .proposalId,
      null,
    );
    await refunds.unlink(
      link.id,
      link.revision,
      'rodion',
      'Owner wants to investigate',
    );
    rows = await repo.list();
    const unlinked = await historicalReporting(
      repo,
      rows,
      await convertedSpending(repo, rows, 'UAH'),
    );
    assert.equal(unlinked.estimatedCount, 0);
    assert.equal(unlinked.unknownCount, 2);
    assert.equal(unlinked.unknownMinor, '20000');
  } finally {
    await db.close();
  }
});

test('cached proposal must belong to the transaction owner even when category labels exist for both', async (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-09-12T12:00:00Z'),
  });
  const { db, repo, categories } = await setup();
  try {
    // One shared tree: adding it once serves both members.
    await categories.saveNode({ name: 'Software' });
    await repo.importBatch([
      { ...base, sourceId: 'owner-proposal', sourceDetails: { mcc: 0 } },
    ]);
    const rows = await repo.list('rodion');
    await db.query(
      `INSERT INTO transaction_triage(transaction_id,revision,owner,state,decision) VALUES($1,$2,'katya','ready',$3)`,
      [
        rows[0]!.id,
        rows[0]!.revision,
        {
          kind: 'personal_expense',
          category: 'Software',
          confidence: 0.99,
          reason: 'Synthetic wrong-owner proposal',
        },
      ],
    );
    const reporting = await convertedSpending(repo, rows, 'UAH');
    const mismatched = await historicalReporting(repo, rows, reporting);
    assert.equal(mismatched.estimatedCount, 0);
    assert.equal(mismatched.unknownCount, 1);
    await db.query(
      `UPDATE transaction_triage SET owner='rodion' WHERE transaction_id=$1`,
      [rows[0]!.id],
    );
    const matched = await historicalReporting(repo, rows, reporting);
    assert.equal(matched.estimatedCount, 1);
    assert.equal(matched.estimatedMinor, '10000');
    assert.equal(matched.rows[0]!.category, 'Software');
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});
