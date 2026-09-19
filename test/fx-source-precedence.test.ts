import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from '../src/database.js';
import {
  FxRates,
  initializeFxRates,
  convertWithDailyRates,
} from '../src/fx-rates.js';
import {
  MINFIN_SOURCE,
  PRIVATBANK_SOURCE,
  compareFxSources,
  fxSourceRank,
} from '../src/fx-sources.js';

const quote = (source: string, rate: string) => ({
  source,
  base: 'UAH',
  target: 'EUR',
  rate,
  asOf: '2025-10-26',
  retrievedAt: '2025-10-27T00:00:00Z',
  version: 1,
  provenance: `${source} quote for the test`,
});

/**
 * The trap this exists for: `Minfin bank average midpoint` sorts before
 * `PrivatBank commercial midpoint`, so the moment a second source was added an
 * alphabetical winner would have quietly demoted the owner's approved primary
 * for every date both of them cover. Reading the code would not have caught it;
 * the two names look unrelated to the ordering.
 */
test('the primary source wins a date the secondary one also covers', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    const rates = new FxRates(db);
    // Stored secondary first, so insertion order cannot be what decides.
    await rates.insert(quote(MINFIN_SOURCE, '0.0205'));
    await rates.insert(quote(PRIVATBANK_SOURCE, '0.0200'));
    const stored = await rates.list('2025-10-26', '2025-10-26');
    const result = convertWithDailyRates(
      {
        amountMinor: '-45000',
        currency: 'UAH',
        targetCurrency: 'EUR',
        occurredAt: '2025-10-26T10:00:00Z',
      },
      stored,
    );
    assert.equal(result.status, 'converted');
    if (result.status !== 'converted') return;
    assert.equal(result.provenance.source, PRIVATBANK_SOURCE);
    // 450.00 UAH at 0.0200, not at the secondary source's 0.0205.
    assert.equal(result.amountMinor, '-900');
  } finally {
    await db.close();
  }
});

test('the secondary source is used on a date the primary one left empty', async () => {
  const db = memoryDatabase();
  try {
    await initializeFxRates(db);
    const rates = new FxRates(db);
    await rates.insert(quote(MINFIN_SOURCE, '0.0205'));
    const result = convertWithDailyRates(
      {
        amountMinor: '-45000',
        currency: 'UAH',
        targetCurrency: 'EUR',
        occurredAt: '2025-10-26T10:00:00Z',
      },
      await rates.list('2025-10-26', '2025-10-26'),
    );
    assert.equal(result.status, 'converted');
    if (result.status !== 'converted') return;
    assert.equal(result.provenance.source, MINFIN_SOURCE);
  } finally {
    await db.close();
  }
});

test('a source nobody ranked sorts after both declared ones', () => {
  assert.equal(fxSourceRank(PRIVATBANK_SOURCE), 0);
  assert.equal(fxSourceRank(MINFIN_SOURCE), 1);
  assert.ok(fxSourceRank('Anything else') > fxSourceRank(MINFIN_SOURCE));
  // Alphabetically 'A...' would come first. Precedence is not the alphabet.
  assert.ok(compareFxSources(PRIVATBANK_SOURCE, 'Anything else') < 0);
  assert.ok(compareFxSources(PRIVATBANK_SOURCE, MINFIN_SOURCE) < 0);
  assert.ok(compareFxSources('Alpha', 'Beta') < 0);
});
