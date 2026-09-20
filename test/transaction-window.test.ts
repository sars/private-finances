import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { filterTransactions, parseFilters } from '../src/filters.js';

/**
 * The window the database applies and the window the filters apply must be the
 * same window.
 *
 * Home and Analytics send a period and the server used to read the whole
 * ledger before dropping what fell outside it. Now the period reaches SQL, and
 * the only thing that makes that safe is that the two agree exactly — at the
 * edges, where a Riga day is not a UTC day, and across the October clock
 * change, where it is not even a fixed offset from one.
 */
const at = (bookedAt: string, sourceId: string) => ({
  source: 'window-test',
  sourceId,
  accountId: 'a',
  owner: 'rodion' as const,
  bookedAt,
  currency: 'EUR',
  amountMinor: '-1000',
  description: sourceId,
});

test('the windowed query returns what the filters would have kept', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    const repo = new Repository(db);
    await repo.importBatch([
      // Riga is UTC+3 in summer. 20:59:59Z is 23:59:59 on the 30th.
      at('2026-09-30T20:59:59.000Z', 'september-last-second'),
      // One second later is midnight on 1 October, a different month.
      at('2026-09-30T21:00:00.000Z', 'october-first-second'),
      at('2026-10-10T12:00:00.000Z', 'october-middle'),
      // The clock goes back on 25 October: 00:30Z is 03:30 local, still the
      // 25th, but the offset either side of it is not the same.
      at('2026-10-25T00:30:00.000Z', 'october-clock-change'),
      // Riga is UTC+2 by the end of the month. 21:59:59Z is 23:59:59 local.
      at('2026-10-31T21:59:59.000Z', 'october-last-second'),
      // And one second later is November.
      at('2026-10-31T22:00:00.000Z', 'november-first-second'),
    ]);

    const filters = parseFilters(
      new URLSearchParams({ from: '2026-10-01', to: '2026-10-31' }),
    );
    const windowed = await repo.listWindow('rodion', filters.from, filters.to);
    const filtered = filterTransactions(await repo.list('rodion'), filters);

    const ids = (rows: { description: string }[]) =>
      rows.map((row) => row.description).sort();
    assert.deepEqual(
      ids(windowed),
      ids(filtered),
      'the database and the filters must choose the same payments',
    );
    assert.deepEqual(ids(windowed), [
      'october-clock-change',
      'october-first-second',
      'october-last-second',
      'october-middle',
    ]);

    // An open-ended window is still a window, and no window is everything.
    assert.equal((await repo.listWindow('rodion')).length, 6);
    assert.equal(
      (await repo.listWindow('rodion', '2026-10-01')).length,
      5,
      'from alone keeps everything after it',
    );
    assert.equal(
      (await repo.listWindow('rodion', undefined, '2026-09-30')).length,
      1,
      'to alone keeps everything before it',
    );
  } finally {
    await db.close();
  }
});
