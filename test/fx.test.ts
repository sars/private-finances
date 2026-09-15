import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convertMoney,
  currencyExponent,
  type DatedMarketQuote,
  type FxResult,
} from '../src/fx.js';

const input = {
  amountMinor: '-10000',
  currency: 'EUR',
  targetCurrency: 'UAH',
  occurredAt: '2026-09-10T12:00:00Z',
};
// All rates below are synthetic test values, not historical financial data.
const quote: DatedMarketQuote = {
  source: 'synthetic_market',
  base: 'EUR',
  target: 'UAH',
  rate: '40.125',
  asOf: '2026-09-10',
  resolution: 'daily',
};
function success(result: FxResult) {
  assert.equal(result.status, 'converted');
  if (result.status !== 'converted') throw new Error('Expected conversion');
  return result;
}

test('actual bank amounts take precedence over market and retain exact provenance', () => {
  const result = success(
    convertMoney({
      ...input,
      quotes: [quote],
      actualExchange: {
        source: 'monobank',
        account: { currency: 'EUR', amountMinor: '-10000' },
        operation: { currency: 'UAH', amountMinor: '-412345' },
      },
    }),
  );
  assert.equal(result.amountMinor, '-412345');
  assert.deepEqual(result.provenance, {
    kind: 'actual_bank',
    source: 'monobank',
    asOf: '2026-09-10T12:00:00.000Z',
    resolution: 'transaction',
    base: 'EUR',
    target: 'UAH',
    rateNumerator: '82469',
    rateDenominator: '2000',
    inverted: false,
    rounding: 'half_away_from_zero',
  });
});

test('actual amounts support inverse direction and differing minor-unit exponents', () => {
  const result = success(
    convertMoney({
      ...input,
      currency: 'JPY',
      targetCurrency: 'KWD',
      amountMinor: '-1000',
      actualExchange: {
        source: 'synthetic_bank',
        account: { currency: 'KWD', amountMinor: '-2500' },
        operation: { currency: 'JPY', amountMinor: '-1000' },
      },
    }),
  );
  assert.equal(result.amountMinor, '-2500');
  assert.equal(result.provenance.rateNumerator, '1');
  assert.equal(result.provenance.rateDenominator, '400');
  assert.equal(result.provenance.inverted, true);
});

test('invalid or unrelated actual evidence cannot provide another transaction a rate', () => {
  for (const [accountAmount, operationAmount] of [
    ['0', '-400'],
    ['-10000', '0'],
    ['-10000', '400'],
    ['-99', '-400'],
    ['bad', '-400'],
  ]) {
    const actualExchange = {
      source: 'bank',
      account: { currency: 'EUR', amountMinor: accountAmount! },
      operation: { currency: 'UAH', amountMinor: operationAmount! },
    };
    assert.equal(convertMoney({ ...input, actualExchange }).status, 'missing');
    assert.equal(
      success(convertMoney({ ...input, actualExchange, quotes: [quote] }))
        .provenance.kind,
      'market_estimate',
    );
  }
  assert.equal(
    convertMoney({
      ...input,
      targetCurrency: 'GBP',
      actualExchange: {
        source: 'bank',
        account: { currency: 'EUR', amountMinor: '-10000' },
        operation: { currency: 'UAH', amountMinor: '-400000' },
      },
    }).status,
    'missing',
  );
});

test('daily estimates are labeled with rate date, source, exact ratio and rounding', () => {
  const result = success(convertMoney({ ...input, quotes: [quote] }));
  assert.equal(result.amountMinor, '-401250');
  assert.equal(result.provenance.kind, 'market_estimate');
  assert.equal(result.provenance.resolution, 'daily');
  assert.equal(result.provenance.source, quote.source);
  assert.equal(result.provenance.asOf, '2026-09-10');
  assert.equal(result.provenance.rateNumerator, '321');
  assert.equal(result.provenance.rateDenominator, '8');
});

test('rounding is half away from zero, with no floating-point loss', () => {
  for (const [amountMinor, rate, expected] of [
    ['1', '0.5', '1'],
    ['-1', '0.5', '-1'],
    ['1', '0.499999999999999999999999999999', '0'],
    ['-1', '0.499999999999999999999999999999', '0'],
    ['9007199254740993', '1.5', '13510798882111490'],
    ['-9007199254740993', '1.5', '-13510798882111490'],
  ]) {
    assert.equal(
      success(
        convertMoney({
          ...input,
          amountMinor: amountMinor!,
          quotes: [{ ...quote, rate: rate! }],
        }),
      ).amountMinor,
      expected,
    );
  }
});

test('market inverse direction and currency exponents convert correctly', () => {
  assert.equal(
    success(
      convertMoney({
        ...input,
        amountMinor: '-1',
        quotes: [{ ...quote, base: 'UAH', target: 'EUR', rate: '8' }],
      }),
    ).amountMinor,
    '0',
  );
  assert.equal(
    success(
      convertMoney({
        ...input,
        amountMinor: '-100',
        currency: 'UAH',
        targetCurrency: 'EUR',
        quotes: [{ ...quote, rate: '8' }],
      }),
    ).amountMinor,
    '-13',
  );
  assert.equal(
    success(
      convertMoney({
        ...input,
        amountMinor: '100',
        targetCurrency: 'JPY',
        quotes: [{ ...quote, target: 'JPY', rate: '150' }],
      }),
    ).amountMinor,
    '150',
  );
  assert.equal(
    success(
      convertMoney({
        ...input,
        amountMinor: '100',
        targetCurrency: 'KWD',
        quotes: [{ ...quote, target: 'KWD', rate: '0.3335' }],
      }),
    ).amountMinor,
    '334',
  );
});

test('same-currency amounts remain exact without inventing an FX date', () => {
  const result = success(
    convertMoney({
      currency: 'USD',
      targetCurrency: 'USD',
      amountMinor: '-9007199254740993123456',
    }),
  );
  assert.equal(result.amountMinor, '-9007199254740993123456');
  assert.equal(result.provenance.kind, 'identity');
  assert.equal(result.provenance.asOf, null);
});

test('missing or malformed amount, currency and transaction time remain visible', () => {
  const check = (overrides: Partial<typeof input>, reason: string) =>
    assert.deepEqual(
      convertMoney({ ...input, ...overrides, quotes: [quote] }),
      {
        status: 'missing',
        currency: overrides.targetCurrency ?? input.targetCurrency,
        reason,
      },
    );
  check({ amountMinor: '1.01' }, 'invalid_amount');
  check({ currency: '' }, 'unsupported_currency');
  check({ targetCurrency: 'XXX' }, 'unsupported_currency');
  check({ occurredAt: '' }, 'missing_time');
  for (const occurredAt of [
    '2026-02-30T12:00:00Z',
    '2026-09-10',
    '2026-09-10T12:00:00',
    '2026-09-10T24:00:00Z',
  ])
    check({ occurredAt }, 'invalid_time');
  assert.equal(currencyExponent('constructor'), undefined);
});

test('quotes require matching date, currency pair, nonempty source and positive exact rate', () => {
  for (const overrides of [
    { asOf: '2026-09-09' },
    { asOf: '' },
    { asOf: '2026-02-30' },
    { source: '' },
    { target: 'GBP' },
    { rate: '0' },
    { rate: '-1' },
    { rate: '1e2' },
  ]) {
    assert.deepEqual(
      convertMoney({ ...input, quotes: [{ ...quote, ...overrides }] }),
      { status: 'missing', currency: 'UAH', reason: 'no_matching_quote' },
    );
  }
  assert.equal(convertMoney(input).status, 'missing');
});

test('timestamp evidence requires the exact instant and takes precedence over a daily quote', () => {
  const timed: DatedMarketQuote = {
    ...quote,
    rate: '42',
    asOf: '2026-09-10T15:00:00+03:00',
    resolution: 'timestamp',
  };
  const result = success(convertMoney({ ...input, quotes: [quote, timed] }));
  assert.equal(result.amountMinor, '-420000');
  assert.equal(result.provenance.resolution, 'timestamp');
  assert.equal(result.provenance.asOf, '2026-09-10T12:00:00.000Z');
  assert.equal(
    convertMoney({
      ...input,
      quotes: [{ ...timed, asOf: '2026-09-10T11:59:59Z' }],
    }).status,
    'missing',
  );
});

test('daily matching uses UTC date across local midnight', () => {
  assert.equal(
    convertMoney({
      ...input,
      occurredAt: '2026-09-10T01:00:00+03:00',
      quotes: [quote],
    }).status,
    'missing',
  );
  assert.equal(
    success(
      convertMoney({
        ...input,
        occurredAt: '2026-09-11T01:00:00+03:00',
        quotes: [quote],
      }),
    ).provenance.asOf,
    '2026-09-10',
  );
});
