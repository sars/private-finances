/**
 * A payment is easier to place when the account it came from is recognisable at
 * a glance. The owner names their own accounts ("Monobank black", "Revolut
 * USD"), so the label decides the look where it says something, and the
 * connector and currency decide it otherwise. Renaming an account changes the
 * text, never which account a payment belongs to. The look itself — glyph,
 * tile colour, owner colour — comes from the registry in account-visuals.
 */
import {
  bankFor,
  productFor,
  tileFor,
  type Bank,
  type Product,
} from './account-visuals.ts';

export type AccountIdentity = {
  /** What to print on the chip. */
  name: string;
  /** Two or three characters for the square, when the chip is icon-sized. */
  short: string;
  /** The bank the account is with, or null when nothing says. */
  bank: Bank | null;
  /** The card product, for banks that issue several. */
  product: Product;
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

export function accountIdentity(
  source: string | undefined,
  currency: string,
  label: string | null | undefined,
): AccountIdentity {
  const institution = institutions[source ?? ''];
  const trimmed = (label ?? '').trim();
  const bank = bankFor(source, trimmed);
  const product = productFor(bank, trimmed);
  // An unnamed account is described by what it holds rather than by how it was
  // fetched: "USD account" says something true, an aggregator's name does not.
  const name =
    trimmed ||
    institution ||
    (bank ? tileFor(bank, product).name : `${currency} account`);
  const mentionsCurrency = name
    .toLocaleUpperCase()
    .includes(currency.toLocaleUpperCase());
  return {
    name,
    short: currency.slice(0, 3),
    bank,
    product,
    detail: [institution, mentionsCurrency ? '' : currency]
      .filter(Boolean)
      .join(' · '),
  };
}
