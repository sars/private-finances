import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';

/**
 * The corrections live in the CLI, but the rule they rely on is that a payment a
 * person filed as something other than a personal expense is a different
 * decision and must survive a bulk category fix.
 */
test('a bulk category fix leaves other decisions alone', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const base = {
    source: 'monobank',
    accountId: 'card',
    owner: 'rodion',
    currency: 'UAH',
    bookedAt: '2026-08-01T10:00:00Z',
    amountMinor: '-10000',
  };
  await repo.importBatch([
    { ...base, sourceId: 'ride', description: 'Bolt' },
    { ...base, sourceId: 'meal', description: 'Bolt Food' },
    { ...base, sourceId: 'paid-for-someone', description: 'Bolt' },
  ]);
  try {
    const rows = await repo.list('rodion');
    const other = rows.find((r) => r.sourceId === 'paid-for-someone')!;
    await repo.classify(
      other.id,
      other.revision,
      {
        kind: 'non_personal',
        category: null,
        reason: 'Owner paid for someone else',
      },
      'rodion',
    );
    const selected = (
      await db.query(
        `SELECT id,description FROM transactions
         WHERE amount_minor<0 AND description=ANY($1::text[])
           AND kind IN ('personal_expense','unresolved')`,
        [['Bolt']],
      )
    ).rows;
    // The ride is corrected; the meal is a different service and the payment
    // made for someone else is a different decision.
    assert.deepEqual(
      selected.map((r) => String(r.description)),
      ['Bolt'],
    );
    assert.equal(selected.length, 1);
  } finally {
    await db.close();
  }
});
