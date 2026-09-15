import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from '../src/database.js';
import {
  FxRates,
  initializeFxRates,
  convertWithDailyRates,
  type DailyFxRateInput,
  type DailyFxRate,
} from '../src/fx-rates.js';
const input: DailyFxRateInput = {
  source: 'synthetic-market',
  base: 'USD',
  target: 'UAH',
  rate: '40.5',
  asOf: '2026-09-01',
  retrievedAt: '2026-09-02T00:00:00Z',
  version: 1,
  provenance: 'Synthetic archived daily quote',
};
const quote = (overrides: Partial<DailyFxRate> = {}): DailyFxRate => ({
  id: 'synthetic-id',
  ...input,
  ...overrides,
});

test('daily rate versions preserve provenance, reject conflicts, and cannot be overwritten', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    await initializeFxRates(db);
    const rates = new FxRates(db);
    const first = await rates.insert(input);
    assert.deepEqual(await rates.insert(input), first);
    await assert.rejects(
      rates.insert({ ...input, rate: '41' }),
      /fx_rate_version_conflict/,
    );
    await assert.rejects(
      rates.insert({ ...input, provenance: 'changed evidence' }),
      /fx_rate_version_conflict/,
    );
    const second = await rates.insert({
      ...input,
      rate: '41',
      version: 2,
      retrievedAt: '2026-09-03T00:00:00Z',
    });
    assert.notEqual(first.id, second.id);
    const stored = await rates.list('2026-09-01', '2026-09-01');
    assert.equal(stored.length, 2);
    assert.equal(stored.find((row) => row.version === 1)!.rate, '40.5');
    await assert.rejects(
      db.query("UPDATE daily_fx_rates SET rate='100'"),
      /daily_fx_rates_are_immutable/,
    );
    await assert.rejects(
      db.query('DELETE FROM daily_fx_rates'),
      /daily_fx_rates_are_immutable/,
    );
  } finally {
    await db.close();
  }
});

test('daily quote boundary validation rejects malformed decimals, dates and provenance', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    const rates = new FxRates(db);
    for (const overrides of [
      { rate: '0' },
      { rate: '-1' },
      { rate: '1e3' },
      { rate: 1.23 },
      { base: 'XYZ' },
      { target: 'USD' },
      { asOf: '2026-02-30' },
      { retrievedAt: '2026-02-30T00:00:00Z' },
      { retrievedAt: '2026-09-01T24:00:00Z' },
      { retrievedAt: '2026-09-01' },
      { version: 0 },
      { version: 1.5 },
      { source: '' },
      { provenance: '' },
    ])
      await assert.rejects(
        rates.insert({ ...input, ...overrides } as DailyFxRateInput),
        /invalid_fx_rate/,
      );
    assert.deepEqual(await rates.list('2026-09-01', '2026-09-01'), []);
  } finally {
    await db.close();
  }
});

test('daily selection is order-independent, chooses latest version, and never uses another date', () => {
  const request = {
    amountMinor: '-100',
    currency: 'USD',
    targetCurrency: 'UAH',
    occurredAt: '2026-09-01T12:00:00Z',
  };
  const rates = [
    quote(),
    quote({ version: 2, rate: '42' }),
    quote({ source: 'z-other', rate: '99' }),
    quote({ version: 3, asOf: '2026-09-02', rate: '100' }),
  ];
  const first = convertWithDailyRates(request, rates);
  assert.deepEqual(first, convertWithDailyRates(request, [...rates].reverse()));
  assert.equal(first.status, 'converted');
  if (first.status !== 'converted') return;
  assert.equal(first.amountMinor, '-4200');
  assert.equal(first.provenance.quotes![0]!.version, 2);
  assert.equal(
    convertWithDailyRates(
      { ...request, occurredAt: '2026-08-31T12:00:00Z' },
      rates,
    ).status,
    'missing',
  );
});

test('UAH cross rates use exact rational arithmetic with one final rounding and same-source evidence', () => {
  const request = {
    amountMinor: '-1',
    currency: 'USD',
    targetCurrency: 'EUR',
    occurredAt: '2026-09-01T00:00:00Z',
  };
  const rates = [quote({ rate: '2' }), quote({ base: 'EUR', rate: '3' })];
  const result = convertWithDailyRates(request, rates);
  assert.equal(result.status, 'converted');
  if (result.status !== 'converted') return;
  assert.equal(result.amountMinor, '-1');
  assert.equal(result.provenance.rateNumerator, '2');
  assert.equal(result.provenance.rateDenominator, '3');
  assert.equal(result.provenance.quotes!.length, 2);
  const huge = convertWithDailyRates(
    { ...request, amountMinor: '-90071992547409931' },
    rates,
  );
  assert.equal(
    huge.status === 'converted' && huge.amountMinor,
    '-60047995031606621',
  );
  assert.equal(
    convertWithDailyRates(request, [
      rates[0]!,
      { ...rates[1]!, source: 'different' },
    ]).status,
    'missing',
  );
  const reverse = convertWithDailyRates(
    { ...request, amountMinor: '1', currency: 'EUR', targetCurrency: 'USD' },
    rates,
  );
  assert.equal(reverse.status === 'converted' && reverse.amountMinor, '2');
});

test('actual bank evidence outranks daily quotes and exact currency exponents remain respected', () => {
  const request = {
    amountMinor: '-200',
    currency: 'USD',
    targetCurrency: 'UAH',
    occurredAt: '2026-09-01T00:00:00Z',
    actualExchange: {
      source: 'synthetic bank',
      account: { amountMinor: '-200', currency: 'USD' },
      operation: { amountMinor: '-8000', currency: 'UAH' },
    },
  };
  const result = convertWithDailyRates(request, [quote({ rate: '99' })]);
  assert.equal(result.status === 'converted' && result.amountMinor, '-8000');
  assert.equal(
    result.status === 'converted' && result.provenance.kind,
    'actual_bank',
  );
  const cross = convertWithDailyRates(
    {
      amountMinor: '-1',
      currency: 'JPY',
      targetCurrency: 'KWD',
      occurredAt: request.occurredAt,
    },
    [quote({ base: 'JPY', rate: '0.5' }), quote({ base: 'KWD', rate: '100' })],
  );
  assert.equal(cross.status === 'converted' && cross.amountMinor, '-5');
});
