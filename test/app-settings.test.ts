import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import {
  hiddenByReviewPreferences,
  readAppSettings,
  updateAppSettings,
} from '../src/app-settings.js';
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
      hideNonPersonal: true,
      hideInternalTransfers: true,
      hideRefunds: true,
      hideZeroAmount: true,
    });
    assert.deepEqual(await repo.list('rodion'), beforeLedger);
    const value = {
      hideNonPersonal: false,
      hideInternalTransfers: true,
      hideRefunds: false,
      hideZeroAmount: false,
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
      ['personal', 'business', 'transfer', 'bonds', 'nothing'].map((type) => ({
        source: 'synthetic',
        sourceId: owner + type,
        accountId: type === 'nothing' ? 'personal' : type,
        owner,
        bookedAt: '2026-09-12T10:00:00Z',
        currency: 'EUR',
        amountMinor: type === 'nothing' ? '0' : '-100',
        description: type,
      })),
    ),
  );
  await db.query(
    "UPDATE transactions SET kind='internal_transfer' WHERE description='transfer'",
  );
  // The account a payment sits on no longer hides it; its own kind does. The
  // business account also carries an ordinary personal payment, which stays
  // visible, and the investment is a kind of its own.
  await db.query(
    "UPDATE transactions SET kind='non_personal' WHERE description='business'",
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
      hideNonPersonal: 'false',
      hideInternalTransfers: 'false',
      hideRefunds: 'false',
      hideZeroAmount: 'false',
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
    const withoutZeroes = await (
      await request(
        '/api/review?all=1&window=all&includeNonPersonal=1&includeTransfers=1',
      )
    ).json();
    assert.deepEqual(
      new Set(
        withoutZeroes.transactions.map(
          (t: { description: string }) => t.description,
        ),
      ),
      new Set(['personal', 'business', 'transfer', 'bonds']),
    );
    const explicit = await (
      await request(
        '/api/review?all=1&window=all&includeNonPersonal=1&includeTransfers=1&includeZeroAmount=1',
      )
    ).json();
    assert.equal(explicit.transactions.length, 5);
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
    // Either member may open the other's payment; it is read under its own
    // owner and stays on their account.
    const other = await (
      await request('/api/review?detailOnly=1&id=' + foreign.id)
    ).json();
    assert.deepEqual(
      other.transactions.map((t: { id: string; owner: string }) => [
        t.id,
        t.owner,
      ]),
      [[foreign.id, 'katya']],
    );
    const missing = await (
      await request(
        '/api/review?detailOnly=1&id=00000000-0000-4000-8000-000000000000',
      )
    ).json();
    assert.equal(missing.transactions.length, 0);
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
      5,
    );
    assert.equal(
      (
        await (
          await request(
            '/api/review?all=1&window=all&includeNonPersonal=0&includeTransfers=0&includeZeroAmount=0',
          )
        ).json()
      ).transactions.length,
      2,
    );
    assert.equal((await repo.list('rodion')).length, 5);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});

test('a database saved before version 38 keeps its choice and gains the zero-amount default', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    // Rebuild the shape a database had before this change: one column named for
    // the account a payment sat on, and no zero-amount column at all.
    await db.query('ALTER TABLE app_settings DROP COLUMN hide_zero_amount');
    await db.query(
      'ALTER TABLE app_settings RENAME COLUMN hide_non_personal TO hide_business',
    );
    await db.query('UPDATE app_settings SET hide_business=false');
    await db.query('DELETE FROM schema_versions WHERE version=38');
    await migrate(db);
    await migrate(db);
    assert.deepEqual(await readAppSettings(db), {
      revision: 0,
      hideNonPersonal: false,
      hideInternalTransfers: true,
      hideRefunds: true,
      hideZeroAmount: true,
    });
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name='app_settings' AND column_name='hide_business'",
        )
      ).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});

test('hiding follows what a payment is, not the account it sits on, and zero is what it finally came to', async () => {
  const preferences = {
    hideNonPersonal: true,
    hideInternalTransfers: true,
    hideRefunds: true,
    hideZeroAmount: true,
  };
  const transaction = (over: Record<string, unknown>) =>
    ({
      id: 'x',
      kind: 'personal_expense',
      amountMinor: '-100',
      currency: 'EUR',
      ...over,
    }) as unknown as Parameters<typeof hiddenByReviewPreferences>[0];
  const onBusinessAccount = {
    spendingPolicy: { accountPurpose: 'business' },
  };
  assert.equal(
    hiddenByReviewPreferences(transaction(onBusinessAccount), preferences),
    false,
  );
  assert.equal(
    hiddenByReviewPreferences(
      transaction({ kind: 'non_personal' }),
      preferences,
    ),
    true,
  );
  assert.equal(
    hiddenByReviewPreferences(transaction({ kind: 'non_personal' }), {
      ...preferences,
      hideNonPersonal: false,
    }),
    false,
  );
  assert.equal(
    hiddenByReviewPreferences(transaction({ kind: 'investment' }), preferences),
    false,
  );
  // A purchase reduced to nothing is hidden by its net, not by its bank amount,
  // and one that only came back in part is still money the household spent.
  assert.equal(
    hiddenByReviewPreferences(
      transaction({ refund: { netMinor: '0', reductions: [] } }),
      preferences,
    ),
    true,
  );
  assert.equal(
    hiddenByReviewPreferences(
      transaction({ refund: { netMinor: '-40', reductions: [] } }),
      preferences,
    ),
    false,
  );
  assert.equal(
    hiddenByReviewPreferences(
      transaction({ refund: { netMinor: '0', reductions: [] } }),
      { ...preferences, hideZeroAmount: false },
    ),
    false,
  );
  assert.equal(
    hiddenByReviewPreferences(transaction({ amountMinor: '0' }), preferences),
    true,
  );
  // A reduction that disagrees with a later correction needs a person, so the
  // purchase stays listed even though the stored reduction cancels it out.
  assert.equal(
    hiddenByReviewPreferences(
      transaction({
        refund: {
          netMinor: '0',
          reductions: [{ discrepancy: '-1' }],
        },
      }),
      preferences,
    ),
    false,
  );
});
