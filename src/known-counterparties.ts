/**
 * Two counterparties a bank names in its own words, not the payer's.
 *
 * The resting place (ADR 0008, decision 7) places an undecided outflow on a
 * personal account as personal spending, and a money-transfer code with nothing
 * else to say rests in the catch-all. That was measured against transfers to
 * people, which are household-sized. It met two kinds of payment it was not
 * sized against, and the result was a July total of 1.58 million UAH where the
 * owner's own spreadsheet says 369 thousand.
 *
 * Both are recognisable from the description alone, because in both the bank is
 * describing the rail rather than quoting a payee the owner typed.
 *
 * **The State Treasury.** Monobank renders a payment of sole-trader tax as
 * `ГУК <region>/<community>/<budget code>` — Головне управління Казначейства,
 * the body that collects it. Five such payments rested as personal spending,
 * 1,145,672 UAH of them, including 880,894 UAH of single tax on 28 July. The
 * ledger already disagreed with itself about this: of sixteen treasury payments
 * eleven were `non_personal` before the sweep ran, decided by their account's
 * policy or by a person, and only the five nobody had reached became household
 * spending. Tax is not household consumption and the owner's own spreadsheet
 * excludes it by an explicit rule, so this is the "already known to be business"
 * carve-out ADR 0008 names, not a change to it.
 *
 * **The household's own accounts.** `Переказ на картку` is Monobank's wording
 * when money moves to a card and the app is shown no counterparty at all — no
 * IBAN, no comment, no card digits. Thirty-two of these rested as spending,
 * 502,687 UAH. Checked against the owner's spreadsheet, thirty-one are
 * `Перекази між своїми рахунками` and one is a real payment to a therapist's
 * card. So the wording is strong evidence and not proof, which is why the
 * placement it produces is **provisional**: it leaves the totals, and it stays
 * in the review queue for the owner to confirm or correct. Thirty-two payments
 * to glance at is not the review session decision 6 declined.
 *
 * Neither recogniser fires when the payment carries counterparty evidence of
 * its own. That evidence is stronger and is already handled a step earlier, by
 * the registered-account identity match.
 */

/** What a bank-worded counterparty settles, and how sure the wording makes it. */
export interface KnownCounterparty {
  kind: 'non_personal' | 'internal_transfer';
  /** False only where the wording is conclusive, as the treasury's is. */
  provisional: boolean;
  /** The owner-facing reason, recorded on the audit event. */
  reason: string;
}

/**
 * Head of a Ukrainian treasury payment description.
 *
 * `ГУК` is the standard abbreviation and always leads the description, followed
 * by the region: `ГУК Сум.обл/…`, `ГУК в Iв.-Фр.об./…`. The longer spellings are
 * accepted wherever they appear, because a description that names the treasury
 * service names the treasury service.
 *
 * The abbreviation must be a whole word, so that a merchant whose name merely
 * begins with those letters — `ГУКОВ І СИН` — is not swept up. That is written
 * as an explicit "not followed by a letter or digit" rather than with `\b`,
 * because `\b` is defined on ASCII word characters and finds no boundary at all
 * beside a Cyrillic letter.
 */
const TREASURY =
  /(^\s*ГУК(?![\p{L}\p{N}]))|(казначейс)|((?<![\p{L}\p{N}])УДКСУ(?![\p{L}\p{N}]))|((?<![\p{L}\p{N}])ГУ\s*ДКСУ(?![\p{L}\p{N}]))/iu;

/**
 * Monobank's own wording for money moving between the client's own accounts.
 *
 * Matched whole, after case and spacing are normalised, so a description that
 * merely contains these words as part of a longer narrative is left alone. The
 * `…для переказу на картку` variants are the bank's phrasing when the movement
 * is a step in a longer hop between the owner's accounts.
 */
const OWN_ACCOUNT_MOVEMENT = new Set([
  'переказ на картку',
  'на залізну картку',
  'з гривневого рахунку фоп',
  'з доларового рахунку фоп',
  'з єврового рахунку фоп',
  'на гривневий рахунок фоп',
  'на доларовий рахунок фоп',
  'на єврового рахунок фоп',
  'з гривневого рахунку фоп для переказу на картку',
  'з доларового рахунку фоп для переказу на картку',
  'з єврового рахунку фоп для переказу на картку',
  'на гривневий рахунок фоп для переказу на картку',
]);

function normalise(description: unknown): string {
  return typeof description === 'string'
    ? description.toLowerCase().replace(/\s+/g, ' ').trim()
    : '';
}

/**
 * Whether the payment names a counterparty of its own, in which case neither
 * recogniser applies: a stated IBAN, a comment the payer typed, or card digits
 * printed in the description all describe somebody, and the identity match has
 * already had its turn at them.
 */
function carriesCounterpartyEvidence(
  details: Record<string, unknown> | undefined,
  description: string,
): boolean {
  const iban = details?.counterIban;
  const comment = details?.comment;
  return (
    (typeof iban === 'string' && iban.trim().length > 0) ||
    (typeof comment === 'string' && comment.trim().length > 0) ||
    /\d{4,}[*xX•·]{2,}\d{4}/u.test(description)
  );
}

/** The kind a bank-worded counterparty settles, or null when it says nothing. */
export function knownCounterparty(
  description: unknown,
  details?: Record<string, unknown>,
): KnownCounterparty | null {
  const raw = typeof description === 'string' ? description : '';
  if (TREASURY.test(raw))
    return {
      kind: 'non_personal',
      provisional: false,
      reason:
        'Paid to the State Treasury, so this is tax rather than household spending',
    };
  if (carriesCounterpartyEvidence(details, raw)) return null;
  if (OWN_ACCOUNT_MOVEMENT.has(normalise(raw)))
    return {
      kind: 'internal_transfer',
      provisional: true,
      reason:
        'The bank describes this as money moving to one of our own cards or accounts, and names no other party; confirm it if it went to someone else',
    };
  return null;
}
