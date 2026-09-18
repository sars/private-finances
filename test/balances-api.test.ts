import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web, type WebConfig } from '../src/web.js';
import { AccountBalances } from '../src/account-balances.js';
import { FxRates } from '../src/fx-rates.js';
import { seedTestOwners, signInAs } from './sign-in.js';

test('balances report the household, arrive in each person’s own order and refuse a stale arrangement', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await db.query(
    `INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES
     ('monobank','a','rodion','Black','personal'),
     ('monobank','b','rodion','White','personal'),
     ('monobank','k','katya','Her card','personal')`,
  );
  const service = new AccountBalances(db);
  await service.record({ source: 'monobank', accountId: 'a' }, [
    { currency: 'UAH', amountMinor: '150000' },
  ]);
  await service.record({ source: 'monobank', accountId: 'k' }, [
    { currency: 'UAH', amountMinor: '25000' },
  ]);
  const config: WebConfig = {
    mode: 'postgres',
    port: 0,
    release: 'balances-test',
    monobankJarsExcluded: true,
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  // The server checks the Host it is reached on, so it has to know its port.
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  const cookies: Record<'rodion' | 'katya', string> = {
    rodion: '',
    katya: '',
  };
  const get = (path: string, who: 'rodion' | 'katya' = 'rodion') =>
    fetch(base + path, { headers: { cookie: cookies[who] } });
  try {
    // Financial data, so it is behind the same sign-in as everything else.
    assert.equal((await fetch(base + '/api/balances')).status, 401);
    await seedTestOwners(db);
    cookies.rodion = await signInAs(base, 'rodion');
    cookies.katya = await signInAs(base, 'katya');

    const first = await (await get('/api/balances?display=UAH')).json();
    // The household, both members, as the overview already reports it.
    assert.deepEqual(
      first.accounts.map((a: { accountId: string }) => a.accountId),
      ['k', 'a', 'b'],
    );
    assert.equal(first.layout.revision, 0);
    // Neither of these cards has an agreed overdraft, so own money and the
    // stated figures are the same total.
    assert.equal(first.reporting.totalMinor, '175000');
    assert.deepEqual(first.reporting.coverage, { converted: 2, missing: 0 });
    // An account whose bank has not reported is still part of the answer.
    assert.deepEqual(
      first.accounts.find((a: { accountId: string }) => a.accountId === 'b')
        .balances,
      [],
    );

    const csrf = (await (await get('/api/bootstrap')).json()).csrf;
    const save = (
      ordering: string[],
      revision: number,
      who: 'rodion' | 'katya' = 'rodion',
      token = csrf,
    ) =>
      fetch(base + '/api/ui-layout', {
        method: 'POST',
        headers: { cookie: cookies[who] },
        body: new URLSearchParams({
          csrf: token,
          key: 'balances',
          revision: String(revision),
          ordering: JSON.stringify(ordering),
        }),
      });

    assert.equal(
      (await save(['monobank:a'], 0, 'rodion', 'wrong')).status,
      403,
    );
    const saved = await save(['monobank:b', 'monobank:a', 'monobank:k'], 0);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).layout.revision, 1);
    // A second tab still holding revision 0 is told to look again.
    assert.equal(
      (await save(['monobank:a', 'monobank:b', 'monobank:k'], 0)).status,
      409,
    );

    const arranged = await (await get('/api/balances')).json();
    assert.deepEqual(
      arranged.accounts.map((a: { accountId: string }) => a.accountId),
      ['b', 'a', 'k'],
    );
    // Without a display currency there is nothing to convert and no total.
    assert.equal(arranged.reporting, undefined);
    // Katya sees the same household and her own, untouched, arrangement.
    const hers = await (await get('/api/balances', 'katya')).json();
    assert.equal(hers.accounts.length, 3);
    assert.deepEqual(hers.layout, { ordering: [], revision: 0 });

    assert.equal(
      (
        await fetch(base + '/api/ui-layout', {
          method: 'POST',
          headers: { cookie: cookies.rodion },
          body: new URLSearchParams({
            csrf,
            key: 'NOT A KEY',
            revision: '1',
            ordering: '[]',
          }),
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
  }
});

test('the reported total is the household’s own money, with the agreed overdrafts taken out', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await db.query(
    `INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES
     ('monobank','a','rodion','Card','personal'),
     ('monobank','d','rodion','Dollars','personal')`,
  );
  await new FxRates(db).insert({
    source: 'test',
    base: 'USD',
    target: 'UAH',
    rate: '41.5',
    asOf: '2026-09-15',
    retrievedAt: '2026-09-15T12:00:00.000Z',
    version: 1,
    provenance: 'synthetic test rate',
  });
  const observedAt = new Date('2026-09-15T09:00:00.000Z');
  const service = new AccountBalances(db);
  // The bank states the limit inside the balance it reports.
  await service.record(
    { source: 'monobank', accountId: 'a' },
    [{ currency: 'UAH', amountMinor: '5300000', creditLimitMinor: '2000000' }],
    observedAt,
  );
  await service.record(
    { source: 'monobank', accountId: 'd' },
    [{ currency: 'USD', amountMinor: '10000', creditLimitMinor: '4000' }],
    observedAt,
  );
  const config: WebConfig = {
    mode: 'postgres',
    port: 0,
    release: 'balances-test',
    monobankJarsExcluded: true,
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  try {
    await seedTestOwners(db);
    const cookie = await signInAs(base, 'rodion');
    const report = await (
      await fetch(base + '/api/balances?display=UAH', { headers: { cookie } })
    ).json();
    const row = (accountId: string) =>
      report.reporting.rows.find(
        (r: { accountId: string }) => r.accountId === accountId,
      );
    // 53,000 stated less the 20,000 limit, in the display currency itself.
    assert.equal(row('a').convertedMinor, '3300000');
    assert.equal(row('a').rateDate, null);
    // 100.00 stated less a 40.00 limit, converted at that day's rate.
    assert.equal(row('d').convertedMinor, '249000');
    assert.equal(row('d').rateDate, '2026-09-15');
    assert.equal(report.reporting.totalMinor, '3549000');
    assert.deepEqual(report.reporting.coverage, { converted: 2, missing: 0 });
    // The stated figure and the limit still travel with each account, so the
    // screen can show what the bank said beside what the household owns.
    const account = report.accounts.find(
      (a: { accountId: string }) => a.accountId === 'a',
    );
    assert.equal(account.balances[0].amountMinor, '5300000');
    assert.equal(account.balances[0].creditLimitMinor, '2000000');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
  }
});
