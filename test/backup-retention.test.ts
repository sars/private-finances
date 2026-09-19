import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('frequent backups retain daily recovery history as well as recent snapshots', () => {
  execFileSync('python3', [
    '-c',
    `
import runpy, tempfile
from pathlib import Path
retain = runpy.run_path('deploy/local-backup.py')['expired_backups']
with tempfile.TemporaryDirectory() as d:
    folder = Path(d)
    for day in range(1, 31):
        for hour in range(24):
            (folder / (str((day * 86400 + hour * 3600) * 1000000000) + '.dump')).touch()
    all_files = set(folder.glob('*.dump'))
    remaining = all_files - set(retain(folder))
    assert len(remaining) <= 28
    assert set(sorted(all_files, key=lambda p: int(p.stem))[-14:]) <= remaining
    for day in range(17, 31):
        assert folder / (str((day * 86400 + 23 * 3600) * 1000000000) + '.dump') in remaining
    assert not any(int(p.stem) // (86400 * 1000000000) < 17 for p in remaining)
`,
  ]);
});

test('the named reference dumps from the first install are never expired', () => {
  // `/var/lib/private-finances/predeploy/` holds `initial-empty.dump` and
  // `schema-v3-empty.dump` beside the timestamped ones. A retention rule that
  // simply kept the newest N files would delete them; this one globs
  // `[0-9]*.dump`, so they are never candidates. The release switch prunes that
  // directory with this same function, which is why it is asserted here.
  execFileSync('python3', [
    '-c',
    `
import runpy, tempfile
from pathlib import Path
retain = runpy.run_path('deploy/local-backup.py')['expired_backups']
with tempfile.TemporaryDirectory() as d:
    folder = Path(d)
    named = [folder / 'initial-empty.dump', folder / 'schema-v3-empty.dump']
    for path in named:
        path.touch()
    for day in range(1, 31):
        for hour in range(24):
            (folder / (str((day * 86400 + hour * 3600) * 1000000000) + '.dump')).touch()
    expired = set(retain(folder))
    for path in named:
        assert path not in expired, path
    # And the rule still bounds the directory. 27 rather than 28, because the
    # newest day's dump is already one of the newest fourteen.
    remaining = 720 - len(expired)
    assert remaining == 27, remaining
`,
  ]);
});
