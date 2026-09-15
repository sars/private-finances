import { mccLabels } from './mcc-labels.js';

export function readMcc(details: Record<string, unknown> | undefined) {
  const raw = details?.mcc ?? details?.merchant_category_code;
  const code =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d{4}$/.test(raw)
        ? Number(raw)
        : NaN;
  if (!Number.isInteger(code) || code < 1 || code > 9999) return null;
  const financialTransfer = code === 4829;
  return {
    code,
    meaning: mccLabels[code] ?? 'Unknown merchant category',
    financialTransfer,
    inferenceNote: financialTransfer
      ? 'Money transfer code: this alone does not establish own-account transfer, investment, income, or personal expense. Use direction, counterparty and confirmed owner context.'
      : 'MCC describes the merchant business, not the individual item purchased; use it as supporting evidence with payment context.',
  };
}
export function displayMcc(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const mcc = readMcc(details);
  return mcc
    ? `${String(mcc.code).padStart(4, '0')}${mcc.meaning ? ` · ${mcc.meaning}` : ''}`
    : undefined;
}
