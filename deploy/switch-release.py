#!/usr/bin/env python3
"""Switch an already verified root-owned release. Caller must verify schema compatibility."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
from frontend_assets import retain_frontend_assets


def command(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def switch(target):
    staged = Path('/opt/private-finances/current.next')
    if staged.is_symlink():
        staged.unlink()
    staged.symlink_to(target)
    staged.replace('/opt/private-finances/current')


def ready(sha, password):
    auth = 'Basic ' + base64.b64encode(('rodion:' + password).encode()).decode()
    for attempt in range(30):
        try:
            req = urllib.request.Request('http://127.0.0.1:3300/health/ready', headers={'Authorization': auth})
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
            ready(sha, values['RODION_PASSWORD'])
        except Exception:
            env_path.write_text(previous_env)
            switch(current)
            command('systemctl', 'restart', 'private-finances.service')
            ready(previous_sha, values['RODION_PASSWORD'])
            raise RuntimeError('deployment_failed_previous_release_restored') from None
        print(json.dumps({'event': 'deployment_succeeded', 'release': sha, 'previousRelease': previous_sha}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"event":"deployment_failed","action":"inspect_service_and_previous_release"}', file=sys.stderr)
        sys.exit(1)
