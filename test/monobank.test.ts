import test from 'node:test';
import assert from 'node:assert/strict';
import { MonobankConnector } from '../src/connectors/monobank.js';
import { requester } from '../src/connectors/http.js';
import { ConnectorError, decimalToMinor } from '../src/connectors/types.js';

test('all mono accounts and jars are discovered; statement amounts use account currency and holds stay pending', async () => {
  const calls: string[] = [];
  const mono = new MonobankConnector(
    'rodion',
    'synthetic-test-token',
    async (path, headers) => {
      calls.push(path);
      assert.equal(headers['X-Token'], 'synthetic-test-token');
      if (path === '/personal/client-info')
        return {
          accounts: [
            { id: 'a', currencyCode: 980, type: 'black' },
            { id: 'b', currencyCode: 840, type: 'white' },
          ],
          jars: [{ id: 'j', currencyCode: 980, title: 'Savings' }],
        };
      return [
        {
          id: 't',
          time: 1788220800,
          amount: -123456,
          operationAmount: -2500,
          currencyCode: 978,
          description: 'Test',
          hold: true,
        },
      ];
    },
  );
  const accounts = await mono.accounts();
  assert.equal(accounts.length, 3);
  const transactions = await mono.transactions(
    accounts[0]!,
    new Date('2026-09-01'),
    new Date('2026-09-02'),
  );
  assert.equal(transactions[0]?.currency, 'UAH');
  assert.equal(transactions[0]?.amountMinor, '-123456');
  assert.equal(transactions[0]?.status, 'pending');
  assert.ok(calls[1]?.includes('/statement/a/'));
});
test('mono splits long windows and deduplicates overlapping source IDs', async () => {
  let requests = 0;
  const mono = new MonobankConnector('katya', 'test', async () => {
    requests++;
    return [{ id: 'same', time: 1788220800, amount: -100, hold: false }];
  });
  const data = await mono.transactions(
    {
      source: 'monobank',
      accountId: 'a',
      providerAccountId: 'a',
      owner: 'katya',
      currency: 'UAH',
      label: 'Test',
    },
    new Date('2026-08-01'),
    new Date('2026-10-01'),
  );
  assert.equal(requests, 2);
  assert.equal(data.length, 1);
});
test('HTTP client does not leak upstream text, follow redirects or retry authorization failures', async () => {
  let calls = 0;
  const fake: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(options?.redirect, 'error');
    return new Response('private bank details', { status: 401 });
  };
  await assert.rejects(
    requester('https://api.monobank.ua', 0, fake)('/personal/client-info', {}),
    (e: unknown) =>
      e instanceof ConnectorError &&
      e.code === 'auth' &&
      !e.message.includes('private'),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    requester('https://api.monobank.ua', 0, fake)('//evil.example', {}),
    ConnectorError,
  );
});
test('rate-limit retry delay and exact decimal conversion are explicit', async () => {
  const fake: typeof fetch = async () =>
    new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  await assert.rejects(
    requester('https://api.monobank.ua', 0, fake)('/x', {}),
    (e: unknown) =>
      e instanceof ConnectorError &&
      e.code === 'rate_limit' &&
      e.retryAfterMs === 120000,
  );
  assert.equal(
    decimalToMinor('900719925474099.99', 'EUR'),
    '90071992547409999',
  );
  assert.equal(decimalToMinor('1.234', 'KWD'), '1234');
  assert.throws(() => decimalToMinor('1.001', 'EUR'), ConnectorError);
  assert.throws(() => decimalToMinor('10', 'XYZ'), ConnectorError);
});

test('potentially capped Mono statement does not claim complete coverage', async () => {
  const mono = new MonobankConnector('rodion', 'test', async () =>
    Array(500).fill({ id: 't', time: 1788220800, amount: -100, hold: false }),
  );
  await assert.rejects(
    mono.transactions(
      {
        source: 'monobank',
        accountId: 'a',
        providerAccountId: 'a',
        owner: 'rodion',
        currency: 'UAH',
        label: 'Test',
      },
      new Date('2026-09-01'),
      new Date('2026-09-02'),
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === 'incomplete',
  );
});

test('explicit regular-account scope excludes jars without changing default discovery', async () => {
  const mono = new MonobankConnector(
    'rodion',
    'test',
    async () => ({
      accounts: [{ id: 'a', currencyCode: 980 }],
      jars: [{ id: 'j', currencyCode: 980 }],
    }),
    false,
  );
  const accounts = await mono.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.providerAccountId, 'a');
});

test('capped Mono windows bisect inclusively and return every transaction once', async () => {
  const start = 1788220800;
  const rows = Array.from({ length: 701 }, (_, index) => ({
    id: `synthetic-${index}`,
    time: start + index,
    amount: -100,
    hold: false,
  }));
  const calls: Array<[number, number]> = [];
  const mono = new MonobankConnector('rodion', 'test', async (path) => {
    const [from, to] = path.split('/').slice(-2).map(Number) as [
      number,
      number,
    ];
    calls.push([from, to]);
    return rows.filter((row) => row.time >= from && row.time <= to).slice(-500);
  });
  const actual = await mono.transactions(
    {
      source: 'monobank',
      accountId: 'a',
      providerAccountId: 'a',
      owner: 'rodion',
      currency: 'UAH',
      label: 'Test',
    },
    new Date(start * 1000),
    new Date((start + 1000) * 1000),
  );
  assert.deepEqual(
    actual.map((row) => row.sourceId).sort(),
    rows.map((row) => row.id).sort(),
  );
  assert.deepEqual(calls, [
    [start, start + 1000],
    [start, start + 500],
    [start, start + 250],
    [start + 250, start + 500],
    [start + 500, start + 1000],
  ]);
});

test('500 same-second records terminate as incomplete at the smallest window', async () => {
  const start = 1788220800;
  let calls = 0;
  const rows = Array.from({ length: 500 }, (_, index) => ({
    id: `synthetic-${index}`,
    time: start,
    amount: -100,
    hold: false,
  }));
  const mono = new MonobankConnector('rodion', 'test', async () => {
    calls++;
    return rows;
  });
  await assert.rejects(
    mono.transactions(
      {
        source: 'monobank',
        accountId: 'a',
        providerAccountId: 'a',
        owner: 'rodion',
        currency: 'UAH',
        label: 'Test',
      },
      new Date(start * 1000),
      new Date((start + 1024) * 1000),
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === 'incomplete',
  );
  assert.equal(calls, 11);
});

test('adaptive Mono requests remain bounded per original time window', async () => {
  const start = 1788220800;
  let calls = 0;
  const mono = new MonobankConnector('rodion', 'test', async (path) => {
    calls++;
    const [from, to] = path.split('/').slice(-2).map(Number) as [
      number,
      number,
    ];
    return to - from > 10000
      ? Array(500).fill({
          id: 'synthetic',
          time: from,
          amount: -100,
          hold: false,
        })
      : [];
  });
  await assert.rejects(
    mono.transactions(
      {
        source: 'monobank',
        accountId: 'a',
        providerAccountId: 'a',
        owner: 'rodion',
        currency: 'UAH',
        label: 'Test',
      },
      new Date(start * 1000),
      new Date((start + 2682000) * 1000),
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === 'incomplete',
  );
  assert.equal(calls, 255);
});
