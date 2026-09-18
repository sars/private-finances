import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web, type WebConfig } from '../src/web.js';
import { FxRates } from '../src/fx-rates.js';
import { AccountBalances } from '../src/account-balances.js';
import { Accounts } from '../src/accounts.js';
import { seedTestOwners, signInAs } from './sign-in.js';

test('holdings HTTP routes are shared by the household, need CSRF, and value in the display currency', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await new FxRates(db).insert({
    source: 'synthetic-bank',
    base: 'USD',
    target: 'UAH',
    rate: '41',
    asOf: '2026-09-24',
    retrievedAt: '2026-09-24T05:00:00Z',
    version: 1,
    provenance: 'synthetic',
  });
  const config: WebConfig = {
    port: 0,
    mode: 'postgres',
    release: 'test',
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  const cookies: Record<string, string> = { rodion: '', katya: '' };
  const get = (path: string, owner = 'rodion') =>
    fetch(base + path, { headers: { cookie: cookies[owner]! } });
  const post = (
    path: string,
    fields: Record<string, string>,
    owner = 'rodion',
  ) =>
    fetch(base + path, {
      method: 'POST',
      headers: { cookie: cookies[owner]! },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
  try {
    assert.equal((await fetch(`${base}/api/holdings`)).status, 401);
    await seedTestOwners(db);
    cookies.rodion = await signInAs(base, 'rodion');
    cookies.katya = await signInAs(base, 'katya');
    const csrf = (await (await get('/api/bootstrap')).json()).csrf;
    const kateCsrf = (await (await get('/api/bootstrap', 'katya')).json()).csrf;
    const fields = {
      name: 'Shoebox EUR',
      kind: 'cash',
      denomination: 'EUR',
      invested: 'false',
      liquid: 'true',
    };
    assert.equal((await post('/api/holdings', fields)).status, 403);
    assert.equal(
      (await post('/api/holdings', { ...fields, csrf, kind: 'yacht' })).status,
      400,
    );
    const created = await post('/api/holdings', { ...fields, csrf });
    assert.equal(created.status, 200);
    const { holding } = await created.json();
    assert.equal(holding.name, 'Shoebox EUR');
    // The other member may change it, and a stale revision is refused.
    assert.equal(
      (
        await post(
          '/api/holdings',
          { ...fields, csrf: kateCsrf, id: holding.id, revision: '7' },
          'katya',
        )
      ).status,
      409,
    );
    const renamed = await post(
      '/api/holdings',
      {
        ...fields,
        csrf: kateCsrf,
        id: holding.id,
        revision: '0',
        name: 'Shoebox EUR (home)',
        denomination: 'USD',
        group: 'Cash',
      },
      'katya',
    );
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).holding.revision, 1);
    assert.equal(
      (
        await post('/api/holding-snapshots', {
          csrf,
          holdingId: holding.id,
          asOf: '2026-09-24',
          amount: 'lots',
        })
      ).status,
      400,
    );
    const recorded = await post(
      '/api/holding-snapshots',
      {
        csrf: kateCsrf,
        holdingId: holding.id,
        asOf: '2026-09-24',
        amount: '4100',
        currency: 'UAH',
        note: 'Counted together',
      },
      'katya',
    );
    assert.equal(recorded.status, 200);
    const { snapshot } = await recorded.json();
    assert.equal(snapshot.quantity, '100');
    assert.equal(snapshot.enteredCurrency, 'UAH');
    assert.equal(snapshot.enteredBy, 'katya');
    assert.equal(
      (
        await post('/api/asset-prices', {
          csrf,
          symbol: 'USD',
          asOf: '2026-09-24',
          usdPerUnit: '1',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post('/api/asset-prices', {
          csrf,
          symbol: 'VWRL',
          asOf: '2026-09-24',
          usdPerUnit: '120.5',
        })
      ).status,
      200,
    );
    const report = await (
      await get('/api/holdings?display=UAH', 'katya')
    ).json();
    assert.equal(report.display, 'UAH');
    assert.equal(report.at, '2026-09-24');
    assert.deepEqual(report.dates, ['2026-09-24']);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].valueMinor, '410000');
    assert.equal(report.rows[0].holding.name, 'Shoebox EUR (home)');
    assert.equal(report.totals.totalMinor, '410000');
    assert.equal(report.previous, null);
    const inUsd = await (await get('/api/holdings')).json();
    assert.equal(inUsd.display, 'USD');
    assert.equal(inUsd.totals.totalMinor, '10000');
    assert.equal((await get('/api/holdings?display=XYZ')).status, 400);
    assert.equal((await get('/api/holdings?at=soon')).status, 400);
    const carried = await (await get('/api/holdings?at=2026-09-25')).json();
    assert.equal(carried.rows[0].carried, true);
    assert.equal(carried.series.length, 2);
    // The accounts a bank holding may link to travel with the report, and a
    // linked holding is filled from the stored balance on demand.
    assert.deepEqual(carried.accounts, []);
    await new Accounts(db).discover({
      source: 'synthetic',
      accountId: 'main',
      owner: 'rodion',
      label: 'Main account',
    });
    await new AccountBalances(db).record(
      { source: 'synthetic', accountId: 'main' },
      [{ currency: 'USD', amountMinor: '250000' }],
    );
    const withAccounts = await (await get('/api/holdings')).json();
    assert.equal(withAccounts.accounts.length, 1);
    assert.deepEqual(withAccounts.accounts[0].currencies, ['USD']);
    assert.equal(
      (
        await post('/api/holdings', {
          ...fields,
          csrf,
          id: holding.id,
          revision: '1',
          denomination: 'USD',
          feed: 'bank',
          feedRef: 'synthetic|main',
        })
      ).status,
      200,
    );
    assert.equal(
      (await post('/api/holdings/fill', { csrf, asOf: 'today' })).status,
      400,
    );
    const today = new Date().toISOString().slice(0, 10);
    const filled = await post(
      '/api/holdings/fill',
      { csrf: kateCsrf, asOf: today },
      'katya',
    );
    assert.equal(filled.status, 200);
    assert.equal((await filled.json()).fill.filled, 1);
    const latest = await (await get(`/api/holdings?at=${today}`)).json();
    assert.equal(latest.rows[0].quantity, '2500');
    assert.equal(latest.rows[0].source, 'bank');
    assert.equal(latest.rows[0].holding.feed, 'bank');
  } finally {
    server.close();
    await db.close();
  }
});

test('a snapshot day is deleted whole, by either member, and the day before is carried afterwards', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const config: WebConfig = { port: 0, mode: 'postgres', release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  const cookies: Record<string, string> = { rodion: '', katya: '' };
  const get = (path: string, owner = 'rodion') =>
    fetch(base + path, { headers: { cookie: cookies[owner]! } });
  const post = (
    path: string,
    fields: Record<string, string>,
    owner = 'rodion',
  ) =>
    fetch(base + path, {
      method: 'POST',
      headers: { cookie: cookies[owner]! },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
  try {
    await seedTestOwners(db);
    cookies.rodion = await signInAs(base, 'rodion');
    cookies.katya = await signInAs(base, 'katya');
    const csrf = (await (await get('/api/bootstrap')).json()).csrf;
    const kateCsrf = (await (await get('/api/bootstrap', 'katya')).json()).csrf;
    const { holding } = await (
      await post('/api/holdings', {
        csrf,
        name: 'Jar USD',
        kind: 'cash',
        denomination: 'USD',
        invested: 'false',
        liquid: 'true',
      })
    ).json();
    const record = (asOf: string, amount: string) =>
      post('/api/holding-snapshots', {
        csrf,
        holdingId: holding.id,
        asOf,
        amount,
      });
    assert.equal((await record('2026-08-27', '1000')).status, 200);
    assert.equal((await record('2026-09-24', '1200')).status, 200);
    // A correction on the day that is about to go: a second version of it.
    assert.equal((await record('2026-09-24', '1300')).status, 200);
    assert.equal(
      (await post('/api/holding-snapshots/delete', { asOf: '2026-09-24' }))
        .status,
      403,
    );
    assert.equal(
      (
        await post('/api/holding-snapshots/delete', {
          csrf,
          asOf: 'the other day',
        })
      ).status,
      400,
    );
    // Either member: the snapshots are the household's, not one member's.
    const deleted = await post(
      '/api/holding-snapshots/delete',
      { csrf: kateCsrf, asOf: '2026-09-24' },
      'katya',
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { removed: 2 });
    const without = await (await get('/api/holdings?at=2026-09-24')).json();
    assert.deepEqual(without.dates, ['2026-08-27']);
    // The figure from before the deleted day, carried, is what is left.
    assert.equal(without.rows[0].quantity, '1000');
    assert.equal(without.rows[0].carried, true);
    // Deleting it again is not an error; there is simply nothing there.
    assert.deepEqual(
      await (
        await post('/api/holding-snapshots/delete', {
          csrf,
          asOf: '2026-09-24',
        })
      ).json(),
      { removed: 0 },
    );
  } finally {
    server.close();
    await db.close();
  }
});
