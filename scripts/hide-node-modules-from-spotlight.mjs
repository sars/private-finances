// Stops macOS Spotlight from indexing this checkout's dependencies.
//
// `node_modules` holds far more files than the rest of the repository, and on a
// machine where several agents each work in their own worktree the count
// multiplies. Indexing them keeps mds_stores and its workers busy for nothing:
// a vendored dependency is not something anyone searches Spotlight for.
//
// A `.metadata_never_index` file makes Spotlight skip the directory it sits in,
// but `pnpm install` builds `node_modules` fresh, so the marker has to be
// written again afterwards. Running from `postinstall` is what makes the
// exclusion survive; doing it by hand is what makes it drift.
//
// Everything here is best-effort. The marker is a local convenience, so a
// failure to write it must never fail an install — least of all on the server,
// where this is a no-op because the mechanism is macOS-only.
import { writeFileSync } from 'node:fs';

if (process.platform === 'darwin') {
  try {
    writeFileSync(new URL('../node_modules/.metadata_never_index', import.meta.url), '');
  } catch {
    // No marker this time; `exclude-dev-caches` can place it later.
  }
}
