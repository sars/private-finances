import type { Repository, Transaction } from './repository.js';
import { type ActualExchange } from './fx.js';
import {
  FxRates,
  convertWithDailyRates,
  type StoredFxProvenance,
} from './fx-rates.js';

export interface ConvertedSpendingRow {
  id: string;
  description: string;
  owner: Transaction['owner'];
  bookedAt: string;
  kind: Transaction['kind'];
  storedClassification?: Transaction['storedClassification'];
  spendingPolicy?: Transaction['spendingPolicy'];
  transactionStatus: Transaction['status'];
  originalAmountMinor: string;
  originalCurrency: string;
  convertedAmountMinor: string | null;
  /** Money returned against this purchase, converted, positive (ADR 0007). */
  reducedAmountMinor: string | null;
  /** What the purchase finally cost: converted amount plus its reductions. */
  netAmountMinor: string | null;
  currency: string;
  status: 'converted' | 'missing';
  method: StoredFxProvenance['kind'] | null;
  provenance: StoredFxProvenance | null;
  missingReason: string | null;
  counted: 'confirmed' | 'unresolved' | 'pending' | 'excluded' | 'missing';
}

const currencyCodes: Record<number, string> = {
  980: 'UAH',
  978: 'EUR',
  840: 'USD',
  826: 'GBP',
  985: 'PLN',
  756: 'CHF',
  203: 'CZK',
  392: 'JPY',
};

/** The bank's own rate for this movement, when it recorded one. */
function actualExchangeFor(
  source: string,
  amountMinor: string,
  currency: string,
  details: Record<string, unknown> | undefined,
): ActualExchange | undefined {
  if (
    source !== 'monobank' ||
    !details ||
    !Number.isSafeInteger(details.amount) ||
    String(details.amount) !== amountMinor ||
    !Number.isSafeInteger(details.operationAmount) ||
    !Number.isSafeInteger(details.currencyCode)
  )
    return undefined;
  const operationCurrency = currencyCodes[Number(details.currencyCode)];
  if (!operationCurrency) return undefined;
  return {
    source: 'Monobank recorded original amount; fees may be separate',
    account: { amountMinor, currency },
    operation: {
      amountMinor: String(details.operationAmount),
      currency: operationCurrency,
    },
  };
}

/** Display-only conversion, with complete row visibility and explicit evidence. */
export async function convertedSpending(
  repo: Repository,
  rows: Transaction[],
  target: string,
) {
  if (!/^[A-Z]{3}$/.test(target)) throw new Error('invalid_display_currency');
  let confirmed = 0n,
    unresolved = 0n,
    pending = 0n,
    missing = 0;
  const converted = [];
  const allRows: ConvertedSpendingRow[] = [];
  const coverage = {
    confirmed: { converted: 0, missing: 0 },
    unresolved: { converted: 0, missing: 0 },
    pending: { converted: 0, missing: 0 },
  };
  const detailsById = new Map(
    rows.length
      ? (
          await repo.db.query(
            'SELECT id,revision,source_details FROM transactions WHERE id=ANY($1::uuid[])',
            [rows.map((row) => row.id)],
          )
        ).rows.map((row) => [String(row.id), row])
      : [],
  );
  const dates = rows
    .map((row) => new Date(row.bookedAt).toISOString().slice(0, 10))
    .sort();
  const rates = dates.length
    ? await new FxRates(repo.db).list(dates[0]!, dates.at(-1)!)
    : [];
  for (const row of rows) {
    const current = detailsById.get(row.id);
    const fresh = current && Number(current.revision) === row.revision;
    const details = fresh
      ? (current.source_details as Record<string, unknown> | undefined)
      : undefined;
    // A hold is money the bank has already taken, so it is bucketed by what the
    // payment is, exactly like a settled one. `pending` remains a figure of its
    // own below — "of which the amount is not final" — rather than a reason to
    // leave the money out of the total.
    const bucket =
      row.spendingPolicy?.excluded || BigInt(row.amountMinor) >= 0n
        ? 'excluded'
        : row.kind === 'personal_expense'
          ? 'confirmed'
          : row.kind === 'unresolved'
            ? 'unresolved'
            : 'excluded';
    const display: ConvertedSpendingRow = {
      id: row.id,
      description: row.description,
      owner: row.owner,
      bookedAt: row.bookedAt,
      kind: row.kind,
      storedClassification: row.storedClassification,
      spendingPolicy: row.spendingPolicy,
      transactionStatus: row.status,
      originalAmountMinor: row.amountMinor,
      originalCurrency: row.currency,
      convertedAmountMinor: null,
      reducedAmountMinor: null,
      netAmountMinor: null,
      currency: target,
      status: 'missing',
      method: null,
      provenance: null,
      missingReason: null,
      counted: bucket === 'excluded' ? 'excluded' : 'missing',
    };
    const actualExchange = actualExchangeFor(
      row.source,
      row.amountMinor,
      row.currency,
      details,
    );
    const result = !fresh
      ? {
          status: 'missing' as const,
          reason: 'stale_transaction',
          currency: target,
        }
      : convertWithDailyRates(
          {
            amountMinor: row.amountMinor,
            currency: row.currency,
            targetCurrency: target,
            occurredAt: row.bookedAt,
            actualExchange,
          },
          rates,
        );
    if (result.status === 'missing') {
      missing++;
      display.missingReason = result.reason;
      if (bucket !== 'excluded') coverage[bucket].missing++;
      allRows.push(display);
      continue;
    }
    display.convertedAmountMinor = result.amountMinor;
    display.status = 'converted';
    display.method = result.provenance.kind;
    display.provenance = result.provenance;
    // What the purchase finally cost is settled in its own currency, on the
    // purchase itself, and then converted like any other transaction (the
    // owner's rule). A refund larger than its purchase reduces it to nothing;
    // it never becomes negative spending.
    const reduction = row.refund?.role === 'reduced' ? row.refund : undefined;
    const netInAccountCurrency = reduction
      ? BigInt(reduction.netMinor) > 0n
        ? 0n
        : BigInt(reduction.netMinor)
      : null;
    const netResult =
      netInAccountCurrency === null
        ? result
        : netInAccountCurrency === 0n
          ? { status: 'converted' as const, amountMinor: '0' }
          : convertWithDailyRates(
              {
                amountMinor: netInAccountCurrency.toString(),
                currency: row.currency,
                targetCurrency: target,
                occurredAt: row.bookedAt,
                actualExchange,
              },
              rates,
            );
    if (netResult.status === 'missing') {
      // The purchase converts but its remaining cost does not, so no total can
      // state what it was. It stays visible as missing rather than overstated.
      missing++;
      display.missingReason = netResult.reason;
      display.counted = bucket === 'excluded' ? 'excluded' : 'missing';
      if (bucket !== 'excluded') coverage[bucket].missing++;
      allRows.push(display);
      continue;
    }
    display.netAmountMinor = netResult.amountMinor;
    // Both are negative; what came back is the distance between them.
    display.reducedAmountMinor = (
      BigInt(netResult.amountMinor) - BigInt(result.amountMinor)
    ).toString();
    display.counted = bucket;
    if (bucket !== 'excluded') coverage[bucket].converted++;
    allRows.push(display);
    const amount = BigInt(display.netAmountMinor);
    if (amount < 0n && bucket !== 'excluded') {
      if (row.kind === 'personal_expense') confirmed -= amount;
      else if (row.kind === 'unresolved') unresolved -= amount;
      // Not exclusive: a hold is inside one of the totals above and is also
      // counted here, so the dashboard can say how much of a total the bank
      // could still adjust.
      if (row.status === 'pending') pending -= amount;
    }
    converted.push({
      id: row.id,
      description: row.description,
      amountMinor: display.netAmountMinor,
      source: result.provenance.source,
    });
  }
  const months = new Map<
    string,
    {
      month: string;
      owner: Transaction['owner'];
      confirmedMinor: bigint;
      covered: number;
      missing: number;
    }
  >();
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
  });
  for (const row of allRows) {
    const parts = calendar.formatToParts(new Date(row.bookedAt));
    const month =
      parts.find((p) => p.type === 'year')!.value +
      '-' +
      parts.find((p) => p.type === 'month')!.value;
    const key = month + ':' + row.owner;
    const bucket = months.get(key) ?? {
      month,
      owner: row.owner,
      confirmedMinor: 0n,
      covered: 0,
      missing: 0,
    };
    if (
      row.kind === 'personal_expense' &&
      BigInt(row.originalAmountMinor) < 0n
    ) {
      if (row.netAmountMinor === null) bucket.missing++;
      else {
        bucket.confirmedMinor -= BigInt(row.netAmountMinor);
        bucket.covered++;
      }
    }
    months.set(key, bucket);
  }
  return {
    currency: target,
    confirmedMinor: confirmed.toString(),
    unresolvedMinor: unresolved.toString(),
    pendingMinor: pending.toString(),
    missing,
    converted,
    rows: allRows,
    monthly: [...months.values()]
      .sort(
        (a, b) =>
          b.month.localeCompare(a.month) || a.owner.localeCompare(b.owner),
      )
      .map((item) => ({
        ...item,
        confirmedMinor: item.confirmedMinor.toString(),
      })),
    coverage,
  };
}
