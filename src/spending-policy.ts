import type { AccountPurpose } from './accounts.js';
import { spendingVisibility, type Kind } from './domain.js';

export type StoredClassification = { kind: Kind; category: string | null };
export type SpendingPolicy = {
  accountLabel: string | null;
  accountPurpose: AccountPurpose;
  accountRevision: number;
  /** Whether this payment is outside the headline spending figure, derived from
   * the payment's own kind rather than from the account it happens to sit on. */
  excluded: boolean;
  visibility: ReturnType<typeof spendingVisibility>;
  /** What the account purpose would suggest if nobody had decided yet. Advice
   * for the review screen, never applied behind the owner's back. */
  suggestedKind: Kind | null;
  reason: 'business_account' | 'investment_account' | null;
};

export function isExcludedAccount(purpose: unknown): boolean {
  return purpose === 'business' || purpose === 'investment';
}

/** The kind an account's purpose implies for a payment nobody has classified. */
export function suggestedKindFor(purpose: AccountPurpose): Kind | null {
  if (purpose === 'investment') return 'investment';
  if (purpose === 'business') return 'non_personal';
  return null;
}

/**
 * Attach reporting context to a payment.
 *
 * This used to rewrite `kind` and blank `category` whenever the account was a
 * business or investment account. That conflated where the money sat with what
 * the money was: a grocery run charged to a business card became an
 * uncategorised business payment, and there was no way to say otherwise. The
 * account policy is now recorded on the payment itself (see the version 25
 * migration) and account purpose survives only as a suggestion, because not
 * everything on a business account is business spending.
 */
export function applySpendingPolicy<T extends StoredClassification>(
  transaction: T,
  account: {
    label: string | null;
    purpose: AccountPurpose;
    revision?: number;
  } | null,
): T & {
  storedClassification: StoredClassification;
  spendingPolicy: SpendingPolicy;
} {
  const purpose = account?.purpose ?? 'unreviewed';
  const visibility = spendingVisibility(transaction.kind);
  return {
    ...transaction,
    storedClassification: {
      kind: transaction.kind,
      category: transaction.category,
    },
    spendingPolicy: {
      accountLabel: account?.label ?? null,
      accountPurpose: purpose,
      accountRevision: account?.revision ?? 0,
      excluded: visibility !== 'counted',
      visibility,
      suggestedKind:
        transaction.kind === 'unresolved' ? suggestedKindFor(purpose) : null,
      reason:
        purpose === 'business'
          ? 'business_account'
          : purpose === 'investment'
            ? 'investment_account'
            : null,
    },
  };
}
