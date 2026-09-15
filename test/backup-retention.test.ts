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
