import { currencyExponent } from './fx.js';
import { merchantMatches } from './merchant-names.js';
import { readMcc } from './mcc.js';

/**
 * Refund matching rules from ADR 0007. Pure functions over already-loaded rows so
 * every rule is unit-testable without a database, and so the same rules decide a
 * manual candidate list, an automatic link and a Telegram question.
 */

/** Numeric ISO 4217 codes Monobank uses for the original operation currency. */
const numericCurrencies: Record<number, string> = {
  980: 'UAH',
  978: 'EUR',
  840: 'USD',
  826: 'GBP',
  985: 'PLN',
  756: 'CHF',
  203: 'CZK',
  392: 'JPY',
  752: 'SEK',
  578: 'NOK',
  208: 'DKK',
};

export type Money = { amountMinor: string; currency: string };

export type RefundRow = {
  id: string;
  source: string;
  accountId: string;
  owner: string;
  bookedAt: string;
  currency: string;
  amountMinor: string;
  description: string;
  status: 'booked' | 'pending';
  kind: string;
  category: string | null;
  sourceDetails?: Record<string, unknown>;
  /** Reductions already linked to this debit, in ledger minor units, positive. */
  reducedMinor?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decimalToMinorUnits(amount: string, currency: string): string | null {
  const exponent = currencyExponent(currency);
  if (exponent === undefined) return null;
  const match = /^([+-]?)(\d{1,30})(?:[.,](\d{1,12}))?$/.exec(amount.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent)))
    return null;
  const digits = fraction.padEnd(exponent, '0').slice(0, exponent);
  const value = BigInt(`${whole}${digits}`);
  return (sign === '-' ? -value : value).toString();
}

/**
 * What the merchant actually charged, which is what a reversal repeats. The
 * ledger amount drifts with the exchange rate between a charge and its refund
 * (ADR 0007: 17.99 EUR out and back differs by 7.54 UAH forty-one days later),
 * so it can never be the matching key. Falls back to the ledger amount, which is
 * the original amount whenever no conversion happened.
 */
export function originalAmount(row: RefundRow): Money {
  const ledger: Money = {
    amountMinor: row.amountMinor,
    currency: row.currency,
  };
  const details = record(row.sourceDetails);
  if (row.source === 'monobank') {
    // Only trust the pair when the ledger amount is the one it was recorded with.
    if (
      Number.isSafeInteger(details.amount) &&
      String(details.amount) === row.amountMinor &&
      Number.isSafeInteger(details.operationAmount) &&
      Number.isSafeInteger(details.currencyCode)
    ) {
      const currency = numericCurrencies[Number(details.currencyCode)];
      if (currency) {
        const amountMinor = String(details.operationAmount);
        // Monobank signs the operation amount like the ledger amount.
        if (
          amountMinor !== '0' &&
          amountMinor.startsWith('-') === row.amountMinor.startsWith('-')
        )
          return { amountMinor, currency };
      }
    }
    return ledger;
  }
  if (row.source === 'enablebanking') {
    for (const candidate of [
      record(record(details.currency_exchange).instructed_amount),
      record(details.instructed_amount),
      record(record(details.currency_exchange).original_amount),
    ]) {
      const currency =
        typeof candidate.currency === 'string' &&
        /^[A-Z]{3}$/.test(candidate.currency)
          ? candidate.currency
          : null;
      const raw =
        typeof candidate.amount === 'string'
          ? candidate.amount
          : typeof candidate.amount === 'number' &&
              Number.isFinite(candidate.amount)
            ? String(candidate.amount)
            : null;
      if (!currency || raw === null) continue;
      const minor = decimalToMinorUnits(raw, currency);
      // The provider states magnitude only; direction comes from the ledger row.
      if (minor === null || minor === '0' || minor.startsWith('-')) continue;
      return {
        amountMinor: row.amountMinor.startsWith('-') ? `-${minor}` : minor,
        currency,
      };
    }
  }
  return ledger;
}

/** The merchant as written, with a cancellation prefix removed. */
export function merchantName(description: string): string {
  return description
    .replace(/^\s*(скасування|cancellation|refund)\s*[.:-]?\s*/iu, '')
    .trim()
    .toLowerCase();
}

function sameMerchantName(a: RefundRow, b: RefundRow): boolean {
  return merchantName(a.description) === merchantName(b.description);
}

export function sameMerchant(left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return false;
  return merchantMatches(a, b) || merchantMatches(b, a);
}

/**
 * Two amounts a merchant would call the same purchase. A ride charged at 5.20
 * and reversed at 5.19 is one cent apart because the app rounds, not because it
 * is a different ride. Deliberately tight: a whisker, not a tolerance band, and
 * it only ever decides anything when exactly one candidate is inside it.
 */
export function closeAmounts(left: bigint, right: bigint): boolean {
  const gap = left > right ? left - right : right - left;
  const larger = left > right ? left : right;
  return gap <= 3n || gap * 100n <= larger;
}

/** True while either side is a hold: the amounts can still change. */
export function provisionalPair(credit: RefundRow, debit: RefundRow): boolean {
  return credit.status === 'pending' || debit.status === 'pending';
}

/**
 * Whether a purchase that has already given money back could give back this
 * much more, judged in the currency the merchant charged in.
 *
 * A purchase nobody has touched is always a candidate, even for a reversal
 * larger than itself: that is a question worth asking, and the charge is the
 * only thing worth offering as its answer. Once a purchase has been reduced,
 * though, only what is left of it can come back again.
 *
 * The comparison has to leave the ledger. A 14.74 EUR booking the merchant
 * returned in full still shows 8.93 UAH outstanding when the hryvnia moved 1.2%
 * between the charge and the reversal — enough to look like a live candidate,
 * and too much for the whisker to dismiss. Scaling what is left back into the
 * merchant's own currency turns those 8.93 UAH into 0.17 EUR of a 14.74 EUR
 * booking, which is plainly nothing rather than plainly something.
 */
export function canAbsorb(
  debit: RefundRow,
  returnedOriginalMinor: bigint,
): boolean {
  const reduced = BigInt(debit.reducedMinor ?? '0');
  if (reduced <= 0n) return true;
  const charged = -BigInt(debit.amountMinor);
  if (charged <= 0n) return false;
  const chargedOriginal = -BigInt(originalAmount(debit).amountMinor);
  const remaining = (remainingMinor(debit) * chargedOriginal) / charged;
  return (
    remaining >= returnedOriginalMinor ||
    closeAmounts(remaining, returnedOriginalMinor)
  );
}

/** Remaining amount of a purchase, in ledger minor units, never below zero. */
export function remainingMinor(debit: RefundRow): bigint {
  const charged = -BigInt(debit.amountMinor);
  const reduced = BigInt(debit.reducedMinor ?? '0');
  return charged > reduced ? charged - reduced : 0n;
}

export type RefundCandidateMatch = {
  debit: RefundRow;
  /** Exact repeat of what the merchant charged, in the original currency. */
  exactOriginal: boolean;
  /** The charge is larger than the refund, so this could be a partial return. */
  partial: boolean;
  original: Money;
};

export type RefundWindow = {
  /** Days a refund may follow its charge. ADR 0007: roughly four months. */
  backDays: number;
  /** Days a refund may precede its charge, for bank booking-date inversion. */
  forwardDays: number;
};
export const defaultRefundWindow: RefundWindow = {
  backDays: 120,
  forwardDays: 3,
};

/**
 * Debits the credit could be returning. Same account only: a reversal lands on
 * the card that was charged, and that is what keeps one member's refund away
 * from the other's identical subscription (ADR 0007).
 */
export function refundCandidates(
  credit: RefundRow,
  debits: RefundRow[],
  window: RefundWindow = defaultRefundWindow,
): RefundCandidateMatch[] {
  const creditOriginal = originalAmount(credit);
  const returned = BigInt(creditOriginal.amountMinor);
  if (returned <= 0n) return [];
  const creditTime = Date.parse(credit.bookedAt);
  if (!Number.isFinite(creditTime)) return [];
  // When a charge carries the merchant's name exactly as the refund does, that
  // reading wins: "Bolt" and "Bolt Food" are different services that share a
  // word, and the bank writes each of them plainly.
  const exactNameAvailable = debits.some(
    (debit) =>
      merchantName(debit.description) === merchantName(credit.description),
  );
  const matches: RefundCandidateMatch[] = [];
  for (const debit of debits) {
    if (
      debit.id === credit.id ||
      debit.owner !== credit.owner ||
      debit.source !== credit.source ||
      debit.accountId !== credit.accountId ||
      debit.currency !== credit.currency ||
      BigInt(debit.amountMinor) >= 0n
    )
      continue;
    const debitTime = Date.parse(debit.bookedAt);
    if (!Number.isFinite(debitTime)) continue;
    const days = (creditTime - debitTime) / 86400000;
    if (days > window.backDays || days < -window.forwardDays) continue;
    if (!sameMerchant(debit.description, credit.description)) continue;
    // "Bolt" and "Bolt Food" share a name and are different services, and the
    // bank writes each of them exactly. When the merchant names match exactly,
    // that is the stronger reading and a near-name is not a candidate at all.
    if (exactNameAvailable && !sameMerchantName(debit, credit)) continue;
    const original = originalAmount(debit);
    if (original.currency !== creditOriginal.currency) continue;
    const charged = -BigInt(original.amountMinor);
    if (charged <= 0n) continue;
    // A booking already returned in full is not a rival for the next reversal,
    // whatever loose change the exchange rate left behind on it. This is what
    // kept three of the owner's Playtomic cancellations unlinked: the real
    // parent was never alone in the running.
    if (!canAbsorb(debit, returned)) continue;
    matches.push({
      debit,
      original,
      exactOriginal: charged === returned,
      partial: charged > returned,
    });
  }
  return matches.sort(
    (a, b) =>
      Date.parse(a.debit.bookedAt) - Date.parse(b.debit.bookedAt) ||
      (a.debit.id < b.debit.id ? -1 : a.debit.id > b.debit.id ? 1 : 0),
  );
}

/**
 * Two charges nobody could tell apart. Choosing between them cannot change any
 * total, any category or any period figure, so ADR 0007 links the oldest instead
 * of asking a question with no meaningful answer.
 */
function indistinguishable(a: RefundRow, b: RefundRow): boolean {
  // Judged in the currency the merchant charged in. Two rides at the same 2.00
  // EUR are a few kopiyky apart in the ledger after the rate moves, which is not
  // a difference between the rides. How each was categorised is our own label
  // rather than evidence about which one a refund returns, and the owner asked
  // for it to be left out of matching entirely.
  const original = (row: RefundRow) => {
    const money = originalAmount(row);
    return `${money.amountMinor}|${money.currency}`;
  };
  return (
    original(a) === original(b) &&
    (a.reducedMinor ?? '0') === (b.reducedMinor ?? '0') &&
    a.description.trim().toLowerCase() === b.description.trim().toLowerCase()
  );
}

/** Card-scheme codes that describe moving money rather than buying something. */
const transferMccs = new Set([4829, 6012, 6050, 6051, 6536, 6537, 6538, 6540]);
const legalForms =
  /\b(sia|as|ik|ooo|ltd|llc|inc|gmbh|ag|ou|uab|sp|bv|nv|sa|srl|plc|tov|fop|pat|bank|group|company|co)\b/iu;

/**
 * Who sent the money. Only a name that reads like a person, on a transfer rather
 * than a merchant purchase, counts: ADR 0007 always asks about money from a
 * person, and a wrong guess here turns a salary or a merchant credit into a
 * Telegram question.
 */
export function incomingCounterparty(
  row: RefundRow,
): 'person' | 'merchant' | 'unknown' {
  const details = record(row.sourceDetails);
  const mcc = readMcc(details);
  if (mcc && !transferMccs.has(mcc.code)) return 'merchant';
  const name =
    row.source === 'monobank'
      ? typeof details.counterName === 'string'
        ? details.counterName
        : ''
      : typeof record(details.debtor).name === 'string'
        ? String(record(details.debtor).name)
        : '';
  const trimmed = name.trim();
  if (!trimmed) return 'unknown';
  if (/\d/u.test(trimmed) || legalForms.test(trimmed)) return 'merchant';
  const words = trimmed.split(/\s+/u);
  return words.length >= 2 &&
    words.length <= 4 &&
    words.every((word) => /^\p{L}[\p{L}'’-]*$/u.test(word) && word.length >= 2)
    ? 'person'
    : 'unknown';
}

export type RefundDecision =
  | {
      action: 'link';
      debitId: string;
      rule:
        | 'exact_original'
        | 'exact_ledger_and_original'
        | 'indistinguishable_nearest'
        | 'single_partial'
        | 'nearest_amount'
        | 'partial_latest';
      reductionMinor: string;
    }
  | {
      action: 'ask';
      reason: 'differing_candidates' | 'unclear_amount' | 'from_person';
      debitIds: string[];
    }
  | { action: 'none'; reason: 'no_candidate' | 'not_a_refund' };

/**
 * Ask only when the answer would change something. Everything else is decided
 * here, silently, which is the governing rule of ADR 0007.
 */
export function refundDecision(
  credit: RefundRow,
  debits: RefundRow[],
  window: RefundWindow = defaultRefundWindow,
): RefundDecision {
  // Money the bank is still holding is matched now and settled later: the owner
  // asked for the link to exist while the amount is provisional, and for it to
  // be recalculated or removed when the hold turns into a booked amount.
  if (BigInt(credit.amountMinor) <= 0n)
    return { action: 'none', reason: 'not_a_refund' };
  const matches = refundCandidates(credit, debits, window);
  if (!matches.length)
    return incomingCounterparty(credit) === 'person'
      ? { action: 'ask', reason: 'from_person', debitIds: [] }
      : { action: 'none', reason: 'no_candidate' };
  const reduction = BigInt(credit.amountMinor).toString();
  const exact = matches.filter((m) => m.exactOriginal);
  if (exact.length === 1)
    return {
      action: 'link',
      debitId: exact[0]!.debit.id,
      rule: 'exact_original',
      reductionMinor: reduction,
    };
  if (exact.length > 1) {
    // Two rides charged at the same 2.00 EUR on different days are not the same
    // number of hryvnia, and the reversal repeats the hryvnia of the one it
    // belongs to. When exactly one candidate is that amount to the kopiyka, it
    // is the parent, and asking would be asking about something already known.
    const sameLedger = exact.filter(
      (m) =>
        -BigInt(m.debit.amountMinor) === BigInt(credit.amountMinor) &&
        remainingMinor(m.debit) >= BigInt(credit.amountMinor),
    );
    if (sameLedger.length === 1)
      return {
        action: 'link',
        debitId: sameLedger[0]!.debit.id,
        rule: 'exact_ledger_and_original',
        reductionMinor: reduction,
      };
    const candidates = sameLedger.length > 1 ? sameLedger : exact;
    const first = candidates[0]!.debit;
    if (candidates.every((m) => indistinguishable(first, m.debit))) {
      // The owner's ride receipts settled which of two identical holds a
      // cancellation belongs to: a ride hailed at 14:15 and cancelled at 14:16
      // returns the hold placed a minute earlier, not the one from 14:03 whose
      // ride was still running. ADR 0007 said oldest, reasoning that the choice
      // could not matter; it does matter to the two rows, and the nearest
      // preceding charge is the one the refund actually belongs to.
      const creditTime = Date.parse(credit.bookedAt);
      const preceding = candidates.filter(
        (m) => Date.parse(m.debit.bookedAt) <= creditTime,
      );
      const chosen = (preceding.length ? preceding : candidates).at(-1)!;
      return {
        action: 'link',
        debitId: chosen.debit.id,
        rule: 'indistinguishable_nearest',
        reductionMinor: reduction,
      };
    }
    return {
      action: 'ask',
      reason: 'differing_candidates',
      debitIds: candidates.map((m) => m.debit.id),
    };
  }
  // A reversal a whisker away from exactly one outstanding charge belongs to it.
  // Every other candidate being further away is what makes this an answer rather
  // than a guess, and it is the shape a ride-hailing adjustment actually takes.
  // It is decided before the partial rule below, because being a whisker away is
  // stronger evidence than being the only charge large enough: a rate wobble can
  // leave the true parent a few kopiyky short in the ledger.
  const returned = BigInt(originalAmount(credit).amountMinor);
  const nearest = matches.filter((m) =>
    closeAmounts(-BigInt(m.original.amountMinor), returned),
  );
  if (nearest.length === 1)
    return {
      action: 'link',
      debitId: nearest[0]!.debit.id,
      rule: 'nearest_amount',
      reductionMinor: reduction,
    };
  if (nearest.length > 1) {
    // Several charges are a whisker away. The closest in amount wins, and when
    // that ties, the one placed nearest before the refund: a hold cancelled at
    // 01:47 belongs to the ride hailed at 01:47, not to one two days earlier
    // that happens to be a cent away too. The owner's ride receipts show this
    // shape, and a weaker rule must never answer it by reaching past them.
    const distance = (m: RefundCandidateMatch) => {
      const charged = -BigInt(m.original.amountMinor);
      return charged > returned ? charged - returned : returned - charged;
    };
    const closest = distance(
      nearest.reduce((best, m) => (distance(m) < distance(best) ? m : best)),
    );
    const tied = nearest.filter((m) => distance(m) === closest);
    const creditTime = Date.parse(credit.bookedAt);
    const preceding = tied.filter(
      (m) => Date.parse(m.debit.bookedAt) <= creditTime,
    );
    const ordered = preceding.length ? preceding : tied;
    const chosen = ordered.at(-1)!;
    // Only a genuine tie in both amount and time is left to a person.
    if (
      ordered.length > 1 &&
      Date.parse(ordered.at(-2)!.debit.bookedAt) ===
        Date.parse(chosen.debit.bookedAt)
    )
      return {
        action: 'ask',
        reason: 'differing_candidates',
        debitIds: ordered.map((m) => m.debit.id),
      };
    return {
      action: 'link',
      debitId: chosen.debit.id,
      rule: 'nearest_amount',
      reductionMinor: reduction,
    };
  }
  const partial = matches.filter(
    (m) => m.partial && remainingMinor(m.debit) >= BigInt(credit.amountMinor),
  );
  if (partial.length === 1)
    return {
      action: 'link',
      debitId: partial[0]!.debit.id,
      rule: 'single_partial',
      reductionMinor: reduction,
    };
  if (partial.length > 1) {
    // Several charges from the same merchant could absorb this partial refund.
    // It goes to the most recent one before it, which is the purchase a
    // cancellation follows. How those charges were categorised does not enter
    // into it: the owner's instruction is that a category is a label we chose,
    // not evidence about which charge the merchant gave money back on.
    const creditTime = Date.parse(credit.bookedAt);
    const preceding = partial.filter(
      (m) => Date.parse(m.debit.bookedAt) <= creditTime,
    );
    const chosen = (preceding.length ? preceding : partial).at(-1)!;
    return {
      action: 'link',
      debitId: chosen.debit.id,
      rule: 'partial_latest',
      reductionMinor: reduction,
    };
  }
  // A reversal a cent adrift from its likely parent, or larger than anything it
  // could be returning: asked about rather than absorbed by a tolerance.
  return {
    action: 'ask',
    reason: 'unclear_amount',
    debitIds: matches.map((m) => m.debit.id),
  };
}
