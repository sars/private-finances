import type { Transaction } from './repository.js';
/** The catch-all leaf at the root of the tree. A payment filed here carries no
 * meaning, unlike `Food / Unspecified`, which at least names a branch. */
const MEANINGLESS_CATEGORY = 'Unspecified';
/** Spending review excludes income, zero movements and account exclusions. Browsing may opt into unbooked holds.
 *
 * `includeUnspecified` also returns payments already classified into the root
 * catch-all. Those are finished as far as the classifier is concerned — a person
 * or the category-tree migration put them there — so the undecided test alone
 * lets them leave the queue for good while still saying nothing about the money.
 * The review screen opts in; historical reporting does not, because those rows
 * already count as spending and estimating them again would double count. */
export function needsSpendingReview(
  t: Transaction,
  includePending = false,
  includeUnspecified = false,
): boolean {
  const undecided = t.kind === 'unresolved' || t.provisional === true;
  const unfinished = includeUnspecified && t.category === MEANINGLESS_CATEGORY;
  return (
    (undecided || unfinished) &&
    (includePending || t.status !== 'pending') &&
    BigInt(t.amountMinor) < 0n &&
    !t.spendingPolicy?.excluded
  );
}
