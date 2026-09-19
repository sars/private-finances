import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from '../src/database.js';
import { FxRates, initializeFxRates } from '../src/fx-rates.js';
import {
  eachDate,
  fxCoverage,
  initializeFxCoverage,
  provenEmptyDates,
  recordFxAbsence,
} from '../src/fx-coverage.js';
import { MINFIN_SOURCE, PRIVATBANK_SOURCE } from '../src/fx-sources.js';
import { missingReasonSentence } from '../src/fx-status.js';

const quote = (source: string, asOf: string) => ({
  source,
  base: 'EUR',
  target: 'UAH',
  rate: '48.86',
  asOf,
  retrievedAt: '2025-10-28T00:00:00Z',
  version: 1,
  provenance: `${source} quote for the test`,
});

/**
 * The distinction the whole strip exists for.
 *
 * A day nobody published will never fill, and drawing it as a warning would put
 * an alarm on the page that is on for ever — which is an alarm nobody reads. A
 * day the sync has not reached is a real failure the owner can act on. They are
 * only distinguishable because a source that answered "nothing" says so out
 * loud and that answer is kept.
 */
test('a day proven empty is not the same as a day nobody has asked about', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    await initializeFxCoverage(db);
    const rates = new FxRates(db);
    await rates.insert(quote(PRIVATBANK_SOURCE, '2025-10-25'));
    await rates.insert(quote(MINFIN_SOURCE, '2025-10-27'));
    // Asked, and both said nothing.
    for (const source of [PRIVATBANK_SOURCE, MINFIN_SOURCE])
      await recordFxAbsence(
        db,
        source,
        '2025-10-26',
        '2025-10-28T00:00:00Z',
        'nothing published',
      );
    // Asked of one source only: still waiting on the other, not yet proven.
    await recordFxAbsence(
      db,
      PRIVATBANK_SOURCE,
      '2025-10-28',
      '2025-10-29T00:00:00Z',
      'nothing published',
    );
    assert.deepEqual(await fxCoverage(db, '2025-10-25', '2025-10-29'), [
      { date: '2025-10-25', state: 'covered' },
      { date: '2025-10-26', state: 'empty_at_source' },
      // The secondary source alone is enough to make the day covered.
      { date: '2025-10-27', state: 'covered' },
      { date: '2025-10-28', state: 'not_fetched' },
      { date: '2025-10-29', state: 'not_fetched' },
    ]);
  } finally {
    await db.close();
  }
});

test('re-asking a day that is still empty updates the record rather than failing', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    await initializeFxCoverage(db);
    await initializeFxCoverage(db);
    for (const at of ['2025-10-28T00:00:00Z', '2025-11-28T00:00:00Z'])
      for (const source of [PRIVATBANK_SOURCE, MINFIN_SOURCE])
        await recordFxAbsence(db, source, '2025-10-26', at, 'still nothing');
    assert.deepEqual(await fxCoverage(db, '2025-10-26', '2025-10-26'), [
      { date: '2025-10-26', state: 'empty_at_source' },
    ]);
    await assert.rejects(
      recordFxAbsence(
        db,
        PRIVATBANK_SOURCE,
        '2025-13-01',
        '2025-10-28T00:00:00Z',
        'nothing',
      ),
      /invalid_fx_absence/,
    );
  } finally {
    await db.close();
  }
});

test('the range covers every calendar day, month ends and leap days included', () => {
  assert.deepEqual(eachDate('2026-02-27', '2026-03-01'), [
    '2026-02-27',
    '2026-02-28',
    '2026-03-01',
  ]);
  assert.equal(eachDate('2024-02-01', '2024-03-01').length, 30);
  assert.deepEqual(eachDate('2025-10-26', '2025-10-26'), ['2025-10-26']);
  assert.throws(() => eachDate('2025-10-27', '2025-10-26'), /invalid/);
});

test('a reason is a sentence, and one nobody wrote a sentence for stays itself', () => {
  assert.equal(
    missingReasonSentence('no_matching_quote'),
    'No rate published for this day',
  );
  assert.equal(
    missingReasonSentence('stale_transaction'),
    'Changed while loading — reload',
  );
  assert.equal(missingReasonSentence('something_new'), 'something_new');
});

test('a day both sources have settled is not asked about again', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    await initializeFxCoverage(db);
    // Only the primary has answered: the day is still outstanding.
    await recordFxAbsence(
      db,
      PRIVATBANK_SOURCE,
      '2025-10-28',
      '2025-10-29T00:00:00Z',
      'nothing published',
    );
    assert.deepEqual([...(await provenEmptyDates(db))], []);
    for (const source of [PRIVATBANK_SOURCE, MINFIN_SOURCE])
      await recordFxAbsence(
        db,
        source,
        '2025-10-26',
        '2025-10-27T00:00:00Z',
        'nothing published',
      );
    assert.deepEqual([...(await provenEmptyDates(db))], ['2025-10-26']);
  } finally {
    await db.close();
  }
});
