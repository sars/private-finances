import type { Database } from './database.js';
import type { Owner } from './domain.js';
import { Accounts } from './accounts.js';
import { currencyExponent } from './fx.js';
import { Conflict, Repository } from './repository.js';

function validate(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('cash_invalid_input');
  const value = input as Record<string, unknown>;
  if (
    typeof value.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.requestId,
    )
  )
    throw new Error('cash_invalid_request_id');
  const currency = value.currency;
  const exponent =
    typeof currency === 'string' ? currencyExponent(currency) : undefined;
  if (exponent === undefined) throw new Error('cash_invalid_currency');
  if (
    typeof value.amount !== 'string' ||
    !/^(0|[1-9]\d{0,26})(?:\.\d+)?$/.test(value.amount)
  )
    throw new Error('cash_invalid_amount');
  const [whole, fraction = ''] = value.amount.split('.');
  if (fraction.length > exponent) throw new Error('cash_invalid_amount');
  const minor = BigInt(whole! + fraction.padEnd(exponent, '0'));
  if (minor <= 0n || minor.toString().length > 30)
    throw new Error('cash_invalid_amount');
  if (
    typeof value.date !== 'string' ||
    !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value.date) ||
    !Number.isFinite(Date.parse(value.date)) ||
    new Date(value.date).toISOString().slice(0, 10) !== value.date
  )
    throw new Error('cash_invalid_date');
  if (
    typeof value.description !== 'string' ||
    !value.description.trim() ||
    value.description.length > 2000
  )
    throw new Error('cash_invalid_description');
  return {
    requestId: value.requestId.toLowerCase(),
    currency: currency as string,
    amountMinor: `-${minor}`,
    date: value.date,
    description: value.description.trim(),
  };
}

/** An owner-entered purchase is ordinary booked ledger evidence, initially unresolved. */
export class CashTransactions {
  constructor(private db: Database) {}
  async create(
    actor: Owner,
    input: unknown,
  ): Promise<{ id: string; created: boolean }> {
    if (actor !== 'rodion' && actor !== 'katya')
      throw new Error('cash_invalid_actor');
    const value = validate(input);
    const sourceId = `${actor}:${value.requestId}`;
    const accountId = `cash:${actor}:${value.currency}`;
    return this.db.transaction(async (tx) => {
      // Reuse account/import locks so request validation, account audit, and import
      // are one atomic operation. Account IDs and request IDs include the owner.
      // Receipt classifiers acquire import before account/budget locks too.
      await tx.query('SELECT pg_advisory_xact_lock(7482392)');
      await tx.query('SELECT pg_advisory_xact_lock(7482393)');
      const bookedAt = new Date(
        String(
          (
            await tx.query(
              "SELECT (($1::date + time '12:00') AT TIME ZONE 'Europe/Riga') AS booked_at",
              [value.date],
            )
          ).rows[0]!.booked_at,
        ),
      ).toISOString();
      const existing = (
        await tx.query(
          "SELECT id,owner,account_id,currency,amount_minor,description,booked_at FROM transactions WHERE source='manual_cash' AND source_id=$1 FOR UPDATE",
          [sourceId],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.owner !== actor ||
          existing.account_id !== accountId ||
          existing.currency !== value.currency ||
          String(existing.amount_minor) !== value.amountMinor ||
          existing.description !== value.description ||
          new Date(String(existing.booked_at)).toISOString() !== bookedAt
        )
          throw new Conflict('cash_request_conflict');
        return { id: String(existing.id), created: false };
      }
      // Accounts.upsert keeps its established audit format inside this transaction.
      const scoped: Database = {
        query: (sql, params) => tx.query(sql, params),
        transaction: (action) => action(tx),
        close: async () => {},
      };
      const accounts = new Accounts(scoped);
      const account = (await accounts.list(actor)).find(
        (row) => row.source === 'manual_cash' && row.accountId === accountId,
      );
      if (account && account.purpose !== 'personal')
        throw new Conflict('cash_account_not_personal');
      if (!account)
        await accounts.upsert(
          {
            source: 'manual_cash',
            accountId,
            owner: actor,
            label: `Cash ${value.currency}`,
            purpose: 'personal',
            reason: 'Owner created a cash purchase account',
          },
          actor,
        );
      await new Repository(scoped).importBatch(
        [
          {
            source: 'manual_cash',
            sourceId,
            accountId,
            owner: actor,
            bookedAt,
            currency: value.currency,
            amountMinor: value.amountMinor,
            description: value.description,
            status: 'booked',
            sourceDetails: {
              entryMethod: 'owner_cash_purchase',
              datePrecision: 'day',
              actor,
              purchaseDate: value.date,
              requestId: value.requestId,
            },
          },
        ],
        tx,
      );
      const row = (
        await tx.query(
          "SELECT id FROM transactions WHERE source='manual_cash' AND source_id=$1 AND owner=$2",
          [sourceId, actor],
        )
      ).rows[0]!;
      return { id: String(row.id), created: true };
    });
  }
}
