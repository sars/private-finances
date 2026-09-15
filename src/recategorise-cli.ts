import { postgresDatabase, migrate } from './database.js';
import { Repository } from './repository.js';
import type { Owner } from './domain.js';

/**
 * Corrections the owner asked for by name, applied to every payment from a
 * merchant that was filed somewhere else. Each one is written down here rather
 * than typed at a prompt, so the decision is reviewable, repeatable and shows up
 * in the diff that changed the ledger.
 *
 *   node dist/src/recategorise-cli.js            # counts only, changes nothing
 *   node dist/src/recategorise-cli.js --apply    # classifies, with an audit entry
 *
 * A payment a person deliberately filed as something other than a personal
 * expense — a transfer, an investment, a non-personal payment — is never touched:
 * that is a different decision from which category a purchase belongs in.
 */
const corrections = [
  {
    name: 'Bolt rides',
    // "Bolt Food" is a different service under a name that contains this one.
    descriptions: ['Bolt'],
    category: 'Transport / Ride-hailing',
    reason: 'Owner: Bolt rides are ride-hailing, not public transport',
  },
  {
    name: 'Playtomic bookings',
    descriptions: ['Playtomic'],
    category: 'Sport / Racket sports',
    reason: 'Owner: Playtomic is racket sports',
  },
  {
    name: 'Circle K',
    descriptions: [
      'Circle K',
      'CIRCLE K EKSPORTA',
      'CIRCLE K BAUSKA',
      'CIRCLE K LIDO',
      'CIRCLE K KULDIGA',
      'CIRCLE K SAULKRASTI 2',
      'CIRCLE K APLINKKELIS I',
      'CIRCLE K TINUZI',
    ],
    category: 'Transport / Car / Fuel',
    reason: 'Owner: Circle K is most likely fuel',
  },
  {
    name: 'Ukrainian railways',
    descriptions: ['Укрзалізниця'],
    category: 'Transport / Long distance',
    reason: 'Owner: Ukrzaliznytsia is long distance travel',
  },
] as const;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    const repo = new Repository(db);
    for (const correction of corrections) {
      const rows = (
        await db.query(
          `SELECT id,owner,revision,kind,category FROM transactions
           WHERE amount_minor<0 AND description=ANY($1::text[])
             AND kind IN ('personal_expense','unresolved')
             AND (category IS DISTINCT FROM $2)
           ORDER BY booked_at`,
          [correction.descriptions, correction.category],
        )
      ).rows;
      const skipped = (
        await db.query(
          `SELECT count(*)::int AS count FROM transactions
           WHERE amount_minor<0 AND description=ANY($1::text[])
             AND kind NOT IN ('personal_expense','unresolved')`,
          [correction.descriptions],
        )
      ).rows[0]!.count;
      let changed = 0;
      for (const row of rows) {
        if (!apply) continue;
        await repo.classify(
          String(row.id),
          Number(row.revision),
          {
            kind: 'personal_expense',
            category: correction.category,
            reason: correction.reason,
          },
          row.owner as Owner,
        );
        changed++;
      }
      process.stdout.write(
        JSON.stringify({
          event: apply ? 'recategorised' : 'recategorise_preview',
          correction: correction.name,
          category: correction.category,
          matching: rows.length,
          changed,
          leftAlone: Number(skipped),
        }) + '\n',
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      event: 'recategorise_failed',
      code: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
    }) + '\n',
  );
  process.exitCode = 1;
});
