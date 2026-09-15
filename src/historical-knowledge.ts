import { open } from 'node:fs/promises';
import type { Owner, TransactionInput } from './domain.js';

const MAX_BYTES = 64 * 1024;
const invalid = () => new Error('historical_knowledge_invalid');

export interface HistoricalEvidence {
  id: string;
  owner: Owner;
  sourceReference: string;
  kind: 'context' | 'scoped_fact';
  proposedKind:
    'internal_transfer' | 'investment' | 'non_personal' | 'unresolved';
  /** A short, redacted owner-confirmed explanation, never raw source text. */
  statement: string;
  match: {
    source: string;
    description: string;
    currency: string;
    direction: 'outflow' | 'inflow';
    accountId?: string;
    amountMinor?: string;
    /** Inclusive UTC calendar dates (YYYY-MM-DD). */
    from?: string;
    to?: string;
  };
}
export interface HistoricalKnowledge {
  schemaVersion: 1;
  entries: HistoricalEvidence[];
}
export type HistoricalTransaction = Pick<
  TransactionInput,
  | 'owner'
  | 'source'
  | 'accountId'
  | 'description'
  | 'currency'
  | 'amountMinor'
  | 'bookedAt'
>;
export type HistoricalStatement = Pick<
  HistoricalEvidence,
  'id' | 'sourceReference' | 'statement' | 'proposedKind'
>;

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw invalid();
  return value;
}
function date(value: unknown): string {
  const result = string(value, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result
  )
    throw invalid();
  return result;
}

/** Reject the entire file on any invalid entry; never silently widen a match. */
export function validateHistoricalKnowledge(
  input: unknown,
): HistoricalKnowledge {
  const root = record(input, ['schemaVersion', 'entries']);
  if (
    root.schemaVersion !== 1 ||
    !Array.isArray(root.entries) ||
    root.entries.length > 100
  )
    throw invalid();
  const ids = new Set<string>();
  const entries = root.entries.map((raw): HistoricalEvidence => {
    const value = record(raw, [
      'id',
      'owner',
      'sourceReference',
      'kind',
      'proposedKind',
      'statement',
      'match',
    ]);
    const id = string(value.id, 80);
    const sourceReference = string(value.sourceReference, 160);
    // References are opaque labels, not paths, URLs or copied source excerpts.
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(id) ||
      !/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(sourceReference) ||
      ids.has(id)
    )
      throw invalid();
    ids.add(id);
    if (value.owner !== 'rodion' && value.owner !== 'katya') throw invalid();
    if (value.kind !== 'context' && value.kind !== 'scoped_fact')
      throw invalid();
    if (
      value.proposedKind !== 'internal_transfer' &&
      value.proposedKind !== 'investment' &&
      value.proposedKind !== 'non_personal' &&
      value.proposedKind !== 'unresolved'
    )
      throw invalid();
    const statement = string(value.statement, 400);
    const rawMatch = record(value.match, [
      'source',
      'description',
      'currency',
      'direction',
      'accountId',
      'amountMinor',
      'from',
      'to',
    ]);
    if (rawMatch.direction !== 'inflow' && rawMatch.direction !== 'outflow')
      throw invalid();
    const match: HistoricalEvidence['match'] = {
      source: string(rawMatch.source, 100),
      description: string(rawMatch.description, 1000),
      currency: string(rawMatch.currency, 3),
      direction: rawMatch.direction,
    };
    if (!/^[A-Z]{3}$/.test(match.currency)) throw invalid();
    if (rawMatch.accountId !== undefined)
      match.accountId = string(rawMatch.accountId, 200);
    if (rawMatch.amountMinor !== undefined) {
      const amount = string(rawMatch.amountMinor, 31);
      if (!/^[+-]?\d{1,30}$/.test(amount)) throw invalid();
      match.amountMinor = BigInt(amount).toString();
      if (
        (match.direction === 'outflow' && BigInt(amount) >= 0n) ||
        (match.direction === 'inflow' && BigInt(amount) <= 0n)
      )
        throw invalid();
    }
    if (rawMatch.from !== undefined) match.from = date(rawMatch.from);
    if (rawMatch.to !== undefined) match.to = date(rawMatch.to);
    if (
      (match.from === undefined) !== (match.to === undefined) ||
      (match.from && match.to && match.from > match.to)
    )
      throw invalid();
    if (
      value.kind === 'scoped_fact' &&
      (match.amountMinor === undefined || !match.from || !match.to)
    )
      throw invalid();
    return {
      id,
      proposedKind: value.proposedKind,
      owner: value.owner,
      sourceReference,
      kind: value.kind,
      statement,
      match,
    };
  });
  const result: HistoricalKnowledge = { schemaVersion: 1, entries };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES)
    throw invalid();
  return result;
}

/** Explicitly configured missing, unreadable or malformed files fail closed. */
export async function loadHistoricalKnowledge(
  path: string,
): Promise<HistoricalKnowledge> {
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077) !== 0)
        throw invalid();
      // Bound the read itself, including files that grow after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw invalid();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, size),
      );
      return validateHistoricalKnowledge(JSON.parse(text));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('historical_knowledge_unavailable');
  }
}

export function matchHistoricalKnowledge(
  knowledge: HistoricalKnowledge,
  transaction: HistoricalTransaction,
): HistoricalStatement[] {
  const validated = validateHistoricalKnowledge(knowledge);
  const booked = Date.parse(transaction.bookedAt);
  if (
    !Number.isFinite(booked) ||
    !/^[+-]?\d{1,30}$/.test(transaction.amountMinor)
  )
    return [];
  const day = new Date(booked).toISOString().slice(0, 10);
  const matches = validated.entries.filter((entry) => {
    const match = entry.match;
    return (
      entry.owner === transaction.owner &&
      match.source === transaction.source &&
      match.description === transaction.description &&
      match.currency === transaction.currency &&
      (match.direction === 'outflow'
        ? BigInt(transaction.amountMinor) < 0n
        : BigInt(transaction.amountMinor) > 0n) &&
      (match.accountId === undefined ||
        match.accountId === transaction.accountId) &&
      (match.amountMinor === undefined ||
        match.amountMinor === BigInt(transaction.amountMinor).toString()) &&
      (match.from === undefined || day >= match.from) &&
      (match.to === undefined || day <= match.to)
    );
  });
  // Overflow is ambiguity, not absence: callers must not fall back to a model.
  if (matches.length > 3) throw new Error('historical_knowledge_ambiguous');
  return matches.map(({ id, sourceReference, statement, proposedKind }) => ({
    id,
    sourceReference,
    statement,
    proposedKind,
  }));
}
