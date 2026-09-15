import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planBackfillWindows,
  runBackfill,
  type BackfillDependencies,
  type BackfillProgress,
} from '../src/backfill.js';
import {
  ConnectorError,
  type BankAccount,
  type BankConnector,
} from '../src/connectors/types.js';

const from = new Date('2025-01-01T00:00:00Z');
const to = new Date('2025-04-01T00:00:00Z');
function fixture(source: BankConnector['source'] = 'monobank') {
  const accounts: BankAccount[] = ['synthetic-a', 'synthetic-b'].map(
    (accountId) => ({
      source,
      owner: 'rodion',
      accountId,
      providerAccountId: accountId,
      currency: 'EUR',
      label: 'Synthetic account',
    }),
  );
  let accountCalls = 0;
  const connector: BankConnector = {
    source,
    owner: 'rodion',
    ...(source === 'enablebanking' ? { bank: 'wise' as const } : {}),
    accounts: async () => {
      accountCalls++;
      return accounts;
    },
    transactions: async () => [],
  };
  return { accounts, connector, calls: () => accountCalls };
}

test('monthly Monobank windows cover the full range without gaps; Enable Banking requests the whole period', () => {
  const windows = planBackfillWindows('monobank', from, to);
  assert.equal(windows.length, 3);
  assert.equal(windows[0]!.from.toISOString(), '2025-03-01T00:00:00.000Z');
  assert.equal(windows.at(-1)!.from.getTime(), from.getTime());
  assert.equal(windows[0]!.to.getTime(), to.getTime());
  for (let index = 0; index < windows.length; index++) {
    const current = windows[index]!;
    assert.ok(current.to.getTime() - current.from.getTime() <= 31 * 86400000);
    if (index > 0)
      assert.equal(current.to.getTime(), windows[index - 1]!.from.getTime());
  }
  const partial = planBackfillWindows(
    'monobank',
    new Date('2024-02-12T13:00:00Z'),
    new Date('2024-03-12T14:00:00Z'),
  );
  assert.equal(partial.length, 2);
  assert.equal(partial[1]!.to.toISOString(), '2024-03-01T00:00:00.000Z');
  assert.deepEqual(planBackfillWindows('enablebanking', from, to), [
    { from, to },
  ]);
  assert.throws(() => planBackfillWindows('monobank', to, from));
  assert.throws(() =>
    planBackfillWindows('monobank', new Date(from.getTime() + 1), to),
  );
});

test('fetches accounts once, syncs each separately and resumes only committed coverage without private progress text', async () => {
  const { connector, calls } = fixture();
  const completed = new Set<string>();
  const events: BackfillProgress[] = [];
  let syncCalls = 0;
  const key = (account: BankAccount, start: Date, end: Date) =>
    JSON.stringify([
      account.owner,
      account.source,
      account.accountId,
      account.currency,
      start,
      end,
    ]);
  const dependencies: BackfillDependencies = {
    covered: async (account, window) =>
      completed.has(key(account, window.from, window.to)),
    sync: async (single, start, end) => {
      const accounts = await single.accounts();
      assert.equal(accounts.length, 1);
      assert.equal(single.source, connector.source);
      assert.equal(single.owner, connector.owner);
      assert.deepEqual(await single.transactions(accounts[0]!, start, end), []);
      syncCalls++;
      if (syncCalls === 3) throw new ConnectorError('auth');
      completed.add(key(accounts[0]!, start, end));
      return { changed: 1 };
    },
    progress: (event) => events.push(event),
  };
  await assert.rejects(runBackfill(connector, from, to, dependencies), {
    code: 'auth',
  });
  assert.equal(calls(), 1);
  assert.equal(completed.size, 2);
  const result = await runBackfill(connector, from, to, dependencies);
  assert.equal(calls(), 2);
  assert.deepEqual(result, {
    accounts: 2,
    completed: 4,
    skipped: 2,
    changed: 4,
  });
  assert.equal(completed.size, 6);
  assert.ok(!JSON.stringify(events).includes('synthetic-a'));
  assert.ok(!JSON.stringify(events).includes('synthetic-b'));
});

test('capped Enable Banking responses bisect windows with complete second-boundary coverage', async () => {
  const { connector, accounts } = fixture('enablebanking');
  accounts.splice(1);
  const end = new Date(from.getTime() + 4000);
  const windows: [number, number][] = [];
  let count = 0;
  await runBackfill(connector, from, end, {
    covered: async () => false,
    sync: async (_single, start, finish) => {
      count++;
      if (finish.getTime() - start.getTime() > 1000)
        throw new ConnectorError('incomplete');
      windows.push([start.getTime(), finish.getTime()]);
      return { changed: 0 };
    },
  });
  assert.equal(count, 7);
  windows.sort((a, b) => a[0] - b[0]);
  assert.deepEqual(
    windows,
    [0, 1, 2, 3].map((index) => [
      from.getTime() + index * 1000,
      from.getTime() + (index + 1) * 1000,
    ]),
  );
});

test('rate limits respect retry-after with at most three attempts; consent failures stop immediately', async () => {
  for (const code of ['rate_limit', 'consent'] as const) {
    const { connector } = fixture();
    let attempts = 0;
    const delays: number[] = [];
    await assert.rejects(
      runBackfill(connector, from, to, {
        covered: async () => false,
        sleep: async (delay) => {
          delays.push(delay);
        },
        sync: async () => {
          attempts++;
          throw new ConnectorError(code, 123456);
        },
      }),
      { code },
    );
    assert.equal(attempts, code === 'rate_limit' ? 3 : 1);
    assert.deepEqual(delays, code === 'rate_limit' ? [123456, 123456] : []);
  }
});

test('malformed account discovery and irreducibly incomplete windows cannot claim success', async () => {
  for (const duplicate of [true, false]) {
    const { connector, accounts } = fixture();
    if (duplicate) accounts.push(accounts[0]!);
    else accounts.splice(0);
    let attempts = 0;
    await assert.rejects(
      runBackfill(connector, from, to, {
        covered: async () => false,
        sync: async () => {
          attempts++;
          return { changed: 0 };
        },
      }),
      { code: duplicate ? 'schema' : 'incomplete' },
    );
    assert.equal(attempts, 0);
  }
  const { connector } = fixture();
  let attempts = 0;
  await assert.rejects(
    runBackfill(connector, from, new Date(from.getTime() + 1000), {
      covered: async () => false,
      sync: async () => {
        attempts++;
        throw new ConnectorError('incomplete');
      },
    }),
    { code: 'incomplete' },
  );
  assert.equal(attempts, 1);
});

test('Enable Banking bisection has a hard 255-job ceiling per account window', async () => {
  const { connector } = fixture('enablebanking');
  let attempts = 0;
  await assert.rejects(
    runBackfill(connector, from, new Date(from.getTime() + 256000), {
      covered: async () => false,
      sync: async (_single, start, end) => {
        attempts++;
        if (end.getTime() - start.getTime() > 1000)
          throw new ConnectorError('incomplete');
        return { changed: 0 };
      },
    }),
    { code: 'incomplete' },
  );
  assert.ok(attempts <= 255);
  assert.ok(attempts > 1);
});

test('Monobank incomplete stops after one sync without resetting its adaptive request budget', async () => {
  const { connector } = fixture('monobank');
  let attempts = 0;
  const events: BackfillProgress[] = [];
  await assert.rejects(
    runBackfill(connector, from, to, {
      covered: async () => false,
      sync: async () => {
        attempts++;
        throw new ConnectorError('incomplete');
      },
      progress: (event) => events.push(event),
    }),
    { code: 'incomplete' },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(events, []);
});
