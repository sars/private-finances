import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Refunds } from '../src/refunds.js';
import { web } from '../src/web.js';

test('a linked credit is hidden while its purchase stays listed; the toggle and direct links preserve owner scope', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(
    ['rodion', 'katya'].flatMap((owner) =>
      [-100, 100, -50].map((amount, i) => ({
        source: 'synthetic',
        sourceId: owner + i,
        accountId: owner,
        owner,
        bookedAt: '2026-09-12T10:00:00Z',
        currency: 'EUR',
        amountMinor: String(amount),
        description: 'Synthetic purchase',
      })),
    ),
  );
  const rows = await repo.list('rodion');
  const debit = rows.find((r) => r.amountMinor === '-100')!;
  const credit = rows.find((r) => r.amountMinor === '100')!;
  const other = (await repo.list('katya'))[0]!;
  const refunds = new Refunds(db);
  const link = await refunds.link({
    debitId: debit.id,
    creditId: credit.id,
    expectedDebitRevision: 0,
    expectedCreditRevision: 0,
    owner: 'rodion',
    reason: 'Confirmed synthetic full refund',
  });
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${config.port}`;
  const ids = async (query: string) => {
    const response = await fetch(base + '/api/review?all=1&window=all' + query);
    assert.equal(response.status, 200);
    return (await response.json()).transactions.map(
      (t: { id: string }) => t.id,
    ) as string[];
  };
  try {
    const hidden = async (owner: 'rodion' | 'katya') =>
      (await repo.list(owner))
        .filter(
          (t) =>
            t.refund?.role === 'refund' &&
            t.refund.reductions.every((item) => item.discrepancy === null),
        )
        .map((t) => t.id);
    // The credit is counted through the purchase, so only it disappears; the
    // purchase stays listed because it still needs a category.
    assert.deepEqual(await hidden('rodion'), [credit.id]);
    assert.equal((await hidden('katya')).length, 0);
    const listed = await ids('');
    assert.equal(listed.length, 2);
    assert.ok(listed.includes(debit.id));
    assert.ok(!listed.includes(credit.id));
    assert.equal((await ids('&includeRefunds=1')).length, 3);
    assert.ok((await ids('&id=' + debit.id)).includes(debit.id));
    assert.ok(
      !(await ids('&id=' + other.id + '&includeRefunds=1')).includes(other.id),
    );
    const before = await repo.list('rodion');
    await ids('&includeRefunds=1');
    assert.deepEqual(await repo.list('rodion'), before);
    // A corrected amount disagrees with what the link was made from, so both
    // sides become visible again instead of the link being undone.
    for (const change of ['amount_minor=99', 'amount_minor=101']) {
      await db.query(`UPDATE transactions SET ${change} WHERE id=$1`, [
        credit.id,
      ]);
      assert.equal((await hidden('rodion')).length, 0);
      assert.equal((await ids('')).length, 3);
      await db.query('UPDATE transactions SET amount_minor=100 WHERE id=$1', [
        credit.id,
      ]);
    }
    await refunds.unlink(link.id, 1, 'rodion', 'Undo synthetic refund');
    assert.equal((await hidden('rodion')).length, 0);
    assert.equal((await ids('')).length, 3);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
  }
});
