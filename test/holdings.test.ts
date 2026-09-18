import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Holdings, initializeHoldings } from '../src/holdings.js';
import { FxRates } from '../src/fx-rates.js';

async function bankRate(
  db: ReturnType<typeof memoryDatabase>,
  base: string,
  rate: string,
  asOf: string,
) {
  await new FxRates(db).insert({
    source: 'synthetic-bank',
    base,
    target: 'UAH',
    rate,
    asOf,
    retrievedAt: `${asOf}T05:00:00Z`,
    version: 1,
    provenance: 'synthetic',
  });
}

test('the holdings migration creates the holdings tables once and a holding is validated, created and revised', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await initializeHoldings(db);
    assert.equal(
      (await db.query('SELECT version FROM schema_versions WHERE version=51'))
        .rows.length,
      1,
    );
    const service = new Holdings(db);
    const base = {
      name: 'Wallet USD',
      kind: 'cash',
      denomination: 'usd',
      invested: 'false',
      liquid: 'true',
    };
    const created = await service.upsert('rodion', base);
    assert.equal(created.denomination, 'USD');
    assert.equal(created.revision, 0);
    assert.equal(created.archived, false);
    for (const [overrides, error] of [
      [{ name: '' }, /holding_invalid_name/],
      [{ kind: 'boat' }, /holding_invalid_kind/],
      [{ denomination: 'not a symbol' }, /holding_invalid_denomination/],
      [{ invested: 'maybe' }, /holding_invalid_flag/],
      [{ owner: 'someone' }, /holding_invalid_owner/],
      [{ maturesOn: '2026-02-30' }, /holding_invalid_date/],
      [{ name: 'Second', id: created.id }, /holding_revision_required/],
      [
        { name: 'Second', id: created.id, revision: 5 },
        /holding_stale_revision/,
      ],
      [
        {
          name: 'Second',
          id: '00000000-0000-4000-8000-000000000000',
          revision: 0,
        },
        /holding_not_found/,
      ],
      [{ name: 'Wallet USD' }, /holding_name_taken/],
    ] as const)
      await assert.rejects(
        service.upsert('rodion', { ...base, ...overrides }),
        error,
      );
    const revised = await service.upsert('katya', {
      ...base,
      id: created.id,
      revision: 0,
      name: 'Wallet USD (safe)',
      kind: 'cash',
      group: 'Cash',
      note: 'Counted on the last Thursday',
      maturesOn: '2027-01-15',
      owner: 'katya',
    });
    assert.equal(revised.revision, 1);
    assert.equal(revised.name, 'Wallet USD (safe)');
    assert.equal(revised.maturesOn, '2027-01-15');
    assert.equal(revised.owner, 'katya');
    assert.equal((await service.list()).length, 1);
    assert.equal((await service.list(false)).length, 1);
    await service.upsert('rodion', {
      ...base,
      id: created.id,
      revision: 1,
      archived: 'true',
    });
    assert.equal((await service.list(false)).length, 0);
    assert.equal((await service.list()).length, 1);
  } finally {
    await db.close();
  }
});

test('snapshots are versioned, converted from a typed currency at that day, and valued with carry-forward', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const service = new Holdings(db);
    const cash = await service.upsert('rodion', {
      name: 'Cash USD',
      kind: 'cash',
      denomination: 'USD',
      invested: false,
      liquid: true,
    });
    const card = await service.upsert('rodion', {
      name: 'Card UAH',
      kind: 'bank',
      denomination: 'UAH',
      invested: false,
      liquid: true,
    });
    const fund = await service.upsert('rodion', {
      name: 'World fund',
      kind: 'broker',
      denomination: 'VWRL',
      invested: true,
      liquid: true,
      group: 'Broker',
    });
    const house = await service.upsert('rodion', {
      name: 'House',
      kind: 'real_estate',
      denomination: 'USD',
      invested: true,
      liquid: false,
    });
    await bankRate(db, 'USD', '40', '2026-08-27');
    await bankRate(db, 'USD', '41', '2026-09-24');
    await bankRate(db, 'EUR', '45.1', '2026-09-24');
    for (const [input, error] of [
      [
        { holdingId: 'nope', asOf: '2026-09-24', amount: '1' },
        /snapshot_invalid_holding/,
      ],
      [
        { holdingId: cash.id, asOf: '2026-9-24', amount: '1' },
        /snapshot_invalid_date/,
      ],
      [
        { holdingId: cash.id, asOf: '2026-09-24', amount: '1e3' },
        /snapshot_invalid_amount/,
      ],
      [
        {
          holdingId: cash.id,
          asOf: '2026-09-24',
          amount: '1',
          currency: 'XYZ',
        },
        /snapshot_invalid_currency/,
      ],
      [
        {
          holdingId: fund.id,
          asOf: '2026-09-24',
          amount: '1',
          currency: 'USD',
        },
        /snapshot_no_rate/,
      ],
    ] as const)
      await assert.rejects(service.recordSnapshot('rodion', input), error);
    const first = await service.recordSnapshot('rodion', {
      holdingId: cash.id,
      asOf: '2026-08-27',
      amount: '1000',
    });
    assert.equal(first.version, 1);
    assert.equal(first.quantity, '1000');
    // The same figure again is the same row; a different one is a new version.
    assert.equal(
      (
        await service.recordSnapshot('rodion', {
          holdingId: cash.id,
          asOf: '2026-08-27',
          amount: '1000.00',
        })
      ).id,
      first.id,
    );
    const corrected = await service.recordSnapshot('katya', {
      holdingId: cash.id,
      asOf: '2026-08-27',
      amount: '1100',
      note: 'Recounted',
    });
    assert.equal(corrected.version, 2);
    assert.equal(corrected.enteredBy, 'katya');
    // Typed in hryvnia on the day the rate is 41: 4,100 UAH is 100 USD.
    const typed = await service.recordSnapshot('rodion', {
      holdingId: cash.id,
      asOf: '2026-09-24',
      amount: '4100',
      currency: 'uah',
    });
    assert.equal(typed.quantity, '100');
    assert.equal(typed.enteredAmount, '4100');
    assert.equal(typed.enteredCurrency, 'UAH');
    // Typed in euro: 1,000 EUR at 45.1 UAH, 41 UAH per USD → 1,100 USD.
    const euro = await service.recordSnapshot('rodion', {
      holdingId: house.id,
      asOf: '2026-09-24',
      amount: '1000',
      currency: 'EUR',
    });
    assert.equal(euro.quantity, '1100');
    await service.recordSnapshot('rodion', {
      holdingId: card.id,
      asOf: '2026-08-27',
      amount: '8200',
    });
    await service.recordSnapshot('rodion', {
      holdingId: fund.id,
      asOf: '2026-08-27',
      amount: '10',
    });
    await assert.rejects(
      service.recordPrice('rodion', {
        symbol: 'VWRL',
        asOf: '2026-09-24',
        usdPerUnit: '0',
      }),
      /price_invalid_value/,
    );
    await assert.rejects(
      service.recordPrice('rodion', {
        symbol: 'USD',
        asOf: '2026-09-24',
        usdPerUnit: '1',
      }),
      /price_invalid_symbol/,
    );
    await service.recordPrice('rodion', {
      symbol: 'vwrl',
      asOf: '2026-09-24',
      usdPerUnit: '120',
    });
    await service.recordPrice('rodion', {
      symbol: 'VWRL',
      asOf: '2026-09-24',
      usdPerUnit: '125',
    });
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM asset_prices WHERE symbol='VWRL'",
        )
      ).rows[0]!.n,
      2,
    );
    assert.deepEqual(await service.snapshotDates(), [
      '2026-08-27',
      '2026-09-24',
    ]);

    const report = await service.report('USD');
    assert.equal(report.at, '2026-09-24');
    assert.deepEqual(report.dates, ['2026-08-27', '2026-09-24']);
    const row = (id: string) => report.rows.find((r) => r.holding.id === id)!;
    assert.equal(row(cash.id).valueMinor, '10000');
    assert.equal(row(cash.id).carried, false);
    assert.equal(row(card.id).valueMinor, '20000'); // 8,200 UAH at 41, carried
    assert.equal(row(card.id).carried, true);
    assert.equal(row(fund.id).valueMinor, '125000'); // latest price version
    assert.equal(row(fund.id).price?.usdPerUnit, '125');
    assert.equal(row(house.id).valueMinor, '110000');
    assert.equal(report.totals.totalMinor, '265000');
    assert.equal(report.totals.investedMinor, '235000');
    assert.equal(report.totals.liquidMinor, '155000');
    assert.equal(report.totals.uahMinor, '20000');
    assert.equal(report.totals.missing, 0);
    // August: the fund has no price within a week, so it is missing, not zero.
    assert.equal(report.previous?.asOf, '2026-08-27');
    assert.equal(report.previous?.missing, 1);
    assert.equal(report.previous?.totalMinor, '130500'); // 1,100 + 8,200/40
    assert.equal(report.series.length, 2);
    // A day with no snapshot of its own shows carried quantities and joins the chart.
    const later = await service.report('UAH', '2026-10-29');
    assert.equal(later.at, '2026-10-29');
    assert.deepEqual(later.dates, ['2026-08-27', '2026-09-24']);
    assert.equal(later.series.length, 3);
    assert.equal(later.totals.missing, 4); // no rate within a week of that day
    assert.equal(
      later.rows.every((r) => r.carried || r.quantity === null),
      true,
    );
    await assert.rejects(service.report('XYZ'), /holdings_invalid_display/);
    await assert.rejects(
      service.report('USD', 'yesterday'),
      /holdings_invalid_date/,
    );
  } finally {
    await db.close();
  }
});

test('deleting a snapshot day removes every version of it, leaves the days around it alone, and keeps the prices', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const service = new Holdings(db);
    const cash = await service.upsert('rodion', {
      name: 'Tin USD',
      kind: 'cash',
      denomination: 'USD',
      invested: false,
      liquid: true,
    });
    const fund = await service.upsert('rodion', {
      name: 'Fund units',
      kind: 'fund',
      denomination: 'VWRL',
      invested: true,
      liquid: true,
    });
    await service.recordPrice('rodion', {
      symbol: 'VWRL',
      asOf: '2026-09-24',
      usdPerUnit: '120',
    });
    await service.recordSnapshot('rodion', {
      holdingId: cash.id,
      asOf: '2026-08-27',
      amount: '1000',
    });
    await service.recordSnapshot('rodion', {
      holdingId: cash.id,
      asOf: '2026-09-24',
      amount: '1200',
    });
    // A correction on the same day is a second version, and it goes too.
    await service.recordSnapshot('katya', {
      holdingId: cash.id,
      asOf: '2026-09-24',
      amount: '1300',
    });
    await service.recordSnapshot('rodion', {
      holdingId: fund.id,
      asOf: '2026-09-24',
      amount: '10',
    });
    for (const bad of ['yesterday', '2026-13-01', '2026-02-30', ''])
      await assert.rejects(service.deleteDay(bad), /snapshot_invalid_date/);
    // A day nobody recorded removes nothing, which is not an error.
    assert.deepEqual(await service.deleteDay('2026-09-01'), { removed: 0 });
    assert.deepEqual(await service.deleteDay('2026-09-24'), { removed: 3 });
    assert.deepEqual(await service.snapshotDates(), ['2026-08-27']);
    assert.equal((await service.snapshots()).length, 1);
    // The price the deleted day valued through says what the symbol was worth,
    // which is true whoever held it, so it stays.
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM asset_prices')).rows[0]!
        .n,
      1,
    );
    // The day is gone from the report, and everything carries from before it.
    const report = await service.report('USD', '2026-09-24');
    assert.deepEqual(report.dates, ['2026-08-27']);
    const row = report.rows.find((r) => r.holding.id === cash.id)!;
    assert.equal(row.quantity, '1000');
    assert.equal(row.carried, true);
    assert.equal(
      report.rows.find((r) => r.holding.id === fund.id)!.quantity,
      null,
    );
  } finally {
    await db.close();
  }
});
