import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Holdings } from '../src/holdings.js';
import { importHoldings, parseImportDocument } from '../src/holdings-import.js';

const document = {
  holdings: [
    {
      name: 'Wallet USD',
      denomination: 'USD',
      kind: 'cash',
      invested: false,
      liquid: true,
    },
    {
      name: 'Card UAH',
      denomination: 'UAH',
      kind: 'bank',
      invested: false,
      liquid: true,
    },
    {
      name: 'World fund',
      denomination: 'VWRL',
      kind: 'broker',
      invested: true,
      liquid: true,
      group: 'Broker',
    },
    {
      name: 'Flat',
      denomination: 'USD',
      kind: 'real_estate',
      invested: true,
      liquid: false,
    },
  ],
  snapshots: [
    { name: 'Wallet USD', asOf: '2025-11-28', quantity: '1000' },
    { name: 'Wallet USD', asOf: '2025-12-26', quantity: '900' },
    { name: 'Card UAH', asOf: '2025-11-28', quantity: '42000' },
    { name: 'World fund', asOf: '2025-11-28', quantity: '10' },
    { name: 'Flat', asOf: '2025-11-28', quantity: '100000' },
    { name: 'Flat', asOf: '2025-12-26', quantity: '0' },
  ],
  prices: [
    { symbol: 'UAH', asOf: '2025-11-28', usdPerUnit: '0.025' },
    { symbol: 'UAH', asOf: '2025-12-26', usdPerUnit: '0.024' },
    { symbol: 'VWRL', asOf: '2025-11-28', usdPerUnit: '120' },
    { symbol: 'USD', asOf: '2025-11-28', usdPerUnit: '1' },
  ],
};

test('a prepared document is validated for shape, loaded once, and a second run changes nothing', async () => {
  for (const broken of [
    null,
    { holdings: [], snapshots: [] },
    {
      ...document,
      holdings: [
        { name: 'x', denomination: 'USD', invested: 'no', liquid: true },
      ],
    },
    { ...document, holdings: [...document.holdings, document.holdings[0]] },
    {
      ...document,
      snapshots: [{ name: 'Unknown', asOf: '2025-11-28', quantity: '1' }],
    },
    {
      ...document,
      snapshots: [{ name: 'Flat', asOf: '2025-11-28', quantity: '1e3' }],
    },
    {
      ...document,
      prices: [{ symbol: 'UAH', asOf: '2025-11-28', usdPerUnit: 0.025 }],
    },
    { ...document, holdings: [{ ...document.holdings[0], kind: 'castle' }] },
  ])
    assert.throws(() => parseImportDocument(broken), /import_/);
  const db = memoryDatabase();
  try {
    await migrate(db);
    const first = await importHoldings(db, parseImportDocument(document));
    assert.deepEqual(first, {
      holdingsCreated: 4,
      holdingsSeen: 4,
      snapshotsWritten: 6,
      snapshotsUnchanged: 0,
      pricesWritten: 3,
      pricesUnchanged: 0,
    });
    const second = await importHoldings(db, parseImportDocument(document));
    assert.deepEqual(second, {
      holdingsCreated: 0,
      holdingsSeen: 4,
      snapshotsWritten: 0,
      snapshotsUnchanged: 6,
      pricesWritten: 0,
      pricesUnchanged: 3,
    });
    const service = new Holdings(db);
    assert.equal((await service.list()).length, 4);
    assert.deepEqual(await service.snapshotDates(), [
      '2025-11-28',
      '2025-12-26',
    ]);
    const report = await service.report('USD');
    assert.equal(report.at, '2025-12-26');
    // 900 + 42,000 × 0.024 (carried) + 10 × 120 (price carried? no: a week too old) + 0
    assert.equal(report.totals.missing, 1);
    assert.equal(report.totals.totalMinor, '190800');
    assert.equal(report.previous!.totalMinor, '10325000'); // 1,000 + 1,050 + 1,200 + 100,000
    assert.equal(report.previous!.missing, 0);
    // A corrected figure on a later run is a new version, not an overwrite.
    const corrected = await importHoldings(
      db,
      parseImportDocument({
        ...document,
        snapshots: [
          { name: 'Wallet USD', asOf: '2025-12-26', quantity: '950' },
        ],
        prices: [],
      }),
    );
    assert.equal(corrected.snapshotsWritten, 1);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM holding_snapshots WHERE as_of='2025-12-26' AND quantity IN ('900','950')",
          )
        ).rows[0]!.n,
      ),
      2,
    );
    assert.equal((await service.report('USD')).totals.totalMinor, '195800');
  } finally {
    await db.close();
  }
});
