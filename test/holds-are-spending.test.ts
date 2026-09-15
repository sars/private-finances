import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { restPlacements } from '../src/resting-place.js';
import { expenseSummary } from '../src/domain.js';
import { convertedSpending } from '../src/analytics.js';

/**
 * A hold is money the bank has already taken.
 *
 * Monobank deducts at authorisation and its `hold` flag only says the final
 * amount could still be adjusted. Asked again four months later it still
 * answers `hold: true` for the same operations, and the balance in its own
 * payload runs straight through them — 358,113.98 minus 416.41 is 354,054.01,
 * and the next settled operation continues from there. Keeping that money out
 * of the totals left 99 payments uncounted, some for a year.
 *
 * What stays true is that the amount is not final, so the pending figure is
 * still reported; it is now "of which" rather than "as well as".
 */

const base = {
  source: 'monobank',
  accountId: 'personal',
  owner: 'rodion' as const,
  bookedAt: '2026-05-08T15:36:50Z',
  currency: 'UAH',
  amountMinor: '-41641',
  description: 'SMAKOLIKI SIA',
};

async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO own_accounts(source,account_id,owner,label,purpose)
     VALUES('monobank','personal','rodion','Everyday','personal')`,
  );
  return { db, repo: new Repository(db) };
}

test('a hold counts as spending and is still shown as not final', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'hold',
        status: 'pending',
        sourceDetails: { mcc: 5411, hold: true },
      },
      {
        ...base,
        sourceId: 'settled',
        amountMinor: '-70269',
        description: 'Misto',
        status: 'booked',
        sourceDetails: { mcc: 5411, hold: false },
      },
    ]);
    await db.transaction((tx) => restPlacements(tx));
    const rows = await repo.list();
    const summary = expenseSummary(rows);
    const uah = summary.byCurrency.find((t) => t.currency === 'UAH')!;
    assert.equal(
      uah.personalExpenseMinor,
      '111910',
      'both the hold and the settled payment are in the total',
    );
    assert.equal(
      uah.pendingOutflowMinor,
      '41641',
      'the hold is still reported, as a share of that total',
    );
    assert.equal(uah.pendingCount, 1);
  } finally {
    await db.close();
  }
});

test('the same is true of the converted totals and the monthly figures', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'hold',
        status: 'pending',
        sourceDetails: { mcc: 5411, hold: true },
      },
    ]);
    await db.transaction((tx) => restPlacements(tx));
    const totals = await convertedSpending(repo, await repo.list(), 'UAH');
    assert.equal(totals.confirmedMinor, '41641', 'counted');
    assert.equal(totals.pendingMinor, '41641', 'and flagged as not final');
    const month = totals.monthly.find((m) => m.month === '2026-05')!;
    assert.equal(
      month.confirmedMinor,
      '41641',
      'a hold reaches the monthly chart the owner reads',
    );
    assert.equal(month.covered, 1);
  } finally {
    await db.close();
  }
});

test('a hold is categorised rather than waiting for a settlement that never comes', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'hold',
        status: 'pending',
        sourceDetails: { mcc: 5411, hold: true },
      },
    ]);
    const report = await db.transaction((tx) => restPlacements(tx));
    assert.equal(report.byMcc, 1);
    const row = (await repo.list())[0]!;
    assert.equal(row.kind, 'personal_expense');
    assert.equal(row.category, 'Food / Groceries');
    assert.equal(row.status, 'pending', 'still a hold; the bank may revise it');
  } finally {
    await db.close();
  }
});

test('incoming money the bank is holding is still not spending', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'incoming',
        amountMinor: '41641',
        description: 'Скасування. SMAKOLIKI SIA',
        status: 'pending',
        sourceDetails: { hold: true },
      },
    ]);
    const uah = expenseSummary(await repo.list()).byCurrency.find(
      (t) => t.currency === 'UAH',
    )!;
    assert.equal(uah.personalExpenseMinor, '0');
    assert.equal(
      uah.pendingOutflowMinor,
      '0',
      'a credit is not an outflow, held or not',
    );
    assert.equal(uah.pendingCount, 0);
  } finally {
    await db.close();
  }
});
