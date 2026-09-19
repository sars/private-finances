import test from 'node:test';
import { execFileSync } from 'node:child_process';

/**
 * Built releases are the largest thing this deployment leaves behind — an
 * unpacked tree with its own `node_modules`, around half a gigabyte each, one
 * per release and several releases a day. Nothing removed any until now, and by
 * 19 September 2026 there were 136 of them holding 45 GB on a root filesystem
 * 92% full and shared with other applications, with under a day of headroom.
 *
 * The rule has to be dull and it has to be safe, so what is asserted here is
 * mostly what it refuses to delete.
 */
test('release retention keeps the newest ten and never the one being served', () => {
  execFileSync('python3', [
    '-c',
    `
import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, 'deploy')
from release_retention import expired_releases

with tempfile.TemporaryDirectory() as d:
    folder = Path(d)
    shas = ['%040x' % n for n in range(30)]
    for index, sha in enumerate(shas):
        release = folder / sha
        release.mkdir()
        os.utime(release, (1_700_000_000 + index, 1_700_000_000 + index))

    newest = folder / shas[-1]
    expired = expired_releases(folder, newest)
    remaining = [p for p in folder.iterdir() if p not in set(expired)]
    assert len(remaining) == 10, len(remaining)
    # The ten newest by modification time, and nothing older.
    assert set(remaining) == {folder / s for s in shas[-10:]}, sorted(p.name for p in remaining)

    # The release being served is kept even when it is the oldest thing there,
    # which is what a rollback to an old commit leaves behind.
    oldest = folder / shas[0]
    expired = expired_releases(folder, oldest)
    assert oldest not in expired
    remaining = [p for p in folder.iterdir() if p not in set(expired)]
    assert len(remaining) == 11, len(remaining)

    # Anything that is not a commit SHA was put there by a person.
    keepsake = folder / 'known-good'
    keepsake.mkdir()
    (folder / 'notes.txt').write_text('x')
    expired = expired_releases(folder, newest)
    assert keepsake not in expired
    assert all(p.name not in ('known-good', 'notes.txt') for p in expired)

    # A symlink is never followed and never removed.
    link = folder / ('%040x' % 999)
    link.symlink_to(folder / shas[0])
    assert link not in expired_releases(folder, newest)

    # Keeping nothing is a bug, not a configuration.
    try:
        expired_releases(folder, newest, keep=0)
    except ValueError:
        pass
    else:
        raise AssertionError('keep=0 should be refused')
`,
  ]);
});
