/**
 * One page of the household's payments, chosen and cut by the database.
 *
 * The list screens used to receive an owner's whole ledger and throw most of
 * it away in the browser. Here every filter that can be expressed against the
 * `transactions` table becomes a WHERE clause, the page is cut with a keyset
 * rather than an offset, and only the rows on the page are enriched with
 * their account policy, spending pattern and refunds. The grammar is the one
 * `/api/analytics` already speaks (owner, from, to, category, pattern, scope)
 * so a drill link from a figure lists exactly the payments behind it, plus
 * what a list needs and a chart does not: a search box, the kinds, tags,
 * receipts, refunds, an amount range and the household's visibility defaults.
 *
 * Two predicates are not written in SQL, because their truth is decided by
 * code that must not exist twice. A linked refund credit is hidden unless one
 * of its links disagrees with a later bank correction, and a purchase is hidden
 * as "came to nothing" only when its net after refunds is zero without such a
 * disagreement; both are computed by `attachRefunds` and `settledToNothing`
 * over the few linked payments, and the ids they yield are handed to SQL. The
 * amount range compares the converted net figure, which only the reporting
 * conversion produces, so when that filter is active the candidates are
 * converted first and the page is cut afterwards.
 */
import type { Repository, Transaction } from './repository.js';
import { settledToNothing, type ReviewPreferences } from './app-settings.js';
import { convertedSpending, type ConvertedSpendingRow } from './analytics.js';
import { parseFilters, type Filters } from './filters.js';
import { MEANINGLESS_CATEGORY } from './spending-review.js';
import type { Kind, Owner } from './domain.js';

export const KINDS: Kind[] = [
  'unresolved',
  'personal_expense',
  'internal_transfer',
  'investment',
  'non_personal',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

export type PageQuery = Filters & {
  /** One member, or the household when absent. */
  owner?: Owner;
  /** Only outflows still waiting for a decision (`needsSpendingReview`). */
  review: boolean;
  /** Case-insensitive fragment of the description. */
  q?: string;
  /** One account, by the importer's account id; the label is the owner's
   * own name for it and changes, the id does not. */
  account?: string;
  kinds?: Kind[];
  /** A tag id the payment must carry. */
  tag?: string;
  receipts?: 'with' | 'without';
  refunds?: 'with' | 'without';
  /** Bounds on the magnitude of what the payment finally cost, in minor units
   * of `display`; a payment without a conversion never satisfies them. */
  minMinor?: bigint;
  maxMinor?: bigint;
  display?: string;
  /** The id of the last payment already shown; the page starts after it. */
  cursor?: string;
  limit: number;
};

export function parsePageQuery(params: URLSearchParams): PageQuery {
  const owner = params.get('owner') || undefined;
  if (owner && owner !== 'rodion' && owner !== 'katya')
    throw new Error('invalid_owner');
  const filters = parseFilters(params);
  const q = params.get('q')?.trim() || undefined;
  if (q && q.length > 200) throw new Error('invalid_search');
  const account = params.get('account') || undefined;
  if (account && account.length > 200) throw new Error('invalid_account');
  const kindsText = params.get('kinds') || undefined;
  const kinds = kindsText?.split(',').map((k) => k.trim());
  if (kinds && (!kinds.length || kinds.some((k) => !KINDS.includes(k as Kind))))
    throw new Error('invalid_kinds');
  const tag = params.get('tag') || undefined;
  if (tag && !UUID.test(tag)) throw new Error('invalid_tag');
  const presence = (key: 'receipts' | 'refunds') => {
    const value = params.get(key) || undefined;
    if (value && value !== 'with' && value !== 'without')
      throw new Error(`invalid_${key}`);
    return value as 'with' | 'without' | undefined;
  };
  const display = params.get('display') || undefined;
  if (display && !/^[A-Z]{3}$/.test(display))
    throw new Error('invalid_display_currency');
  const bound = (key: 'min' | 'max') => {
    const value = params.get(key);
    if (value === null || value === '') return undefined;
    if (!/^\d{1,18}$/.test(value)) throw new Error('invalid_amount');
    if (!display) throw new Error('invalid_display_currency');
    return BigInt(value);
  };
  const minMinor = bound('min'),
    maxMinor = bound('max');
  if (minMinor !== undefined && maxMinor !== undefined && minMinor > maxMinor)
    throw new Error('invalid_amount');
  const cursor = params.get('cursor') || undefined;
  if (cursor && !UUID.test(cursor)) throw new Error('invalid_cursor');
  const limitText = params.get('limit');
  const limit = limitText === null ? DEFAULT_PAGE : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
    throw new Error('invalid_limit');
  return {
    ...filters,
    owner: owner as Owner | undefined,
    review: params.get('review') === '1',
    q,
    account,
    kinds: kinds as Kind[] | undefined,
    tag,
    receipts: presence('receipts'),
    refunds: presence('refunds'),
    minMinor,
    maxMinor,
    display,
    cursor,
    limit,
  };
}

const rigaParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Riga',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
/** The instant a Riga calendar day begins, so a date filter can use the
 * `booked_at` index instead of converting every row's zone. Riga changes its
 * clocks at three in the morning, so midnight is never ambiguous. */
export function rigaDayStart(day: string): string {
  const midnightUtc = Date.parse(day + 'T00:00:00Z');
  let guess = midnightUtc;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      rigaParts.formatToParts(new Date(guess)).map((x) => [x.type, x.value]),
    );
    const seen = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    guess = midnightUtc - (seen - guess);
  }
  return new Date(guess).toISOString();
}
function nextDay(day: string): string {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

class Clause {
  readonly parts: string[] = [];
  readonly params: unknown[] = [];
  add(sql: (n: (value: unknown) => string) => string) {
    this.parts.push(
      sql((value) => {
        this.params.push(value);
        return `$${this.params.length}`;
      }),
    );
  }
  get where() {
    return this.parts.length ? this.parts.join(' AND ') : 'TRUE';
  }
}

const LINKED_CREDIT =
  "EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND r.credit_id=t.id)";
const LINKED_DEBIT =
  "EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND r.debit_id=t.id)";
const HAS_RECEIPT =
  "EXISTS(SELECT 1 FROM receipt_jobs r WHERE r.transaction_id=t.id AND r.state='matched')";

/**
 * The WHERE clause for a query, against `t` and `sp`. The two predicates that
 * depend on refund arithmetic are resolved first into id lists.
 */
export async function pageClause(
  repo: Repository,
  query: PageQuery,
  preferences: ReviewPreferences,
): Promise<Clause> {
  const c = new Clause();
  if (query.owner) c.add((n) => `t.owner=${n(query.owner)}`);
  if (query.from)
    c.add((n) => `t.booked_at >= ${n(rigaDayStart(query.from!))}::timestamptz`);
  if (query.to)
    c.add(
      (n) =>
        `t.booked_at < ${n(rigaDayStart(nextDay(query.to!)))}::timestamptz`,
    );
  if (query.currency) c.add((n) => `t.currency=${n(query.currency)}`);
  if (query.category)
    c.add(
      (n) =>
        `(t.category=${n(query.category)} OR left(t.category, ${n(query.category!.length + 3)}::int)=${n(query.category + ' / ')})`,
    );
  if (query.pattern)
    c.add((n) => `COALESCE(sp.pattern,'unreviewed')=${n(query.pattern)}`);
  if (query.scope === 'spending') c.add(() => "t.kind='personal_expense'");
  if (query.scope === 'unresolved') c.add(() => "t.kind='unresolved'");
  if (query.scope === 'excluded')
    c.add(() => "t.kind IN ('internal_transfer','investment','non_personal')");
  if (query.kinds) c.add((n) => `t.kind=ANY(${n(query.kinds)}::text[])`);
  if (query.q)
    c.add((n) => `position(lower(${n(query.q)}) in lower(t.description)) > 0`);
  if (query.account) c.add((n) => `t.account_id=${n(query.account)}`);
  if (query.tag)
    c.add(
      (n) =>
        `EXISTS(SELECT 1 FROM transaction_tags g WHERE g.transaction_id=t.id AND g.tag_id=${n(query.tag)}::uuid)`,
    );
  if (query.receipts)
    c.add(() =>
      query.receipts === 'with' ? HAS_RECEIPT : `NOT ${HAS_RECEIPT}`,
    );
  // "With refunds" means a purchase that was partly or wholly given back, not
  // the money-in credit that gave it back: the owner is looking for what they
  // bought. "Without" still excludes both sides, so the two halves of the
  // filter never show the same credit.
  if (query.refunds)
    c.add(() =>
      query.refunds === 'with'
        ? LINKED_DEBIT
        : `NOT (${LINKED_DEBIT} OR ${LINKED_CREDIT})`,
    );
  if (query.review)
    // needsSpendingReview(t, true, true): undecided or filed in the root
    // catch-all, an outflow, and on a kind that counts as spending. Holds are
    // included, as the review screen has always done.
    c.add(
      (n) =>
        `(t.kind='unresolved' OR t.provisional OR t.category=${n(MEANINGLESS_CATEGORY)}) AND t.amount_minor < 0 AND t.kind IN ('unresolved','personal_expense')`,
    );
  if (preferences.hideNonPersonal) c.add(() => "t.kind<>'non_personal'");
  if (preferences.hideInternalTransfers)
    c.add(() => "t.kind<>'internal_transfer'");
  if (preferences.hideRefunds) {
    // A credit already counted through its purchase, unless a link disagrees
    // with a later correction: that needs a person and stays listed.
    const credits = await repo.select(LINKED_CREDIT, []);
    const disputed = credits
      .filter((t) =>
        t.refund?.reductions.some((item) => item.discrepancy !== null),
      )
      .map((t) => t.id);
    c.add((n) => `(NOT ${LINKED_CREDIT} OR t.id=ANY(${n(disputed)}::uuid[]))`);
  }
  if (preferences.hideZeroAmount) {
    const candidates = await repo.select(
      `(t.amount_minor=0 OR ${LINKED_DEBIT})`,
      [],
    );
    const nothing = candidates.filter(settledToNothing).map((t) => t.id);
    c.add((n) => `t.id<>ALL(${n(nothing)}::uuid[])`);
  }
  return c;
}

export type TransactionPage = {
  transactions: Transaction[];
  /** How many payments the filters select in all, not only on this page. */
  total: number;
  /** Pass back as `cursor` for the next page; null when this is the last. */
  nextCursor: string | null;
  /** Present when the amount filter already converted the page's rows. */
  reporting?: { currency: string; rows: ConvertedSpendingRow[] };
};

function magnitude(row: ConvertedSpendingRow | undefined): bigint | null {
  const value = row?.netAmountMinor ?? row?.convertedAmountMinor ?? null;
  if (value === null) return null;
  const n = BigInt(value);
  return n < 0n ? -n : n;
}

export async function pageTransactions(
  repo: Repository,
  query: PageQuery,
  preferences: ReviewPreferences,
): Promise<TransactionPage> {
  const clause = await pageClause(repo, query, preferences);
  if (query.minMinor !== undefined || query.maxMinor !== undefined) {
    const candidates = await repo.select(clause.where, clause.params);
    const reporting = await convertedSpending(repo, candidates, query.display!);
    const byId = new Map(reporting.rows.map((r) => [r.id, r]));
    const matching = candidates.filter((t) => {
      const size = magnitude(byId.get(t.id));
      return (
        size !== null &&
        (query.minMinor === undefined || size >= query.minMinor) &&
        (query.maxMinor === undefined || size <= query.maxMinor)
      );
    });
    const start = query.cursor
      ? matching.findIndex((t) => t.id === query.cursor) + 1
      : 0;
    const transactions = matching.slice(start, start + query.limit);
    return {
      transactions,
      total: matching.length,
      nextCursor:
        start + query.limit < matching.length ? transactions.at(-1)!.id : null,
      reporting: {
        currency: reporting.currency,
        rows: reporting.rows.filter((r) =>
          transactions.some((t) => t.id === r.id),
        ),
      },
    };
  }
  const total = await repo.count(clause.where, clause.params);
  if (query.cursor)
    clause.add(
      (n) =>
        `EXISTS(SELECT 1 FROM transactions c WHERE c.id=${n(query.cursor)}::uuid AND (t.booked_at < c.booked_at OR (t.booked_at=c.booked_at AND t.id > c.id)))`,
    );
  const rows = await repo.select(clause.where, clause.params, query.limit + 1);
  const transactions = rows.slice(0, query.limit);
  return {
    transactions,
    total,
    nextCursor: rows.length > query.limit ? transactions.at(-1)!.id : null,
  };
}
