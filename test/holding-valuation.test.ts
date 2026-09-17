import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimal,
  toDecimal,
  toMinor,
  usdPerUnit,
  valueOn,
  series,
  quantityFromAmount,
  inForce,
  type ValuedHolding,
  type SnapshotPoint,
  type PricePoint,
} from '../src/holding-valuation.js';
import type { DailyFxRate } from '../src/fx-rates.js';

const rate = (
  base: string,
  value: string,
  asOf = '2026-09-24',
  version = 1,
  source = 'synthetic-bank',
): DailyFxRate => ({
  id: `${base}-${asOf}-${version}`,
  source,
  base,
  target: 'UAH',
  rate: value,
  asOf,
  retrievedAt: `${asOf}T05:00:00Z`,
  version,
  provenance: 'synthetic',
});
const holding = (
  overrides: Partial<ValuedHolding> & { id: string; denomination: string },
): ValuedHolding => ({
  name: overrides.id,
  kind: 'other',
  invested: false,
  liquid: true,
  owner: null,
  group: null,
  maturesOn: null,
  note: null,
  archived: false,
  revision: 0,
  ...overrides,
});
const point = (
  holdingId: string,
  asOf: string,
  quantity: string,
): SnapshotPoint => ({
  holdingId,
  asOf,
  quantity,
  source: 'manual',
  enteredAmount: null,
  enteredCurrency: null,
  note: null,
});

test('decimal strings parse exactly, round half away from zero and print without noise', () => {
  assert.deepEqual(parseDecimal('0.18174197'), { n: 18174197n, d: 100000000n });
  assert.deepEqual(parseDecimal('-0.5'), { n: -1n, d: 2n });
  assert.deepEqual(parseDecimal('2.50'), { n: 5n, d: 2n });
  assert.equal(parseDecimal('1e3'), null);
  assert.equal(parseDecimal('1,5'), null);
  assert.equal(parseDecimal(1.5), null);
  assert.equal(parseDecimal(''), null);
  assert.equal(toMinor({ n: 5n, d: 1000n }, 'USD'), '1'); // 0.005 → 0.01
  assert.equal(toMinor({ n: -5n, d: 1000n }, 'USD'), '-1');
  assert.equal(toMinor({ n: 4n, d: 1000n }, 'USD'), '0');
  assert.equal(toDecimal({ n: 1n, d: 3n }, 8), '0.33333333');
  assert.equal(toDecimal({ n: 9660n, d: 1n }, 2), '9660');
  assert.equal(toDecimal({ n: -1n, d: 2n }, 2), '-0.5');
  assert.equal(toDecimal({ n: -1n, d: 1000n }, 2), '0');
  assert.throws(() => toMinor({ n: 1n, d: 1n }, 'XYZ'), /unsupported_currency/);
});

test('a price is a stored quote for the day, else a bank cross rate, else the nearest week-old figure', () => {
  const rates = [rate('USD', '41'), rate('EUR', '45.1')];
  const prices: PricePoint[] = [
    { symbol: 'QQQ', asOf: '2026-09-20', usdPerUnit: '600', source: 'manual' },
    {
      symbol: 'BTC',
      asOf: '2026-09-24',
      usdPerUnit: '90000',
      source: 'manual',
    },
    { symbol: 'OLD', asOf: '2026-09-01', usdPerUnit: '1', source: 'manual' },
    // A stored rate for a currency on the day beats the bank's cross rate.
    { symbol: 'EUR', asOf: '2026-09-24', usdPerUnit: '1.2', source: 'manual' },
  ];
  const usd = usdPerUnit('USD', '2026-09-24', prices, rates)!;
  assert.deepEqual(usd.price, { n: 1n, d: 1n });
  const uah = usdPerUnit('UAH', '2026-09-24', prices, rates)!;
  assert.deepEqual(uah.price, { n: 1n, d: 41n });
  assert.equal(uah.approximate, false);
  const eur = usdPerUnit('EUR', '2026-09-24', prices, rates)!;
  assert.equal(eur.source, 'manual');
  assert.deepEqual(eur.price, { n: 6n, d: 5n });
  const eurCross = usdPerUnit('EUR', '2026-09-24', [], rates)!;
  assert.deepEqual(eurCross.price, { n: 11n, d: 10n });
  const qqq = usdPerUnit('QQQ', '2026-09-24', prices, rates)!;
  assert.equal(qqq.approximate, true);
  assert.equal(qqq.asOf, '2026-09-20');
  assert.equal(usdPerUnit('OLD', '2026-09-24', prices, rates), null);
  assert.equal(usdPerUnit('VOO', '2026-09-24', prices, rates), null);
  // A later version of the same day's quote wins; a future quote is never used.
  const revised = usdPerUnit(
    'UAH',
    '2026-09-24',
    [],
    [
      ...rates,
      rate('USD', '42', '2026-09-24', 2),
      rate('USD', '50', '2026-09-25'),
    ],
  )!;
  assert.deepEqual(revised.price, { n: 1n, d: 42n });
});

test('carry-forward, totals by flag and missing prices are exact and reported', () => {
  const holdings = [
    holding({ id: 'cash-usd', denomination: 'USD', kind: 'cash' }),
    holding({ id: 'card-uah', denomination: 'UAH', kind: 'bank' }),
    holding({
      id: 'fund',
      denomination: 'QQQ',
      kind: 'broker',
      invested: true,
    }),
    holding({
      id: 'flat',
      denomination: 'USD',
      kind: 'real_estate',
      invested: true,
      liquid: false,
    }),
    holding({
      id: 'coin',
      denomination: 'BTC',
      kind: 'crypto',
      invested: true,
    }),
    holding({
      id: 'closed',
      denomination: 'USD',
      kind: 'deposit',
      archived: true,
    }),
    holding({ id: 'never', denomination: 'EUR', kind: 'cash' }),
  ];
  const snapshots = [
    point('cash-usd', '2026-08-27', '1000'),
    point('cash-usd', '2026-09-24', '900.50'),
    point('card-uah', '2026-08-27', '41000'),
    point('fund', '2026-08-27', '10'),
    point('flat', '2026-08-27', '100000'),
    point('coin', '2026-09-24', '0.5'),
    point('closed', '2026-08-27', '5000'),
  ];
  const prices: PricePoint[] = [
    { symbol: 'QQQ', asOf: '2026-09-24', usdPerUnit: '500', source: 'manual' },
    { symbol: 'QQQ', asOf: '2026-08-27', usdPerUnit: '400', source: 'manual' },
  ];
  const rates = [rate('USD', '41'), rate('USD', '40', '2026-08-27')];
  const september = valueOn(
    '2026-09-24',
    'USD',
    holdings,
    snapshots,
    prices,
    rates,
  );
  const row = (id: string) => september.rows.find((r) => r.holding.id === id)!;
  assert.equal(row('cash-usd').valueMinor, '90050');
  assert.equal(row('cash-usd').carried, false);
  // 41,000 UAH at 41 per USD, carried from August.
  assert.equal(row('card-uah').valueMinor, '100000');
  assert.equal(row('card-uah').carried, true);
  assert.equal(row('card-uah').quantityAsOf, '2026-08-27');
  assert.equal(row('fund').valueMinor, '500000');
  assert.equal(row('flat').valueMinor, '10000000');
  assert.equal(row('coin').valueMinor, null);
  assert.equal(row('coin').price, null);
  // Retired holdings are not carried into a later day, and one never recorded stays empty.
  assert.equal(row('closed').quantity, null);
  assert.equal(row('never').quantity, null);
  assert.deepEqual(september.totals, {
    totalMinor: '10690050',
    investedMinor: '10500000',
    notInvestedMinor: '190050',
    liquidMinor: '690050',
    uahMinor: '100000',
    missing: 1,
    counted: 5,
  });
  const inUah = valueOn(
    '2026-09-24',
    'UAH',
    holdings,
    snapshots,
    prices,
    rates,
  );
  assert.equal(inUah.totals.totalMinor, '438292050'); // 106,900.50 USD × 41
  assert.equal(
    inUah.rows.find((r) => r.holding.id === 'card-uah')!.valueMinor,
    '4100000',
  );
  const august = valueOn(
    '2026-08-27',
    'USD',
    holdings,
    snapshots,
    prices,
    rates,
  );
  assert.equal(
    august.rows.find((r) => r.holding.id === 'closed')!.valueMinor,
    '500000',
  );
  assert.equal(august.totals.totalMinor, '11102500');
  const points = series(
    ['2026-09-24', '2026-08-27'],
    'USD',
    holdings,
    snapshots,
    prices,
    rates,
  );
  assert.deepEqual(
    points.map((p) => p.asOf),
    ['2026-08-27', '2026-09-24'],
  );
  assert.equal(points[1]!.totalMinor, '10690050');
  assert.equal(inForce(holdings, snapshots, '2026-08-01').size, 0);
  assert.throws(
    () => valueOn('2026-09-24', 'XYZ', holdings, snapshots, prices, rates),
    /unsupported_currency/,
  );
});

test('an amount typed in another currency becomes a quantity of the denomination at that day', () => {
  const rates = [rate('USD', '40'), rate('EUR', '44')];
  const prices: PricePoint[] = [
    { symbol: 'QQQ', asOf: '2026-09-24', usdPerUnit: '500', source: 'manual' },
  ];
  assert.equal(
    quantityFromAmount(
      { n: 4400n, d: 1n },
      'UAH',
      'USD',
      '2026-09-24',
      prices,
      rates,
    ),
    '110',
  );
  assert.equal(
    quantityFromAmount(
      { n: 1000n, d: 1n },
      'EUR',
      'USD',
      '2026-09-24',
      prices,
      rates,
    ),
    '1100',
  );
  assert.equal(
    quantityFromAmount(
      { n: 1000n, d: 1n },
      'USD',
      'QQQ',
      '2026-09-24',
      prices,
      rates,
    ),
    '2',
  );
  assert.equal(
    quantityFromAmount(
      { n: 1n, d: 3n },
      'USD',
      'USD',
      '2026-09-24',
      prices,
      rates,
    ),
    '0.33',
  );
  assert.equal(
    quantityFromAmount(
      { n: 1n, d: 1n },
      'USD',
      'BTC',
      '2026-09-24',
      prices,
      rates,
    ),
    null,
  );
});
