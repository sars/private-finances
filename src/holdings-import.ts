/**
 * Loading a household's asset history from a document prepared outside the
 * application — `scripts/holdings_from_spreadsheet.py` turns the owner's
 * spreadsheet into this shape. The document names real holdings, so it is
 * produced and consumed on the operator's machines and never committed.
 *
 * Holdings are matched by name and created when new; a snapshot or price
 * that already exists with the same figure is left alone, and a different
 * figure becomes a new version, exactly as if it had been typed in.
 */
import type { Database } from './database.js';
import { Holdings, HOLDING_KINDS, type HoldingKind } from './holdings.js';
import { parseDecimal } from './holding-valuation.js';

export interface ImportDocument {
  holdings: Array<{
    name: string;
    denomination: string;
    kind?: string;
    invested: boolean;
    liquid: boolean;
    group?: string | null;
    owner?: string | null;
    note?: string | null;
    archived?: boolean;
    sortOrder?: number;
    maturesOn?: string | null;
  }>;
  snapshots: Array<{ name: string; asOf: string; quantity: string }>;
  prices: Array<{ symbol: string; asOf: string; usdPerUnit: string }>;
}
export interface ImportSummary {
  holdingsCreated: number;
  holdingsSeen: number;
  snapshotsWritten: number;
  snapshotsUnchanged: number;
  pricesWritten: number;
  pricesUnchanged: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Shape only; names and figures are validated where they are stored. */
export function parseImportDocument(raw: unknown): ImportDocument {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.holdings) ||
    !Array.isArray(raw.snapshots) ||
    !Array.isArray(raw.prices)
  )
    throw new Error('import_invalid_document');
  for (const holding of raw.holdings) {
    if (
      !isRecord(holding) ||
      typeof holding.name !== 'string' ||
      typeof holding.denomination !== 'string' ||
      typeof holding.invested !== 'boolean' ||
      typeof holding.liquid !== 'boolean' ||
      (holding.kind !== undefined &&
        !HOLDING_KINDS.includes(holding.kind as HoldingKind)) ||
      (holding.maturesOn !== undefined &&
        holding.maturesOn !== null &&
        typeof holding.maturesOn !== 'string')
    )
      throw new Error('import_invalid_holding');
  }
  const names = new Set<string>();
  for (const holding of raw.holdings as ImportDocument['holdings']) {
    if (names.has(holding.name)) throw new Error('import_duplicate_holding');
    names.add(holding.name);
  }
  for (const snapshot of raw.snapshots) {
    if (
      !isRecord(snapshot) ||
      typeof snapshot.name !== 'string' ||
      !names.has(snapshot.name) ||
      typeof snapshot.asOf !== 'string' ||
      !parseDecimal(snapshot.quantity)
    )
      throw new Error('import_invalid_snapshot');
  }
  for (const price of raw.prices) {
    if (
      !isRecord(price) ||
      typeof price.symbol !== 'string' ||
      typeof price.asOf !== 'string' ||
      !parseDecimal(price.usdPerUnit)
    )
      throw new Error('import_invalid_price');
  }
  return raw as unknown as ImportDocument;
}

export async function importHoldings(
  db: Database,
  document: ImportDocument,
  source = 'spreadsheet',
): Promise<ImportSummary> {
  const service = new Holdings(db);
  const summary: ImportSummary = {
    holdingsCreated: 0,
    holdingsSeen: 0,
    snapshotsWritten: 0,
    snapshotsUnchanged: 0,
    pricesWritten: 0,
    pricesUnchanged: 0,
  };
  const byName = new Map((await service.list()).map((h) => [h.name, h]));
  for (const entry of document.holdings) {
    summary.holdingsSeen += 1;
    if (byName.has(entry.name)) continue;
    const created = await service.upsert('import', {
      name: entry.name,
      kind: entry.kind ?? 'other',
      denomination: entry.denomination,
      invested: entry.invested,
      liquid: entry.liquid,
      group: entry.group ?? null,
      owner: entry.owner ?? null,
      note: entry.note ?? null,
      archived: entry.archived ?? false,
      sortOrder: entry.sortOrder ?? 0,
      maturesOn: entry.maturesOn ?? null,
    });
    byName.set(created.name, created);
    summary.holdingsCreated += 1;
  }
  const before = new Set(
    (await service.snapshots()).map(
      (s) => `${s.holdingId}|${s.asOf}|${s.quantity}`,
    ),
  );
  for (const entry of document.snapshots) {
    const holding = byName.get(entry.name)!;
    const recorded = await service.recordSnapshot(null, {
      holdingId: holding.id,
      asOf: entry.asOf,
      amount: entry.quantity,
      source,
    });
    if (before.has(`${holding.id}|${entry.asOf}|${recorded.quantity}`))
      summary.snapshotsUnchanged += 1;
    else {
      summary.snapshotsWritten += 1;
      before.add(`${holding.id}|${entry.asOf}|${recorded.quantity}`);
    }
  }
  for (const entry of document.prices) {
    if (entry.symbol.toUpperCase() === 'USD') continue;
    const existing = (
      await db.query(
        'SELECT usd_per_unit FROM asset_prices WHERE symbol=$1 AND as_of=$2 ORDER BY version DESC LIMIT 1',
        [entry.symbol.toUpperCase(), entry.asOf],
      )
    ).rows[0];
    const recorded = await service.recordPrice(null, {
      symbol: entry.symbol,
      asOf: entry.asOf,
      usdPerUnit: entry.usdPerUnit,
      source,
    });
    if (existing && String(existing.usd_per_unit) === recorded.usdPerUnit)
      summary.pricesUnchanged += 1;
    else summary.pricesWritten += 1;
  }
  return summary;
}
