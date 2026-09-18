/**
 * How an account is named wherever the application lists one: the member,
 * the bank, the product, and the currency when the product does not say it —
 * "Rodion · Monobank · Iron", "Katya · Wise · EUR", "Rodion · Monobank · FOP
 * USD". One rule, so a picker on Assets, a card on Balances and a filter on
 * Transactions all call the same account the same thing.
 *
 * The owner's own label decides the product ("black", "Wise EUR", "LHV"); the
 * connector decides the bank where the label does not. Nothing here changes
 * which account a payment belongs to.
 */
export type AccountOwner = 'rodion' | 'katya';

const OWNER_NAMES: Record<AccountOwner, string> = {
  rodion: 'Rodion',
  katya: 'Katya',
};
/** Banks the household holds accounts with, by the word a label starts with. */
const BANKS = ['Monobank', 'Wise', 'Revolut', 'Swedbank', 'LHV', 'PrivatBank'];
const SOURCE_BANK: Record<string, string> = {
  monobank: 'Monobank',
  manual_cash: 'Cash',
};
/** Monobank's card names as the API states them, spelt for people. */
const PRODUCTS: Record<string, string> = {
  black: 'Black',
  white: 'White',
  iron: 'Iron',
  platinum: 'Platinum',
  yellow: 'Yellow',
  fop: 'FOP',
  eaid: 'eAid',
  diia: 'Diia',
  madeinukraine: 'Made in Ukraine',
  rebuilding: 'Rebuilding',
};

export interface AccountNameInput {
  owner: AccountOwner | string;
  source: string;
  label: string | null | undefined;
  /** The currency the account holds, when one is known; several stay unnamed. */
  currency?: string | null;
}

/** The parts of the name, for callers that lay them out separately. */
export function accountNameParts(input: AccountNameInput): {
  owner: string;
  bank: string | null;
  product: string | null;
} {
  const owner =
    OWNER_NAMES[input.owner as AccountOwner] ??
    input.owner.charAt(0).toUpperCase() + input.owner.slice(1);
  let label = (input.label ?? '').trim().replace(/\s+/g, ' ');
  let bank: string | null = SOURCE_BANK[input.source] ?? null;
  // A label the owner wrote may start with the bank: "Wise EUR", "LHV".
  const leading = [...(bank ? [bank] : []), ...BANKS].find((name) =>
    label.toLowerCase().startsWith(name.toLowerCase()),
  );
  if (leading) {
    bank = bank ?? leading;
    if (leading.toLowerCase() === bank.toLowerCase())
      label = label.slice(leading.length).trim();
  }
  let product: string | null = label
    ? (PRODUCTS[label.toLowerCase()] ?? label)
    : null;
  const currency = input.currency?.toUpperCase();
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    if (!product) product = currency;
    else if (!product.toUpperCase().split(' ').includes(currency))
      product = `${product} ${currency}`;
  }
  return { owner, bank, product };
}

/** "Rodion · Monobank · Iron UAH"; parts that are unknown are simply left out. */
export function accountDisplayName(input: AccountNameInput): string {
  const { owner, bank, product } = accountNameParts(input);
  return [owner, bank, product].filter(Boolean).join(' · ');
}
