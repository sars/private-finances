import type { Repository, Transaction } from './repository.js';
import { convertedSpending, type ConvertedSpendingRow } from './analytics.js';
import { accountDisplayName } from './account-names.js';
import { fxCoverage, type FxDay } from './fx-coverage.js';
import { compareFxSources } from './fx-sources.js';

/**
 * What the conversion status page asks for, and nothing else.
 *
 * The endpoint used to return every row in the ledger so the browser could
 * count them. The page only ever shows counts and the handful of failures, so
 * that is what it gets; thousands of rows were being sent to be discarded.
 */
/**
 * Every currency a total can be reported in.
 *
 * The status is measured against all of them at once, not against whichever one
 * the header happens to be showing. Conversion really is per-target — a hryvnia
 * payment is already in hryvnia but needs a rate to become euro — so a page
 * that answered for one currency could read green while the ledger was broken
 * in another, which is the one thing a status page must not do.
 */
export const REPORTING_CURRENCIES = ['UAH', 'EUR', 'USD'] as const;

export interface FxConversionStatus {
  rates: {
    from: string;
    to: string;
    /** One entry per calendar day in the range, for the coverage strip. */
    days: FxDay[];
    /** Days that need a rate, and how many of them have one. Days with no
     * payment on them are in neither figure: they need nothing. */
    covered: number;
    needed: number;
    /** The most recent day with a stored quote, or null when none exists. */
    current: string | null;
    /** How many days each source accounts for, most trusted source first. */
    sources: { source: string; days: number }[];
  };
  conversions: {
    /** The same set of rows for every currency: all of them, pending included. */
    total: number;
    /** Every reporting currency, worst first, so a failure cannot hide behind
     * whichever one the header is showing. */
    currencies: {
      currency: string;
      converted: number;
      missing: number;
      /** How each converted row got its figure. Not a health metric — a
       * canary: almost every bank-recorded figure is Monobank's own converted
       * amount, and if that field stopped arriving they would all quietly fall
       * back to a daily estimate with nothing else noticing. */
      method: { bank: number; daily: number; identity: number };
    }[];
    /** Rows with no amount in at least one reporting currency. */
    missing: number;
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
    /** Which reporting currencies this payment has no amount in. */
    missingFor: string[];
  }[];
  /** True when the list above was capped; `conversions.missing` stays exact. */
  unconvertedCapped: boolean;
}

/** The page lists failures, not pages of them. Beyond this it states the count. */
export const UNCONVERTED_LIMIT = 200;

/**
 * How far back the coverage strip looks.
 *
 * A year is the window worth watching: it is what the owner asked for, it keeps
 * the strip a size a thumb can hit on a phone, and a day older than that has
 * long since settled one way or the other. The conversion counts above the
 * strip still cover the whole ledger, so nothing is hidden by this — only the
 * calendar is.
 */
export const COVERAGE_DAYS = 365;

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
  today: string,
): Promise<FxConversionStatus> {
  // Once per reporting currency, against the same rows. A payment that cannot
  // be priced in euro is a failure even while the page is showing hryvnia.
  const currencies: FxConversionStatus['conversions']['currencies'] = [];
  const failures = new Map<
    string,
    { row: ConvertedSpendingRow; missingFor: string[] }
  >();
  for (const currency of REPORTING_CURRENCIES) {
    const spending = await convertedSpending(repo, rows, currency);
    const method = { bank: 0, daily: 0, identity: 0 };
    let missing = 0;
    for (const row of spending.rows) {
      if (row.status === 'missing') {
        missing++;
        const held = failures.get(row.id);
        if (held) held.missingFor.push(currency);
        else failures.set(row.id, { row, missingFor: [currency] });
        continue;
      }
      if (row.method === 'actual_bank') method.bank++;
      else if (row.method === 'market_estimate') method.daily++;
      else if (row.method === 'identity') method.identity++;
    }
    currencies.push({
      currency,
      converted: spending.rows.length - missing,
      missing,
      method,
    });
  }
  // Worst first: whatever is broken is the first thing read.
  currencies.sort(
    (a, b) =>
      b.missing - a.missing ||
      REPORTING_CURRENCIES.indexOf(
        a.currency as (typeof REPORTING_CURRENCIES)[number],
      ) -
        REPORTING_CURRENCIES.indexOf(
          b.currency as (typeof REPORTING_CURRENCIES)[number],
        ),
  );
  const missingRows = [...failures.values()].sort((a, b) =>
    a.row.bookedAt < b.row.bookedAt ? 1 : -1,
  );
  const dates = rows
    .map((row) => new Date(row.bookedAt).toISOString().slice(0, 10))
    .sort();
  // The range the rates have to cover is the ledger's own span, extended to
  // today: a rate for a day after the last payment is what proves the nightly
  // sync is still running, and nothing else in the application would notice if
  // it stopped.
  const earliest = dates[0] ?? today;
  const latest = dates.at(-1) ?? today;
  const window = new Date(
    Date.parse(`${today}T00:00:00Z`) - (COVERAGE_DAYS - 1) * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const span = earliest < today ? earliest : today;
  const from = span > window ? span : window;
  const to = latest > today ? latest : today;
  // The days a rate is actually wanted for: the ones carrying a payment, plus
  // today, which is exactly the set the nightly sync asks about. Keeping the two
  // definitions identical is what stops the page reporting a gap the sync was
  // never going to fill.
  const needed = new Set([...dates, today]);
  const days = await fxCoverage(repo.db, from, to, needed);
  const current =
    [...days].reverse().find((day) => day.state === 'covered')?.date ?? null;
  const sources = (
    await repo.db.query(
      'SELECT source,count(DISTINCT as_of)::int AS days FROM daily_fx_rates WHERE as_of>=$1 AND as_of<=$2 GROUP BY source',
      [from, to],
    )
  ).rows
    .map((row) => ({ source: String(row.source), days: Number(row.days) }))
    .sort((a, b) => compareFxSources(a.source, b.source));
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
    rates: {
      from,
      to,
      days,
      covered: days.filter((day) => day.state === 'covered').length,
      needed: days.filter((day) => day.state !== 'not_needed').length,
      current,
      sources,
    },
    conversions: {
      total: rows.length,
      currencies,
      missing: missingRows.length,
    },
    unconverted: missingRows
      .slice(0, UNCONVERTED_LIMIT)
      .map(({ row, missingFor }) => {
        const source = byId.get(row.id)!;
        const registered = accounts.get(
          accountKey(source.source, source.accountId),
        );
        const label =
          registered?.label == null ? null : String(registered.label);
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
          reason: missingReasonSentence(
            row.missingReason ?? 'no_matching_quote',
          ),
          missingFor,
        };
      }),
    unconvertedCapped: missingRows.length > UNCONVERTED_LIMIT,
  };
}
