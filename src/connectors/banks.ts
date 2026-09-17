/**
 * The banks this application can reach through its account-information
 * provider, in one place.
 *
 * The bank used to be spelled out as a two-value union in nine files: the
 * connector, the sync and backfill commands, the systemd instance pattern, the
 * consent service, the web form and the React page. Adding a third bank meant
 * finding all nine, and missing one failed late — a schedule that refuses to
 * start, or a consent that writes a session file the importer never looks for.
 *
 * Three spellings are needed and they are not interchangeable. The provider
 * identifies a bank by the name it publishes, capitalised, and it must match
 * byte for byte or the authorisation is rejected. Everything of ours — the
 * session filename, the systemd instance, the connection key that leases a
 * sync run — uses a lowercase slug. And the owner knows some banks by a
 * shorter name than the provider publishes: the provider says "LHV Pank",
 * the owner says "LHV", and an account called "LHV Pank EUR" would read as a
 * stranger's. Keeping all three on one row is what stops them drifting apart.
 */
export const BANKS = [
  { slug: 'wise', name: 'Wise', label: 'Wise' },
  { slug: 'revolut', name: 'Revolut', label: 'Revolut' },
  { slug: 'swedbank', name: 'Swedbank', label: 'Swedbank' },
  { slug: 'lhv', name: 'LHV Pank', label: 'LHV' },
] as const;

/** Ours: session files, systemd instances, the `enablebanking:<owner>:<bank>` key. */
export type BankSlug = (typeof BANKS)[number]['slug'];
/** The provider's: sent as the ASPSP name and compared exactly on the way back. */
export type BankName = (typeof BANKS)[number]['name'];

export const BANK_SLUGS: readonly BankSlug[] = BANKS.map((b) => b.slug);
export const BANK_NAMES: readonly BankName[] = BANKS.map((b) => b.name);

export function isBankSlug(value: unknown): value is BankSlug {
  return typeof value === 'string' && BANK_SLUGS.includes(value as BankSlug);
}

export function isBankName(value: unknown): value is BankName {
  return typeof value === 'string' && BANK_NAMES.includes(value as BankName);
}

/** The bank's name as the provider publishes it, sent as the ASPSP name. */
export function bankName(slug: BankSlug): BankName {
  const found = BANKS.find((b) => b.slug === slug);
  if (!found) throw new Error('unknown_bank');
  return found.name;
}

/** The bank as the owner knows it — never the aggregator, and never the
 * provider's longer registered name where the owner uses a short one. */
export function bankLabel(slug: BankSlug): string {
  const found = BANKS.find((b) => b.slug === slug);
  if (!found) throw new Error('unknown_bank');
  return found.label;
}

/**
 * The slug for a provider name.
 *
 * The first three names lowercased to their own slugs, and the consent
 * service once derived the session filename that way. "LHV Pank" is why it
 * must not: lowercasing it would produce a filename with a space in it that
 * nothing else would ever match. The table decides.
 */
export function bankSlug(name: BankName): BankSlug {
  const found = BANKS.find((b) => b.name === name);
  if (!found) throw new Error('unknown_bank');
  return found.slug;
}
