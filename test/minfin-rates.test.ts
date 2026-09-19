import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MinfinRateError,
  minfinRateUrl,
  parseMinfinRate,
} from '../src/minfin-rates.js';
import { MINFIN_SOURCE } from '../src/fx-sources.js';

/**
 * The shape Minfin's rates page actually has, reduced to the parts the parser
 * reads: the date picker that proves which day was served, and the average row
 * whose two commercial cells carry `type="average"`. The National Bank column
 * beside them deliberately does not, which is why the parser can never pick it
 * up by accident.
 */
const page = (
  date: string,
  currency = 'eur',
  buy = '48,5462',
  sell = '49,17463',
  nbu = '48,5502',
) => `<!DOCTYPE html><html><body>
<input type="date" name="currency-datepicker" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" value="${date}" min="2006-01-04" max="2026-09-19" class="tjc6dx-7">
<div class="bvp3d3-2">Середній курс в банках</div>
<table><thead><tr><th type="average">Валюта</th><th type="average">Купівля</th><th type="average">Продаж</th><th type="average">Курс НБУ</th></tr></thead>
<tbody><tr>
<td type="average"><a href="/ua/currency/banks/${currency}/${date}/" class="sc-1x32wa2-8">${currency.toUpperCase()}</a></td>
<td class="sc-1x32wa2-9"><div type="average" class="sc-1x32wa2-10">${buy}<div data-tip-target="true"><p class="sc-1x32wa2-13">0.01</p></div></div></td>
<td class="sc-1x32wa2-9"><div type="average" class="sc-1x32wa2-10">${sell}<div data-tip-target="true"><p class="sc-1x32wa2-13">-0.01</p></div></div></td>
<td class="sc-1x32wa2-9"><div class="sc-1x32wa2-10">${nbu}<div><p class="sc-1x32wa2-13">0.00</p></div></div></td>
</tr></tbody></table></body></html>`;

test('the average of the banks becomes one midpoint quote for the day', () => {
  const rate = parseMinfinRate(
    page('2025-10-26'),
    'EUR',
    '2025-10-26',
    '2026-09-19T12:00:00Z',
  );
  assert.equal(rate.source, MINFIN_SOURCE);
  assert.equal(rate.base, 'EUR');
  assert.equal(rate.target, 'UAH');
  // (48.5462 + 49.17463) / 2, exactly, without touching a binary float.
  assert.equal(rate.rate, '48.860415');
  assert.equal(rate.asOf, '2025-10-26');
  // Decimal text, exactly as published, only with Minfin's comma written as a
  // point: the provenance has to be readable back as a number.
  assert.match(rate.provenance, /buy=48\.5462/);
  assert.match(rate.provenance, /sell=49\.17463/);
  assert.match(rate.provenance, /not the National Bank reference/);
  // The National Bank's own number is in the page and never reaches the quote.
  assert.ok(!rate.provenance.includes('48,5502'));
  assert.ok(!rate.provenance.includes('48.5502'));
  assert.equal(
    minfinRateUrl('EUR', '2025-10-26'),
    'https://minfin.com.ua/ua/currency/banks/eur/2025-10-26/',
  );
});

/**
 * Minfin serves the current day's rates for a URL it does not recognise. Storing
 * those against a date in October would be a fabricated rate wearing a real
 * one's clothes, so the page has to prove which day it is before it is read.
 */
test('a page for a different day than the one asked for is refused', () => {
  assert.throws(
    () =>
      parseMinfinRate(
        page('2026-09-19'),
        'EUR',
        '2025-10-26',
        '2026-09-19T12:00:00Z',
      ),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_response',
  );
});

test('a page for a different currency than the one asked for is refused', () => {
  assert.throws(
    () =>
      parseMinfinRate(
        page('2025-10-26', 'usd'),
        'EUR',
        '2025-10-26',
        '2026-09-19T12:00:00Z',
      ),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_response',
  );
});

test('a layout that no longer matches makes the day unavailable, not a guess', () => {
  const moved = page('2025-10-26').replace(/type="average"/g, 'type="rate"');
  assert.throws(
    () =>
      parseMinfinRate(moved, 'EUR', '2025-10-26', '2026-09-19T12:00:00Z'),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_response',
  );
  assert.throws(
    () =>
      parseMinfinRate(
        page('2025-10-26').replace('Середній курс в банках', 'Курс у банках'),
        'EUR',
        '2025-10-26',
        '2026-09-19T12:00:00Z',
      ),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_response',
  );
});

test('a sell below the buy is a misread page, not a rate', () => {
  assert.throws(
    () =>
      parseMinfinRate(
        page('2025-10-26', 'eur', '49,17463', '48,5462'),
        'EUR',
        '2025-10-26',
        '2026-09-19T12:00:00Z',
      ),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_response',
  );
});

test('a date before the published archive, or in the future, is not asked for', () => {
  assert.throws(
    () =>
      parseMinfinRate(
        page('2005-01-01'),
        'EUR',
        '2005-01-01',
        '2026-09-19T12:00:00Z',
      ),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_date',
  );
  assert.throws(
    () =>
      parseMinfinRate(
        page('2026-09-20'),
        'EUR',
        '2026-09-20',
        '2026-09-19T12:00:00Z',
      ),
    (error: unknown) =>
      error instanceof MinfinRateError && error.code === 'invalid_date',
  );
});
