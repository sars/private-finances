import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { FxRates } from '../src/fx-rates.js';
import { convertedSpending } from '../src/analytics.js';
import { filterTransactions, parseFilters } from '../src/filters.js';
import {
  aggregateSpending,
  parseAnalyticsOptions,
} from '../src/analytics-aggregation.js';
import { web } from '../src/web.js';

async function seeded() {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const at = (day: string) => `${day}T10:00:00Z`;
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'g1',
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '-10000',
      bookedAt: at('2026-07-03'),
      description: 'Groceries',
    },
    {
      source: 'synthetic',
      sourceId: 'g2',
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '-5000',
      bookedAt: at('2026-08-14'),
      description: 'Groceries again',
    },
    {
      source: 'synthetic',
      sourceId: 'r1',
      accountId: 'b',
      owner: 'katya',
      currency: 'EUR',
      amountMinor: '-1000',
      bookedAt: at('2026-08-20'),
      description: 'Restaurant',
    },
    {
      source: 'synthetic',
      sourceId: 't1',
      accountId: 'b',
      owner: 'katya',
      currency: 'EUR',
      amountMinor: '-200',
      bookedAt: at('2026-08-21'),
      description: 'Bus',
    },
    {
      source: 'synthetic',
      sourceId: 'inv',
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '-30000',
      bookedAt: at('2026-08-22'),
      description: 'Broker',
    },
    {
      source: 'synthetic',
      sourceId: 'nofx',
      accountId: 'b',
      owner: 'katya',
      currency: 'GBP',
      amountMinor: '-700',
      bookedAt: at('2026-08-23'),
      description: 'Unconvertible',
    },
    {
      source: 'synthetic',
      sourceId: 'in',
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '90000',
      bookedAt: at('2026-08-24'),
      description: 'Salary',
    },
  ]);
  const decide = async (
    sourceId: string,
    kind: string,
    category: string | null,
  ) => {
    const row = (await repo.list()).find((r) => r.sourceId === sourceId)!;
    await repo.classify(
      row.id,
      row.revision,
      { kind: kind as never, category, reason: 'synthetic' },
      row.owner,
    );
  };
  await decide('g1', 'personal_expense', 'Food / Groceries');
  await decide('g2', 'personal_expense', 'Food / Groceries');
  await decide('r1', 'personal_expense', 'Food / Restaurants / Dining in');
  await decide('t1', 'personal_expense', 'Transport / Public transport');
  await decide('inv', 'investment', null);
  // Conversion is by daily rate, so each EUR day needs its own quote.
  for (const asOf of ['2026-08-20', '2026-08-21'])
    await new FxRates(db).insert({
      source: 'synthetic-market',
      base: 'EUR',
      target: 'UAH',
      rate: '50',
      asOf,
      retrievedAt: `${asOf}T00:00:00Z`,
      version: 1,
      provenance: 'Synthetic quote',
    });
  return { db, repo };
}

test('every bucket and series sums to the total, the tree rolls up, kinds and missing rates behave', async () => {
  const { db, repo } = await seeded();
  try {
    const rows = filterTransactions(
      await repo.list(),
      parseFilters(new URLSearchParams()),
    );
    const reporting = await convertedSpending(repo, rows, 'UAH');
    const byCategory = aggregateSpending(
      rows,
      reporting.rows,
      parseAnalyticsOptions(
        new URLSearchParams('bucket=month&series=category&depth=1'),
      ),
    );
    // 10000 + 5000 + 1000*50 + 200*50 = 75000 UAH of spending; the investment
    // is not asked for and the salary is money in.
    assert.equal(byCategory.totals.netMinor, '75000');
    assert.equal(byCategory.totals.count, 4);
    // The GBP payment converts to nothing, so it is reported rather than zeroed.
    assert.equal(byCategory.totals.missingFx, 1);
    const seriesSum = byCategory.buckets
      .flatMap((b) => b.series)
      .reduce((n, s) => n + BigInt(s.netMinor), 0n);
    assert.equal(seriesSum.toString(), byCategory.totals.netMinor);
    for (const bucket of byCategory.buckets) {
      const listed = filterTransactions(
        rows,
        parseFilters(
          new URLSearchParams({
            from: bucket.period + '-01',
            to: bucket.period + '-31',
          }),
        ),
      );
      const monthly = aggregateSpending(
        listed,
        reporting.rows,
        parseAnalyticsOptions(new URLSearchParams('bucket=month&series=none')),
      );
      // The drill link for a bucket lists exactly the payments that made it.
      assert.equal(
        monthly.totals.netMinor,
        bucket.series.reduce((n, s) => n + BigInt(s.netMinor), 0n).toString(),
      );
    }
    const food = byCategory.tree.find((n) => n.id === 'Food')!;
    const groceries = byCategory.tree.find((n) => n.id === 'Food / Groceries')!;
    const restaurants = byCategory.tree.find(
      (n) => n.id === 'Food / Restaurants',
    )!;
    assert.equal(groceries.parentId, 'Food');
    assert.equal(
      food.netMinor,
      (BigInt(groceries.netMinor) + BigInt(restaurants.netMinor)).toString(),
    );
    assert.equal(
      byCategory.tree.find((n) => n.id === 'Uncategorized')!.missingFx,
      1,
    );
    // Series by owner: two people, the same total.
    const byOwner = aggregateSpending(
      rows,
      reporting.rows,
      parseAnalyticsOptions(new URLSearchParams('series=owner')),
    );
    const owners = new Set(
      byOwner.buckets.flatMap((b) => b.series.map((s) => s.key)),
    );
    assert.deepEqual([...owners].sort(), ['katya', 'rodion']);
    assert.equal(
      byOwner.buckets
        .flatMap((b) => b.series)
        .reduce((n, s) => n + BigInt(s.netMinor), 0n)
        .toString(),
      '75000',
    );
    // Asking for investments as a kind counts the broker payment as its own series.
    const withInvestments = aggregateSpending(
      rows,
      reporting.rows,
      parseAnalyticsOptions(
        new URLSearchParams(
          'series=kind&kinds=personal_expense,unresolved,investment',
        ),
      ),
    );
    assert.equal(withInvestments.totals.netMinor, '105000');
    assert.ok(
      withInvestments.buckets.some((b) =>
        b.series.some((s) => s.key === 'investment' && s.netMinor === '30000'),
      ),
    );
    // Every payment was decided by a person here.
    assert.equal(byCategory.coverage.human?.count, 4);
    assert.throws(
      () => parseAnalyticsOptions(new URLSearchParams('bucket=year')),
      /invalid_bucket/,
    );
    assert.throws(
      () => parseAnalyticsOptions(new URLSearchParams('kinds=salary')),
      /invalid_kinds/,
    );
    assert.throws(
      () => parseAnalyticsOptions(new URLSearchParams('depth=9')),
      /invalid_depth/,
    );
  } finally {
    await db.close();
  }
});

test('/api/analytics answers the same grammar as the transaction list and rejects a bad option', async () => {
  const { db, repo } = await seeded();
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  // The handler only answers its own host, and only learns the port now.
  config.port = port;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/analytics?display=UAH&bucket=month&series=category&depth=1&from=2026-08-01&to=2026-08-31`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.currency, 'UAH');
    // August only: 5000 + 50000 + 10000.
    assert.equal(body.totals.netMinor, '65000');
    assert.equal(body.buckets.length, 1);
    assert.equal(body.buckets[0].period, '2026-08');
    const katya = await fetch(
      `http://127.0.0.1:${port}/api/analytics?display=UAH&owner=katya`,
    );
    assert.equal((await katya.json()).totals.netMinor, '60000');
    const bad = await fetch(
      `http://127.0.0.1:${port}/api/analytics?display=UAH&bucket=year`,
    );
    assert.equal(bad.status, 400);
    const noDisplay = await fetch(`http://127.0.0.1:${port}/api/analytics`);
    assert.equal(noDisplay.status, 400);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});
