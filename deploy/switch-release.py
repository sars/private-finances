#!/usr/bin/env python3
"""Switch an already verified root-owned release. Caller must verify schema compatibility."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from runpy import run_path
from frontend_assets import retain_frontend_assets

RELEASES = Path('/opt/private-finances/releases')

# How many release trees survive a switch. Each is a complete copy of the
# application including node_modules, about 520 MB, so the number is a direct
# multiplier on disk: five is 2.6 GB.
KEEP_RELEASES = 5


def prune_predeploy(directory):
    """Drop the pre-deployment dumps the retention rule no longer keeps.

    One dump is taken before every switch and this project releases several
    times a day, so without this the directory only grows: 134 files and 442 MB
    by 19 September 2026, on a root filesystem that was 90% full and shared with
    other applications.

    The rule is the one `local-backup.py` already defines and `backup-retention`
    already tests — the newest fourteen, plus one per day for the last fourteen
    days — rather than a second rule written here. It keeps enough recent depth
    to roll back a release and enough daily history to answer what the data
    looked like a week ago, and it caps the directory at twenty-eight files.

    Its glob is `[0-9]*.dump`, so the named reference dumps from the first
    install — `initial-empty.dump`, `schema-v3-empty.dump` — are never candidates.

    This runs only after a switch has succeeded. A failed release keeps every
    dump it might need, and a failure to prune is reported rather than allowed
    to fail a deployment that has already worked.
    """
    expired = run_path(str(Path(__file__).with_name('local-backup.py')))['expired_backups']
    removed = 0
    for old in expired(Path(directory)):
        old.unlink()
        removed += 1
    return removed


def prune_releases(directory, live):
    """Drop the release trees no rollback can still reach.

    Nothing removed them until now. By 19 September 2026 there were 136 trees
    under /opt/private-finances/releases, 45 GB — 92% of a 96 GB disk shared
    with other applications, and still growing by roughly 9 GB a day at this
    project's release rate of between eight and twenty-three deployments daily.
    A disk that fills stops the database, so this is not housekeeping.

    A release tree is a build artefact and not a record. Every commit can be
    rebuilt from Git, so the only thing an old tree buys is a rollback that
    skips a build, and `main` here rolls back exactly one release. The
    fingerprinted frontend assets an older client may still ask for are
    retained separately by `retain_frontend_assets`, which copies them forward
    into the live tree rather than depending on the old one surviving. Five
    trees is therefore already generous depth rather than a considered number.

    Ordering is by `st_ctime_ns`, not `st_mtime`: the tree arrives via `cp -a`,
    which preserves the build directory's modification time, while the inode's
    change time is set by the copy and the `chown -R` that follows it and so
    always reflects when this server received the release.

    The live tree is kept whatever its age, which matters when a rollback has
    made an older release current again. Anything that is not a 40-character
    SHA directory is left alone entirely.
    """
    trees = [
        path
        for path in directory.iterdir()
        if path.is_dir() and not path.is_symlink() and re.fullmatch('[a-f0-9]{40}', path.name)
    ]
    trees.sort(key=lambda path: path.stat().st_ctime_ns, reverse=True)
    keep = set(trees[:KEEP_RELEASES]) | {live}
    removed = 0
    for tree in trees:
        if tree not in keep:
            shutil.rmtree(tree)
            removed += 1
    return removed


def command(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def switch(target):
    staged = Path('/opt/private-finances/current.next')
    if staged.is_symlink():
        staged.unlink()
    staged.symlink_to(target)
    staged.replace('/opt/private-finances/current')


def ready(sha):
    # Readiness carries no household data and the service listens on loopback
    # only, so it answers without a session. A deploy has no session to hold.
    for attempt in range(30):
        try:
            req = urllib.request.Request('http://127.0.0.1:3300/health/ready')
            with urllib.request.urlopen(req, timeout=2) as response:
                if json.load(response).get('release') == sha:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('readiness_failed')


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[2] != '--schema-compatible':
        raise RuntimeError('root_and_schema_compatibility_acknowledgement_required')
    sha = sys.argv[1]
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise RuntimeError('invalid_sha')
    release = RELEASES / sha
    if not (release / 'dist/src/main.js').is_file() or release.stat().st_uid != 0:
        raise RuntimeError('verified_root_owned_release_required')
    with open('/var/lib/private-finances/deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = Path('/opt/private-finances/current').resolve(strict=True)
        env_path = Path('/etc/private-finances/app.env')
        previous_env = env_path.read_text()
        values = dict(line.split('=', 1) for line in previous_env.splitlines() if '=' in line)
        previous_sha = values['RELEASE_SHA']
        backup = Path('/var/lib/private-finances/predeploy') / (str(time.time_ns()) + '.dump')
        with backup.open('xb') as out:
            subprocess.run(['sudo', '-u', 'postgres', 'pg_dump', '-Fc', 'private_finances'], stdout=out, stderr=subprocess.DEVNULL, check=True)
        retain_frontend_assets(release, current)
        # Prepare rollback assets before exposing the new release; rollback itself
        # must never depend on an additional copy operation succeeding.
        retain_frontend_assets(current, release)
        next_env = re.sub(r'^RELEASE_SHA=.*$', 'RELEASE_SHA=' + sha, previous_env, flags=re.M)
        staged_env = env_path.with_suffix('.next')
        try:
            staged_env.write_text(next_env)
            staged_env.chmod(0o600)
            staged_env.replace(env_path)
            switch(release)
            command('systemctl', 'restart', 'private-finances.service')
            ready(sha)
        except Exception:
            env_path.write_text(previous_env)
            switch(current)
            command('systemctl', 'restart', 'private-finances.service')
            ready(previous_sha)
            raise RuntimeError('deployment_failed_previous_release_restored') from None
        print(json.dumps({'event': 'deployment_succeeded', 'release': sha, 'previousRelease': previous_sha}))
        try:
            removed = prune_predeploy('/var/lib/private-finances/predeploy')
            print(json.dumps({'event': 'predeploy_pruned', 'removed': removed}))
        except Exception:
            print('{"event":"predeploy_prune_failed"}', file=sys.stderr)
        # Same contract as the dumps above: only after a switch has succeeded,
        # and a prune that fails is reported rather than allowed to fail a
        # deployment that has already worked.
        try:
            removed = prune_releases(RELEASES, release)
            print(json.dumps({'event': 'releases_pruned', 'removed': removed}))
        except Exception:
            print('{"event":"release_prune_failed"}', file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"event":"deployment_failed","action":"inspect_service_and_previous_release"}', file=sys.stderr)
        sys.exit(1)
