import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web } from '../src/web.js';
test('family receipt routes preserve CSRF and generic transaction ownership; correspondence is not exposed', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(
    ['rodion', 'katya'].map((owner) => ({
      source: 'synthetic',
      sourceId: owner,
      accountId: owner,
      owner,
      amountMinor: '-100',
      currency: 'UAH',
      bookedAt: '2026-08-01T12:00:00Z',
      description: 'Synthetic payment',
    })),
  );
  const mine = (await repo.list('rodion'))[0]!,
    other = (await repo.list('katya'))[0]!;
  const receipt = randomUUID();
  await db.query(
    "INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state) VALUES($1,'katya','synthetic',1,'file','pending')",
    [receipt],
  );
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${config.port}`;
  try {
    const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
    assert.equal(
      (await fetch(base + '/api/evidence?id=' + other.id)).status,
      404,
    );
    assert.equal(
      (await (await fetch(base + '/api/receipts')).json()).receipts[0].id,
      receipt,
    );
    const candidates = (
      await (await fetch(base + '/api/receipt-candidates')).json()
    ).transactions;
    assert.deepEqual(
      new Set(candidates.map((t: { owner: string }) => t.owner)),
      new Set(['rodion', 'katya']),
    );
    assert.equal(
      (await fetch(base + '/api/transaction-details?id=' + other.id)).status,
      404,
    );
    assert.equal(
      (await fetch(base + '/api/receipt-image?id=' + receipt)).status,
      404,
    );
    const post = (route: string, values: Record<string, string>) =>
      fetch(base + route, {
        method: 'POST',
        body: new URLSearchParams(values),
        redirect: 'manual',
      });
    assert.equal(
      (await fetch(base + '/api/evidence?id=' + mine.id)).status,
      404,
    );
    assert.equal(
      (await post('/receipts/attach', { id: receipt, transactionId: mine.id }))
        .status,
      403,
    );
    assert.equal(
      (
        await post('/receipts/attach', {
          csrf: bootstrap.csrf,
          id: receipt,
          transactionId: mine.id,
        })
      ).status,
      303,
    );
    assert.equal((await repo.list('rodion'))[0]!.kind, 'unresolved');
    assert.equal(
      (await post('/receipts/delete', { csrf: bootstrap.csrf, id: receipt }))
        .status,
      303,
    );
    assert.equal(
      (
        await post('/receipts/delete', {
          csrf: bootstrap.csrf,
          id: randomUUID(),
        })
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});
