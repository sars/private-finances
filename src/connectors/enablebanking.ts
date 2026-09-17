import { createHash, createPrivateKey, sign } from 'node:crypto';
import type { Owner } from '../domain.js';
import { bankLabel, isBankSlug, type BankSlug } from './banks.js';
import {
  ConnectorError,
  decimalToMinor,
  record,
  text,
  type AccountBalance,
  type BankAccount,
  type BankConnector,
  type BankTransaction,
  type Requester,
} from './types.js';

export function signJwt(
  applicationId: string,
  privateKey: string,
  nowSecs = Math.floor(Date.now() / 1000),
): string {
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'rsa' || !Number.isSafeInteger(nowSecs))
      throw new Error();
    const header = Buffer.from(
      JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: text(applicationId) }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        iss: 'enablebanking.com',
        aud: 'api.enablebanking.com',
        iat: nowSecs,
        exp: nowSecs + 3600,
      }),
    ).toString('base64url');
    const payload = `${header}.${body}`;
    return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`;
  } catch {
    throw new ConnectorError('auth');
  }
}

function day(value: unknown): string {
  const date = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ConnectorError('schema');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new ConnectorError('schema');
  return parsed.toISOString();
}
/**
 * ISO 20022 balance types, best first. `ITAV` is what is spendable now and
 * `CLBD` what the bank last closed the books on; the two interim and opening
 * figures follow. Everything else — forward-dated availability, informational
 * rows, a bank's own `OTHR` — is deliberately absent, so an unrecognised type
 * is skipped instead of being shown as the account's position.
 */
const balanceRanks: Record<string, number> = {
  ITAV: 0,
  CLBD: 1,
  ITBD: 2,
  OPAV: 3,
  OPBD: 4,
  PRCD: 5,
};
/**
 * A provider timestamp as an instant. The resource carries either a full
 * date-time or a bare calendar day; a day is read at UTC midnight, the same
 * reading the transaction importer already gives Enable Banking dates. An
 * unparseable value is a payload this code does not understand.
 */
function instant(value: string): string {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return day(raw);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new ConnectorError('schema');
  return new Date(parsed).toISOString();
}
function identity(owner: Owner, hash: string): string {
  return `enablebanking:${owner}:${createHash('sha256').update(hash).digest('hex')}`;
}

/** Read-only existing-session adapter. Requester must enforce the fixed provider host and GET-only requests. */

/**
 * What an account is called on screen.
 *
 * The owner could not find their own rent payment. It leaves Revolut, and the
 * app called the account "USD account"; their Wise dollar account was called
 * "USD". Five foreign accounts read EUR, EUR account, GBP, USD and USD account,
 * with nothing anywhere saying which bank — and two pairs separated only by the
 * word "account".
 *
 * The provider's own name for the account is the cause: Revolut sends nothing
 * useful and Wise sends the bare currency. The bank is known here and was
 * simply not used. It is used now, and it leads, because the bank is what the
 * owner recognises first.
 *
 * Anything the provider says beyond the currency is kept after it, so a second
 * account in the same currency at the same bank stays distinguishable. A
 * provider label that only repeats the currency, or is the fallback we would
 * have generated ourselves, adds nothing and is dropped.
 *
 * An account that holds several currencies has no single currency to lead with.
 * Swedbank reports such an account as XXX, the ISO code for "no currency", and
 * "Swedbank XXX" means nothing to the owner — so the provider's own word for it
 * leads instead, and failing that it is simply the bank's multi-currency
 * account.
 */
export function accountLabel(
  bank: BankSlug,
  currency: string,
  details: Record<string, unknown> = {},
): string {
  const provider = [details.details, details.product]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => text(value))[0];
  // An account holding several currencies is named after the bank alone.
  // The household's Swedbank account arrived as "Swedbank XXX · CURRENT" and
  // was renamed twice before it read "Swedbank"; the LHV account arrived
  // with the holder's own name as the provider's only descriptor, and a
  // person's name is not an account name. What the provider calls such an
  // account is kept in `source_details` of its payments, not in its label.
  if (isMultiCurrency(currency)) return bankLabel(bank);
  const base = `${bankLabel(bank)} ${currency}`;
  if (!provider) return base;
  const noise = new Set([
    currency.toLowerCase(),
    `${currency.toLowerCase()} account`,
    'account',
    'current account',
    bankLabel(bank).toLowerCase(),
  ]);
  const extra = provider.trim();
  return noise.has(extra.toLowerCase()) ? base : `${base} · ${extra}`;
}

/**
 * XXX is the ISO 4217 code for "no currency". A bank uses it for an account
 * that holds several, and then only each payment knows what it was settled in.
 */
export function isMultiCurrency(currency: string): boolean {
  return currency === 'XXX';
}

export class EnableBankingConnector implements BankConnector {
  readonly source = 'enablebanking' as const;
  readonly owner: Owner;
  readonly bank: BankSlug;
  constructor(
    private readonly config: {
      owner: Owner;
      bank: BankSlug;
      applicationId: string;
      privateKey: string;
      sessionId: string;
    },
    private readonly requester: Requester,
  ) {
    this.owner = config.owner;
    this.bank = config.bank;
    if (!isBankSlug(this.bank)) throw new ConnectorError('schema');
    text(config.sessionId);
    if (this.owner !== 'rodion' && this.owner !== 'katya')
      throw new ConnectorError('schema');
  }
  private async get(path: string): Promise<Record<string, unknown>> {
    return record(
      await this.requester(path, {
        Authorization: `Bearer ${signJwt(this.config.applicationId, this.config.privateKey)}`,
        Accept: 'application/json',
      }),
    );
  }
  private async session(): Promise<Record<string, unknown>[]> {
    const session = await this.get(
      `/sessions/${encodeURIComponent(this.config.sessionId)}`,
    );
    if (session.status !== 'AUTHORIZED') throw new ConnectorError('consent');
    const validUntil = text(record(session.access).valid_until, 64);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        validUntil,
      ) ||
      !Number.isFinite(Date.parse(validUntil))
    )
      throw new ConnectorError('schema');
    if (Date.parse(validUntil) <= Date.now())
      throw new ConnectorError('consent');
    if (
      !Array.isArray(session.accounts_data) ||
      session.accounts_data.length > 200
    )
      throw new ConnectorError('schema');
    return session.accounts_data.map(record);
  }
  async accounts(): Promise<BankAccount[]> {
    const result: BankAccount[] = [];
    const seen = new Set<string>();
    for (const entry of await this.session()) {
      const uid = text(entry.uid),
        hash = text(entry.identification_hash, 8192);
      const accountId = identity(this.owner, hash);
      if (seen.has(accountId)) throw new ConnectorError('schema');
      seen.add(accountId);
      const details = await this.get(
        `/accounts/${encodeURIComponent(uid)}/details`,
      );
      const currency = text(details.currency, 3);
      if (
        !/^[A-Z]{3}$/.test(currency) ||
        (details.identification_hash !== undefined &&
          details.identification_hash !== hash)
      )
        throw new ConnectorError('schema');
      const identification = record(details.account_id ?? {});
      const iban = [identification.iban, details.iban].find(
        (value) => typeof value === 'string' && value.trim(),
      );
      result.push({
        source: this.source,
        owner: this.owner,
        accountId,
        providerAccountId: uid,
        identificationHash: hash,
        currency,
        ...(typeof iban === 'string' ? { iban: iban.trim() } : {}),
        label: accountLabel(this.bank, currency, details),
      });
    }
    return result;
  }
  /**
   * What the account holds, from the provider's own balances resource.
   *
   * This is one extra request per account per run. It does not cost a further
   * background fetch against the allowance many banks impose — that counts
   * unattended polls, not the requests inside one — but it is still a request,
   * so the caller makes it best-effort and an import never waits on it.
   *
   * A bank publishes several balance types for the same account. The one worth
   * showing is what is spendable now, so an available figure is preferred over
   * a booked one, and a booked one over anything else; a forward-dated or
   * purely informational figure is never treated as the account's position. An
   * account holding several currencies returns one entry per currency, and
   * amounts arrive as decimal strings converted exactly to minor units.
   */
  async balances(account: BankAccount): Promise<AccountBalance[]> {
    if (account.owner !== this.owner || account.source !== this.source)
      throw new ConnectorError('schema');
    const response = await this.get(
      `/accounts/${encodeURIComponent(account.providerAccountId)}/balances`,
    );
    const entries = response.balances;
    if (!Array.isArray(entries) || entries.length > 200)
      throw new ConnectorError('schema');
    const best = new Map<string, { rank: number; balance: AccountBalance }>();
    for (const raw of entries) {
      const entry = record(raw);
      const amount = record(entry.balance_amount);
      const currency = text(amount.currency, 3);
      if (!/^[A-Z]{3}$/.test(currency)) throw new ConnectorError('schema');
      const type =
        typeof entry.balance_type === 'string'
          ? entry.balance_type.trim().toUpperCase()
          : '';
      const rank = balanceRanks[type];
      // A forward-dated, informational or otherwise unranked figure says
      // nothing about what the account holds today and is left out entirely.
      if (rank === undefined) continue;
      const asOf = [entry.last_change_date_time, entry.reference_date].find(
        (value) => typeof value === 'string' && value.trim(),
      );
      const balance: AccountBalance = {
        currency,
        amountMinor: decimalToMinor(text(amount.amount, 40), currency),
        ...(typeof asOf === 'string' ? { asOf: instant(asOf) } : {}),
      };
      const held = best.get(currency);
      if (!held || rank < held.rank) best.set(currency, { rank, balance });
    }
    return [...best.values()].map((held) => held.balance);
  }
  async transactions(
    account: BankAccount,
    from: Date,
    to: Date,
  ): Promise<BankTransaction[]> {
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      from > to
    )
      throw new ConnectorError('schema');
    const entries = await this.session();
    const entry = entries.find(
      (entry) => entry.uid === account.providerAccountId,
    );
    if (
      account.owner !== this.owner ||
      account.source !== this.source ||
      !entry ||
      identity(this.owner, text(entry.identification_hash, 8192)) !==
        account.accountId
    )
      throw new ConnectorError('consent');
    const params = new URLSearchParams({
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10),
    });
    const cursors = new Set<string>();
    const result: BankTransaction[] = [];
    for (let page = 0; page < 1000; page++) {
      const response = await this.get(
        `/accounts/${encodeURIComponent(account.providerAccountId)}/transactions?${params}`,
      );
      if (
        !Array.isArray(response.transactions) ||
        response.transactions.length > 10000
      )
        throw new ConnectorError('schema');
      for (const raw of response.transactions) {
        const row = record(raw);
        // transaction_id is explicitly unstable in the API documentation; only entry_reference is suitable for imports.
        if (
          typeof row.entry_reference !== 'string' ||
          !row.entry_reference.trim()
        )
          throw new ConnectorError('incomplete');
        const sourceId = text(row.entry_reference);
        const amount = record(row.transaction_amount);
        const currency = text(amount.currency, 3);
        // An account that holds one currency must not report payments in
        // another; an account that holds several has no currency to check
        // against, and the payment's own is the only one there is.
        if (!/^[A-Z]{3}$/.test(currency) || isMultiCurrency(currency))
          throw new ConnectorError('schema');
        if (!isMultiCurrency(account.currency) && currency !== account.currency)
          throw new ConnectorError('schema');
        const minor = BigInt(decimalToMinor(text(amount.amount, 64), currency));
        if (
          minor < 0n ||
          !['CRDT', 'DBIT'].includes(String(row.credit_debit_indicator))
        )
          throw new ConnectorError('schema');
        if (!['BOOK', 'PDNG', 'HOLD', 'SCHD'].includes(String(row.status)))
          throw new ConnectorError('incomplete');
        const dateField =
          row.booking_date != null ? 'booking_date' : 'value_date';
        if (row[dateField] == null) throw new ConnectorError('incomplete');
        const remittance = row.remittance_information ?? [];
        if (
          !Array.isArray(remittance) ||
          remittance.some((line) => typeof line !== 'string')
        )
          throw new ConnectorError('schema');
        const description = remittance.join(' ').slice(0, 2000);
        result.push({
          source: this.source,
          sourceId,
          accountId: account.accountId,
          owner: this.owner,
          bookedAt: day(row[dateField]),
          currency,
          amountMinor: (row.credit_debit_indicator === 'DBIT'
            ? -minor
            : minor
          ).toString(),
          description,
          status: row.status === 'BOOK' ? 'booked' : 'pending',
          // Provider supplies calendar days, not instants; UTC midnight is a storage convention.
          sourceDetails: {
            ...row,
            _import: {
              datePrecision: 'day',
              dateField,
              timezoneConvention: 'UTC midnight',
            },
          },
        });
      }
      if (result.length > 100000) throw new ConnectorError('incomplete');
      if (response.continuation_key == null) return result;
      const cursor = text(response.continuation_key, 8192);
      if (cursors.has(cursor)) throw new ConnectorError('incomplete');
      cursors.add(cursor);
      params.set('continuation_key', cursor);
    }
    throw new ConnectorError('incomplete');
  }
}
