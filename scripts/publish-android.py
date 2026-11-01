#!/usr/bin/env python3
"""Publish checked main-branch APKs as ordinary, permanent GitHub Release assets."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
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
    apk = directory / 'bungee-debug.apk'
    expected = (directory / 'bungee-debug.apk.sha256').read_text().split()
    if apk.is_symlink() or len(expected) != 2 or expected[1] != 'bungee-debug.apk':
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
        if not any(job['name'] == 'android' and job['conclusion'] == 'success' for job in jobs): continue
        artifacts = api(repo, f'actions/runs/{run["id"]}/artifacts')['artifacts']
        if any(a['name'] == 'bungee-android-debug' and not a['expired'] for a in artifacts):
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
        gh('run', 'download', str(run['id']), '--repo', repo, '--name', 'bungee-android-debug', '--dir', str(directory))
        digest = verify_checksum(directory)
        shutil.copyfile(directory / 'bungee-debug.apk', directory / 'bungee.apk')
        (directory / 'bungee.apk.sha256').write_text(digest + '  bungee.apk\n')
        (directory / 'build.json').write_text(json.dumps({'version': version, 'android_version_code': app_release['android_version_code'], 'commit': sha, 'run_id': run['id'], 'sha256': digest}, indent=2) + '\n')
        notes = directory / 'notes.md'
        notes.write_text(f'''Download **bungee.apk** below and open it on your Android phone. No ZIP extraction or Actions login is needed for this public release.

Android app version: **{version}** · source: [{sha[:12]}](https://github.com/{repo}/commit/{sha})

For a paired phone with in-app updates, install **manager Settings → Phone app updates → Download this server’s APK**. That APK uses your server’s persistent signing key. The GitHub asset below is also the verified input used by the host’s signer.

This standalone development APK includes the current main-branch phone features. Its Android build, unit tests and lint passed in [the source build]({run['html_url']}). This release does not claim that unrelated server jobs passed or that physical-device testing is complete.

The standalone APK has a disposable CI signing key, with Android debugging disabled. It cannot update to a differently signed server APK in place. Switching once removes unsent local data on uninstall: upload it first, keep the saved manager device, then use **Reconnect · keep history** on that same device after installing the server APK. Do not purge or erase it. Subsequent server-signed upgrades keep pairing and app data; do not uninstall for routine updates.

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
