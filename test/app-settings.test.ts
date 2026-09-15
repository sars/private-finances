import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { readAppSettings, updateAppSettings } from '../src/app-settings.js';
import { web } from '../src/web.js';
test('settings migration upgrades v16 without changing ledger and audits optimistic admin updates', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    const repo = new Repository(db);
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'migration',
        accountId: 'a',
        owner: 'rodion',
        bookedAt: '2026-09-12T10:00:00Z',
        currency: 'EUR',
        amountMinor: '-100',
        description: 'Migration sentinel',
      },
    ]);
    const beforeLedger = await repo.list('rodion');
    await db.query('DROP TABLE app_settings_audit');
    await db.query('DROP TABLE app_settings');
    await db.query('DELETE FROM schema_versions WHERE version=17');
    await migrate(db);
    await migrate(db);
    assert.deepEqual(await readAppSettings(db), {
      revision: 0,
      hideBusiness: true,
      hideInternalTransfers: true,
      hideRefunds: true,
    });
    assert.deepEqual(await repo.list('rodion'), beforeLedger);
    const value = {
      hideBusiness: false,
      hideInternalTransfers: true,
      hideRefunds: false,
    };
    await assert.rejects(
      updateAppSettings(db, 'katya', 0, value),
      /admin_required/,
    );
    await updateAppSettings(db, 'rodion', 0, value);
    await assert.rejects(
      updateAppSettings(db, 'rodion', 0, value),
      /stale_settings/,
    );
    assert.equal(
      (await db.query('SELECT * FROM app_settings_audit')).rows.length,
      1,
    );
    assert.equal(
      (await db.query('SELECT * FROM schema_versions WHERE version=17')).rows
        .length,
      1,
    );
  } finally {
    await db.close();
  }
});
test('admin settings routes enforce ownership and CSRF; shared defaults and direct detail browsing are reversible', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(
    ['rodion', 'katya'].flatMap((owner) =>
      ['personal', 'business', 'transfer', 'bonds'].map((type, i) => ({
        source: 'synthetic',
        sourceId: owner + type,
        accountId: type,
        owner,
        bookedAt: '2026-09-12T10:00:00Z',
        currency: 'EUR',
        amountMinor: '-100',
        description: type,
      })),
    ),
  );
  await db.query(
    "UPDATE transactions SET kind='internal_transfer' WHERE description='transfer'",
  );
  await db.query(
    "UPDATE transactions SET kind='investment' WHERE description='bonds'",
  );
  await db.query(
    "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','business','rodion','Business','business'),('synthetic','bonds','rodion','Business bonds','business')",
  );
  const rows = await repo.list('rodion');
  const business = rows.find((t) => t.description === 'business')!;
  const foreign = (await repo.list('katya'))[0]!;
  const config = {
    port: 0,
    mode: 'postgres' as const,
    release: 'test',
    passwords: {
      rodion: 'synthetic-rodion-password',
      katya: 'synthetic-katya-password',
    },
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${config.port}`;
  const request = (
    path: string,
    owner: 'rodion' | 'katya' = 'rodion',
    form?: Record<string, string>,
  ) =>
    fetch(base + path, {
      headers: {
        authorization:
          'Basic ' +
          Buffer.from(owner + ':' + config.passwords[owner]).toString('base64'),
        ...(form
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(form ? { method: 'POST', body: new URLSearchParams(form) } : {}),
    });
  try {
    for (const route of ['/api/settings', '/settings'])
      assert.equal((await request(route, 'katya')).status, 403);
    const rb = await (await request('/api/bootstrap')).json(),
      kb = await (await request('/api/bootstrap', 'katya')).json();
    assert.equal(rb.isAdmin, true);
    assert.equal(kb.isAdmin, false);
    assert.deepEqual(rb.reviewDefaults, kb.reviewDefaults);
    const form = {
      revision: '0',
      hideBusiness: 'false',
      hideInternalTransfers: 'false',
      hideRefunds: 'false',
    };
    assert.equal((await request('/api/settings', 'rodion', form)).status, 403);
    assert.equal(
      (await request('/api/settings', 'katya', { ...form, csrf: kb.csrf }))
        .status,
      403,
    );
    const initial = await (
      await request('/api/review?all=1&window=all')
    ).json();
    assert.deepEqual(
      new Set(
        initial.transactions.map((t: { description: string }) => t.description),
      ),
      new Set(['personal', 'bonds']),
    );
    const explicit = await (
      await request(
        '/api/review?all=1&window=all&includeBusiness=1&includeTransfers=1',
      )
    ).json();
    assert.equal(explicit.transactions.length, 4);
    const detail = await (
      await request('/api/review?detailOnly=1&id=' + business.id)
    ).json();
    assert.deepEqual(
      detail.transactions.map((t: { id: string }) => t.id),
      [business.id],
    );
    for (const display of ['UAH', 'EUR', 'USD', 'GBP']) {
      const result = await (
        await request(
          '/api/review?detailOnly=1&id=' + business.id + '&display=' + display,
        )
      ).json();
      assert.equal(result.reporting.currency, display);
      assert.deepEqual(
        result.reporting.rows.map((r: { id: string }) => r.id),
        [business.id],
      );
      if (display === 'EUR')
        assert.equal(result.reporting.rows[0].convertedAmountMinor, '-100');
    }
    assert.equal((await request('/api/review?display=INVALID')).status, 400);
    const denied = await (
      await request('/api/review?detailOnly=1&id=' + foreign.id)
    ).json();
    assert.equal(denied.transactions.length, 0);
    assert.equal(
      (await request('/api/settings', 'rodion', { ...form, csrf: rb.csrf }))
        .status,
      200,
    );
    assert.equal(
      (await request('/api/settings', 'rodion', { ...form, csrf: rb.csrf }))
        .status,
      409,
    );
    assert.equal(
      (await (await request('/api/review?all=1&window=all')).json())
        .transactions.length,
      4,
    );
    assert.equal(
      (
        await (
          await request(
            '/api/review?all=1&window=all&includeBusiness=0&includeTransfers=0',
          )
        ).json()
      ).transactions.length,
      2,
    );
    assert.equal((await repo.list('rodion')).length, 4);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});
