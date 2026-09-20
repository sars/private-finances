/**
 * The invented household's savings, rates and import history.
 *
 * Everything the article shows beyond the payment list. The holdings are the
 * part the owner went through group by group: which may appear at all, and
 * what inside them had to be replaced. The groups kept are the ones this
 * public repository already names as integrations — Binance and Interactive
 * Brokers disclose nothing by being there — but what they hold is invented,
 * because the particular coins and the particular stocks are the household's
 * own business.
 *
 * Groups deliberately absent: everything else the real workspace carries. A
 * generated household has no hole where they were, which is the advantage over
 * deleting them from a copy of the real one: the parts still add up to the
 * whole, and nothing in the article fails to reconcile.
 */
import { randomUUID } from 'node:crypto';
import { isMemoryDatabase, type Database } from './database.js';
import { Holdings } from './holdings.js';
import { AccountBalances } from './account-balances.js';
import { FxRates } from './fx-rates.js';
import { PRIVATBANK_SOURCE } from './fx-sources.js';

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * What the invented household holds.
 *
 * `base` is the opening quantity in the holding's own denomination, and
 * `drift` how much it tends to move each month — enough for the history chart
 * to have a shape rather than a flat line.
 */
type ShowcaseHolding = {
  group: string;
  name: string;
  kind: string;
  denomination: string;
  invested: boolean;
  liquid: boolean;
  owner: string | null;
  base: number;
  drift: number;
  decimals: number;
};
export const SHOWCASE_HOLDINGS: readonly ShowcaseHolding[] = [
  {
    group: 'Monobank',
    name: 'Everyday card',
    kind: 'bank',
    denomination: 'UAH',
    invested: false,
    liquid: true,
    owner: 'rodion',
    base: 48000,
    drift: 6000,
    decimals: 2,
  },
  {
    group: 'Monobank',
    name: 'Set aside',
    kind: 'bank',
    denomination: 'UAH',
    invested: false,
    liquid: true,
    owner: 'katya',
    base: 62000,
    drift: 4000,
    decimals: 2,
  },
  {
    group: 'Wise',
    name: 'Wise balance',
    kind: 'bank',
    denomination: 'EUR',
    invested: false,
    liquid: true,
    owner: 'rodion',
    base: 2400,
    drift: 260,
    decimals: 2,
  },
  {
    group: 'Revolut',
    name: 'Revolut balance',
    kind: 'bank',
    denomination: 'EUR',
    invested: false,
    liquid: true,
    owner: 'katya',
    base: 1150,
    drift: 180,
    decimals: 2,
  },
  {
    group: 'Swedbank',
    name: 'Swedbank current',
    kind: 'bank',
    denomination: 'EUR',
    invested: false,
    liquid: true,
    owner: 'katya',
    base: 3100,
    drift: 220,
    decimals: 2,
  },
  {
    group: 'LHV',
    name: 'LHV current',
    kind: 'bank',
    denomination: 'EUR',
    invested: false,
    liquid: true,
    owner: 'rodion',
    base: 1800,
    drift: 300,
    decimals: 2,
  },
  {
    group: 'Cash',
    name: 'Cash at home',
    kind: 'cash',
    denomination: 'UAH',
    invested: false,
    liquid: true,
    owner: null,
    base: 15000,
    drift: 3000,
    decimals: 2,
  },
  {
    group: 'Cash',
    name: 'Cash euro',
    kind: 'cash',
    denomination: 'EUR',
    invested: false,
    liquid: true,
    owner: null,
    base: 900,
    drift: 150,
    decimals: 2,
  },
  {
    group: 'Cold wallets',
    name: 'Hardware wallet',
    kind: 'crypto',
    denomination: 'BTC',
    invested: true,
    liquid: true,
    owner: null,
    base: 0.14,
    drift: 0.004,
    decimals: 8,
  },
  {
    group: 'Binance',
    name: 'Binance BTC',
    kind: 'crypto',
    denomination: 'BTC',
    invested: true,
    liquid: true,
    owner: 'rodion',
    base: 0.05,
    drift: 0.003,
    decimals: 8,
  },
  {
    group: 'Binance',
    name: 'Binance ETH',
    kind: 'crypto',
    denomination: 'ETH',
    invested: true,
    liquid: true,
    owner: 'rodion',
    base: 1.6,
    drift: 0.08,
    decimals: 8,
  },
  {
    group: 'Binance',
    name: 'Binance SOL',
    kind: 'crypto',
    denomination: 'SOL',
    invested: true,
    liquid: true,
    owner: 'rodion',
    base: 14,
    drift: 0.9,
    decimals: 8,
  },
  {
    group: 'Interactive Brokers',
    name: 'World index fund',
    kind: 'fund',
    denomination: 'IWDA',
    invested: true,
    liquid: true,
    owner: 'rodion',
    base: 62,
    drift: 3,
    decimals: 4,
  },
  {
    group: 'Interactive Brokers',
    name: 'S&P 500 fund',
    kind: 'fund',
    denomination: 'VUAA',
    invested: true,
    liquid: true,
    owner: 'rodion',
    base: 48,
    drift: 2.5,
    decimals: 4,
  },
  {
    group: 'Real estate',
    name: 'Apartment',
    kind: 'real_estate',
    denomination: 'EUR',
    invested: true,
    liquid: false,
    owner: null,
    base: 74000,
    drift: 300,
    decimals: 2,
  },
  {
    group: 'Real estate',
    name: 'Parking space',
    kind: 'real_estate',
    denomination: 'EUR',
    invested: true,
    liquid: false,
    owner: null,
    base: 9000,
    drift: 40,
    decimals: 2,
  },
];

/** Opening price in USD for everything that is not money, and its monthly
 * drift. Invented, like the quantities they multiply. */
const PRICES: Record<string, { base: number; drift: number }> = {
  BTC: { base: 61000, drift: 2600 },
  ETH: { base: 2400, drift: 130 },
  SOL: { base: 118, drift: 9 },
  IWDA: { base: 92, drift: 1.4 },
  VUAA: { base: 98, drift: 1.7 },
};

/** Opening rate against the hryvnia, and its monthly drift. The household
 * holds hryvnia and euro; the dollar is here because the savings are valued
 * in it. */
const FX: Record<string, { base: number; drift: number }> = {
  USD: { base: 40.2, drift: 0.22 },
  EUR: { base: 44.6, drift: 0.3 },
};

/** The first day of the month `back` months before the month `from` is in. */
function monthStart(from: Date, back: number): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - back, 1),
  );
}

/**
 * A daily rate for every day the article can show, from the one source the
 * owner approved as primary. Quotes are immutable, so re-seeding writes
 * nothing it has written before.
 */
export async function seedShowcaseRates(
  db: Database,
  now: Date,
  months: number,
): Promise<number> {
  const random = generator(0x2adeb1);
  const rates = new FxRates(db);
  const start = monthStart(now, months - 1);
  let written = 0;
  for (const [currency, shape] of Object.entries(FX)) {
    let value = shape.base;
    for (
      let day = new Date(start);
      day <= now;
      day = new Date(day.getTime() + 86400000)
    ) {
      value += (random() - 0.45) * (shape.drift / 12);
      await rates.insert({
        source: PRIVATBANK_SOURCE,
        base: currency,
        target: 'UAH',
        rate: value.toFixed(4),
        asOf: isoDate(day),
        retrievedAt: new Date(day.getTime() + 43200000).toISOString(),
        version: 1,
        provenance: 'Showcase household',
      });
      written += 1;
    }
  }
  return written;
}

/**
 * The savings, with a snapshot on the first of every month.
 *
 * A snapshot is a reading of a day, so the history the Assets screen draws is
 * a genuine series rather than one figure repeated. The prices move with it,
 * or every holding denominated in something other than money would be valued
 * today's way for every month in the chart.
 */
export async function seedShowcaseHoldings(
  db: Database,
  now: Date,
  months: number,
): Promise<{ holdings: number; snapshots: number }> {
  const holdings = new Holdings(db);
  const random = generator(0x5a71c5);

  // A reseed replaces the savings rather than adding a second set beside them.
  await db.query('DELETE FROM holding_snapshots');
  await db.query('DELETE FROM holdings');

  const created: Array<{ id: string; shape: ShowcaseHolding }> = [];
  let order = 0;
  for (const shape of SHOWCASE_HOLDINGS) {
    const holding = await holdings.upsert('rodion', {
      name: shape.name,
      kind: shape.kind,
      denomination: shape.denomination,
      invested: shape.invested,
      liquid: shape.liquid,
      owner: shape.owner,
      group: shape.group,
      sortOrder: (order += 10),
    });
    created.push({ id: holding.id, shape });
  }

  let snapshots = 0;
  for (let back = months - 1; back >= 0; back -= 1) {
    const asOf = isoDate(monthStart(now, back));
    const elapsed = months - 1 - back;

    for (const [symbol, shape] of Object.entries(PRICES)) {
      const value = shape.base + shape.drift * elapsed * (0.8 + random() * 0.4);
      await holdings.recordPrice('rodion', {
        symbol,
        asOf,
        usdPerUnit: value.toFixed(4),
      });
    }

    for (const { id, shape } of created) {
      const value = shape.base + shape.drift * elapsed * (0.7 + random() * 0.6);
      await holdings.recordSnapshot('rodion', {
        holdingId: id,
        asOf,
        amount: value.toFixed(shape.decimals),
        source: 'showcase',
      });
      snapshots += 1;
    }
  }
  return { holdings: created.length, snapshots };
}

/**
 * Bank imports that have been running quietly for months.
 *
 * Without these the Bank connections and Imports screens read "no import has
 * run yet", which in an article says the application does not work. The
 * connections are the real integrations, which this repository already names.
 */
export async function seedShowcaseImports(
  db: Database,
  now: Date,
): Promise<number> {
  const connections = [
    'monobank:rodion',
    'monobank:katya',
    'enablebanking:rodion:wise',
    'enablebanking:rodion:revolut',
    'enablebanking:rodion:lhv',
    'enablebanking:katya:swedbank',
  ];
  await db.query('DELETE FROM bank_sync_attempts');
  await db.query('DELETE FROM bank_import_windows');
  await db.query('DELETE FROM bank_sync_runs');

  let written = 0;
  for (const [index, connection] of connections.entries()) {
    // Staggered, because six connections that last succeeded in the same
    // second would read as a fixture rather than as a schedule.
    const last = new Date(now.getTime() - (8 + index * 11) * 60000);
    await db.query(
      `INSERT INTO bank_sync_runs(connection,state,last_success_at)
       VALUES($1,'succeeded',$2)`,
      [connection, last.toISOString()],
    );
    for (let back = 0; back < 6; back += 1) {
      const finished = new Date(last.getTime() - back * 37 * 60000);
      const started = new Date(finished.getTime() - 9000);
      await db.query(
        `INSERT INTO bank_sync_attempts
           (id,connection,started_at,finished_at,from_at,to_at,outcome,accounts,changed)
         VALUES($1,$2,$3,$4,$5,$6,'succeeded',$7,$8)`,
        [
          randomUUID(),
          connection,
          started.toISOString(),
          finished.toISOString(),
          new Date(finished.getTime() - 3 * 86400000).toISOString(),
          finished.toISOString(),
          1 + (index % 3),
          back === 0 ? 2 + (index % 4) : 0,
        ],
      );
      written += 1;
    }
  }
  return written;
}


/**
 * What each bank last reported the accounts held.
 *
 * The balances screen shows stored evidence, never arithmetic over payments:
 * no opening figure exists to sum from, so an unseeded workspace shows zeroes
 * however many payments it holds. They are therefore written here as a
 * connector would have written them, one row per account per currency.
 *
 * These are of the same household as the holdings, but they are not the same
 * reading and are not meant to reconcile to the penny: a balance is what a
 * bank said this morning, a holding is what somebody wrote down on the first
 * of the month. That difference is true of the real workspace too.
 */
const SHOWCASE_BALANCES: ReadonlyArray<{
  source: string;
  accountId: string;
  currency: string;
  amountMinor: string;
}> = [
  {
    source: 'monobank',
    accountId: 'mono-alex-black',
    currency: 'UAH',
    amountMinor: '4812300',
  },
  {
    source: 'monobank',
    accountId: 'mono-alex-iron',
    currency: 'UAH',
    amountMinor: '12648000',
  },
  {
    source: 'monobank',
    accountId: 'mono-alex-fop',
    currency: 'UAH',
    amountMinor: '31204500',
  },
  {
    source: 'enablebanking',
    accountId: 'wise-alex-eur',
    currency: 'EUR',
    amountMinor: '243800',
  },
  {
    source: 'enablebanking',
    accountId: 'revolut-alex-eur',
    currency: 'EUR',
    amountMinor: '86450',
  },
  {
    source: 'enablebanking',
    accountId: 'lhv-alex-eur',
    currency: 'EUR',
    amountMinor: '181200',
  },
  {
    source: 'monobank',
    accountId: 'mono-sam-white',
    currency: 'UAH',
    amountMinor: '6237400',
  },
  {
    source: 'enablebanking',
    accountId: 'wise-sam-eur',
    currency: 'EUR',
    amountMinor: '115900',
  },
  {
    source: 'enablebanking',
    accountId: 'swedbank-sam-eur',
    currency: 'EUR',
    amountMinor: '310600',
  },
];

/** Write the balances a connector would have reported, observed this morning. */
export async function seedShowcaseBalances(
  db: Database,
  now: Date,
): Promise<number> {
  const balances = new AccountBalances(db);
  // Observed a few hours ago, so the screen's freshness note reads like a
  // bank answered today rather than like a fixture written at midnight.
  const observed = new Date(now.getTime() - 3 * 3600000);
  let written = 0;
  for (const row of SHOWCASE_BALANCES)
    written += await balances.record(
      { source: row.source, accountId: row.accountId },
      [{ currency: row.currency, amountMinor: row.amountMinor }],
      observed,
    );
  return written;
}

/** Everything above, for a workspace that is about to be photographed. */
export async function seedShowcaseAssets(
  db: Database,
  now: Date,
  months: number,
): Promise<{ holdings: number; snapshots: number; rates: number }> {
  if (!isMemoryDatabase(db))
    throw new Error(
      'refusing to seed: the showcase may only be written to a local demo database',
    );
  const rates = await seedShowcaseRates(db, now, months);
  const savings = await seedShowcaseHoldings(db, now, months);
  await seedShowcaseImports(db, now);
  await seedShowcaseBalances(db, now);
  return { ...savings, rates };
}
