import type { Owner, TransactionInput } from '../domain.js';
import type { BankSlug } from './banks.js';

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
