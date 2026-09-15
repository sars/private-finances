#!/usr/bin/env python3
"""Create an atomic local backup before scheduled imports; this is not off-server recovery."""
import os
from pathlib import Path
import subprocess
import time

def expired_backups(directory):
    """Keep 14 recent snapshots plus one per UTC day for the last 14 snapshot days."""
    snapshots = sorted(directory.glob('[0-9]*.dump'), key=lambda p: int(p.stem))
    newest_by_day = {}
    for snapshot in snapshots:
        day = int(snapshot.stem) // (86400 * 1_000_000_000)
        newest_by_day[day] = snapshot
    keep = set(snapshots[-14:]) | set(list(newest_by_day.values())[-14:])
    return [snapshot for snapshot in snapshots if snapshot not in keep]


def main():
    os.umask(0o077)
    directory = Path('/var/lib/private-finances-backups')
    staged = directory / 'backup.partial'
    try:
        subprocess.run(['pg_dump', '-Fc', '--file', str(staged), os.environ['DATABASE_URL']],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with staged.open('rb') as stream:
            os.fsync(stream.fileno())
        staged.replace(directory / (str(time.time_ns()) + '.dump'))
        for old in expired_backups(directory):
            old.unlink()
        print('{"event":"local_backup_completed","off_server":false}')
    except Exception:
        staged.unlink(missing_ok=True)
        print('{"event":"local_backup_failed"}')
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
