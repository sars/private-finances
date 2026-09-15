export type Owner = 'rodion' | 'katya';
export type Kind =
  | 'personal_expense'
  | 'internal_transfer'
  | 'investment'
  | 'non_personal'
  | 'unresolved';
/**
 * How a payment's kind affects the spending totals (ADR 0006).
 *
 * Exclusion has three states rather than two, because the owner wants
 * investments out of the headline figure but still reachable:
 *
 * - `counted` — real household spending, or an unresolved outflow that is shown
 *   separately as incompleteness rather than quietly dropped.
 * - `excluded` — absent from the headline number, present the moment the owner
 *   asks for it. Investments and business spending sit here; nothing is deleted
 *   to achieve it and no exclusion is silent.
 * - `hidden` — money that never left the household, so counting it would be
 *   counting the same money twice.
 */
export type SpendingVisibility = 'counted' | 'excluded' | 'hidden';
export function spendingVisibility(kind: Kind): SpendingVisibility {
  if (kind === 'personal_expense' || kind === 'unresolved') return 'counted';
  if (kind === 'internal_transfer') return 'hidden';
  return 'excluded';
}

export interface TransactionInput {
  source: string;
  sourceId: string;
  accountId: string;
  owner: Owner;
  bookedAt: string;
  currency: string;
  amountMinor: string;
  description: string;
  status?: 'booked' | 'pending';
  sourceDetails?: Record<string, unknown>;
}

const kinds: readonly string[] = [
  'personal_expense',
  'internal_transfer',
  'investment',
  'non_personal',
  'unresolved',
];

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function timestamp(value: unknown): string {
  const result = string(value, 'bookedAt', 35);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      result,
    );
  if (!match) throw new Error('Invalid bookedAt');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[7]!;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    (zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error('Invalid bookedAt');
  return result;
}

export function validateTransaction(input: unknown): TransactionInput {
  const value = record(input);
  const owner = value.owner;
  if (owner !== 'rodion' && owner !== 'katya') throw new Error('Invalid owner');
  const currency = string(value.currency, 'currency', 3);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency');
  const amountMinor = string(value.amountMinor, 'amountMinor', 31);
  if (!/^[+-]?\d{1,30}$/.test(amountMinor))
    throw new Error('Invalid amountMinor');
  if (
    value.status !== undefined &&
    value.status !== 'booked' &&
    value.status !== 'pending'
  )
    throw new Error('Invalid status');
  const details =
    value.sourceDetails === undefined ? undefined : record(value.sourceDetails);
  if (details !== undefined && JSON.stringify(details).length > 262144)
    throw new Error('Source details too large');
  return {
    ...(value.status === undefined
      ? {}
      : { status: value.status as 'booked' | 'pending' }),
    ...(details === undefined ? {} : { sourceDetails: details }),
    source: string(value.source, 'source', 64),
    sourceId: string(value.sourceId, 'sourceId', 200),
    accountId: string(value.accountId, 'accountId', 200),
    owner,
    bookedAt: new Date(timestamp(value.bookedAt)).toISOString(),
    currency,
    amountMinor: BigInt(amountMinor).toString(),
    description: string(value.description, 'description', 2000, true),
  };
}

export function validateClassification(input: unknown): {
  kind: Kind;
  category: string | null;
  reason: string;
} {
  const value = record(input);
  if (typeof value.kind !== 'string' || !kinds.includes(value.kind))
    throw new Error('Invalid kind');
  const category =
    value.category === null ? null : string(value.category, 'category', 250);
  if (value.kind === 'personal_expense' && category === null)
    throw new Error('Personal expenses require a category');
  return {
    kind: value.kind as Kind,
    category,
    reason: string(value.reason, 'reason', 500),
  };
}

export function expenseSummary(
  rows: Array<
    TransactionInput & {
      kind: Kind;
      category: string | null;
      spendingPolicy?: { excluded: boolean };
      refund?: { netMinor: string };
      provisional?: boolean;
    }
  >,
): {
  byCurrency: Array<{
    currency: string;
    personalExpenseMinor: string;
    unresolvedOutflowMinor: string;
    unresolvedCount: number;
    /** Counted inside `personalExpenseMinor`, and reported separately because
     * nobody has confirmed it: money placed where its evidence pointed so that
     * the total is complete (ADR 0008). Incompleteness is now unresolved plus
     * provisional, which is what keeps the figure honest while it is counted. */
    provisionalOutflowMinor: string;
    provisionalCount: number;
    pendingOutflowMinor: string;
    pendingCount: number;
  }>;
} {
  const currencies = new Map<
    string,
    {
      personal: bigint;
      unresolved: bigint;
      count: number;
      pending: bigint;
      pendingCount: number;
      provisional: bigint;
      provisionalCount: number;
    }
  >();
  for (const row of rows) {
    const totals = currencies.get(row.currency) ?? {
      personal: 0n,
      unresolved: 0n,
      count: 0,
      pending: 0n,
      pendingCount: 0,
      provisional: 0n,
      provisionalCount: 0,
    };
    currencies.set(row.currency, totals);
    const gross = BigInt(row.amountMinor);
    if (gross >= 0n || row.spendingPolicy?.excluded) continue;
    // A hold has already taken the money. Monobank deducts it at authorisation
    // and its `hold` flag only says the final amount could still be adjusted —
    // the balance in the bank's own payload runs straight through these rows,
    // and the flag never flips back for foreign merchants. So a hold counts
    // like any other payment. It is still reported separately, as "of which
    // the amount is not final" rather than as money that has not left.
    if (row.status === 'pending') {
      totals.pending -= gross;
      totals.pendingCount++;
    }
    // What the purchase finally cost: money that came back reduces it, and a
    // refund larger than the purchase leaves nothing rather than income.
    const net = row.refund ? BigInt(row.refund.netMinor) : gross;
    const amount = net > 0n ? 0n : net;
    if (amount === 0n) continue;
    if (row.kind === 'personal_expense') {
      totals.personal -= amount;
      if (row.provisional) {
        totals.provisional -= amount;
        totals.provisionalCount += 1;
      }
    }
    if (row.kind === 'unresolved') {
      totals.unresolved -= amount;
      totals.count += 1;
    }
  }
  return {
    byCurrency: [...currencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, totals]) => ({
        currency,
        personalExpenseMinor: totals.personal.toString(),
        unresolvedOutflowMinor: totals.unresolved.toString(),
        unresolvedCount: totals.count,
        provisionalOutflowMinor: totals.provisional.toString(),
        provisionalCount: totals.provisionalCount,
        pendingOutflowMinor: totals.pending.toString(),
        pendingCount: totals.pendingCount,
      })),
  };
}
