/**
 * Whose money is in the balance a bank states.
 *
 * A bank with an agreed overdraft states one figure that already has the
 * overdraft inside it: an account showing 21,000 with a 20,000 limit holds
 * 1,000 of the household's own money and 20,000 the bank is willing to lend.
 * Reading the stated figure as savings is how a household believes it is
 * twenty thousand richer than it is, so a screen showing a balance subtracts
 * the limit and shows only what is left. The limit itself is not something the
 * household wants to read about, so no screen prints it.
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
