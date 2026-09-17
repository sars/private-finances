import type { Owner } from '../domain.js';
import { validateTransaction } from '../domain.js';
import {
  ConnectorError,
  record,
  text,
  type BankAccount,
  type BankConnector,
  type BankTransaction,
  type Requester,
} from './types.js';

const currencies: Record<number, string> = {
  980: 'UAH',
  978: 'EUR',
  840: 'USD',
  826: 'GBP',
  985: 'PLN',
  756: 'CHF',
  203: 'CZK',
  752: 'SEK',
  578: 'NOK',
  208: 'DKK',
  392: 'JPY',
  414: 'KWD',
  48: 'BHD',
};
/** A whole number of minor units, or null when the provider sent anything else.
 * Monobank states balances as integers already, so there is nothing to convert
 * and nothing to round; a fractional or out-of-range value is a payload this
 * code does not understand and is dropped rather than guessed at. */
function wholeMinor(value: unknown): string | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) < 1e15
    ? String(value)
    : null;
}
/** The `balance` field of an account or jar, with the card's overdraft when one
 * is published. Returns nothing to spread when the balance is unreadable, so an
 * account still lists without one. */
function balanceOf(
  raw: Record<string, unknown>,
  currency: string,
): { balance: BankAccount['balance'] } | null {
  const amountMinor = wholeMinor(raw.balance);
  if (amountMinor === null) return null;
  // `creditLimit` is the agreed overdraft already counted inside `balance`.
  // Zero means no overdraft and is not worth recording.
  const creditLimitMinor = wholeMinor(raw.creditLimit);
  return {
    balance: {
      currency,
      amountMinor,
      ...(creditLimitMinor !== null && creditLimitMinor !== '0'
        ? { creditLimitMinor }
        : {}),
    },
  };
}
export class MonobankConnector implements BankConnector {
  readonly source = 'monobank' as const;
  constructor(
    readonly owner: Owner,
    private readonly token: string,
    private readonly request: Requester,
    private readonly includeJars = true,
  ) {
    if (!token.trim()) throw new ConnectorError('auth');
  }
  async accounts(): Promise<BankAccount[]> {
    const data = record(
      await this.request('/personal/client-info', { 'X-Token': this.token }),
    );
    if (!Array.isArray(data.accounts)) throw new ConnectorError('schema');
    // Include jars when supplied, but never silently infer third-party managedClients ownership.
    if (data.jars !== undefined && !Array.isArray(data.jars))
      throw new ConnectorError('schema');
    return [
      ...data.accounts,
      ...(this.includeJars ? ((data.jars as unknown[] | undefined) ?? []) : []),
    ].map((raw) => {
      const a = record(raw);
      const id = text(a.id);
      const currency = currencies[Number(a.currencyCode)];
      if (!currency) throw new ConnectorError('schema');
      return {
        source: this.source,
        accountId: `mono:${this.owner}:${id}`,
        providerAccountId: id,
        owner: this.owner,
        currency,
        // Stated per account in client-info. A jar has none, and an absent or
        // malformed value is simply not registered rather than guessed at.
        ...(typeof a.iban === 'string' && a.iban.trim()
          ? { iban: a.iban.trim() }
          : {}),
        // Stated per account as an array, one entry per physical card. A jar
        // has none. Anything that is not a string is dropped rather than
        // passed on, and whether a string is really a card number is decided
        // by the one function that does the matching.
        ...(Array.isArray(a.maskedPan)
          ? {
              cards: a.maskedPan.filter(
                (pan): pan is string => typeof pan === 'string' && !!pan.trim(),
              ),
            }
          : {}),
        label:
          typeof a.title === 'string'
            ? text(a.title)
            : typeof a.type === 'string'
              ? text(a.type)
              : 'Monobank account',
        // Stated per account and per jar in the same `client-info` response the
        // listing already costs, in the account's own minor units. It is read
        // here rather than fetched later so knowing what an account holds
        // spends no part of the 60-second-per-token allowance. A value that is
        // not a whole number is dropped rather than rounded: a balance nobody
        // can vouch for is worse than no balance.
        ...(balanceOf(a, currency) ?? {}),
      };
    });
  }
  async transactions(
    account: BankAccount,
    from: Date,
    to: Date,
  ): Promise<BankTransaction[]> {
    if (
      account.source !== this.source ||
      account.owner !== this.owner ||
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      to <= from
    )
      throw new ConnectorError('schema');
    const result: BankTransaction[] = [];
    const start = Math.floor(from.getTime() / 1000),
      end = Math.floor(to.getTime() / 1000);
    // Inclusive windows share their boundary second; source IDs deduplicate overlaps.
    for (let at = start; at < end;) {
      const until = Math.min(at + 2682000, end);
      const windows = [{ start: at, end: until, depth: 0 }];
      let requests = 0;
      while (windows.length) {
        const window = windows.pop()!;
        // Bound provider calls per original 31-day window, even for pathological data.
        if (++requests > 255) throw new ConnectorError('incomplete');
        const data = await this.request(
          `/personal/statement/${encodeURIComponent(account.providerAccountId)}/${window.start}/${window.end}`,
          { 'X-Token': this.token },
        );
        if (!Array.isArray(data)) throw new ConnectorError('schema');
        if (data.length >= 500) {
          // A one-second interval cannot shrink further while preserving overlap.
          if (window.end - window.start <= 1 || window.depth >= 22)
            throw new ConnectorError('incomplete');
          const midpoint = Math.floor((window.start + window.end) / 2);
          // Discard the capped parent response; only complete child windows count.
          windows.push(
            { start: midpoint, end: window.end, depth: window.depth + 1 },
            { start: window.start, end: midpoint, depth: window.depth + 1 },
          );
          continue;
        }
        for (const raw of data) {
          const t = record(raw);
          if (
            !Number.isSafeInteger(t.amount) ||
            !Number.isSafeInteger(t.time) ||
            typeof t.hold !== 'boolean'
          )
            throw new ConnectorError('schema');
          const timestamp = new Date(Number(t.time) * 1000);
          if (timestamp < from || timestamp > to) continue;
          const normalized = validateTransaction({
            source: this.source,
            sourceId: text(t.id),
            accountId: account.accountId,
            owner: this.owner,
            bookedAt: timestamp.toISOString(),
            currency: account.currency,
            amountMinor: String(t.amount),
            description: typeof t.description === 'string' ? t.description : '',
          });
          result.push({
            ...normalized,
            status: t.hold ? 'pending' : 'booked',
            sourceDetails: t,
          });
        }
      }
      at = until;
    }
    return [...new Map(result.map((t) => [t.sourceId, t])).values()];
  }
}
