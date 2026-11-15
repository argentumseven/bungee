#!/usr/bin/env python3
"""Preview/back up one explicitly named release correction; apply only on request."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess

REPOSITORY = 'argentumseven/bungee'
ASSETS = {'bungee.apk', 'bungee.apk.sha256', 'build.json'}


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True).strip()


def api(path):
    return json.loads(gh('api', f'repos/{REPOSITORY}/{path}'))


def validate_release(release, expected):
    for actual, wanted in ((release['id'], expected['id']), (release['tag_name'], expected['tag']),
                           (release['target_commitish'], expected['commit'])):
        if actual != wanted:
            raise ValueError('Release identity/source changed; review the cleanup plan again')
    if release.get('draft') or release.get('prerelease') or {a['name'] for a in release['assets']} != ASSETS:
        raise ValueError('Expected a complete regular official APK release')
    source = api('contents/release.json?ref=' + expected['commit'])
    source = json.loads(base64.b64decode(source['content']))
    if (source['version'], source['android_version_code']) != (expected['version'], expected['android_version_code']):
        raise ValueError('Release source version does not match the reviewed plan')


def verify_backup(directory, expected):
    build = json.loads((directory / 'build.json').read_text())
    if ((build['commit'], build['version'], build['android_version_code']) !=
            (expected['commit'], expected['version'], expected['android_version_code']) or
            build.get('signing') != 'publisher-v1'):
        raise ValueError('Backup APK build identity does not match the reviewed release')
    with (directory / 'bungee.apk').open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    checksum = (directory / 'bungee.apk.sha256').read_text().split()
    if checksum != [digest, 'bungee.apk'] or build['sha256'] != digest:
        raise ValueError('Backup APK checksum mismatch')


def identity(release):
    # Download/reaction counters can change while backing up. Release content
    # and asset identities must remain exactly as reviewed.
    return {
        **{key: release.get(key) for key in ('id', 'tag_name', 'target_commitish', 'name', 'body', 'draft', 'prerelease', 'updated_at')},
        'assets': sorted(({key: asset.get(key) for key in ('id', 'name', 'size', 'digest', 'updated_at')} for asset in release['assets']), key=lambda a: a['name']),
    }


def run(plan, backup, apply=False):
    if plan['repository'] != REPOSITORY:
        raise ValueError('Unexpected repository')
    keep, retire = plan['keep'], plan['retire']
    if keep['id'] == retire['id'] or keep['commit'] == retire['commit']:
        raise ValueError('Cleanup must name two different source releases')
    if tuple(map(int, keep['version'].split('.'))) <= tuple(map(int, retire['version'].split('.'))):
        raise ValueError('Replacement must have a newer app version')
    releases = api('releases?per_page=100')
    kept = next((r for r in releases if r['id'] == keep['id']), None)
    retired = next((r for r in releases if r['id'] == retire['id']), None)
    if kept is None:
        raise ValueError('Replacement release is missing; refusing cleanup')
    validate_release(kept, keep)
    latest = api('releases/latest')
    if latest['id'] not in (keep['id'], retire['id']):
        raise ValueError('Another release is latest; do not replace a newer release with this historical plan')
    if retired is None:
        print('Named obsolete release is already absent; no changes made.')
        return
    validate_release(retired, retire)
    backup = Path(backup)
    for expected, release in ((keep, kept), (retire, retired)):
        directory = backup / expected['tag']
        metadata = directory / 'release.json'
        if apply:
            if not metadata.is_file() or identity(json.loads(metadata.read_text())) != identity(release):
                raise ValueError('Release metadata changed after backup; preview/back up again before applying')
        else:
            directory.mkdir(parents=True, exist_ok=True)
            metadata.write_text(json.dumps(release, indent=2) + '\n')
            gh('release', 'download', expected['tag'], '--repo', REPOSITORY, '--dir', str(directory),
               '--pattern', 'bungee.apk', '--pattern', 'bungee.apk.sha256', '--pattern', 'build.json', '--clobber')
        verify_backup(directory, expected)
    notes = Path(plan['notes_file'])
    if not notes.is_file() or f"<!-- android-source-run: {keep['source_run']} -->" not in notes.read_text():
        raise ValueError('Replacement notes must retain the source-run marker used by the publisher')
    print(f"Keep {keep['tag']} ({keep['version']}); set its title/notes and latest marker.")
    print(f"Delete release {retire['tag']} (ID {retire['id']}); retain its Git tag/source history.")
    print('Verified APK backups:', backup)
    if not apply:
        print('Preview only. No GitHub release was changed.')
        return
    # Set the valid replacement first. A failed edit must never delete the old release.
    gh('release', 'edit', keep['tag'], '--repo', REPOSITORY, '--title', f"Bungee {keep['version']} (Android APK)",
       '--notes-file', str(notes), '--prerelease=false', '--latest')
    gh('release', 'delete', retire['tag'], '--repo', REPOSITORY, '--yes')
    if api('releases/latest')['id'] != keep['id']:
        raise RuntimeError('Latest release did not match after cleanup; inspect GitHub before further changes')
    if any(r['id'] == retire['id'] for r in api('releases?per_page=100')):
        raise RuntimeError('Obsolete release is still present after deletion')
    print('Release cleanup verified. APK bytes and signing identities were not modified.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=Path('.github/release-cleanup.json'))
    parser.add_argument('--backup-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Apply only after a successful preview/backup')
    args = parser.parse_args()
    run(json.loads(args.plan.read_text()), args.backup_dir, args.apply)
