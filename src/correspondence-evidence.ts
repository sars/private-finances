import { randomUUID } from 'node:crypto';
import type { Database, Row } from './database.js';
import type { Owner } from './domain.js';
import { Conflict, type Transaction } from './repository.js';
import type { TransactionDetails } from './transaction-details.js';
import { currencyExponent } from './fx.js';

export type CorrespondenceSource =
  'gmail' | 'telegram' | 'whatsapp' | 'viber' | 'sms' | 'other';
export interface CorrespondenceEntry {
  source: CorrespondenceSource;
  reference: string;
  summary: string;
}
export interface CorrespondenceEvidence extends CorrespondenceEntry {
  id: string;
  transactionId: string;
  transactionRevision: number;
  currentTransactionRevision: number;
  owner: Owner;
  createdAt: string;
  stale: boolean;
}
function checkTarget(owner: Owner, id: string) {
  if (owner !== 'rodion' && owner !== 'katya') throw new Error('invalid_owner');
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error('invalid_transaction_id');
}
function checkEntry(entry: CorrespondenceEntry) {
  if (
    !entry ||
    !['gmail', 'telegram', 'whatsapp', 'viber', 'sms', 'other'].includes(
      entry.source,
    )
  )
    throw new Error('invalid_correspondence_source');
  for (const [field, max] of [
    ['reference', 1000],
    ['summary', 2000],
  ] as const) {
    if (
      typeof entry[field] !== 'string' ||
      !entry[field].trim() ||
      entry[field].length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry[field])
    )
      throw new Error(`invalid_correspondence_${field}`);
  }
}
function project(
  row: Row,
  owner: Owner,
  currentRevision: number,
): CorrespondenceEvidence {
  const value = row.after_value as CorrespondenceEntry & {
    transactionRevision: number;
  };
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    owner,
    source: value.source,
    reference: value.reference,
    summary: value.summary,
    transactionRevision: value.transactionRevision,
    currentTransactionRevision: currentRevision,
    createdAt: new Date(String(row.created_at)).toISOString(),
    stale: value.transactionRevision !== currentRevision,
  };
}
/** Owner-supplied context only. Notes never classify payments or fetch external references. */
export class CorrespondenceEvidenceStore {
  constructor(readonly db: Database) {}
  async add(
    owner: Owner,
    id: string,
    expectedRevision: number,
    entry: CorrespondenceEntry,
  ): Promise<CorrespondenceEvidence> {
    checkTarget(owner, id);
    checkEntry(entry);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('invalid_revision');
    return this.db.transaction(async (tx) => {
      const transaction = (
        await tx.query(
          'SELECT owner,revision FROM transactions WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!transaction || transaction.owner !== owner)
        throw new Error('not_found');
      if (Number(transaction.revision) !== expectedRevision)
        throw new Conflict('stale_revision');
      const row = (
        await tx.query(
          `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
        VALUES($1,$2,$3,'correspondence_evidence_added',NULL,$4,'Owner supplied correspondence context') RETURNING *`,
          [
            randomUUID(),
            id,
            owner,
            JSON.stringify({
              source: entry.source,
              reference: entry.reference.trim(),
              summary: entry.summary.trim(),
              transactionRevision: expectedRevision,
            }),
          ],
        )
      ).rows[0]!;
      return project(row, owner, expectedRevision);
    });
  }
  async list(owner: Owner, id: string): Promise<CorrespondenceEvidence[]> {
    checkTarget(owner, id);
    return this.db.transaction(async (tx) => {
      const transaction = (
        await tx.query(
          'SELECT owner,revision FROM transactions WHERE id=$1 FOR SHARE',
          [id],
        )
      ).rows[0];
      if (!transaction || transaction.owner !== owner)
        throw new Error('not_found');
      const rows = (
        await tx.query(
          "SELECT * FROM audit_events WHERE transaction_id=$1 AND actor=$2 AND event='correspondence_evidence_added' ORDER BY created_at,id",
          [id, owner],
        )
      ).rows;
      return rows.map((row) =>
        project(row, owner, Number(transaction.revision)),
      );
    });
  }
}

/** Only opens a user-initiated search; no scraping or implication that a message was found. */
export function gmailEvidenceSearch(
  transaction: Pick<
    Transaction,
    'id' | 'bookedAt' | 'amountMinor' | 'currency' | 'description'
  >,
  details?: Pick<TransactionDetails, 'id' | 'fields'>,
): { query: string; url: string; amount: string; contextQuery: string | null } {
  const exponent = currencyExponent(transaction.currency);
  if (exponent === undefined || !/^-?\d{1,60}$/.test(transaction.amountMinor))
    throw new Error('unsupported_search_amount');
  const digits = transaction.amountMinor
    .replace(/^-/, '')
    .padStart(exponent + 1, '0');
  const amount = exponent
    ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
    : digits;
  const instant = new Date(transaction.bookedAt);
  if (!Number.isFinite(instant.getTime()))
    throw new Error('invalid_search_date');
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  const day = Date.parse(`${date}T00:00:00Z`);
  const shift = (n: number) =>
    new Date(day + n * 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '/');
  const range = `after:${shift(-7)} before:${shift(8)}`;
  // Bank/context strings never become Gmail operators, braces, URLs or executable content.
  const phrase = (value: string) =>
    value
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  const terms = [
    transaction.description,
    ...(details?.id === transaction.id
      ? details.fields
          .filter((f) =>
            /^(?:Recipient|Sender|Comment \/ payment purpose)/.test(f.label),
          )
          .map((f) => f.value)
      : []),
  ]
    .map(phrase)
    .filter((value) => value.length >= 3)
    .slice(0, 4);
  const query = `${range} {"${amount}" "${amount.replace('.', ',')}"}`;
  const contextQuery = terms.length
    ? `${query} {${[...new Set(terms)].map((term) => `"${term}"`).join(' ')}}`
    : null;
  return {
    query,
    url: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,
    amount,
    contextQuery,
  };
}
