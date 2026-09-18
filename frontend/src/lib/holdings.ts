// What the holdings API says, and the words the screens put on it. The assets
// screens each read the same report, so the shape and the vocabulary live here
// rather than being spelt out again on every page.
import { queryClient } from './query';

export type Feed = 'bank' | 'ibkr' | 'binance' | 'wallet';
export type Owner = 'rodion' | 'katya';

export type Holding = {
  id: string;
  name: string;
  kind: string;
  denomination: string;
  invested: boolean;
  liquid: boolean;
  owner: Owner | null;
  group: string | null;
  maturesOn: string | null;
  note: string | null;
  archived: boolean;
  revision: number;
  feed: Feed | null;
  feedRef: string | null;
};

/** An account whose stored balance can fill a holding, named the one way. */
export type LinkableAccount = {
  source: string;
  accountId: string;
  owner: Owner;
  label: string;
  currencies: string[];
  displayName: string;
};

export type HoldingRow = {
  holding: Holding;
  quantity: string | null;
  quantityAsOf: string | null;
  carried: boolean;
  source: string | null;
  enteredAmount?: string | null;
  enteredCurrency?: string | null;
  valueMinor: string | null;
  price: {
    usdPerUnit: string;
    asOf: string;
    source: string;
    approximate: boolean;
  } | null;
};

export type HoldingTotals = {
  asOf: string;
  totalMinor: string;
  investedMinor: string;
  notInvestedMinor: string;
  liquidMinor: string;
  uahMinor: string;
  missing: number;
  counted: number;
};

export type HoldingsReport = {
  display: string;
  at: string;
  dates: string[];
  rows: HoldingRow[];
  totals: HoldingTotals;
  previous: HoldingTotals | null;
  series: HoldingTotals[];
  accounts: LinkableAccount[];
};

export const holdingKinds: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank account',
  broker: 'Brokerage',
  crypto: 'Crypto',
  bond: 'Bond',
  deposit: 'Deposit',
  fund: 'Fund',
  real_estate: 'Real estate',
  business: 'Business',
  receivable: 'Owed to us',
  other: 'Other',
};

export const feedNames: Record<Feed, string> = {
  bank: 'Bank balance',
  ibkr: 'Interactive Brokers',
  binance: 'Binance',
  wallet: 'Wallet address',
};

export const feedHints: Record<Feed, string> = {
  bank: 'The account whose stored balance fills this holding.',
  ibkr: 'The symbol in the statement, or CASH for the cash in this currency.',
  binance: 'TOTAL for everything in USD, or one asset symbol.',
  wallet: 'The public address, or an extended public key.',
};

export const sourceNames: Record<string, string> = {
  manual: 'typed',
  spreadsheet: 'spreadsheet',
  bank: 'from the bank',
  ibkr: 'from IBKR',
  binance: 'from Binance',
  wallet: 'from the wallet',
};

export const ownerNames: Record<Owner, string> = {
  rodion: 'Rodion',
  katya: 'Katya',
};

/** Today in the household's own calendar; a snapshot belongs to a Riga day. */
export const rigaToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** A figure typed by hand: digits, optionally signed, optionally fractional. */
export const decimalPattern = /^-?\d+(\.\d+)?$/;
export const isDecimal = (value: string) => decimalPattern.test(value.trim());

/** A calendar day as the API writes it; a URL can carry anything. */
export const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (value: string) => dayPattern.test(value);

/**
 * One form-encoded POST, with the messages a person can act on. The server
 * answers 409 when the record moved under us and 400 when the figure is wrong;
 * either way the page says which, and nothing is retried silently.
 */
export async function postForm<T>(
  path: string,
  fields: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Your session has changed. Reload the page and try again.'
        : response.status === 409
          ? 'This changed since you opened it. Refresh and try again.'
          : response.status === 400
            ? 'The server refused this. Check the fields and try again.'
            : response.status === 404
              ? 'This server does not have that yet. Update it and try again.'
              : 'Not saved. Try again.',
    );
  return (await response.json()) as T;
}

/**
 * Every figure recorded on one day, taken out together. A day counted wrongly
 * is removed whole and counted again; there is no half-corrected snapshot.
 */
export const deleteSnapshotDay = (csrf: string, asOf: string) =>
  postForm<{ removed: number }>('/api/holding-snapshots/delete', {
    csrf,
    asOf,
  });

/** What one feed did when the automatic figures were read for a day. */
export type FeedOutcome =
  | {
      feed: Feed;
      status: 'ok';
      summary: {
        filled: number;
        unchanged: number;
        skipped: Record<string, number>;
        pricesRecorded: number;
        created: number;
      };
    }
  | { feed: Feed; status: 'not_configured' }
  | { feed: Feed; status: 'failed'; code: string };

/**
 * Read the automatic figures for today — stored bank balances, the broker,
 * the exchange, the wallets — and write them into the day's snapshot. The
 * server refuses any other day: a reading is of now.
 */
export const readFeeds = (csrf: string, asOf: string) =>
  postForm<{ outcomes: FeedOutcome[] }>('/api/holdings/read-feeds', {
    csrf,
    asOf,
  });

/** One line per feed, counts only: "bank 14 read, 1 skipped · IBKR failed (auth)". */
export function describeOutcomes(outcomes: FeedOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const name = feedNames[outcome.feed] ?? outcome.feed;
      if (outcome.status === 'not_configured') return `${name} not configured`;
      if (outcome.status === 'failed')
        return `${name} failed (${outcome.code})`;
      const { filled, unchanged, skipped, created } = outcome.summary;
      const skippedCount = Object.values(skipped).reduce((a, b) => a + b, 0);
      const parts = [`${filled + unchanged} read`];
      if (created) parts.push(`${created} new`);
      if (skippedCount) parts.push(`${skippedCount} skipped`);
      return `${name} ${parts.join(', ')}`;
    })
    .join(' · ');
}

/** Every holdings view is stale once a figure is written. */
export const refreshHoldings = () =>
  queryClient.invalidateQueries({ queryKey: ['holdings'] });

/** The report's own address, so both pages ask for it the same way. */
export const holdingsUrl = (display: string, at?: string) =>
  `/api/holdings?display=${encodeURIComponent(display)}${at ? `&at=${encodeURIComponent(at)}` : ''}`;

/** Group first, then name; the order a person reads a list of holdings in. */
export function byGroupThenName(a: Holding, b: Holding) {
  const group = (a.group ?? '').localeCompare(b.group ?? '');
  return group !== 0 ? group : a.name.localeCompare(b.name);
}
