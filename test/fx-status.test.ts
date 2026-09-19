import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { FxRates } from '../src/fx-rates.js';
import { recordFxAbsence } from '../src/fx-coverage.js';
import { MINFIN_SOURCE, PRIVATBANK_SOURCE } from '../src/fx-sources.js';
import { fxConversionStatus } from '../src/fx-status.js';

const quote = (source: string, asOf: string) => ({
  source,
  base: 'UAH',
  target: 'EUR',
  rate: '0.02',
  asOf,
  retrievedAt: '2025-10-28T00:00:00Z',
  version: 1,
  provenance: `${source} quote for the test`,
});

/**
 * The shape of the whole page, on the ledger it was measured against: a day
 * nobody published, the payments booked on it, and everything else converting.
 */
async function ledger() {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([
    // Monobank's own converted figure: needs no daily rate at all.
    {
      source: 'monobank',
      sourceId: 'a',
      accountId: 'a',
      owner: 'rodion',
      bookedAt: '2025-10-25T09:00:00Z',
      currency: 'UAH',
      amountMinor: '-45000',
      description: 'Bank converted',
      sourceDetails: {
        amount: -45000,
        operationAmount: -900,
        currencyCode: 978,
      },
    },
    // Priced by the stored daily rate for the 25th.
    {
      source: 'monobank',
      sourceId: 'b',
      accountId: 'a',
      owner: 'rodion',
      bookedAt: '2025-10-25T10:00:00Z',
      currency: 'UAH',
      amountMinor: '-30000',
      description: 'Daily estimate',
    },
    // Already in the display currency.
    {
      source: 'enablebanking',
      sourceId: 'c',
      accountId: 'c',
      owner: 'katya',
      bookedAt: '2025-10-25T11:00:00Z',
      currency: 'EUR',
      amountMinor: '-1000',
      description: 'Already EUR',
    },
    // The Sunday nobody published a rate for.
    {
      source: 'monobank',
      sourceId: 'd',
      accountId: 'a',
      owner: 'rodion',
      bookedAt: '2025-10-26T12:00:00Z',
      currency: 'UAH',
      amountMinor: '-45000',
      description: 'No rate that day',
    },
  ]);
  return { db, repo };
}

test('a day nothing published leaves its payments visible, listed and uncounted', async () => {
  const { db, repo } = await ledger();
  try {
    await new FxRates(db).insert(quote(PRIVATBANK_SOURCE, '2025-10-25'));
    for (const source of [PRIVATBANK_SOURCE, MINFIN_SOURCE])
      await recordFxAbsence(
        db,
        source,
        '2025-10-26',
        '2025-10-27T00:00:00Z',
        'nothing published',
      );
    const status = await fxConversionStatus(
      repo,
      await repo.list(),
      'EUR',
      '2025-10-26',
    );
    assert.equal(status.currency, 'EUR');
    // Every count covers the same four rows: personal or not, pending or not.
    assert.equal(status.conversions.total, 4);
    assert.equal(status.conversions.converted, 3);
    assert.equal(status.conversions.missing, 1);
    assert.deepEqual(status.conversions.method, {
      bank: 1,
      daily: 1,
      identity: 1,
    });
    // Listed as itself, in the currency it was paid in. There is no converted
    // figure, and a zero would be a lie rather than an absence.
    assert.equal(status.unconverted.length, 1);
    const [row] = status.unconverted;
    assert.equal(row!.currency, 'UAH');
    assert.equal(row!.amountMinor, '-45000');
    assert.equal(row!.reason, 'No rate published for this day');
    assert.equal(row!.bookedAt.slice(0, 10), '2025-10-26');
    // The account by the name the owner recognises, not the integration's.
    assert.match(row!.account.name, /^Rodion · Monobank/);
    assert.equal(status.unconvertedCapped, false);
    assert.deepEqual(status.rates.days, [
      { date: '2025-10-25', state: 'covered' },
      { date: '2025-10-26', state: 'empty_at_source' },
    ]);
    assert.equal(status.rates.covered, 1);
    assert.equal(status.rates.needed, 2);
    assert.equal(status.rates.current, '2025-10-25');
    assert.deepEqual(status.rates.sources, [
      { source: PRIVATBANK_SOURCE, days: 1 },
    ]);
    // A page about rates shows one. The pair, the figure and where it came from.
    assert.deepEqual(status.rates.latest, [
      {
        base: 'UAH',
        target: 'EUR',
        rate: '0.02',
        source: PRIVATBANK_SOURCE,
        asOf: '2025-10-25',
      },
    ]);
    // The page is counts and failures. The ledger itself stays on the server.
    assert.deepEqual(Object.keys(status).sort(), [
      'conversions',
      'currency',
      'rates',
      'unconverted',
      'unconvertedCapped',
    ]);
  } finally {
    await db.close();
  }
});

test('the secondary source closes the gap and the ledger reports full coverage', async () => {
  const { db, repo } = await ledger();
  try {
    const rates = new FxRates(db);
    await rates.insert(quote(PRIVATBANK_SOURCE, '2025-10-25'));
    // The day PrivatBank published nothing, filled by the bank average.
    await rates.insert(quote(MINFIN_SOURCE, '2025-10-26'));
    await recordFxAbsence(
      db,
      PRIVATBANK_SOURCE,
      '2025-10-26',
      '2025-10-27T00:00:00Z',
      'nothing published',
    );
    const status = await fxConversionStatus(
      repo,
      await repo.list(),
      'EUR',
      '2025-10-26',
    );
    assert.equal(status.conversions.missing, 0);
    assert.equal(status.conversions.converted, 4);
    assert.deepEqual(status.unconverted, []);
    assert.equal(status.rates.covered, 2);
    assert.equal(status.rates.needed, 2);
    assert.equal(status.rates.current, '2025-10-26');
    assert.ok(status.rates.days.every((day) => day.state === 'covered'));
  } finally {
    await db.close();
  }
});

/**
 * The rate side is the only thing that can show the nightly sync is alive. Most
 * recent spending carries the bank's own converted amount and needs no daily
 * rate, so a sync that died tonight would break nothing visible for weeks. The
 * days between the last stored quote and today are what says so the next
 * morning.
 */
test('days since the last stored quote show as unfetched, not as empty', async () => {
  const { db, repo } = await ledger();
  try {
    const rates = new FxRates(db);
    await rates.insert(quote(PRIVATBANK_SOURCE, '2025-10-25'));
    await rates.insert(quote(MINFIN_SOURCE, '2025-10-26'));
    const status = await fxConversionStatus(
      repo,
      await repo.list(),
      'EUR',
      '2025-10-29',
    );
    assert.equal(status.rates.to, '2025-10-29');
    assert.equal(status.rates.current, '2025-10-26');
    assert.deepEqual(
      status.rates.days.map((day) => day.state),
      ['covered', 'covered', 'not_needed', 'not_needed', 'not_fetched'],
    );
    assert.equal(status.rates.covered, 2);
    // 27 and 28 October carry no payment, so they need no rate and are not
    // counted; only the 29th, which the sync asks about as today, is a gap.
    assert.equal(status.rates.needed, 3);
    assert.deepEqual(
      status.rates.sources,
      [
        { source: PRIVATBANK_SOURCE, days: 1 },
        { source: MINFIN_SOURCE, days: 1 },
      ],
      'most trusted source first, not alphabetical',
    );
  } finally {
    await db.close();
  }
});

/**
 * The failure this was written for: the nightly sync only ever asks about days
 * that carry a payment, so counting the days it deliberately skips as gaps left
 * two cells amber on the real page with nothing able to clear them. A warning
 * that cannot be acted on is the one kind this page must never show.
 */
test('a day with no payments needs no rate and is not counted as a gap', async () => {
  const { db, repo } = await ledger();
  try {
    const rates = new FxRates(db);
    await rates.insert(quote(PRIVATBANK_SOURCE, '2025-10-25'));
    await rates.insert(quote(MINFIN_SOURCE, '2025-10-26'));
    const status = await fxConversionStatus(
      repo,
      await repo.list(),
      'EUR',
      '2025-10-31',
    );
    // 27 to 30 October hold no payment at all; 31 October is today, which the
    // sync always asks about, so it is the only real gap.
    assert.deepEqual(
      status.rates.days.map((day) => day.state),
      [
        'covered',
        'covered',
        'not_needed',
        'not_needed',
        'not_needed',
        'not_needed',
        'not_fetched',
      ],
    );
    assert.equal(status.rates.needed, 3);
    assert.equal(status.rates.covered, 2);
  } finally {
    await db.close();
  }
});
