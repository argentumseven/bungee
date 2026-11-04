#!/usr/bin/env python3
"""Publish checked main-branch APKs as ordinary, permanent GitHub Release assets."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True).strip()


def api(repo, path):
    return json.loads(gh('api', f'repos/{repo}/{path}'))


def trusted_run(run, repo):
    return ((run.get('head_repository') or {}).get('full_name') == repo
            and run.get('head_branch') == 'main'
            and run.get('event') in ('push', 'workflow_dispatch')
            and run.get('path') == '.github/workflows/check.yml'
            and bool(re.fullmatch(r'[a-f0-9]{40}', run.get('head_sha', ''))))


def source_number(release):
    match = re.search(r'<!-- android-source-run: ([0-9]+) -->', release.get('body') or '')
    return int(match[1]) if match and not release.get('draft') else -1


def verify_checksum(directory):
    apk = directory / 'bungee.apk'
    expected = (directory / 'bungee.apk.sha256').read_text().split()
    if apk.is_symlink() or len(expected) != 2 or expected[1] != 'bungee.apk':
        raise ValueError('Unexpected Android artifact/checksum format')
    with apk.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != expected[0]: raise ValueError('Android APK checksum mismatch')
    return digest


def main():
    repo = os.environ['GH_REPO']
    if repo != 'argentumseven/bungee': raise ValueError('Unexpected publication repository')
    requested = os.environ.get('BUNGEE_BUILD_RUN_ID', '')
    if requested:
        runs = [api(repo, f'actions/runs/{int(requested)}')]
    else:
        runs = api(repo, 'actions/workflows/check.yml/runs?branch=main&per_page=30')['workflow_runs']
    selected = None
    for run in runs:
        if not trusted_run(run, repo): continue
        jobs = api(repo, f'actions/runs/{run["id"]}/jobs?per_page=100')['jobs']
        required = {'android', 'apk-signing', 'server-and-web', 'container-boundaries', 'release-apk'}
        if not required.issubset({job['name'] for job in jobs if job['conclusion'] == 'success'}): continue
        artifacts = api(repo, f'actions/runs/{run["id"]}/artifacts')['artifacts']
        if any(a['name'] == 'bungee-android-release' and not a['expired'] for a in artifacts):
            selected = run
            break
    if selected is None:
        print('No successfully checked main-branch Android APK is available; keeping existing releases.')
        return
    run = selected
    releases = api(repo, 'releases?per_page=100')
    if any(source_number(release) > run['run_number'] for release in releases):
        print('A newer Android build is already published; keeping it as latest.')
        return
    sha = run['head_sha']
    tag = 'android-' + sha[:12]
    existing = next((release for release in releases if release['tag_name'] == tag), None)
    assets = ('bungee.apk', 'bungee.apk.sha256', 'build.json')
    if existing and not existing['draft'] and set(assets).issubset({a['name'] for a in existing['assets']}):
        print('Already published:', existing['html_url'])
        return
    manifest = api(repo, f'contents/release.json?ref={sha}')
    app_release = json.loads(base64.b64decode(manifest['content']))
    version = app_release['version']
    with tempfile.TemporaryDirectory(prefix='bungee-publish-') as temporary:
        directory = Path(temporary)
        gh('run', 'download', str(run['id']), '--repo', repo, '--name', 'bungee-android-release', '--dir', str(directory))
        digest = verify_checksum(directory)
        signed = json.loads((directory / 'signing.json').read_text())
        if (signed.get('signing') != 'publisher-v1' or signed.get('sha256') != digest
                or signed.get('size') != (directory / 'bungee.apk').stat().st_size
                or signed.get('version') != version or signed.get('version_code') != app_release['android_version_code']
                or not re.fullmatch('[a-f0-9]{64}', signed.get('signer_sha256', ''))):
            raise ValueError('APK has no verified persistent release signature')
        (directory / 'bungee.apk.sha256').write_text(digest + '  bungee.apk\n')
        (directory / 'build.json').write_text(json.dumps({'version': version, 'android_version_code': app_release['android_version_code'], 'commit': sha, 'run_id': run['id'], 'sha256': digest, 'signing': 'publisher-v1', 'signer_sha256': signed['signer_sha256']}, indent=2) + '\n')
        notes = directory / 'notes.md'
        notes.write_text(f'''Download **bungee.apk** below and open it on your Android phone. No ZIP extraction or Actions login is needed for this public release.

Android app version: **{version}** · source: [{sha[:12]}](https://github.com/{repo}/commit/{sha})

This APK is signed with Bungee’s persistent official release key. **GitHub and manager Settings → Phone app updates distribute the same APK**, with the same checksum and certificate. The server verifies and serves it unchanged.

This standalone development APK includes the current main-branch phone features. Its Android build, unit tests and lint passed in [the source build]({run['html_url']}). This release does not claim that unrelated server jobs passed or that physical-device testing is complete.

Routine official updates preserve pairing, settings and queued data; Android asks for installation confirmation. Android debugging is disabled. Historical GitHub builds used disposable keys, so those installations cannot switch identities in place without the original private key. Existing household-signed phones retain compatible server updates. Do not uninstall for routine upgrades.

`bungee.apk.sha256` verifies the download; `build.json` records the exact source and build.

<!-- android-source-run: {run['run_number']} -->
''')
        if existing:
            gh('release', 'edit', tag, '--repo', repo, '--draft=true', '--notes-file', str(notes))
        else:
            # GITHUB_TOKEN can create tags for its own source commit. Backfills
            # must use an existing source tag and must not ask the release API
            # to create a tag at an older workflow revision.
            target = ('--target', sha) if os.environ.get('GITHUB_SHA') == sha else ('--verify-tag',)
            gh('release', 'create', tag, '--repo', repo, *target, '--title', f'Android APK {version} · {sha[:7]}', '--draft', '--notes-file', str(notes))
        gh('release', 'upload', tag, *[str(directory / name) for name in assets], '--repo', repo, '--clobber')
        gh('release', 'edit', tag, '--repo', repo, '--draft=false', '--latest')
        url = f'https://github.com/{repo}/releases/latest/download/bungee.apk'
        print('Published APK:', url)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(f'## Android APK\n\n[Download bungee.apk]({url}) · [Release notes](https://github.com/{repo}/releases/tag/{tag})\n')


if __name__ == '__main__': main()
