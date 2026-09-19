/**
 * How much room is left on the disk the application is running from.
 *
 * On 19 September 2026 that disk reached 92% full, and the only way anyone
 * found out was by opening an SSH session and running `du`. Nothing in the
 * application knew or said. The cause was this project's own release
 * directory — 136 unpruned trees, 45 GB — which `deploy/switch-release.py` now
 * bounds, but the general shape of the problem outlives that one cause: the
 * server is shared with other applications, a full disk stops PostgreSQL, and
 * the household's first symptom would be an import that quietly failed.
 *
 * So the number belongs on the operations page beside the backup and the bank
 * connections. This module holds only the reading's meaning, with no filesystem
 * access, because the operations screen imports it as well as the server does —
 * the same arrangement `backup-health.ts` has, and for the same reason: one
 * wording, which cannot drift between the two places it is shown. The
 * measurement itself is `readStorage` in `storage.ts`.
 */
export type StorageHealth = {
  totalBytes: number;
  availableBytes: number;
  /** Share of the disk in use, 0 to 1, matching what `df` reports. */
  usedRatio: number;
  state: 'ample' | 'tight' | 'critical';
};

/**
 * Thresholds in free space rather than percentage, because what matters is
 * whether the next stretch of releases and database growth fits, and that is an
 * absolute quantity. A release tree is about 520 MB and five are retained, a
 * pre-deployment dump is taken before every switch, and PostgreSQL needs room
 * to write: below 5 GB the next deployment is genuinely at risk, and 15 GB is
 * roughly a fortnight of ordinary growth — enough warning to act unhurried.
 */
export const STORAGE_CRITICAL_BYTES = 5 * 1024 ** 3;
export const STORAGE_TIGHT_BYTES = 15 * 1024 ** 3;

export function storageState(availableBytes: number): StorageHealth['state'] {
  if (availableBytes < STORAGE_CRITICAL_BYTES) return 'critical';
  if (availableBytes < STORAGE_TIGHT_BYTES) return 'tight';
  return 'ample';
}

/** Whole gigabytes are the only precision this reading deserves. */
export function formatGigabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

export function storageDetail(storage: StorageHealth): string {
  return `${formatGigabytes(storage.availableBytes)} free of ${formatGigabytes(storage.totalBytes)}`;
}
