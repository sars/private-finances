import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository, Conflict } from '../src/repository.js';
import {
  initializeSpendingPatterns,
  SpendingPatterns,
} from '../src/spending-pattern.js';
const input = {
  source: 'synthetic',
  accountId: 'a',
  sourceId: 'one',
  owner: 'rodion',
  bookedAt: '2026-09-12T12:00:00Z',
  currency: 'EUR',
  amountMinor: '-100',
  description: 'Synthetic purchase',
};
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeSpendingPatterns);
  const repo = new Repository(db);
  await repo.importBatch([input]);
  return {
    db,
    repo,
    patterns: new SpendingPatterns(db),
    transaction: (await repo.list())[0]!,
  };
}

test('patterns default to unreviewed, are independent from classification, and audit explicit edits', async () => {
  const { db, repo, patterns, transaction } = await setup();
  try {
    await db.transaction(initializeSpendingPatterns);
    const initial = (await patterns.list('rodion'))[0]!;
    assert.equal(initial.pattern, 'unreviewed');
    assert.equal(initial.explicit, false);
    assert.equal(initial.revision, 0);
    assert.equal(initial.sourceRevision, null);
    assert.equal(
      (await db.query('SELECT * FROM spending_patterns')).rows.length,
      0,
    );
    const exceptional = await patterns.set(
      transaction.id,
      0,
      'rodion',
      'exceptional',
      'Owner says unusual purchase',
    );
    assert.equal(exceptional.revision, 1);
    assert.equal(exceptional.sourceRevision, 0);
    assert.equal(exceptional.explicit, true);
    const cleared = await patterns.set(
      transaction.id,
      0,
      'rodion',
      'unreviewed',
      'Need to reconsider',
      exceptional.revision,
    );
    assert.equal(cleared.revision, 2);
    assert.equal(cleared.pattern, 'unreviewed');
    assert.equal(cleared.explicit, true);
    const { spendingPattern: _currentPattern, ...currentLedger } = (
      await repo.list()
    )[0]!;
    const { spendingPattern: _originalPattern, ...originalLedger } =
      transaction;
    assert.deepEqual(
      currentLedger,
      originalLedger,
      'label updates do not change bank or classification fields',
    );
    const attached = await patterns.attach('rodion', [
      { id: transaction.id, extra: 'keep' },
    ]);
    assert.equal(attached[0]!.extra, 'keep');
    assert.deepEqual(attached[0]!.spendingPattern, cleared);
    const audits = (
      await db.query(
        "SELECT * FROM audit_events WHERE event='spending_pattern_set' ORDER BY (after_value->>'revision')::integer",
      )
    ).rows;
    assert.equal(audits.length, 2);
    assert.equal(audits[0]!.actor, 'rodion');
    assert.equal((audits[0]!.before_value as any).pattern, 'unreviewed');
    assert.equal((audits[0]!.after_value as any).pattern, 'exceptional');
    assert.equal(audits[1]!.reason, 'Need to reconsider');
  } finally {
    await db.close();
  }
});

test('owner and dual revision guards prevent stale or competing edits without extra audit', async () => {
  const { db, patterns, transaction } = await setup();
  try {
    await assert.rejects(
      patterns.set(transaction.id, 0, 'katya', 'routine', 'Wrong owner'),
      /not_found/,
    );
    assert.deepEqual(await patterns.list('katya', [transaction.id]), []);
    await assert.rejects(
      patterns.attach('katya', [{ id: transaction.id }]),
      /not_found/,
    );
    await assert.rejects(
      patterns.set(transaction.id, 1, 'rodion', 'routine', 'Stale source'),
      Conflict,
    );
    const writes = await Promise.allSettled([
      patterns.set(transaction.id, 0, 'rodion', 'routine', 'First editor'),
      patterns.set(transaction.id, 0, 'rodion', 'exceptional', 'Second editor'),
    ]);
    assert.equal(writes.filter((w) => w.status === 'fulfilled').length, 1);
    const rejected = writes.find(
      (w) => w.status === 'rejected',
    ) as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof Conflict);
    assert.equal(rejected.reason.message, 'stale_annotation_revision');
    assert.equal(
      (
        await db.query(
          "SELECT * FROM audit_events WHERE event='spending_pattern_set'",
        )
      ).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});

test('source corrections preserve explicit pattern with old provenance and permit guarded review', async () => {
  const { db, repo, patterns, transaction } = await setup();
  try {
    await patterns.set(
      transaction.id,
      0,
      'rodion',
      'exceptional',
      'Owner decision',
    );
    await repo.importBatch([{ ...input, amountMinor: '-200' }]);
    const corrected = (await patterns.list('rodion'))[0]!;
    assert.equal(corrected.pattern, 'exceptional');
    assert.equal(corrected.sourceRevision, 0);
    assert.equal(corrected.currentTransactionRevision, 1);
    assert.equal(corrected.needsReview, true);
    await assert.rejects(
      patterns.set(transaction.id, 0, 'rodion', 'routine', 'Old view', 1),
      /stale_revision/,
    );
    const reviewed = await patterns.set(
      transaction.id,
      1,
      'rodion',
      'routine',
      'Reviewed corrected transaction',
      1,
    );
    assert.equal(reviewed.sourceRevision, 1);
    assert.equal(reviewed.revision, 2);
    assert.equal(reviewed.needsReview, false);
    assert.equal((await repo.list())[0]!.revision, 1);
    assert.equal(
      (await repo.list())[0]!.kind,
      'unresolved',
      'pattern is not a classification override',
    );
  } finally {
    await db.close();
  }
});

test('pattern boundary rejects unsupported labels and invalid reason/revisions', async () => {
  const { db, patterns, transaction } = await setup();
  try {
    for (const pattern of ['recurring', 'expensive', '', null])
      await assert.rejects(
        patterns.set(transaction.id, 0, 'rodion', pattern as any, 'Reason'),
        /invalid_spending_pattern/,
      );
    for (const reason of ['', '  ', 'x'.repeat(1001)])
      await assert.rejects(
        patterns.set(transaction.id, 0, 'rodion', 'routine', reason),
        /invalid_spending_pattern_reason/,
      );
    await assert.rejects(
      patterns.set(transaction.id, -1, 'rodion', 'routine', 'Reason'),
      /invalid_revision/,
    );
    await assert.rejects(
      patterns.set(transaction.id, 0, 'rodion', 'routine', 'Reason', 0.5),
      /invalid_revision/,
    );
    assert.deepEqual(await patterns.list('rodion', []), []);
    assert.equal(
      (await db.query('SELECT * FROM spending_patterns')).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
