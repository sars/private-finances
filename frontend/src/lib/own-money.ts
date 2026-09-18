/**
 * Whose money is in the balance a bank states.
 *
 * A bank with an agreed overdraft states one figure that already has the
 * overdraft inside it: an account showing 21,000 with a 20,000 limit holds
 * 1,000 of the household's own money and 20,000 the bank is willing to lend.
 * Reading the stated figure as savings is how a household believes it is
 * twenty thousand richer than it is, so every screen that shows a balance
 * subtracts the limit first and says what the bank stated separately.
 *
 * Amounts are integer minor units in strings, all the way through: BigInt
 * arithmetic only, never a float, and the text comes from lib/format.ts.
 */

/** The stated balance minus the agreed overdraft inside it. */
export function ownMoneyMinor(
  amountMinor: string,
  creditLimitMinor: string | null | undefined,
): string {
  return (BigInt(amountMinor) - BigInt(creditLimitMinor ?? '0')).toString();
}

export type OwnMoneyRow = {
  currency: string;
  amountMinor: string;
  creditLimitMinor: string | null;
  /** The stated amount in the display currency, as the server converted it. */
  convertedMinor: string | null;
};

export type OwnMoneyTotal = {
  /** Null when the figure cannot be stated honestly; show a dash, not a guess. */
  minor: string | null;
  /** Balances left out because no rate converts them. */
  missing: number;
  /** Limits the server converted nothing for, so nothing can subtract them. */
  unconvertedLimits: number;
};

/**
 * The household's own money across balances, in the display currency.
 *
 * The server converts each stated balance and sends no converted credit limit,
 * so a limit in another currency cannot be subtracted from a converted figure
 * without inventing a rate. Rather than quietly overstate the total, this
 * returns no figure at all when such a limit is in play, and counts them so the
 * screen can say why. A limit already in the display currency needs no rate:
 * the subtraction happens before conversion, exactly.
 */
export function ownMoneyTotal(
  rows: OwnMoneyRow[],
  display: string,
): OwnMoneyTotal {
  let sum = 0n;
  let missing = 0;
  let unconvertedLimits = 0;
  for (const row of rows) {
    const limit = BigInt(row.creditLimitMinor ?? '0');
    if (row.currency === display) {
      sum += BigInt(row.amountMinor) - limit;
      continue;
    }
    if (!row.convertedMinor) {
      missing += 1;
      continue;
    }
    if (limit === 0n) {
      sum += BigInt(row.convertedMinor);
      continue;
    }
    unconvertedLimits += 1;
  }
  return {
    minor: unconvertedLimits ? null : sum.toString(),
    missing,
    unconvertedLimits,
  };
}
