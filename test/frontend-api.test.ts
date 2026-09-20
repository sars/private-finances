import { credentialsHealthFromEnv } from '../src/credential-health.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web, type WebConfig } from '../src/web.js';
import { synthetic } from '../src/synthetic.js';
import { seedTestOwners, signInAs, TEST_OWNERS } from './sign-in.js';

test('frontend shell and JSON APIs preserve authentication, owner scope, CSRF and static containment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finances-frontend-test-'));
  const frontend = join(directory, 'frontend');
  await mkdir(join(frontend, 'assets'), { recursive: true });
  await writeFile(
    join(frontend, 'index.html'),
    '<html><body>Application shell</body></html>',
  );
  await writeFile(
    join(frontend, 'assets/app.js'),
    'export const ready = true;',
  );
  await writeFile(join(frontend, 'assets/app.css'), 'body { color: black; }');
  await writeFile(
    join(frontend, 'manifest.webmanifest'),
    '{"name":"Private Finances","start_url":"/"}',
  );
  await writeFile(
    join(frontend, 'assets/app-Abcd1234.js'),
    'export const version = 1;',
  );
  await writeFile(join(directory, 'outside.js'), 'PRIVATE_OUTSIDE_CONTENT');
  await symlink(
    join(directory, 'outside.js'),
    join(frontend, 'assets/escape.js'),
  );
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  // Two members' approvals, so /api/ops can be held to reporting both. The
  // consent stub below is owner-scoped on purpose; App health is not.
  for (const [owner, bank, expiresAt] of [
    ['rodion', 'Wise', '2026-12-20T09:00:00Z'],
    ['katya', 'Revolut', '2026-12-08T09:00:00Z'],
  ])
    await db.query(
      `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
       VALUES($1,$2,'LV',$3,now()+interval '15 minutes',$4,'authorized')`,
      [owner, bank, `hash-${owner}-${bank}`, expiresAt],
    );
  await repo.importBatch(
    synthetic.map((row) => ({
      ...row,
      sourceDetails: { sensitive: 'RAW_PAYLOAD_MUST_STAY_PRIVATE' },
    })),
  );
  const config: WebConfig = {
    mode: 'postgres',
    port: 0,
    release: 'frontend-test',
    frontendDirectory: frontend,
    credentialHealth: () =>
      credentialsHealthFromEnv(
        {
          OPENAI_API_KEY_EXPIRES_ON: '2026-12-10',
          IBKR_FLEX_TOKEN_EXPIRES_AT: '2027-08-19T18:14:23Z',
        },
        new Date('2026-12-05T12:00:00Z'),
      ),
    monobankJarsExcluded: true,
    consent: {
      list: async (actor) => [
        {
          bank: actor === 'rodion' ? 'Wise' : 'Revolut',
          country: 'LV',
          status: 'authorized',
          expiry: '2026-09-21',
        },
      ],
      start: async (actor, bank, country) => {
        assert.equal(actor, 'rodion');
        assert.equal(bank, 'Wise');
        assert.equal(country, 'LV');
        return 'https://auth.enablebanking.com/consent?code=synthetic';
      },
      finish: async () => {},
    },
  };
  const logs: Record<string, unknown>[] = [];
  const server = web(repo, config, (entry) => logs.push(entry));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  let cookie = '';
  const get = (path: string, as = cookie) =>
    fetch(base + path, { headers: { cookie: as } });
  try {
    // The shell and its assets are the sign-in screen, so they answer before
    // there is a session. Everything carrying household data waits for one.
    for (const path of ['/', '/assets/app.js']) {
      assert.equal((await fetch(base + path)).status, 200, path);
    }
    for (const path of [
      '/api/bootstrap',
      '/api/accounts',
      '/api/categories',
      '/api/review',
      '/api/reports',
      '/api/connections',
      '/api/history',
      '/api/fx',
      '/api/llm-budget',
    ]) {
      assert.equal((await fetch(base + path)).status, 401, path);
    }
    await seedTestOwners(db);
    // A wrong password is refused, and repeated guesses are slowed down.
    assert.equal(
      (
        await fetch(base + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            email: TEST_OWNERS[0]!.email,
            password: 'not the password',
          }).toString(),
        })
      ).status,
      401,
    );
    cookie = await signInAs(base, 'rodion');
    const bootstrapResponse = await get('/api/bootstrap');
    const bootstrap = await bootstrapResponse.json();
    assert.match(bootstrap.csrf, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      { ...bootstrap, csrf: 'token' },
      {
        actor: 'rodion',
        csrf: 'token',
        isAdmin: true,
        reviewDefaults: {
          hideNonPersonal: true,
          hideInternalTransfers: true,
          hideRefunds: true,
          hideZeroAmount: true,
        },
        mode: 'postgres',
        // The household's own names outside demo mode; the demo renames them.
        ownerNames: { rodion: 'Rodion', katya: 'Katya' },
        release: 'frontend-test',
        features: {
          ai: false,
          telegram: false,
          consent: true,
          monobankJarsExcluded: true,
        },
        banks: [
          { name: 'Wise', label: 'Wise', country: 'LV' },
          { name: 'Revolut', label: 'Revolut', country: 'LV' },
          { name: 'Swedbank', label: 'Swedbank', country: 'LV' },
          { name: 'LHV Pank', label: 'LHV', country: 'EE' },
        ],
      },
    );
    const katyaCookie = await signInAs(base, 'katya');
    const katyaBootstrap = await (
      await get('/api/bootstrap', katyaCookie)
    ).json();
    assert.equal(katyaBootstrap.actor, 'katya');
    assert.notEqual(katyaBootstrap.csrf, bootstrap.csrf);
    const row = (await repo.list('rodion'))[0]!;
    for (const path of [
      '/',
      '/accounts',
      '/reports',
      '/connections',
      '/review',
      '/categories',
      '/ops',
      '/fx',
      `/transactions/${row.id}/history`,
    ]) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.equal(
        await response.text(),
        '<html><body>Application shell</body></html>',
      );
      const csp = response.headers.get('content-security-policy')!;
      assert.ok(csp.includes("script-src 'self';"));
      assert.ok(csp.includes("style-src 'self' 'unsafe-inline';"));
      assert.ok(csp.includes("connect-src 'self';"));
      // default-src 'none' is the fallback for manifest-src too, so without
      // this directive the browser refuses the installable app's manifest.
      assert.ok(csp.includes("manifest-src 'self';"));
    }
    // The manifest is fetched by the browser itself, not by the bundle: it
    // needs its own route, its own type, and the credentials the link carries.
    const manifest = await get('/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(
      manifest.headers.get('content-type'),
      'application/manifest+json',
    );
    // The manifest is part of the shell, so it answers before a session too.
    assert.equal((await fetch(base + '/manifest.webmanifest')).status, 200);
    // The shell answers screen routes, never a literal /index.html; the worker
    // must not precache a path the server does not serve.
    assert.equal((await get('/index.html')).status, 404);
    const budgetResponse = await get('/api/llm-budget');
    assert.equal(budgetResponse.status, 200);
    const budget = await budgetResponse.json();
    assert.equal(Number(budget.budgetUsd), 10);
    assert.equal(Number(budget.safetyReserveUsd), 0.5);
    assert.equal(budget.timezone, 'Europe/Riga');
    assert.equal(budget.requestCount, 0);
    assert.equal(budget.state, 'healthy');
    assert.ok(
      !JSON.stringify(budget).includes('RAW_PAYLOAD_MUST_STAY_PRIVATE'),
    );
    const ops = await (await get('/api/ops')).json();
    assert.equal(ops.credentials[0].credential, 'openai_api_key');
    assert.equal(ops.credentials[0].state, 'expiring');
    assert.equal(ops.credentials[0].warningDays, 5);
    assert.equal(ops.credentials[0].expiresOn, '2026-12-10');
    // Every tracked credential is reported, each under the name operations
    // reads on the page.
    assert.equal(ops.credentials[1].credential, 'ibkr_flex_token');
    assert.equal(ops.credentials[1].label, 'IBKR Flex token');
    assert.equal(ops.credentials[1].state, 'healthy');
    assert.equal(ops.credentials[1].expiresAt, '2027-08-19T18:14:23.000Z');
    // Both members' approvals, soonest first. Rodion is signed in; Katya's
    // deadline is the household's deadline too, and no screen used to say so.
    assert.deepEqual(
      ops.bankConsents.map((c: { owner: string; bank: string }) => [
        c.owner,
        c.bank,
      ]),
      [
        ['katya', 'Revolut'],
        ['rodion', 'Wise'],
      ],
    );
    assert.equal(ops.bankConsents[0].expiresAt, '2026-12-08T09:00:00.000Z');
    assert.ok(
      !JSON.stringify(ops.bankConsents).includes('hash-'),
      'no state hash or session may leave with the expiry metadata',
    );
    const overview = await (await get('/api/overview?owner=katya')).json();
    assert.ok(
      overview.transactions.every(
        (entry: { owner: string }) => entry.owner === 'katya',
      ),
    );
    assert.deepEqual(
      overview.byCurrency,
      (await (await get('/api/summary?owner=katya')).json()).byCurrency,
    );
    const script = await get('/assets/app.js');
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('cache-control'), 'no-store');
    // The holding pages share the /assets/ prefix with the bundle: a page is
    // the shell, a hashed file with an extension is the file.
    for (const page of [
      '/assets/snapshots',
      '/assets/new',
      '/assets/12345678-1234-1234-1234-123456789012',
    ]) {
      const shell = await get(page);
      assert.equal(shell.status, 200, page);
      assert.match(shell.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await shell.text(), /Application shell/);
    }
    assert.equal((await get('/assets/missing-file.js')).status, 404);
    assert.equal(
      (await get('/assets/app-Abcd1234.js')).headers.get('cache-control'),
      'private, max-age=31536000, immutable',
    );
    assert.equal(
      (await get('/api/bootstrap')).headers.get('cache-control'),
      'no-store',
    );
    assert.equal(
      (await get('/review')).headers.get('cache-control'),
      'no-store',
    );
    assert.match(script.headers.get('content-type')!, /javascript/);
    assert.equal(await script.text(), 'export const ready = true;');
    assert.match(
      (await get('/assets/app.css')).headers.get('content-type')!,
      /text\/css/,
    );
    for (const path of [
      '/assets/escape.js',
      '/assets/%2e%2e%2foutside.js',
      '/assets/%5c..%5coutside.js',
      '/assets/no.js',
      '/assets/../outside.js',
      '/assets/app.js.map',
    ]) {
      const response = await get(path);
      assert.ok(response.status >= 400, path);
      assert.ok(!(await response.text()).includes('PRIVATE_OUTSIDE_CONTENT'));
    }
    const categories = await (await get('/api/categories')).json();
    // The household tree is seeded, so the shape is what matters here: a shared
    // set of nodes and tags, and rules that belong to the signed-in owner.
    assert.ok(
      categories.nodes.some((n: { slug: string }) => n.slug === 'food'),
    );
    assert.deepEqual(categories.rules, []);
    assert.deepEqual(categories.tags, []);
    assert.deepEqual(await (await get('/api/accounts')).json(), {
      accounts: [],
      suggestions: [],
      household: [],
    });
    assert.deepEqual(await (await get('/api/reports?owner=all')).json(), {
      reports: [],
    });
    assert.equal((await get('/api/reports?owner=invalid')).status, 400);
    const review = await (await get('/api/review')).json();
    assert.ok(review.transactions.length > 0);
    assert.ok(
      review.transactions.every(
        (transaction: { owner: string }) => transaction.owner === 'rodion',
      ),
    );
    assert.ok(
      !JSON.stringify(review).includes('RAW_PAYLOAD_MUST_STAY_PRIVATE'),
    );
    assert.ok(review.suggestions[row.id]);
    assert.deepEqual(review.tags[row.id], []);
    const history = await (await get(`/api/history?id=${row.id}`)).json();
    assert.ok(history.history.length > 0);
    assert.ok(
      !JSON.stringify(history).includes('RAW_PAYLOAD_MUST_STAY_PRIVATE'),
    );
    assert.equal((await get('/api/history?id=invalid')).status, 400);
    assert.equal(
      (await get('/api/history?id=00000000-0000-0000-0000-000000000000'))
        .status,
      404,
    );
    assert.equal(
      (await (await get('/api/connections')).json()).connections[0].bank,
      'Wise',
    );
    // Conversion status takes no display currency: it answers for every
    // reporting currency at once, so a failure cannot hide behind the one
    // being viewed.
    const fx = await (await get('/api/fx')).json();
    assert.deepEqual(
      fx.conversions.currencies
        .map((c: { currency: string }) => c.currency)
        .sort(),
      ['EUR', 'UAH', 'USD'],
    );
    // Sterling is not among them: it is no longer a currency a total is
    // reported in, and asking for it is refused rather than quietly honoured.
    assert.equal((await get('/api/review?display=GBP')).status, 400);
    const post = (path: string, fields: Record<string, string>, as = cookie) =>
      fetch(base + path, {
        method: 'POST',
        headers: { cookie: as, accept: 'application/json' },
        body: new URLSearchParams(fields),
        redirect: 'manual',
      });
    assert.equal((await post('/categories', { name: 'Bakery' })).status, 403);
    assert.equal(
      (
        await post(
          '/categories',
          { csrf: bootstrap.csrf, name: 'Bakery' },
          katyaCookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post('/categories', {
          csrf: bootstrap.csrf,
          name: 'Bakery',
        })
      ).status,
      303,
    );
    assert.ok(
      (await (await get('/api/categories')).json()).nodes.some(
        (n: { name: string }) => n.name === 'Bakery',
      ),
    );
    assert.deepEqual(
      (await (await get('/api/categories', katyaCookie)).json()).rules,
      [],
    );
    const ruleFields = {
      csrf: bootstrap.csrf,
      matcherValue: 'Synthetic merchant',
      kind: 'non_personal',
      confirmed: 'yes',
      reason: 'Explicit synthetic rule',
    };
    assert.equal(
      (await post('/rules', { ...ruleFields, matcherField: 'counterparty' }))
        .status,
      303,
    );
    assert.equal(
      (await post('/rules', { ...ruleFields, matcherField: 'invalid' })).status,
      400,
    );
    const rules = (await (await get('/api/categories')).json()).rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].matcher.field, 'counterparty');
    assert.equal(rules[0].matcher.value, 'Synthetic merchant');
    assert.deepEqual(
      (await (await get('/api/categories', katyaCookie)).json()).rules,
      [],
    );
    const redirect = await post('/connections/enablebanking/start', {
      csrf: bootstrap.csrf,
      bank: 'Wise',
      country: 'lv',
    });
    assert.equal(redirect.status, 200);
    assert.deepEqual(await redirect.json(), {
      redirect: 'https://auth.enablebanking.com/consent?code=synthetic',
    });
    assert.ok(!JSON.stringify(logs).includes('RAW_PAYLOAD_MUST_STAY_PRIVATE'));
    assert.ok(!JSON.stringify(logs).includes(bootstrap.csrf));
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
