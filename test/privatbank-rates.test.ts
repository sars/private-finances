import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from '../src/database.js';
import { FxRates, initializeFxRates } from '../src/fx-rates.js';
import {
  PRIVATBANK_SOURCE,
  parsePrivatBankRates,
  fetchPrivatBankRates,
  storePrivatBankRates,
  validatePrivatBankDate,
  privatBankRateUrl,
} from '../src/privatbank-rates.js';
import { planFxSyncDates } from '../src/fx-sync-cli.js';

const date = '2026-09-11';
const retrievedAt = '2026-09-12T12:00:00.000Z';
const now = () => new Date(retrievedAt);
const payload = (
  rows = '{"baseCurrency":"UAH","currency":"USD","purchaseRate":40.10,"saleRate":40.30}',
) =>
  `{"date":"11.09.2026","bank":"PB","baseCurrency":980,"baseCurrencyLit":"UAH","exchangeRate":[${rows}]}`;

test('commercial midpoint preserves numeric decimal lexemes and explicitly ignores NBU-only rates', () => {
  const raw = payload(`
    {"baseCurrency":"UAH","currency":"USD","purchaseRate":40.000000000000000001,"saleRate":40.000000000000000003,"purchaseRateNB":999,"saleRateNB":999},
    {"baseCurrency":"UAH","currency":"EUR","purchaseRateNB":45,"saleRateNB":45},
    {"baseCurrency":"UAH","currency":"GBP","purchaseRate":50,"saleRate":51},
    {"baseCurrency":"UAH","currency":"CHF","purchaseRate":1,"saleRate":2},
    {"baseCurrency":"UAH","currency":"JPY","purchaseRateNB":0.25,"saleRateNB":0.25}
  `);
  const rates = parsePrivatBankRates(raw, date, retrievedAt);
  assert.deepEqual(
    rates.map((rate) => [rate.base, rate.rate]),
    [
      ['GBP', '50.5'],
      ['USD', '40.000000000000000002'],
    ],
  );
  assert.equal(rates[0]!.source, PRIVATBANK_SOURCE);
  assert.equal(rates[0]!.asOf, date);
  assert.equal(rates[0]!.retrievedAt, retrievedAt);
  assert.match(rates[1]!.provenance, /purchaseRate=40\.000000000000000001/);
  assert.match(rates[1]!.provenance, /saleRate=40\.000000000000000003/);
  assert.ok(!rates[1]!.provenance.includes('999'));
  assert.equal(rates[0]!.target, 'UAH');
  assert.equal(
    privatBankRateUrl(date),
    'https://api.privatbank.ua/p24api/exchange_rates?json&date=11.09.2026',
  );
  assert.deepEqual(
    parsePrivatBankRates(
      payload(
        '{"baseCurrency":"UAH","currency":"USD","purchaseRateNB":41,"saleRateNB":41}',
      ),
      date,
      retrievedAt,
    ),
    [],
  );
});

test('malformed, stale and inconsistent provider evidence is rejected without NBU fallback', () => {
  for (const raw of [
    payload().replace('11.09.2026', '10.09.2026'),
    payload().replace('"PB"', '"other"'),
    payload().replace('"baseCurrency":980', '"baseCurrency":978'),
    payload().replace('"baseCurrencyLit":"UAH"', '"baseCurrencyLit":"EUR"'),
    payload().replace('"baseCurrency":"UAH"', '"baseCurrency":"EUR"'),
    payload().replace('"purchaseRate":40.10', '"purchaseRate":41'),
    payload().replace('"purchaseRate":40.10', '"purchaseRate":0'),
    payload().replace('"purchaseRate":40.10', '"purchaseRate":-1'),
    payload().replace('"purchaseRate":40.10', '"purchaseRate":4.01e1'),
    payload().replace('"purchaseRate":40.10,', ''),
    payload().replace('"saleRate":40.30', '"saleRate":null'),
    payload(
      '{"baseCurrency":"UAH","currency":"USD","purchaseRate":1,"saleRate":2},{"baseCurrency":"UAH","currency":"USD","purchaseRate":1,"saleRate":2}',
    ),
    '{invalid}',
    payload().replace('"exchangeRate":[', '"exchangeRate":[').slice(0, -1),
    ' '.repeat(128 * 1024 + 1),
  ])
    assert.throws(
      () => parsePrivatBankRates(raw, date, retrievedAt),
      /invalid_response/,
    );
});

test('archive date guards and inclusive CLI date plans are bounded, newest-first and deterministic', () => {
  for (const invalid of [
    '2026-02-30',
    '2022-09-11',
    '2026-09-13',
    '2026-09-11T00:00:00Z',
  ])
    assert.throws(() => validatePrivatBankDate(invalid, now()), /invalid_date/);
  validatePrivatBankDate('2022-09-12', now());
  assert.deepEqual(
    planFxSyncDates(['2026-09-09', date, '--refresh'], [], now()),
    { dates: [date, '2026-09-10', '2026-09-09'], refresh: true },
  );
  assert.deepEqual(
    planFxSyncDates(
      [],
      [date, '2026-09-10', date, '2021-01-01', '2026-09-13'],
      now(),
    ),
    { dates: [date, '2026-09-10'], refresh: false },
  );
  for (const args of [
    [date],
    [date, date, date],
    ['--refresh', '--refresh'],
    ['2026-09-12', date],
    ['2022-09-11', date],
  ])
    assert.throws(() => planFxSyncDates(args, [], now()));
});

test('public fetch uses a bounded read-only request and respects bounded retry-after delays', async () => {
  let calls = 0;
  const delays: number[] = [];
  const fake: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, privatBankRateUrl(date));
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.method, undefined);
    assert.ok(options?.signal);
    assert.deepEqual(options?.headers, { Accept: 'application/json' });
    if (calls === 1)
      return new Response('', { status: 429, headers: { 'Retry-After': '3' } });
    if (calls === 2) return new Response('', { status: 503 });
    return new Response(payload());
  };
  const rates = await fetchPrivatBankRates(date, {
    fetch: fake,
    sleep: async (delay) => {
      delays.push(delay);
    },
    now,
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [3000, 4000]);
  assert.equal(rates[0]!.rate, '40.2');
});

test('failed public requests stop after three attempts; invalid dates, payloads and long retry delays do not retry', async () => {
  for (const response of [
    'network',
    '500',
    '401',
    'long_delay',
    'large',
    'stale',
    'bad_json',
  ] as const) {
    let calls = 0;
    const delays: number[] = [];
    const fake: typeof fetch = async () => {
      calls++;
      if (response === 'network') throw new Error('synthetic network detail');
      if (response === '500') return new Response('', { status: 500 });
      if (response === '401') return new Response('', { status: 401 });
      if (response === 'long_delay')
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '61' },
        });
      if (response === 'large') return new Response('x'.repeat(128 * 1024 + 1));
      if (response === 'stale')
        return new Response(payload().replace('11.09.2026', '10.09.2026'));
      return new Response('{invalid}');
    };
    await assert.rejects(
      fetchPrivatBankRates(date, {
        fetch: fake,
        sleep: async (delay) => {
          delays.push(delay);
        },
        now,
      }),
      /^Error: privatbank_rates_/,
    );
    assert.equal(calls, response === 'network' || response === '500' ? 3 : 1);
    assert.deepEqual(
      delays,
      response === 'network' || response === '500' ? [2000, 4000] : [],
    );
  }
  let calls = 0;
  await assert.rejects(
    fetchPrivatBankRates('2020-01-01', {
      fetch: async () => {
        calls++;
        return new Response(payload());
      },
      now,
    }),
    /invalid_date/,
  );
  assert.equal(calls, 0);
});

test('provider imports skip stored dates by default and explicit refresh appends immutable versions atomically', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    const rates = parsePrivatBankRates(payload(), date, retrievedAt);
    assert.deepEqual(await storePrivatBankRates(db, date, rates), {
      stored: 1,
      skipped: false,
    });
    const refreshed = parsePrivatBankRates(
      payload().replace('40.30', '40.50'),
      date,
      '2026-09-12T13:00:00.000Z',
    );
    assert.deepEqual(await storePrivatBankRates(db, date, refreshed), {
      stored: 0,
      skipped: true,
    });
    assert.deepEqual(await storePrivatBankRates(db, date, refreshed, true), {
      stored: 1,
      skipped: false,
    });
    const stored = await new FxRates(db).list(date, date);
    assert.deepEqual(
      stored.map((row) => [row.version, row.rate]),
      [
        [2, '40.3'],
        [1, '40.2'],
      ],
    );
    await assert.rejects(
      storePrivatBankRates(
        db,
        date,
        [
          { ...rates[0]!, base: 'EUR' },
          { ...rates[0]!, base: 'GBP', rate: 'invalid' },
        ],
        true,
      ),
    );
    assert.equal((await new FxRates(db).list(date, date)).length, 2);
    await assert.rejects(
      storePrivatBankRates(db, '2026-09-10', rates),
      /invalid_response/,
    );
  } finally {
    await db.close();
  }
});
