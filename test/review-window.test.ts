import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withinReviewWindow,
  reviewPriority,
  reviewWindow,
} from '../src/review-window.js';
test('review periods use Riga boundaries and keep 2025 in archive only', () => {
  const now = new Date('2026-09-12T10:00:00Z');
  const check = (
    bookedAt: string,
    scope: Parameters<typeof withinReviewWindow>[1],
  ) => withinReviewWindow({ bookedAt }, scope, now);
  assert.equal(check('2026-07-31T21:00:00Z', 'previous_month'), true);
  assert.equal(check('2026-07-31T20:59:59Z', 'historical'), true);
  assert.equal(check('2026-08-31T21:00:00Z', 'previous_month'), false);
  assert.equal(check('2026-08-31T21:00:00Z', 'current_month'), true);
  assert.equal(check('2025-12-31T21:59:59Z', 'historical'), false);
  assert.equal(check('2025-12-31T22:00:00Z', 'historical'), true);
  assert.equal(check('2025-01-01T00:00:00Z', 'all'), true);
  assert.throws(() => reviewWindow('wrong'));
});
test('priority is strictly above 3000 UAH and missing conversion stays visible', () => {
  assert.equal(reviewPriority('-300000'), 'normal');
  assert.equal(reviewPriority('-300001'), 'large');
  assert.equal(reviewPriority(null), 'missing_fx');
});

test('runtime cutoff leaves archived payments without new AI work', async () => {
  const { memoryDatabase, migrate } = await import('../src/database.js');
  const { Repository } = await import('../src/repository.js');
  const { TransactionTriage } = await import('../src/transaction-triage.js');
  const db = memoryDatabase();
  try {
    await migrate(db);
    await new Repository(db).importBatch([
      {
        source: 'synthetic',
        sourceId: 'archived',
        accountId: 'a',
        owner: 'rodion',
        currency: 'UAH',
        amountMinor: '-100',
        description: 'Synthetic archive',
        bookedAt: '2025-07-01T12:00:00Z',
      },
    ]);
    let calls = 0;
    const triage = new TransactionTriage(
      db,
      () => {
        calls++;
        return undefined;
      },
      undefined,
      { notBefore: '2025-12-31T22:00:00Z' },
    );
    assert.equal(await triage.processOne(), false);
    assert.equal(calls, 0);
  } finally {
    await db.close();
  }
});
