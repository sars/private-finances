"""Which built releases under /opt/private-finances/releases may be removed.

Every release is an unpacked tree with its own `node_modules`, around 518 MB,
and nothing removed any. By 19 September 2026 there were 136 of them holding
45 GB on a root filesystem 92% full and shared with other applications — about
seventeen releases a day, so roughly 8.8 GB a day, against 7.9 GB free. The disk
had well under a day left, and filling it would have taken the neighbours down
too, not just this project.

The rule is deliberately dull: keep the newest `keep` directories by
modification time, and always keep whatever `current` points at even when it
falls outside them. Ten is far more than anything needs — `switch-release.py`
touches only `current` and the release coming in, and a rollback wants the one
before — but a release is cheap to keep and expensive to want back.

Only names that are a full commit SHA are ever candidates. Anything else in that
directory was put there by a person and is left alone.
"""

import re
from pathlib import Path

SHA = re.compile(r'\A[0-9a-f]{40}\Z')


def expired_releases(directory, current, keep=10):
    """Release directories safe to delete, newest-first order preserved.

    `directory` holds the releases; `current` is the path the live symlink
    resolves to. A `current` that is missing or outside `directory` simply means
    nothing is protected by name, not that everything is fair game — the newest
    `keep` still stand.
    """
    directory = Path(directory)
    if keep < 1:
        raise ValueError('refusing_to_keep_no_releases')
    releases = [
        path
        for path in directory.iterdir()
        if path.is_dir() and not path.is_symlink() and SHA.match(path.name)
    ]
    newest_first = sorted(releases, key=lambda p: p.stat().st_mtime, reverse=True)
    protected = set(newest_first[:keep])
    if current is not None:
        resolved = Path(current)
        protected.update(path for path in releases if path == resolved)
    return [path for path in newest_first if path not in protected]
