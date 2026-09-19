import { statfs } from 'node:fs/promises';
import { storageState, type StorageHealth } from './storage-health.js';

/**
 * Read the filesystem the application is running from.
 *
 * Kept apart from `storage-health.ts` because the operations screen imports
 * that module too and cannot bundle `node:fs/promises`.
 *
 * `bavail`, not `bfree`, for what is free: the kernel keeps a reserve only root
 * may write into, and counting it would promise space the service account
 * cannot actually use. `usedRatio` is measured with `bfree` all the same, so the
 * percentage matches what `df` prints and what an operator sees over SSH.
 */
export async function readStorage(
  path = process.cwd(),
): Promise<StorageHealth | null> {
  try {
    const stats = await statfs(path);
    const block = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * block;
    const availableBytes = Number(stats.bavail) * block;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return {
      totalBytes,
      availableBytes,
      usedRatio: Math.min(
        1,
        Math.max(0, (totalBytes - Number(stats.bfree) * block) / totalBytes),
      ),
      state: storageState(availableBytes),
    };
  } catch {
    // A filesystem that will not answer is not worth failing the whole
    // operations page over; the card simply does not appear.
    return null;
  }
}
