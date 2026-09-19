import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MinfinRateError,
  averageMidpoint,
  minfinRateUrl,
  parseMinfinRates,
} from '../src/minfin-rates.js';
import { MINFIN_SOURCE } from '../src/fx-sources.js';

/**
 * The shape Minfin's own JSON has, reduced to what the parser reads. This is
 * the endpoint the site itself calls: free, unauthenticated, and carrying the
 * per-bank breakdown that the rendered page never showed.
 *
 * Values arrive as quoted strings, which is why no number here ever passes
 * through a float.
 */
const bank = (
  slug: string,
  bid: string | null,
  ask: string | null,
  date = '2025-10-26T22:41:28+02:00',
) => ({
  slug,
  name_uk: slug,
  cash: { date, bid: '1', ask: '2' },
  card: bid === null ? { date, bid: null, ask: null } : { date, bid, ask },
});
const body = (banks: unknown[]) =>
  JSON.stringify({ data: banks, meta: { page: 1, cpp: 100, total: 5 } });

/** The four banks' real card quotes for the Sunday PrivatBank published nothing. */
const sunday = body([
  bank('sensebank', '47.3', '0'), // ask of zero is not a quote
  bank('privatbank', '48.52', '49.2611'),
  bank('oschadbank', '48.5', '49.45'), // not one of the four
  bank('a-bank', '48.4', '49.15'),
  bank('monobank', '48.55', '49.249'),
]);

test('the four banks that published become one averaged midpoint', () => {
  const rates = parseMinfinRates(
    sunday,
    'EUR',
    '2025-10-26',
    '2026-09-19T12:00:00Z',
  );
  assert.equal(rates.length, 1);
  const [rate] = rates;
  assert.equal(rate!.source, MINFIN_SOURCE);
  assert.equal(rate!.base, 'EUR');
  assert.equal(rate!.target, 'UAH');
  // (48.52+49.2611 + 48.4+49.15 + 48.55+49.249) / 6, exactly.
  assert.equal(rate!.rate, '48.855017');
  assert.equal(rate!.asOf, '2025-10-26');
  // Provenance names who contributed, so a day carried by one bank is visible
  // as exactly that rather than hiding behind the word "average".
  assert.match(rate!.provenance, /3 of 4 household banks/);
  assert.match(rate!.provenance, /a-bank 48\.4\/49\.15/);
  assert.match(rate!.provenance, /monobank 48\.55\/49\.249/);
  assert.match(rate!.provenance, /privatbank 48\.52\/49\.2611/);
  // A bank outside the four never contributes, however good its quote.
  assert.ok(!rate!.provenance.includes('oschadbank'));
  // Nor does a bank whose card quote is not a quote.
  assert.ok(!rate!.provenance.includes('sensebank'));
  assert.equal(
    minfinRateUrl('EUR', '2025-10-26'),
    'https://minfin.com.ua/api/currency/rates/banks/eur/?page=1&cpp=100&date=2025-10-26&commercial_sort=true',
  );
});

/**
 * Some banks' entries are stamped the following day. That is the next day's
 * rate, and filing it under this one would be a real number against a date it
 * does not belong to.
 */
test('a quote stamped another day belongs to that day, not this one', () => {
  const rates = parseMinfinRates(
    body([
      bank('monobank', '48.55', '49.249', '2025-10-27T09:00:00+02:00'),
      bank('privatbank', '48.52', '49.2611'),
    ]),
    'EUR',
    '2025-10-26',
    '2026-09-19T12:00:00Z',
  );
  assert.equal(rates.length, 1);
  assert.match(rates[0]!.provenance, /1 of 4 household banks/);
  assert.ok(!rates[0]!.provenance.includes('monobank'));
  // One bank's midpoint, unaveraged, and stated as one bank's.
  assert.equal(rates[0]!.rate, '48.89055');
});

test('a day none of the four published is answered with nothing at all', () => {
  assert.deepEqual(
    parseMinfinRates(
      body([bank('oschadbank', '48.5', '49.45'), bank('pumb', '48.5', '49.2')]),
      'EUR',
      '2025-10-26',
      '2026-09-19T12:00:00Z',
    ),
    [],
  );
  assert.deepEqual(
    parseMinfinRates(body([]), 'EUR', '2025-10-26', '2026-09-19T12:00:00Z'),
    [],
  );
});

test('the average is the mean of the midpoints, in exact integer arithmetic', () => {
  // Mean of midpoints and midpoint of means are the same number; neither is a
  // choice this has to make.
  assert.equal(averageMidpoint([{ buy: '10', sell: '20' }]), '15');
  assert.equal(
    averageMidpoint([
      { buy: '10', sell: '20' },
      { buy: '20', sell: '30' },
    ]),
    '20',
  );
  // A mean of three that does not terminate is rounded, not truncated.
  assert.equal(
    averageMidpoint([
      { buy: '1', sell: '1' },
      { buy: '1', sell: '1' },
      { buy: '2', sell: '2' },
    ]),
    '1.333333',
  );
  assert.throws(() => averageMidpoint([]), MinfinRateError);
  // A sell below the buy is a misread response, not a rate.
  assert.throws(
    () => averageMidpoint([{ buy: '20', sell: '10' }]),
    MinfinRateError,
  );
  // Floats never get near it: an unquoted number is refused outright.
  assert.throws(
    () => averageMidpoint([{ buy: 10 as unknown as string, sell: '20' }]),
    MinfinRateError,
  );
});

test('a response that is not the expected envelope is refused', () => {
  for (const raw of ['not json', '[]', '{}', '{"data":{}}', '{"data":null}'])
    assert.throws(
      () => parseMinfinRates(raw, 'EUR', '2025-10-26', '2026-09-19T12:00:00Z'),
      (error: unknown) =>
        error instanceof MinfinRateError && error.code === 'invalid_response',
    );
  // The same bank twice would silently weight it double in the average.
  assert.throws(
    () =>
      parseMinfinRates(
        body([
          bank('monobank', '48.5', '49.2'),
          bank('monobank', '48.6', '49.3'),
        ]),
        'EUR',
        '2025-10-26',
        '2026-09-19T12:00:00Z',
      ),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_response',
  );
});

test('a pair the four banks do not quote, or a date outside the archive, is never asked for', () => {
  // Not one of the four quotes sterling, in cash or on a card, so there is
  // nothing of theirs to average and the pair is not requested at all.
  assert.throws(
    () => minfinRateUrl('GBP', '2025-10-26'),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_date',
  );
  assert.throws(
    () => parseMinfinRates(sunday, 'EUR', '2005-01-01', '2026-09-19T12:00:00Z'),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_date',
  );
  assert.throws(
    () => parseMinfinRates(sunday, 'EUR', '2026-09-20', '2026-09-19T12:00:00Z'),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_date',
  );
});
