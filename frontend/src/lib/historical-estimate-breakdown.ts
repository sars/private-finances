export type HistoricalProjectionRow = {
  transactionId: string;
  transactionRevision: number;
  status: string;
  category: string | null;
};
type LedgerRow = {
  id: string;
  revision?: number;
  bookedAt: string;
  amountMinor: string;
  kind: string;
  status?: string;
  spendingPolicy?: { excluded: boolean };
};
type ConversionRow = {
  id: string;
  convertedAmountMinor: string | null;
  /** What the payment finally cost, after money that came back. */
  netAmountMinor?: string | null;
  counted: string;
};
export type EstimateGroup = { label: string; minor: string; count: number };
/** Display-only aggregation of separate estimated outflows; no confirmed ledger totals are changed. */
export function historicalEstimateBreakdown(
  transactions: readonly LedgerRow[],
  conversions: readonly ConversionRow[],
  projections: readonly HistoricalProjectionRow[],
) {
  const ledger = new Map(transactions.map((row) => [row.id, row]));
  const converted = new Map(conversions.map((row) => [row.id, row]));
  const categories = new Map<string, { minor: bigint; count: number }>();
  const months = new Map<string, { minor: bigint; count: number }>();
  const seen = new Set<string>();
  let missing = 0;
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  for (const estimate of projections) {
    if (
      estimate.status !== 'estimated' ||
      !estimate.category ||
      seen.has(estimate.transactionId)
    )
      continue;
    seen.add(estimate.transactionId);
    const transaction = ledger.get(estimate.transactionId);
    const conversion = converted.get(estimate.transactionId);
    if (
      !transaction ||
      transaction.kind !== 'unresolved' ||
      transaction.status === 'pending' ||
      transaction.spendingPolicy?.excluded ||
      BigInt(transaction.amountMinor) >= 0n ||
      (transaction.revision !== undefined &&
        transaction.revision !== estimate.transactionRevision)
    )
      continue;
    // The same figure the server reports for these estimates: what the payment
    // finally cost. Totalling what the bank first took would count a refunded
    // payment in full here while the headline above it did not.
    const amount =
      conversion?.netAmountMinor ?? conversion?.convertedAmountMinor ?? null;
    if (!conversion || amount === null) {
      missing++;
      continue;
    }
    if (conversion.counted !== 'unresolved' || BigInt(amount) > 0n) continue;
    const minor = -BigInt(amount);
    const month = calendar.format(new Date(transaction.bookedAt)).slice(0, 7);
    for (const [map, key] of [
      [categories, estimate.category],
      [months, month],
    ] as const) {
      const previous = map.get(key) ?? { minor: 0n, count: 0 };
      map.set(key, {
        minor: previous.minor + minor,
        count: previous.count + 1,
      });
    }
  }
  const serialize = (
    map: Map<string, { minor: bigint; count: number }>,
  ): EstimateGroup[] =>
    [...map].map(([label, row]) => ({
      label,
      minor: row.minor.toString(),
      count: row.count,
    }));
  return {
    months: serialize(months).sort((a, b) => a.label.localeCompare(b.label)),
    categories: serialize(categories).sort((a, b) =>
      BigInt(a.minor) > BigInt(b.minor)
        ? -1
        : BigInt(a.minor) < BigInt(b.minor)
          ? 1
          : a.label.localeCompare(b.label),
    ),
    missing,
  };
}
