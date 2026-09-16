import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Refunds } from '../src/refunds.js';
import { convertedSpending } from '../src/analytics.js';
import { buildReport, previousReportPeriod } from '../src/reports.js';
import { needsSpendingReview } from '../src/spending-review.js';
import { FxRates } from '../src/fx-rates.js';

const card = {
  source: 'monobank',
  accountId: 'card-uah',
  owner: 'rodion',
  currency: 'UAH',
  description: 'EPIDEMIC SOUND',
};

async function household() {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([
    {
      ...card,
      sourceId: 'charge',
      bookedAt: '2026-08-03T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    },
    {
      ...card,
      sourceId: 'reversal',
      bookedAt: '2026-08-13T10:00:00Z',
      amountMinor: '92885',
      sourceDetails: {
        amount: 92885,
        operationAmount: 1799,
        currencyCode: 978,
      },
    },
  ]);
  const rows = await repo.list('rodion');
  const charge = rows.find((r) => r.sourceId === 'charge')!;
  const reversal = rows.find((r) => r.sourceId === 'reversal')!;
  await repo.classify(
    charge.id,
    0,
    {
      kind: 'personal_expense',
      category: 'Apps & services',
      reason: 'Owner labelled the subscription',
    },
    'rodion',
  );
  return { db, repo, charge, reversal };
}

test('a refund reduces spending totals in every display currency without changing a bank amount', async () => {
  const { db, repo, charge, reversal } = await household();
  try {
    const before = await convertedSpending(
      repo,
      await repo.list('rodion'),
      'UAH',
    );
    assert.equal(before.confirmedMinor, '93639');
    await new Refunds(db).link({
      debitId: charge.id,
      creditId: reversal.id,
      expectedDebitRevision: 1,
      expectedCreditRevision: 0,
      owner: 'rodion',
      reason: 'Owner confirms the subscription was refunded',
    });
    const rows = await repo.list('rodion');
    const purchase = rows.find((r) => r.id === charge.id)!;
    assert.equal(
      purchase.amountMinor,
      '-93639',
      'the bank amount is unchanged',
    );
    assert.equal(purchase.refund!.netMinor, '-754');
    const uah = await convertedSpending(repo, rows, 'UAH');
    // Forty-one days of exchange-rate movement is what the subscription cost.
    assert.equal(uah.confirmedMinor, '754');
    const row = uah.rows.find((r) => r.id === charge.id)!;
    assert.equal(row.convertedAmountMinor, '-93639');
    assert.equal(row.reducedAmountMinor, '92885');
    assert.equal(row.netAmountMinor, '-754');
    assert.equal(uah.monthly[0]!.confirmedMinor, '754');
    // What it finally cost is settled in the account currency and then
    // converted like any other transaction: 7.54 UAH at 50 to the euro.
    await new FxRates(db).insert({
      source: 'synthetic-market',
      base: 'EUR',
      target: 'UAH',
      rate: '50',
      asOf: '2026-08-03',
      retrievedAt: '2026-08-04T00:00:00Z',
      version: 1,
      provenance: 'Synthetic daily rate',
    });
    const eur = await convertedSpending(repo, rows, 'EUR');
    assert.equal(eur.confirmedMinor, '15');
    assert.equal(
      eur.rows.find((r) => r.id === charge.id)!.netAmountMinor,
      '-15',
    );
  } finally {
    await db.close();
  }
});

test('household report category totals count what a purchase finally cost', async () => {
  const { db, repo, charge, reversal } = await household();
  try {
    const period = previousReportPeriod(
      'month',
      new Date('2026-09-02T00:00:00Z'),
    );
    const before = buildReport(await repo.list('rodion'), {
      owner: 'rodion',
      period,
    });
    assert.equal(before.byCategory[0]!.personalExpenseMinor, '93639');
    assert.equal(before.byCurrency[0]!.personalExpenseMinor, '93639');
    await new Refunds(db).link({
      debitId: charge.id,
      creditId: reversal.id,
      expectedDebitRevision: 1,
      expectedCreditRevision: 0,
      owner: 'rodion',
      reason: 'Owner confirms the subscription was refunded',
    });
    const after = buildReport(await repo.list('rodion'), {
      owner: 'rodion',
      period,
    });
    assert.equal(after.byCategory[0]!.personalExpenseMinor, '754');
    assert.equal(after.byCurrency[0]!.personalExpenseMinor, '754');
    // A link changes what a report says without changing any revision, so the
    // fingerprint has to notice it.
    assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
  } finally {
    await db.close();
  }
});

test('a refunded purchase still has to be categorised', async () => {
  const { db, repo, charge, reversal } = await household();
  try {
    await repo.classify(
      charge.id,
      1,
      {
        kind: 'unresolved',
        category: null,
        reason: 'Owner reopened the decision',
      },
      'rodion',
    );
    const before = await repo.list('rodion');
    assert.equal(
      before.filter((row) => needsSpendingReview(row)).length,
      1,
      'an unexplained purchase needs review',
    );
    await new Refunds(db).link({
      debitId: charge.id,
      creditId: reversal.id,
      expectedDebitRevision: 2,
      expectedCreditRevision: 0,
      owner: 'rodion',
      reason: 'Owner confirms the subscription was refunded',
    });
    const after = await repo.list('rodion');
    // What the money was for does not change because part of it came back.
    assert.equal(after.filter((row) => needsSpendingReview(row)).length, 1);
    assert.equal(
      after.find((row) => needsSpendingReview(row))!.refund!.netMinor,
      '-754',
    );
    // The credit that returned it is explained by the link, not by a category.
    assert.equal(
      after.find((row) => row.sourceId === 'reversal')!.kind,
      'unresolved',
    );
  } finally {
    await db.close();
  }
});

test('a screen that adds up the counted rows arrives at the headline total', async () => {
  // The overview chart, the category breakdown and the headline total are three
  // renderings of one number. They agree only if a screen adds the amount after
  // refunds; adding the amount before them counts a charge that was reversed
  // alongside whatever replaced it, and the chart then contradicts the total
  // printed directly beneath it.
  const { db, repo, charge, reversal } = await household();
  try {
    await new Refunds(db).link({
      debitId: charge.id,
      creditId: reversal.id,
      expectedDebitRevision: 1,
      expectedCreditRevision: 0,
      owner: 'rodion',
      reason: 'Owner confirms the subscription was refunded',
    });
    const uah = await convertedSpending(repo, await repo.list('rodion'), 'UAH');
    const counted = uah.rows.filter((row) => row.counted === 'confirmed');
    const sum = (pick: (row: (typeof counted)[number]) => string | null) =>
      counted
        .reduce((total, row) => total - BigInt(pick(row) ?? '0'), 0n)
        .toString();

    assert.equal(sum((row) => row.netAmountMinor), uah.confirmedMinor);
    assert.equal(
      sum((row) => row.netAmountMinor),
      uah.monthly
        .reduce((total, month) => total + BigInt(month.confirmedMinor), 0n)
        .toString(),
    );
    // And the reason the distinction matters: before refunds this is the whole
    // 936.39, which is 93,639 more than the household actually spent.
    assert.equal(sum((row) => row.convertedAmountMinor), '93639');
    assert.equal(uah.confirmedMinor, '754');
  } finally {
    await db.close();
  }
});
