#!/usr/bin/env python3
"""Sign a checked APK once; GitHub and every server distribute these exact bytes."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def android_tool(name):
    sdk = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
    candidate = Path(sdk) / 'build-tools/35.0.0' / name if sdk else None
    return str(candidate) if candidate and candidate.is_file() else name


def run(args):
    return subprocess.check_output([str(v) for v in args], text=True, stderr=subprocess.PIPE).strip()


def fingerprint(text):
    values = re.findall(r'^Signer #[0-9]+ certificate SHA-256 digest: ([a-f0-9]{64})$', text, re.M)
    if len(values) != 1:
        raise ValueError('The APK must have exactly one verified signing certificate')
    return values[0]


def inspect(apk, *, verify=True):
    if apk.is_symlink() or not apk.is_file() or not 1 <= apk.stat().st_size <= 256 * 1024**2:
        raise ValueError('Invalid APK file')
    badging = run([android_tool('aapt'), 'dump', 'badging', apk])
    if 'application-debuggable' in badging:
        raise ValueError('A debuggable APK cannot be published')
    package = re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging)
    if not package or package[1] != 'org.bungee.app':
        raise ValueError('Unexpected APK package')
    run([android_tool('zipalign'), '-c', '-p', '4', apk])
    signer = fingerprint(run([android_tool('apksigner'), 'verify', '--print-certs', apk])) if verify else None
    return {'version': package[3], 'version_code': int(package[2]), 'signer_sha256': signer}


def sign(apk, destination, keystore, password_file, alias, expected_signer, release):
    if not re.fullmatch('[a-f0-9]{64}', expected_signer):
        raise ValueError('Configure the persistent BUNGEE_RELEASE_SIGNER_SHA256 repository variable')
    info = inspect(apk, verify=False)
    if info['version'] != release['version'] or info['version_code'] != release['android_version_code']:
        raise ValueError('APK version does not match the checked source release')
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / 'bungee.apk'
    run([android_tool('apksigner'), 'sign', '--ks', keystore, '--ks-key-alias', alias,
         '--ks-pass', 'file:' + str(password_file), '--out', target, apk])
    signed = inspect(target)
    if signed['signer_sha256'] != expected_signer:
        target.unlink(missing_ok=True)
        raise ValueError('Release signing certificate changed; restore the established release key')
    with target.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    descriptor = {**signed, 'sha256': digest, 'size': target.stat().st_size, 'signing': 'publisher-v1'}
    (destination / 'bungee.apk.sha256').write_text(digest + '  bungee.apk\n')
    (destination / 'signing.json').write_text(json.dumps(descriptor, indent=2) + '\n')
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    encoded = os.environ.pop('BUNGEE_RELEASE_KEYSTORE_BASE64', '')
    password = os.environ.pop('BUNGEE_RELEASE_STORE_PASSWORD', '')
    expected = os.environ.get('BUNGEE_RELEASE_SIGNER_SHA256', '')
    alias = os.environ.get('BUNGEE_RELEASE_KEY_ALIAS', '') or 'bungee'
    if not encoded or not password or not expected:
        raise ValueError('Persistent release signing is not configured. Run scripts/setup-release-signing.py on a trusted machine; no disposable-key fallback is allowed')
    checksum = args.apk.with_name(args.apk.name + '.sha256').read_text().split()
    with args.apk.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if len(checksum) != 2 or checksum[1] != args.apk.name or checksum[0] != actual:
        raise ValueError('Unsigned build artifact checksum mismatch')
    release = json.loads((Path(__file__).resolve().parents[1] / 'release.json').read_text())
    with tempfile.TemporaryDirectory(prefix='bungee-release-key-', dir=os.environ.get('RUNNER_TEMP')) as temporary:
        private = Path(temporary)
        key = private / 'release.p12'; secret = private / 'password'
        key.write_bytes(base64.b64decode(encoded, validate=True)); key.chmod(0o600)
        secret.write_text(password + '\n'); secret.chmod(0o600)
        result = sign(args.apk, args.destination, key, secret, alias, expected, release)
    print(f"Verified publisher APK {result['version']}; certificate {result['signer_sha256']}")


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
    except (OSError, subprocess.SubprocessError):
        # Never print subprocess output or signing credentials.

        raise SystemExit('Release signing failed. Check persistent signing secrets, certificate pin and APK version; no APK was published')
