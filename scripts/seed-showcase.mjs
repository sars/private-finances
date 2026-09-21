// Fills the demo workspace with the invented household the public article is
// photographed against. Development and the demo instance only.
//
//   pnpm build && node scripts/seed-showcase.mjs
//   pnpm demo
//
// It empties the showcase ledger before writing, so it is safe to run twice;
// the household is generated from a fixed seed and comes out the same every
// time. Dates are relative to today, so reseed before taking screenshots.
import { memoryDatabase, migrate } from '../dist/src/database.js';
import { seedShowcase } from '../dist/src/showcase.js';

// The seeder refuses a PostgreSQL database of its own accord. This is the
// earlier, blunter refusal: if the household's own connection string is in the
// environment at all, this shell was not meant to be running a seeder.
if (process.env.DATABASE_URL)
  throw new Error(
    'DATABASE_URL is set: run the showcase seeder in a shell that has no production database',
  );
if (process.env.APP_MODE && process.env.APP_MODE !== 'demo')
  throw new Error(
    `APP_MODE is ${process.env.APP_MODE}: the showcase is demo-only`,
  );

// The knobs, read from the environment so a systemd unit can pass on what the
// reseed page was asked for without a shell quoting them into an argument
// list. Anything missing or unreadable falls back to the default, and every
// one of them is clamped to its documented range inside the seeder.
const number = (name) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${name} is not a number: ${raw}`);
  return value;
};
const shape = {
  months: number('SHOWCASE_MONTHS'),
  density: number('SHOWCASE_DENSITY'),
  refunds: number('SHOWCASE_REFUNDS'),
  receipts: number('SHOWCASE_RECEIPTS'),
};

const directory = process.env.DEMO_DATA_DIR ?? 'data/demo';
const db = memoryDatabase(directory);
await migrate(db);

// A seeding that dies part way leaves a workspace mixing two households — a
// fresh ledger beside the previous holdings, say — and it still starts and
// still looks plausible. A stack trace on its own does not say that, so say
// it here: whoever is reading this is one `systemctl start` away from
// photographing a workspace whose screens disagree with each other.
let seeded;
try {
  seeded = await seedShowcase(db, shape);
} catch (error) {
  console.error(
    `showcase seeding failed: ${error instanceof Error ? error.message : error}`,
  );
  console.error(
    `the workspace in ${directory} is now part seeded and must not be used ` +
      'or photographed; run this again once the cause is fixed',
  );
  await db.close();
  throw error;
}
await db.close();
console.log(
  `showcase seeded into ${directory}: ${seeded.transactions} payments ` +
    `across ${seeded.accounts} accounts, ${seeded.holdings} holdings ` +
    `with ${seeded.snapshots} snapshots, ${seeded.rates} daily rates, ` +
    `${seeded.refunds} linked refunds, ${seeded.receipts} receipts`,
);

if (!seeded.receipts)
  console.log(
    'no receipt pictures found — run `pnpm demo:receipts` once and commit them',
  );
