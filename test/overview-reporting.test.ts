import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { FxRates } from '../src/fx-rates.js';
import { web } from '../src/web.js';

test('overview combines account currencies, preserves source rows, uses Riga month and exposes incomplete coverage', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'uah',
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '-10000',
      bookedAt: '2026-08-31T22:30:00Z',
      description: 'Synthetic cafe',
    },
    {
      source: 'synthetic',
      sourceId: 'eur',
      accountId: 'b',
      owner: 'katya',
      currency: 'EUR',
      amountMinor: '-1000',
      bookedAt: '2026-08-31T22:30:00Z',
      description: 'Synthetic cafe',
    },
    {
      source: 'synthetic',
      sourceId: 'missing',
      accountId: 'b',
      owner: 'katya',
      currency: 'GBP',
      amountMinor: '-1000',
      bookedAt: '2026-08-31T22:30:00Z',
      description: 'Synthetic shop',
    },
    {
      source: 'synthetic',
      sourceId: 'incoming',
      accountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '50000',
      bookedAt: '2026-08-31T22:30:00Z',
      description: 'Synthetic inflow',
    },
  ]);
  for (const r of await repo.list())
    if (BigInt(r.amountMinor) < 0n)
      await repo.classify(
        r.id,
        r.revision,
        {
          kind: 'personal_expense',
          category: 'Food / Groceries',
          reason: 'Synthetic confirmed purchase',
        },
        r.owner,
      );
  await new FxRates(db).insert({
    source: 'synthetic-market',
    base: 'EUR',
    target: 'UAH',
    rate: '50',
    asOf: '2026-08-31',
    retrievedAt: '2026-09-01T00:00:00Z',
    version: 1,
    provenance: 'Synthetic quote',
  });
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  config.port = address.port;
  const get = async (q: string) => {
    const res = await fetch(
      `http://127.0.0.1:${address.port}/api/overview?${q}`,
    );
    assert.equal(res.status, 200);
    return res.json();
  };
  try {
    const first = (await repo.list('rodion'))[0]!;
    const detail = await fetch(
      `http://127.0.0.1:${address.port}/api/transaction-details?id=${first.id}`,
    );
    assert.equal(detail.status, 200);
    assert.ok((await detail.json()).details);
    // Either member may read the other's payment; a payment that does not
    // exist is still not found.
    const foreign = (await repo.list('katya'))[0]!;
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${address.port}/api/transaction-details?id=${foreign.id}`,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${address.port}/api/transaction-details?id=00000000-0000-4000-8000-000000000000`,
        )
      ).status,
      404,
    );
    const all = await get('display=UAH');
    assert.equal(all.reporting.confirmedMinor, '60000');
    assert.equal(all.reporting.coverage.confirmed.missing, 1);
    assert.equal(all.reporting.monthly.length, 2);
    assert.ok(
      all.reporting.monthly.every(
        (m: { month: string }) => m.month === '2026-09',
      ),
    );
    assert.equal(
      all.transactions.find((r: { sourceId: string }) => r.sourceId === 'eur')
        .amountMinor,
      '-1000',
    );
    assert.equal(
      all.byCurrency.reduce(
        (n: number, c: { unresolvedCount: number }) => n + c.unresolvedCount,
        0,
      ),
      0,
    );
    const kate = await get('display=UAH&owner=katya');
    assert.equal(kate.reporting.confirmedMinor, '50000');
    const native = await get('display=UAH&currency=UAH');
    assert.equal(native.reporting.confirmedMinor, '10000');
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});
