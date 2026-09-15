/**
 * A payment is easier to place when the account it came from is recognisable at
 * a glance. The owner names their own accounts ("Monobank black", "Revolut
 * USD"), so the label decides the look where it says something, and the
 * connector and currency decide it otherwise. Renaming an account changes the
 * text, never which account a payment belongs to.
 */
export type AccountTone =
  'ink' | 'paper' | 'violet' | 'sky' | 'amber' | 'slate';
export type AccountIcon = 'card' | 'bank' | 'cash';
export type AccountIdentity = {
  /** What to print on the chip. */
  name: string;
  /** Two or three characters for the square, when the chip is icon-sized. */
  short: string;
  tone: AccountTone;
  icon: AccountIcon;
  /** Extra context for a tooltip: the currency, and the bank where it is known. */
  detail: string;
};

/**
 * Only banks the owner actually holds an account with. Enable Banking is an
 * aggregator the household does not bank with, so it is deliberately absent:
 * an account reached through it is identified by the name the owner gave it.
 */
const institutions: Record<string, string> = {
  monobank: 'Monobank',
  manual_cash: 'Cash',
};

function toneFor(
  source: string | undefined,
  label: string,
  currency: string,
): AccountTone {
  const text = label.toLocaleLowerCase();
  if (source === 'manual_cash') return 'amber';
  if (/revolut/.test(text)) return 'violet';
  if (/\b(black|чорн|черн)/.test(text)) return 'ink';
  if (/\b(white|біл|бел)/.test(text)) return 'paper';
  if (source === 'monobank') return currency === 'UAH' ? 'ink' : 'sky';
  return 'slate';
}

export function accountIdentity(
  source: string | undefined,
  currency: string,
  label: string | null | undefined,
): AccountIdentity {
  const institution = institutions[source ?? ''];
  const trimmed = (label ?? '').trim();
  // An unnamed account is described by what it holds rather than by how it was
  // fetched: "USD account" says something true, an aggregator's name does not.
  const name = trimmed || institution || `${currency} account`;
  const mentionsCurrency = name
    .toLocaleUpperCase()
    .includes(currency.toLocaleUpperCase());
  return {
    name,
    short: currency.slice(0, 3),
    tone: toneFor(source, trimmed, currency),
    icon:
      source === 'manual_cash'
        ? 'cash'
        : source === 'monobank'
          ? 'card'
          : 'bank',
    detail: [institution, mentionsCurrency ? '' : currency]
      .filter(Boolean)
      .join(' · '),
  };
}

/** Tailwind classes per tone, kept beside the tone so both stay in step. */
export const accountToneClasses: Record<AccountTone, string> = {
  ink: 'bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900',
  paper:
    'bg-neutral-100 text-neutral-900 ring-1 ring-inset ring-neutral-300 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-600',
  violet: 'bg-violet-600 text-white dark:bg-violet-500',
  sky: 'bg-sky-600 text-white dark:bg-sky-500',
  amber: 'bg-amber-500 text-amber-950 dark:bg-amber-400',
  slate: 'bg-slate-600 text-white dark:bg-slate-500',
};
