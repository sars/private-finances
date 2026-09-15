import test from 'node:test';
import assert from 'node:assert/strict';
import { needsSpendingReview } from '../src/spending-review.js';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web } from '../src/web.js';

test('review browsing includes pending unclear outflows while reporting predicate remains booked-only', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(
    ['4440000', '-1000', '0', '-500'].map((amountMinor, i) => ({
      source: 'synthetic',
      sourceId: String(i),
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor,
      description: 'Synthetic account movement',
      bookedAt: '2026-09-11T09:31:01Z',
      status: i === 3 ? 'pending' : 'booked',
    })),
  );
  const all = await repo.list('rodion');
  assert.deepEqual(
    all.filter((row) => needsSpendingReview(row)).map((r) => r.amountMinor),
    ['-1000'],
  );
  assert.equal(
    needsSpendingReview(all.find((r) => r.status === 'pending')!),
    false,
  );
  assert.equal(
    needsSpendingReview(
      all.find((r) => r.status === 'pending')!,
      true,
    ),
    true,
  );
  assert.equal(
    needsSpendingReview({
      ...all.find((r) => r.amountMinor === '-1000')!,
      spendingPolicy: {
        excluded: true,
        visibility: 'excluded',
        suggestedKind: 'non_personal',
        accountLabel: 'Business',
        accountPurpose: 'business',
        accountRevision: 1,
        reason: 'business_account',
      },
    }),
    false,
  );
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  try {
    const defaults = await (
      await fetch(`http://127.0.0.1:${config.port}/api/review`)
    ).json();
    assert.equal(defaults.transactions.length, 2);
    assert.deepEqual(
      new Set(
        defaults.transactions.map(
          (t: { amountMinor: string }) => t.amountMinor,
        ),
      ),
      new Set(['-1000', '-500']),
    );
    // The account movement of exactly nothing is hidden by default and comes
    // back when asked for.
    const history = await (
      await fetch(`http://127.0.0.1:${config.port}/api/review?all=1`)
    ).json();
    assert.equal(history.transactions.length, 3);
    const zeroes = await (
      await fetch(
        `http://127.0.0.1:${config.port}/api/review?all=1&includeZeroAmount=1`,
      )
    ).json();
    assert.equal(zeroes.transactions.length, 4);
    assert.ok(
      zeroes.transactions.some(
        (t: { amountMinor: string }) => t.amountMinor === '0',
      ),
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});

test('a payment classified into the root catch-all returns to the review queue', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'catch-all',
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '-2500',
      description: 'Synthetic shop with no successor category',
      bookedAt: '2026-09-11T09:31:01Z',
      status: 'booked',
    },
  ]);
  const [imported] = await repo.list('rodion');
  // What the tree migration does to a legacy path with no successor, and what a
  // person does when they cannot decide: a real classification onto the root
  // catch-all, which leaves the payment neither unresolved nor provisional.
  await repo.classify(
    imported!.id,
    imported!.revision,
    { kind: 'personal_expense', category: 'Unspecified', reason: 'migrated' },
    'rodion',
  );
  const [settled] = await repo.list('rodion');
  assert.equal(settled!.kind, 'personal_expense');
  assert.equal(settled!.category, 'Unspecified');
  assert.equal(settled!.provisional, false);
  // The undecided test alone lets it leave the queue for good: that was the hole.
  assert.equal(needsSpendingReview(settled!, true), false);
  assert.equal(needsSpendingReview(settled!, true, true), true);
  // A branch catch-all still names its branch, so it stays finished.
  assert.equal(
    needsSpendingReview(
      { ...settled!, category: 'Food / Unspecified' },
      true,
      true,
    ),
    false,
  );
  // Income still never enters the queue, whatever it is categorised as.
  assert.equal(
    needsSpendingReview({ ...settled!, amountMinor: '2500' }, true, true),
    false,
  );
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  try {
    const listed = await (
      await fetch(`http://127.0.0.1:${config.port}/api/review`)
    ).json();
    assert.deepEqual(
      listed.transactions.map((t: { id: string }) => t.id),
      [settled!.id],
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});
