/**
 * Operator import of asset history: `node dist/src/holdings-import-cli.js
 * <document.json>` against the restricted application's `DATABASE_URL`.
 * The document comes from `scripts/holdings_from_spreadsheet.py` and names
 * real holdings; copy it to the server for the run and remove it after.
 * Output is counts only, never a name or a figure. See docs/assets.md.
 */
import { readFile } from 'node:fs/promises';
import { migrate, postgresDatabase } from './database.js';
import { importHoldings, parseImportDocument } from './holdings-import.js';

const log = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');

async function main() {
  const [path] = process.argv.slice(2);
  if (!path || process.argv.length > 3)
    throw new Error('holdings_import_usage');
  if (!process.env.DATABASE_URL)
    throw new Error('holdings_import_configuration');
  const document = parseImportDocument(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
  log({
    event: 'holdings_import_start',
    holdings: document.holdings.length,
    snapshots: document.snapshots.length,
    prices: document.prices.length,
  });
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    const summary = await importHoldings(db, document);
    log({ event: 'holdings_import_done', ...summary });
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  log({
    event: 'holdings_import_failed',
    error: error instanceof Error ? error.message : 'unknown',
  });
  process.exitCode = 1;
});
