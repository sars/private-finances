import { createHash } from 'node:crypto';
import type { Executor } from './database.js';

/** The fingerprint covers full stored evidence; only bounded, non-identifying text leaves the server. */
export async function loadReceiptEvidence(tx: Executor, transactionId: string) {
  const rows = (
    await tx.query(
      `SELECT id,extraction,updated_at FROM receipt_jobs WHERE transaction_id=$1
    AND state='matched' AND owner IN ('rodion','katya') ORDER BY id FOR SHARE`,
      [transactionId],
    )
  ).rows;
  if (!rows.length) return undefined;
  const key =
    'receipt:v1:' +
    createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const clean = (v: unknown, limit: number) =>
    typeof v === 'string'
      ? v
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi, '[account reference]')
          .replace(/(?:\d[ -]?){13,19}/g, '[numeric reference]')
          .slice(0, limit)
      : null;
  const receipts = rows.slice(0, 3).map((row) => {
    const r = (row.extraction ?? {}) as Record<string, unknown>;
    const items = Array.isArray(r.items) ? r.items : [];
    return {
      merchant: clean(r.merchant, 120),
      date: clean(r.date, 10),
      amountMinor: clean(r.amountMinor, 16),
      currency: clean(r.currency, 3),
      items: items.slice(0, 12).map((v) => clean(v, 65)),
      truncated:
        items.length > 12 ||
        items.some((v) => typeof v === 'string' && v.length > 65) ||
        rows.length > 3,
    };
  });
  return { key, receipts };
}
