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
 * Two spellings are needed and they are not interchangeable. The provider
 * identifies a bank by the name it publishes, capitalised, and it must match
 * byte for byte or the authorisation is rejected. Everything of ours — the
 * session filename, the systemd instance, the connection key that leases a
 * sync run — uses a lowercase slug. Keeping both on one row is what stops them
 * drifting apart.
 */
export const BANKS = [
  { slug: 'wise', name: 'Wise' },
  { slug: 'revolut', name: 'Revolut' },
  { slug: 'swedbank', name: 'Swedbank' },
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

/** The bank as the owner knows it, never the aggregator that fetched it. */
export function bankName(slug: BankSlug): BankName {
  const found = BANKS.find((b) => b.slug === slug);
  if (!found) throw new Error('unknown_bank');
  return found.name;
}

/**
 * The slug for a provider name.
 *
 * Every supported name lowercases to its own slug today, and the consent
 * service has always derived the session filename that way. Going through the
 * table instead means a future bank whose published name is not a single bare
 * token — "Swedbank AS", say — cannot silently produce a filename with a space
 * in it that nothing else will ever match.
 */
export function bankSlug(name: BankName): BankSlug {
  const found = BANKS.find((b) => b.name === name);
  if (!found) throw new Error('unknown_bank');
  return found.slug;
}
