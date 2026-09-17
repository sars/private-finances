import { request } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web, type WebConfig } from '../src/web.js';
import { synthetic } from '../src/synthetic.js';
import type { AddressInfo } from 'node:net';

test('HTTP flow: CSRF, duplicate import, classification, escaping, exact summary and safe logs', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const logs: Record<string, unknown>[] = [];
  const config: WebConfig = { port: 0, mode: 'demo', release: 'test' };
  const server = web(repo, config, (event) => logs.push(event));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  try {
    assert.equal((await fetch(base + '/health/live')).status, 200);
    const html = await (await fetch(base)).text();
    const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)![1]!;
    const post = (path: string, fields: Record<string, string>) =>
      fetch(base + path, {
        method: 'POST',
        body: new URLSearchParams(fields),
        redirect: 'manual',
      });
    assert.equal((await post('/accounts', {})).status, 403);
    assert.equal(
      (
        await post('/accounts', {
          csrf,
          source: 'manual',
          accountId: 'broker-test',
          label: '<script>Broker</script>',
          purpose: 'investment',
        })
      ).status,
      303,
    );
    assert.equal(
      (await post('/categories', { csrf, name: 'Bakery' })).status,
      303,
    );
    const categoryId = String(
      (await db.query("SELECT id FROM category_tree WHERE name='Bakery'"))
        .rows[0]!.id,
    );
    assert.equal(
      (
        await post('/rules', {
          csrf,
          description: 'Shop',
          kind: 'personal_expense',
          categoryId,
          reason: 'Confirmed',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post('/rules', {
          csrf,
          description: 'Shop',
          kind: 'personal_expense',
          categoryId,
          reason: 'Confirmed',
          confirmed: 'yes',
        })
      ).status,
      303,
    );
    assert.equal((await fetch(base + '/review')).status, 200);
    assert.equal((await fetch(base + '/fx')).status, 200);
    const accountPage = await (await fetch(base + '/accounts')).text();
    assert.ok(accountPage.includes('&lt;script&gt;Broker&lt;/script&gt;'));
    assert.equal((await post('/reports', {})).status, 403);
    for (let n = 0; n < 2; n++)
      assert.equal(
        (await post('/reports', { csrf, owner: 'all', period: 'week' })).status,
        303,
      );
    assert.equal(
      (await db.query('SELECT id FROM report_snapshots')).rows.length,
      1,
    );
    assert.ok(
      (await (await fetch(base + '/reports?owner=all')).text()).includes(
        'version 1',
      ),
    );
    assert.equal((await post('/import', {})).status, 403);
    assert.equal((await post('/import', { csrf })).status, 303);
    await repo.work(synthetic);
    await repo.importBatch([
      { ...synthetic[0], description: '<script>secret description</script>' },
    ]);
    const row = (await repo.list()).find((t) => t.sourceId === 'demo-1')!;
    const decision = {
      csrf,
      id: row.id,
      revision: String(row.revision),
      owner: 'rodion',
      kind: 'personal_expense',
      category: 'Food / Groceries',
      reason: 'private explanation',
    };
    assert.equal((await post('/classify', decision)).status, 303);
    assert.equal((await post('/classify', decision)).status, 409);
    // One confirmed decision may become a rule for later payments the bank
    // describes the same way, without the owner retyping the match text.
    const transfer = (await repo.list('rodion')).find(
      (t) => t.description === 'Transfer to Katya — example',
    )!;
    assert.equal(
      (
        await post('/classify', {
          csrf,
          id: transfer.id,
          revision: String(transfer.revision),
          owner: 'rodion',
          kind: 'internal_transfer',
          reason: 'The recipient account belongs to us',
          futureRule: 'yes',
        })
      ).status,
      303,
    );
    assert.deepEqual(
      (
        await db.query(
          `SELECT kind,active FROM classification_rules
          WHERE owner='rodion' AND match_field='description' AND match_value=$1`,
          [transfer.description],
        )
      ).rows,
      [{ kind: 'internal_transfer', active: true }],
    );
    const summary = await (
      await fetch(base + '/api/summary?owner=rodion')
    ).json();
    assert.equal(
      summary.byCurrency.find((c: { currency: string }) => c.currency === 'UAH')
        .personalExpenseMinor,
      '128050',
    );
    const rendered = await (await fetch(base)).text();
    assert.ok(
      rendered.includes('&lt;script&gt;secret description&lt;/script&gt;'),
    );
    assert.ok(!rendered.includes('<script>secret description'));
    const history = await (
      await fetch(`${base}/transactions/${row.id}/history`)
    ).text();
    assert.ok(history.includes('private explanation'));
    assert.ok(history.includes('source corrected'));
    assert.ok(history.includes('&lt;script&gt;secret description'));
    assert.ok(!history.includes('<script>secret description'));
    assert.ok(!JSON.stringify(logs).includes('private explanation'));
    assert.ok(!JSON.stringify(logs).includes('secret description'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});

test('PostgreSQL mode requires credentials and enforces owner writes', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(synthetic);
  assert.throws(
    () => web(repo, { port: 3300, mode: 'postgres', release: 'test' }),
    /passwords/,
  );
  let starts = 0;
  let finishes = 0;
  const config: WebConfig = {
    consent: {
      start: async (owner, bank, country) => {
        assert.equal(owner, 'rodion');
        assert.equal(bank, 'Wise');
        assert.equal(country, 'LV');
        starts++;
        return 'https://tilisy.enablebanking.com/ais/start?auth=synthetic';
      },
      finish: async (owner, state, code) => {
        assert.equal(owner, 'rodion');
        assert.equal(state, 'test-state');
        assert.equal(code, 'test-code');
        finishes++;
      },
      list: async () => [],
    },
    port: 0,
    mode: 'postgres',
    publicOrigin: 'https://finances.example.test:8443',
    release: 'test',
    passwords: {
      rodion: 'synthetic-rodion-password',
      katya: 'synthetic-katya-password',
    },
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  const authorization =
    'Basic ' +
    Buffer.from('rodion:synthetic-rodion-password').toString('base64');
  try {
    assert.equal((await fetch(base + '/api/transactions')).status, 401);
    const withHost = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          base,
          { headers: { host, authorization } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on('error', reject);
        req.end();
      });
    assert.equal(await withHost('attacker.example'), 403);
    assert.equal(await withHost('finances.example.test:8443'), 200);

    const html = await (
      await fetch(base, { headers: { authorization } })
    ).text();
    const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)![1]!;
    assert.equal(html.includes('Import example transactions'), false);
    const demoImport = await fetch(`${base}/import`, {
      method: 'POST',
      headers: {
        authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    assert.equal(demoImport.status, 403);
    const startConsent = (token: string) =>
      fetch(base + '/connections/enablebanking/start', {
        method: 'POST',
        headers: { authorization },
        body: new URLSearchParams({ csrf: token, bank: 'Wise', country: 'lv' }),
      });
    assert.equal((await startConsent('invalid')).status, 403);
    assert.equal(starts, 0);
    const consentPage = await startConsent(csrf);
    assert.equal(consentPage.status, 200);
    assert.equal(consentPage.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(
      (await consentPage.text()).includes(
        'https://tilisy.enablebanking.com/ais/start?auth=synthetic',
      ),
    );
    assert.equal(starts, 1);
    const callback = await fetch(
      base +
        '/connections/enablebanking/callback?state=test-state&code=test-code',
      { headers: { authorization }, redirect: 'manual' },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/connections');
    assert.equal(finishes, 1);

    const katya = (await repo.list('katya'))[0]!;
    // Either member may decide the other's payment. It stays on katya's
    // account and the audit event names rodion as the member who decided.
    const response = await fetch(base + '/classify', {
      method: 'POST',
      headers: { authorization },
      redirect: 'manual',
      body: new URLSearchParams({
        csrf,
        id: katya.id,
        revision: '0',
        owner: 'katya',
        kind: 'non_personal',
        reason: 'Decided for the household',
      }),
    });
    assert.equal(response.status, 303);
    const decided = (await repo.list('katya'))[0]!;
    assert.equal(decided.revision, 1);
    assert.equal(decided.owner, 'katya');
    assert.equal(decided.kind, 'non_personal');
    assert.deepEqual(
      (
        await db.query(
          "SELECT actor FROM audit_events WHERE transaction_id=$1 AND event='classified'",
          [katya.id],
        )
      ).rows,
      [{ actor: 'rodion' }],
    );
    const katyaAuth =
      'Basic ' +
      Buffer.from('katya:synthetic-katya-password').toString('base64');
    const forgedCsrf = await fetch(base + '/classify', {
      method: 'POST',
      headers: { authorization: katyaAuth },
      body: new URLSearchParams({
        csrf,
        id: katya.id,
        revision: '1',
        kind: 'non_personal',
        reason: 'Other owner token',
      }),
    });
    assert.equal(forgedCsrf.status, 403);
    const katyaHtml = await (
      await fetch(base, { headers: { authorization: katyaAuth } })
    ).text();
    const katyaCsrf = /name="csrf" value="([a-f0-9]+)"/.exec(katyaHtml)![1]!;
    assert.notEqual(katyaCsrf, csrf);
    const allowed = await fetch(base + '/classify', {
      method: 'POST',
      headers: { authorization: katyaAuth },
      redirect: 'manual',
      body: new URLSearchParams({
        csrf: katyaCsrf,
        id: katya.id,
        revision: '1',
        kind: 'non_personal',
        reason: 'Own confirmed decision',
      }),
    });
    assert.equal(allowed.status, 303);
    assert.equal((await repo.list('katya'))[0]?.revision, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
