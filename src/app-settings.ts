import type { Database, Executor } from './database.js';
import type { Owner } from './domain.js';
import type { Transaction } from './repository.js';
import { Conflict } from './repository.js';
export type ReviewPreferences = {
  hideBusiness: boolean;
  hideInternalTransfers: boolean;
  hideRefunds: boolean;
};
export type AppSettings = ReviewPreferences & { revision: number };
export async function initializeAppSettings(tx: Executor) {
  await tx.query(`CREATE TABLE IF NOT EXISTS app_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
    hide_business boolean NOT NULL DEFAULT true, hide_internal_transfers boolean NOT NULL DEFAULT true, hide_refunds boolean NOT NULL DEFAULT true)`);
  await tx.query(
    'INSERT INTO app_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING',
  );
  await tx.query(`CREATE TABLE IF NOT EXISTS app_settings_audit (
    revision integer PRIMARY KEY,actor text NOT NULL CHECK(actor='rodion'),before_value jsonb NOT NULL,after_value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`);
}
export async function readAppSettings(tx: Executor): Promise<AppSettings> {
  const row = (
    await tx.query('SELECT * FROM app_settings WHERE singleton=true')
  ).rows[0]!;
  return {
    revision: Number(row.revision),
    hideBusiness: row.hide_business === true,
    hideInternalTransfers: row.hide_internal_transfers === true,
    hideRefunds: row.hide_refunds === true,
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
    Object.keys(value).sort().join(',') !==
      'hideBusiness,hideInternalTransfers,hideRefunds' ||
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
      'UPDATE app_settings SET revision=$1,hide_business=$2,hide_internal_transfers=$3,hide_refunds=$4 WHERE singleton=true',
      [
        after.revision,
        value.hideBusiness,
        value.hideInternalTransfers,
        value.hideRefunds,
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
    hideBusiness: hide('includeBusiness', settings.hideBusiness),
    hideInternalTransfers: hide(
      'includeTransfers',
      settings.hideInternalTransfers,
    ),
    hideRefunds: hide('includeRefunds', settings.hideRefunds),
  };
}
export function hiddenByReviewPreferences(
  t: Transaction,
  p: ReviewPreferences,
): boolean {
  return (
    (p.hideBusiness &&
      t.spendingPolicy?.accountPurpose === 'business' &&
      t.kind !== 'investment') ||
    (p.hideInternalTransfers && t.kind === 'internal_transfer')
  );
}
