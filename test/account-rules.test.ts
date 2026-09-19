import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Accounts } from '../src/accounts.js';
import { Repository } from '../src/repository.js';
import { convertedSpending } from '../src/analytics.js';
import { seedTestOwners, signInAs } from './sign-in.js';

test('account rules expose exact impact and reject stale edits with audited reasons', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const accounts = new Accounts(db);
  const repo = new Repository(db);
  try {
    await accounts.discover({
      source: 'synthetic',
      accountId: 'white',
      owner: 'rodion',
      label: 'Business card',
    });
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'large',
        accountId: 'white',
        owner: 'rodion',
        currency: 'UAH',
        amountMinor: '-9007199254740993',
        bookedAt: '2026-08-01T00:00:00Z',
        description: 'Synthetic merchant',
      },
    ]);
    const row = (await repo.list('rodion'))[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Synthetic prior decision',
      },
      'rodion',
    );
    const account = (await accounts.list('rodion'))[0]!;
    const impact = (await accounts.withImpact('rodion'))[0]!.impact;
    assert.deepEqual(impact, {
      transactionCount: 1,
      personalExpenseCount: 1,
      byCurrency: [
        { currency: 'UAH', personalExpenseMinor: '9007199254740993' },
      ],
    });
    const changed = await accounts.upsert(
      {
        ...account,
        purpose: 'business',
        expectedRevision: 0,
        reason: 'This whole account is for business',
      },
      'rodion',
    );
    assert.equal(changed.revision, 1);
    await assert.rejects(
      accounts.upsert(
        {
          ...account,
          purpose: 'personal',
          expectedRevision: 0,
          reason: 'Stale browser',
        },
        'rodion',
      ),
      /stale_account_revision/,
    );
    await assert.rejects(
      accounts.upsert(
        {
          ...account,
          owner: 'katya',
          purpose: 'personal',
          expectedRevision: 1,
        },
        'katya',
      ),
      /not_found/,
    );
    const audit = (
      await db.query('SELECT reason,after_value FROM account_audit_events')
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.reason, 'This whole account is for business');
    const bank = (
      await db.query(
        'SELECT amount_minor::text,kind,revision FROM transactions',
      )
    ).rows[0]!;
    assert.equal(bank.amount_minor, '-9007199254740993');
    assert.equal(bank.kind, 'personal_expense');
    assert.equal(bank.revision, 1);
  } finally {
    await db.close();
  }
});

test('account HTTP edits change effective totals reversibly and preserve revision/CSRF guards', async () => {
  const { web } = await import('../src/web.js');
  const { buildReport, previousReportPeriod } =
    await import('../src/reports.js');
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const accounts = new Accounts(db);
  await accounts.discover({
    source: 'synthetic',
    accountId: 'card',
    owner: 'rodion',
    label: 'Card',
  });
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'one',
      accountId: 'card',
      owner: 'rodion',
      currency: 'UAH',
      amountMinor: '-12345',
      bookedAt: '2026-08-05T10:00:00Z',
      description: 'Synthetic merchant',
    },
  ]);
  const row = (await repo.list())[0]!;
  await repo.classify(
    row.id,
    0,
    {
      kind: 'personal_expense',
      category: 'Food / Groceries',
      reason: 'Synthetic owner choice',
    },
    'rodion',
  );
  const config = {
    port: 0,
    mode: 'postgres' as const,
    release: 'test',
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${config.port}`;
  let cookie = '';
  const get = (path: string) => fetch(base + path, { headers: { cookie } });
  const post = (fields: Record<string, string>) =>
    fetch(base + '/accounts', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
  try {
    await seedTestOwners(db);
    cookie = await signInAs(base, 'rodion');
    const csrf = (await (await get('/api/bootstrap')).json()).csrf;
    const input = {
      csrf,
      source: 'synthetic',
      accountId: 'card',
      label: 'Card',
      purpose: 'business',
      expectedRevision: '0',
      reason: 'Business account exclusion',
    };
    assert.equal((await post({ ...input, csrf: '' })).status, 403);
    assert.equal((await post({ ...input, expectedRevision: '' })).status, 400);
    const period = previousReportPeriod(
      'month',
      new Date('2026-09-12T00:00:00Z'),
    );
    const before = buildReport(await repo.list(), { owner: 'rodion', period });
    assert.equal((await post(input)).status, 303);
    assert.equal((await post(input)).status, 409);
    const account = (await (await get('/api/accounts')).json()).accounts[0];
    assert.equal(account.revision, 1);
    assert.equal(account.history[0].reason, input.reason);
    assert.equal(account.impact.personalExpenseCount, 1);
    const excluded = await convertedSpending(repo, await repo.list(), 'UAH');
    // The owner classified this payment as personal spending, so marking the
    // card a business card leaves it alone. Not everything on a business
    // account is business spending, and only a person can say which is which.
    assert.equal(excluded.confirmedMinor, '12345');
    assert.equal(excluded.rows[0]!.spendingPolicy!.reason, 'business_account');
    assert.equal((await repo.list())[0]!.kind, 'personal_expense');
    // A payment nobody has decided on does follow the account.
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'two',
        accountId: 'card',
        owner: 'rodion',
        currency: 'UAH',
        amountMinor: '-500',
        bookedAt: '2026-08-06T10:00:00Z',
        description: 'Undecided business merchant',
      },
    ]);
    assert.equal(
      (await repo.list()).find((r) => r.sourceId === 'two')!.kind,
      'non_personal',
    );
    const after = buildReport(await repo.list(), { owner: 'rodion', period });
    assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
    assert.equal(
      (
        await post({
          ...input,
          purpose: 'personal',
          expectedRevision: '1',
          reason: 'Account is personal again',
        })
      ).status,
      303,
    );
    const restored = await convertedSpending(repo, await repo.list(), 'UAH');
    assert.equal(restored.confirmedMinor, '12345');
    const human = (await repo.list()).find((r) => r.sourceId === 'one')!;
    assert.equal(human.category, 'Food / Groceries');
    assert.equal(human.revision, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
