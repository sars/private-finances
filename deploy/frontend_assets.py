"""Retain exactly one previous release's original fingerprinted JS/CSS assets."""
import hashlib
import json
import os
from pathlib import Path
import re

NAME = re.compile(r'[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)\Z')
MAX_FILES = 256
MAX_FILE = 10 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MANIFEST = '.frontend-assets.json'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def assets_directory(release):
    directory = release
    for part in ('dist', 'frontend', 'assets'):
        directory = directory / part
        if directory.is_symlink():
            raise RuntimeError('asset_directory_symlink')
    if not directory.is_dir():
        raise RuntimeError('frontend_assets_missing')
    return directory


def inventory(release):
    directory = assets_directory(release)
    found = {}
    total = 0
    for path in directory.iterdir():
        if not NAME.fullmatch(path.name):
            continue
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE:
            raise RuntimeError('invalid_frontend_asset')
        data = path.read_bytes()
        total += len(data)
        found[path.name] = data
        if len(found) > MAX_FILES or total > MAX_TOTAL:
            raise RuntimeError('frontend_asset_limit')
    marker = release / MANIFEST
    if marker.is_symlink():
        raise RuntimeError('invalid_asset_manifest')
    if marker.exists():
        if marker.stat().st_size > 131072:
            raise RuntimeError('invalid_asset_manifest')
        manifest = json.loads(marker.read_text())
        if set(manifest) != {'native', 'inherited'}:
            raise RuntimeError('invalid_asset_manifest')
        for group in manifest.values():
            if not isinstance(group, dict) or any(
                not NAME.fullmatch(name) or not isinstance(value, str)
                or not re.fullmatch('[a-f0-9]{64}', value)
                for name, value in group.items()
            ):
                raise RuntimeError('invalid_asset_manifest')
        expected = {**manifest['inherited'], **manifest['native']}
        if set(expected) != set(found) or any(digest(found[name]) != value for name, value in expected.items()):
            raise RuntimeError('frontend_assets_changed')
        native = {name: found[name] for name in manifest['native']}
    else:
        native = found
    return directory, native, found


def retain_frontend_assets(target, previous):
    target, previous = Path(target), Path(previous)
    if target.resolve() == previous.resolve():
        return
    directory, native, existing = inventory(target)
    _, previous_native, _ = inventory(previous)
    merged = {**previous_native, **native}
    if len(merged) > MAX_FILES or sum(map(len, merged.values())) > MAX_TOTAL:
        raise RuntimeError('frontend_asset_limit')
    for name in native.keys() & previous_native.keys():
        if native[name] != previous_native[name]:
            raise RuntimeError('frontend_asset_collision')
    for name in merged.keys() & existing.keys():
        if merged[name] != existing[name]:
            raise RuntimeError('frontend_asset_collision')
    # Keep a verified native inventory on the source, preventing inherited assets
    # from being recursively copied at the next deployment.
    save_manifest(previous, previous_native, inventory(previous)[2])
    for name in existing.keys() - merged.keys():
        (directory / name).unlink()
    for name, data in merged.items():
        if name in existing:
            if existing[name] != data:
                # An inherited same-name collision must also fail closed.
                raise RuntimeError('frontend_asset_collision')
            continue
        with (directory / name).open('xb') as handle:
            handle.write(data)
        (directory / name).chmod(0o644)
    save_manifest(target, native, merged)


def save_manifest(release, native, all_assets):
    data = {'native': {name: digest(value) for name, value in sorted(native.items())},
            'inherited': {name: digest(value) for name, value in sorted(all_assets.items()) if name not in native}}
    marker = release / MANIFEST
    staged = release / (MANIFEST + '.next')
    # Never follow or replace an unexpected pre-existing staging path.
    with staged.open('x') as handle:
        json.dump(data, handle, sort_keys=True)
    staged.chmod(0o600)
    os.replace(staged, marker)
