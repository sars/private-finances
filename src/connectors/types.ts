import type { Owner, TransactionInput } from '../domain.js';
import type { BankSlug } from './banks.js';

/**
 * What an account holds, as the provider states it.
 *
 * A balance is evidence carrying a timestamp, not a running total this
 * application computes: nothing sums transactions into a position, because
 * there is no opening figure to sum from. `asOf` is the provider's own word for
 * when the figure was true and is absent when it does not say, in which case
 * the time we asked is all anyone knows.
 */
export type AccountBalance = {
  currency: string;
  /** Exact integer minor units, signed; an overdrawn account is negative. */
  amountMinor: string;
  /** An agreed overdraft, when the provider publishes one. The amount above
   * already includes it, so own money is the amount less this. */
  creditLimitMinor?: string;
  asOf?: string;
};
export type BankAccount = {
  source: 'monobank' | 'enablebanking';
  accountId: string;
  providerAccountId: string;
  owner: Owner;
  currency: string;
  label: string;
  identificationHash?: string;
  /** The account's own IBAN when the provider states it. Registered as a hash so
   * a transfer to this account can be recognised as household money rather than
   * spending; absent when a provider does not publish it, in which case the
   * owner types it once in Accounts. */
  iban?: string;
  /** Masked card numbers the provider publishes for this account, as printed —
   * `537541******1234`. A card-to-card transfer names its recipient by exactly
   * this string and nothing else, so knowing our own cards is the only way such
   * a payment can be recognised as household money rather than spending. */
  cards?: string[];
  /** Stated alongside the account listing, when the provider puts it there.
   * Monobank does, at no extra request; Enable Banking keeps balances behind a
   * request of their own and answers `balances()` instead. */
  balance?: AccountBalance;
};
export type BankTransaction = TransactionInput & {
  status: 'pending' | 'booked';
  sourceDetails: Record<string, unknown>;
};
export interface BankConnector {
  readonly source: BankAccount['source'];
  readonly owner: Owner;
  readonly bank?: BankSlug;
  accounts(): Promise<BankAccount[]>;
  /** What the account holds now, for a provider that does not state it with the
   * listing. Optional: a connector that fills `BankAccount.balance` needs no
   * second request. A caller treats failure here as "not known" and never as a
   * failed import, so a bank that refuses a balance still delivers payments.
   * An account holding several currencies answers with one entry per currency,
   * which is the only shape that can describe it. */
  balances?(account: BankAccount): Promise<AccountBalance[]>;
  transactions(
    account: BankAccount,
    from: Date,
    to: Date,
  ): Promise<BankTransaction[]>;
}
export class ConnectorError extends Error {
  constructor(
    public readonly code:
      'auth' | 'rate_limit' | 'transient' | 'schema' | 'consent' | 'incomplete',
    public readonly retryAfterMs?: number,
  ) {
    super(`connector_${code}`);
  }
}
export type Requester = (
  path: string,
  headers: Record<string, string>,
) => Promise<unknown>;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConnectorError('schema');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ConnectorError('schema');
  return value;
}
export function decimalToMinor(amount: string, currency: string): string {
  const digits: Record<string, number> = {
    UAH: 2,
    EUR: 2,
    USD: 2,
    GBP: 2,
    PLN: 2,
    CHF: 2,
    CZK: 2,
    SEK: 2,
    NOK: 2,
    DKK: 2,
    JPY: 0,
    KWD: 3,
    BHD: 3,
  };
  const exponent = digits[currency];
  if (exponent === undefined || !/^[+-]?\d+(\.\d+)?$/.test(amount))
    throw new ConnectorError('schema');
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = amount.replace(/^[+-]/, '').split('.');
  if (fraction.length > exponent || (whole?.length ?? 0) + exponent > 30)
    throw new ConnectorError('schema');
  const value =
    BigInt(whole!) * 10n ** BigInt(exponent) +
    BigInt(fraction.padEnd(exponent, '0') || '0');
  return (negative ? -value : value).toString();
}
