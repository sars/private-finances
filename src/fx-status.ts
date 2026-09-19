import type { Repository, Transaction } from './repository.js';
import { convertedSpending } from './analytics.js';
import { accountDisplayName } from './account-names.js';
import { fxCoverage, type FxDay } from './fx-coverage.js';

/**
 * What the conversion status page asks for, and nothing else.
 *
 * The endpoint used to return every row in the ledger so the browser could
 * count them. The page only ever shows counts and the handful of failures, so
 * that is what it gets; thousands of rows were being sent to be discarded.
 */
export interface FxConversionStatus {
  currency: string;
  rates: {
    from: string;
    to: string;
    /** One entry per calendar day in the range, for the coverage strip. */
    days: FxDay[];
    covered: number;
    needed: number;
    /** The most recent day with a stored quote, or null when none exists. */
    current: string | null;
  };
  conversions: {
    total: number;
    converted: number;
    missing: number;
    /** How each converted row got its figure. Not a health metric — a canary. */
    method: { bank: number; daily: number; identity: number };
  };
  unconverted: {
    id: string;
    bookedAt: string;
    /** Enough for the badge and for the name beside it; see `AccountBadge`. */
    account: {
      name: string;
      source: string;
      label: string | null;
      owner: string;
      currency: string;
    };
    description: string;
    amountMinor: string;
    currency: string;
    reason: string;
  }[];
  /** True when the list above was capped; `conversions.missing` stays exact. */
  unconvertedCapped: boolean;
}

/** The page lists failures, not pages of them. Beyond this it states the count. */
export const UNCONVERTED_LIMIT = 200;

/**
 * Why a row has no converted amount, in the owner's words.
 *
 * The internal code names a branch in the conversion; it is not an explanation.
 * An unknown code is passed through rather than dressed up as something it is
 * not, so a reason nobody has written a sentence for is visible as itself.
 */
export function missingReasonSentence(reason: string): string {
  switch (reason) {
    case 'no_matching_quote':
      return 'No rate published for this day';
    case 'stale_transaction':
      return 'Changed while loading — reload';
    case 'missing_time':
      return 'The payment carries no date to price it on';
    case 'invalid_time':
      return 'The payment date could not be read';
    case 'unsupported_currency':
      return 'This currency is not converted';
    case 'invalid_amount':
      return 'The amount could not be read';
    default:
      return reason;
  }
}

const accountKey = (source: string, accountId: string) =>
  JSON.stringify([source, accountId]);

/**
 * The status of conversion across the whole ledger.
 *
 * Every count here covers the same set of rows — all of them, personal or not,
 * pending or booked. The page it feeds says "all 4,189 transactions", and that
 * has to be the same 4,189 the rate coverage is measured against; the previous
 * page counted personal expenses in one place and every row in another, which
 * is why its own two numbers disagreed.
 */
export async function fxConversionStatus(
  repo: Repository,
  rows: Transaction[],
  target: string,
  today: string,
): Promise<FxConversionStatus> {
  const spending = await convertedSpending(repo, rows, target);
  const method = { bank: 0, daily: 0, identity: 0 };
  for (const row of spending.rows) {
    if (row.status !== 'converted') continue;
    if (row.method === 'actual_bank') method.bank++;
    else if (row.method === 'market_estimate') method.daily++;
    else if (row.method === 'identity') method.identity++;
  }
  const missingRows = spending.rows.filter((row) => row.status === 'missing');
  const dates = rows
    .map((row) => new Date(row.bookedAt).toISOString().slice(0, 10))
    .sort();
  // The range the rates have to cover is the ledger's own span, extended to
  // today: a rate for a day after the last payment is what proves the nightly
  // sync is still running, and nothing else in the application would notice if
  // it stopped.
  const earliest = dates[0] ?? today;
  const latest = dates.at(-1) ?? today;
  const from = earliest < today ? earliest : today;
  const to = latest > today ? latest : today;
  const days = await fxCoverage(repo.db, from, to);
  const current =
    [...days].reverse().find((day) => day.state === 'covered')?.date ?? null;
  const accounts = new Map(
    (
      await repo.db.query(
        'SELECT source,account_id,owner,label FROM own_accounts',
      )
    ).rows.map((row) => [
      accountKey(String(row.source), String(row.account_id)),
      row,
    ]),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    currency: target,
    rates: {
      from,
      to,
      days,
      covered: days.filter((day) => day.state === 'covered').length,
      needed: days.length,
      current,
    },
    conversions: {
      total: spending.rows.length,
      converted: spending.rows.length - missingRows.length,
      missing: missingRows.length,
      method,
    },
    unconverted: missingRows.slice(0, UNCONVERTED_LIMIT).map((row) => {
      const source = byId.get(row.id)!;
      const registered = accounts.get(
        accountKey(source.source, source.accountId),
      );
      const label = registered?.label == null ? null : String(registered.label);
      return {
        id: row.id,
        bookedAt: row.bookedAt,
        // The name the owner recognises, the same one Balances and Transactions
        // use. An account nobody has registered still gets that name, built
        // from what the connector knows, never the integration's raw label.
        account: {
          name: accountDisplayName({
            owner: source.owner,
            source: source.source,
            label,
            currency: source.currency,
          }),
          source: source.source,
          label,
          owner: source.owner,
          currency: source.currency,
        },
        description: row.description,
        amountMinor: row.originalAmountMinor,
        currency: row.originalCurrency,
        reason: missingReasonSentence(row.missingReason ?? 'no_matching_quote'),
      };
    }),
    unconvertedCapped: missingRows.length > UNCONVERTED_LIMIT,
  };
}
