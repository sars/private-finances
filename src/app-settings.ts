import type { Database, Executor } from './database.js';
import type { Owner } from './domain.js';
import type { Transaction } from './repository.js';
import { Conflict } from './repository.js';
export type ReviewPreferences = {
  hideNonPersonal: boolean;
  hideInternalTransfers: boolean;
  hideRefunds: boolean;
  hideZeroAmount: boolean;
};
export type AppSettings = ReviewPreferences & { revision: number };
const settingKeys = [
  'hideInternalTransfers',
  'hideNonPersonal',
  'hideRefunds',
  'hideZeroAmount',
].join(',');
export async function initializeAppSettings(tx: Executor) {
  await tx.query(`CREATE TABLE IF NOT EXISTS app_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
    hide_non_personal boolean NOT NULL DEFAULT true, hide_internal_transfers boolean NOT NULL DEFAULT true,
    hide_refunds boolean NOT NULL DEFAULT true, hide_zero_amount boolean NOT NULL DEFAULT true)`);
  await tx.query(
    'INSERT INTO app_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING',
  );
  await tx.query(`CREATE TABLE IF NOT EXISTS app_settings_audit (
    revision integer PRIMARY KEY,actor text NOT NULL CHECK(actor='rodion'),before_value jsonb NOT NULL,after_value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`);
}
/**
 * Hiding used to be decided by the account a payment sat on, which contradicts
 * how the rest of the application works: an account purpose is only a
 * suggestion and the payment's own kind is the truth (see `applySpendingPolicy`).
 * The preference now hides payments classified `non_personal` wherever they sit,
 * and carries the saved value across because the intent is the same. The second
 * column is new: a purchase whose money all came back cost nothing, and the
 * owner does not want to read a list of zeroes.
 *
 * A database created after this change already has both columns from
 * `initializeAppSettings`, so this only has work to do on an older one.
 */
export async function migrateNonPersonalPreference(tx: Executor) {
  const legacy = await tx.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='app_settings' AND column_name='hide_business'",
  );
  await tx.query(
    'ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS hide_non_personal boolean NOT NULL DEFAULT true',
  );
  await tx.query(
    'ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS hide_zero_amount boolean NOT NULL DEFAULT true',
  );
  if (legacy.rows.length) {
    await tx.query('UPDATE app_settings SET hide_non_personal=hide_business');
    await tx.query('ALTER TABLE app_settings DROP COLUMN hide_business');
  }
}
export async function readAppSettings(tx: Executor): Promise<AppSettings> {
  const row = (
    await tx.query('SELECT * FROM app_settings WHERE singleton=true')
  ).rows[0]!;
  return {
    revision: Number(row.revision),
    hideNonPersonal: row.hide_non_personal === true,
    hideInternalTransfers: row.hide_internal_transfers === true,
    hideRefunds: row.hide_refunds === true,
    hideZeroAmount: row.hide_zero_amount === true,
  };
}
export async function updateAppSettings(
  db: Database,
  actor: Owner,
  revision: number,
  value: ReviewPreferences,
): Promise<AppSettings> {
  if (actor !== 'rodion') throw new Error('admin_required');
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    Object.keys(value).sort().join(',') !== settingKeys ||
    Object.values(value).some((v) => typeof v !== 'boolean')
  )
    throw new Error('invalid_settings');
  return db.transaction(async (tx) => {
    await tx.query(
      'SELECT singleton FROM app_settings WHERE singleton=true FOR UPDATE',
    );
    const before = await readAppSettings(tx);
    if (before.revision !== revision) throw new Conflict('stale_settings');
    const after = { ...value, revision: revision + 1 };
    await tx.query(
      'UPDATE app_settings SET revision=$1,hide_non_personal=$2,hide_internal_transfers=$3,hide_refunds=$4,hide_zero_amount=$5 WHERE singleton=true',
      [
        after.revision,
        value.hideNonPersonal,
        value.hideInternalTransfers,
        value.hideRefunds,
        value.hideZeroAmount,
      ],
    );
    await tx.query(
      'INSERT INTO app_settings_audit(revision,actor,before_value,after_value) VALUES($1,$2,$3,$4)',
      [after.revision, actor, JSON.stringify(before), JSON.stringify(after)],
    );
    return after;
  });
}
export function reviewPreferences(
  settings: ReviewPreferences,
  query: URLSearchParams,
): ReviewPreferences {
  const hide = (key: string, fallback: boolean) =>
    query.get(key) === '1' ? false : query.get(key) === '0' ? true : fallback;
  return {
    hideNonPersonal: hide('includeNonPersonal', settings.hideNonPersonal),
    hideInternalTransfers: hide(
      'includeTransfers',
      settings.hideInternalTransfers,
    ),
    hideRefunds: hide('includeRefunds', settings.hideRefunds),
    hideZeroAmount: hide('includeZeroAmount', settings.hideZeroAmount),
  };
}
/**
 * What a payment finally came to, in its own account currency: the bank amount
 * less everything that came back. Reductions are already expressed in the
 * purchase's currency by `refund.netMinor`, so nothing is converted here.
 */
export function resultingAmountMinor(t: Transaction): bigint {
  return BigInt(t.refund ? t.refund.netMinor : t.amountMinor);
}
/**
 * Whether the resulting amount can be trusted enough to hide the payment for
 * being nothing. A reduction that disagrees with a later correction is the one
 * case that needs a person, so it keeps the payment in the list rather than
 * hiding a figure nobody has reconciled (ADR 0007).
 */
function settledToNothing(t: Transaction): boolean {
  return (
    (!t.refund ||
      t.refund.reductions.every((item) => item.discrepancy === null)) &&
    resultingAmountMinor(t) === 0n
  );
}
export function hiddenByReviewPreferences(
  t: Transaction,
  p: ReviewPreferences,
): boolean {
  return (
    (p.hideNonPersonal && t.kind === 'non_personal') ||
    (p.hideInternalTransfers && t.kind === 'internal_transfer') ||
    (p.hideZeroAmount && settledToNothing(t))
  );
}
