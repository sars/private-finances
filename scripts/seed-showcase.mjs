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
  throw new Error(`APP_MODE is ${process.env.APP_MODE}: the showcase is demo-only`);

const directory = process.env.DEMO_DATA_DIR ?? 'data/demo';
const db = memoryDatabase(directory);
await migrate(db);
const { transactions, accounts } = await seedShowcase(db);
await db.close();
console.log(
  `showcase seeded into ${directory}: ${transactions} payments across ${accounts} accounts`,
);
