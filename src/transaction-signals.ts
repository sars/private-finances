export interface TransactionSignalInput {
  description: string;
  amountMinor: string;
  status: string;
  sourceDetails: Record<string, unknown>;
}

export interface TransactionSignals {
  clearPhoneTopUp: boolean;
  evidence: string[];
  uncertainty: string | null;
  mcc: number | null;
}

const actions = new Set([
  'topup',
  'refill',
  'recharge',
  'поповнення',
  'поповнити',
  'пополнение',
  'пополнить',
]);
const phoneTargets = new Set([
  'phone',
  'mobile',
  'мобільного',
  'мобільний',
  'телефону',
  'телефон',
  'телефона',
  'мобильного',
  'мобильный',
]);
const competingTargets = new Set([
  'card',
  'wallet',
  'bank',
  'revolut',
  'картки',
  'картку',
  'картка',
  'карткового',
  'карти',
  'карты',
  'карту',
  'карточки',
  'гаманця',
  'гаманець',
  'кошелька',
  'кошелек',
  'банківського',
  'банковского',
]);
const connectingWords = new Set([
  'up',
  'my',
  'the',
  'a',
  'of',
  'for',
  'on',
  'number',
  'мого',
  'свого',
  'свій',
  'на',
  'номер',
  'номеру',
  'номера',
  'моего',
  'своего',
]);
const exceptionalContext = new Set([
  'refund',
  'refunded',
  'reversal',
  'reversed',
  'chargeback',
  'cancelled',
  'canceled',
  'failed',
  'reimbursement',
  'reimbursed',
  'business',
  'corporate',
  'company',
  'employer',
  'work',
  'mixed',
  'split',
  'повернення',
  'повернуто',
  'возврат',
  'возврата',
  'відшкодування',
  'компенсація',
  'компенсация',
  'компенсации',
  'робочий',
  'робочого',
  'рабочего',
  'корпоративного',
  'корпоративний',
  'бізнес',
  'бизнес',
  'скасовано',
  'отмена',
  'отменено',
  'not',
  'no',
  'не',
  'нет',
  'без',
]);

/** Read-only, bounded signals, not a classification or permission to write one. */
export function inspectTransactionSignals(
  transaction: TransactionSignalInput,
): TransactionSignals {
  // Monobank preserves the statement's top-level mcc in sourceDetails.
  // Do not recursively guess keys in other providers' untrusted payloads.
  const rawMcc = transaction.sourceDetails.mcc;
  const mcc =
    typeof rawMcc === 'number' &&
    Number.isInteger(rawMcc) &&
    rawMcc >= 1000 &&
    rawMcc <= 9999
      ? rawMcc
      : null;
  const evidence: string[] = mcc === 4814 ? ['telecommunications_mcc'] : [];
  const uncertain = (reason: string): TransactionSignals => ({
    clearPhoneTopUp: false,
    evidence,
    uncertainty: reason,
    mcc,
  });
  if (!['booked', 'pending'].includes(transaction.status))
    return uncertain('not_active_payment');
  if (
    !/^-\d{1,30}$/.test(transaction.amountMinor) ||
    BigInt(transaction.amountMinor) >= 0n
  )
    return uncertain('not_outflow');
  // Truncating a long description could conceal a contradictory suffix.
  if (transaction.description.length > 4000)
    return uncertain('description_too_long');
  const words = transaction.description
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u);
  if (words.some((word) => exceptionalContext.has(word))) {
    return uncertain('exceptional_or_nonpersonal_context');
  }
  if (words.some((word) => competingTargets.has(word))) {
    return uncertain('competing_top_up_target');
  }
  const actionPositions: number[] = [];
  const targetPositions: number[] = [];
  words.forEach((word, index) => {
    if (actions.has(word) || (word === 'top' && words[index + 1] === 'up')) {
      actionPositions.push(index);
    }
    if (
      phoneTargets.has(word) ||
      (word === 'рахунку' && words[index + 1] === 'оператора')
    ) {
      targetPositions.push(index);
    }
  });
  const explicit = actionPositions.some((action) =>
    targetPositions.some(
      (target) =>
        Math.abs(target - action) <= 5 &&
        words
          .slice(Math.min(target, action) + 1, Math.max(target, action))
          .every((word) => connectingWords.has(word)),
    ),
  );
  if (!explicit) return uncertain('no_explicit_phone_top_up');
  evidence.push(
    'explicit_phone_top_up_description',
    `${transaction.status}_outflow`,
  );
  return { clearPhoneTopUp: true, evidence, uncertainty: null, mcc };
}
