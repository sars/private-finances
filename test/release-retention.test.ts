import test from 'node:test';
import { execFileSync } from 'node:child_process';

// `deploy/switch-release.py` is the only thing that ever removes a release
// tree, and it runs as root on the server against a directory that holds the
// running application. The rule it applies is asserted here rather than read,
// because getting it wrong deletes either the disk's headroom or the release
// currently serving the household.
const prune = (body: string) =>
  execFileSync('python3', [
    '-c',
    `
import runpy, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, 'deploy')
switch = runpy.run_path('deploy/switch-release.py')
prune_releases = switch['prune_releases']
KEEP = switch['KEEP_RELEASES']

def tree(folder, name):
    # One directory per release, created in call order so that the change time
    # the rule sorts by increases with each one. The sleep is what makes that
    # ordering a fact rather than a race.
    path = folder / name
    path.mkdir()
    (path / 'dist').mkdir()
    time.sleep(0.002)
    return path

${body}
`,
  ]);

test('a switch keeps a bounded number of release trees', () => {
  prune(`
with tempfile.TemporaryDirectory() as d:
    folder = Path(d)
    trees = [tree(folder, '%040x' % n) for n in range(1, 13)]
    live = trees[-1]
    removed = prune_releases(folder, live)
    remaining = sorted(p.name for p in folder.iterdir())
    assert removed == 12 - KEEP, removed
    assert remaining == sorted(p.name for p in trees[-KEEP:]), remaining
    assert live.is_dir()
`);
});

test('the live release survives however old it is', () => {
  // The case that matters after a rollback: `current` points at an older tree
  // while newer ones sit beside it. Deleting it would take the running
  // application's own files out from under it.
  prune(`
with tempfile.TemporaryDirectory() as d:
    folder = Path(d)
    trees = [tree(folder, '%040x' % n) for n in range(1, 13)]
    live = trees[0]
    prune_releases(folder, live)
    assert live.is_dir(), 'the live release was removed'
    assert (live / 'dist').is_dir(), 'the live release was emptied'
    # It is kept in addition to the newest KEEP, not instead of one of them.
    assert len(list(folder.iterdir())) == KEEP + 1
`);
});

test('nothing that is not a release tree is touched', () => {
  // The directory is not guaranteed to hold only releases: an operator may
  // have left a note or a partial copy beside them, and a rule that removed
  // whatever it did not recognise would be a worse failure than a full disk.
  prune(`
with tempfile.TemporaryDirectory() as d:
    folder = Path(d)
    trees = [tree(folder, '%040x' % n) for n in range(1, 13)]
    stray = [folder / 'README', folder / 'main.dump']
    for path in stray:
        path.write_text('kept')
    (folder / 'backup-of-a4e5b17').mkdir()
    (folder / ('%040X' % 99)).mkdir()
    prune_releases(folder, trees[-1])
    for path in stray:
        assert path.is_file(), path
    assert (folder / 'backup-of-a4e5b17').is_dir()
    assert (folder / ('%040X' % 99)).is_dir(), 'uppercase is not the sha format we write'
`);
});
