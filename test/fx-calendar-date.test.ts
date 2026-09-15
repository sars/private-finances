import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  memoryDatabase,
  postgresDatabase,
  type Database,
} from '../src/database.js';
import {
  FxRates,
  initializeFxRates,
  convertWithDailyRates,
} from '../src/fx-rates.js';

async function calendarDates(db: Database) {
  const previous = process.env.TZ;
  try {
    await initializeFxRates(db);
    const service = new FxRates(db);
    for (const timezone of ['UTC', 'Europe/Riga']) {
      process.env.TZ = timezone;
      for (const date of [
        '2026-03-29',
        '2026-03-31',
        '2026-04-01',
        '2026-10-25',
        '2026-12-31',
      ]) {
        for (const base of ['EUR', 'USD']) {
          const input = {
            source: 'synthetic-calendar',
            base,
            target: 'UAH',
            rate: base === 'EUR' ? '50' : '40',
            asOf: date,
            retrievedAt: '2027-01-01T00:00:00Z',
            version: 1,
            provenance: 'Synthetic daily test quote',
          };
          const inserted = await service.insert(input);
          assert.equal(inserted.asOf, date);
          assert.deepEqual(await service.insert(input), inserted);
        }
        const rates = await service.list(date, date);
        assert.equal(rates.length, 2);
        assert.ok(rates.every((r) => r.asOf === date));
        for (const [currency, targetCurrency, amountMinor, expected] of [
          ['EUR', 'UAH', '-100', '-5000'],
          ['UAH', 'EUR', '-5000', '-100'],
          ['EUR', 'USD', '-100', '-125'],
        ]) {
          const result = convertWithDailyRates(
            {
              currency: currency!,
              targetCurrency: targetCurrency!,
              amountMinor: amountMinor!,
              occurredAt: date + 'T00:30:00Z',
            },
            rates,
          );
          assert.equal(result.status, 'converted');
          if (result.status === 'converted') {
            assert.equal(result.amountMinor, expected);
            assert.equal(result.provenance.asOf, date);
          }
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
    await db.close();
  }
}
test('calendar quotes survive UTC/Riga, DST and month/year boundaries', () =>
  calendarDates(memoryDatabase()));
test(
  'PostgreSQL DATE quotes preserve calendar labels through the real driver',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = postgresDatabase(process.env.TEST_DATABASE_URL!);
    const schema = 'fx_' + randomUUID().replaceAll('-', '');
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-csearch_path=${schema}`);
      await calendarDates(postgresDatabase(url.toString()));
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  },
);
