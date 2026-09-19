#!/usr/bin/env python3
"""Switch an already verified root-owned release. Caller must verify schema compatibility."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
from runpy import run_path
from frontend_assets import retain_frontend_assets


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
    release = Path('/opt/private-finances/releases') / sha
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


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"event":"deployment_failed","action":"inspect_service_and_previous_release"}', file=sys.stderr)
        sys.exit(1)
