#!/usr/bin/env python3
"""Configure one persistent GitHub Actions signer from a trusted administrator machine."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess

REPOSITORY = 'argentumseven/bungee'
SECRET_NAMES = {'BUNGEE_RELEASE_KEYSTORE_BASE64', 'BUNGEE_RELEASE_STORE_PASSWORD'}


def command(args, *, data=None):
    return subprocess.check_output([str(v) for v in args], input=data, stderr=subprocess.PIPE)


def configure(directory, alias='bungee'):
    directory = directory.expanduser().resolve()
    # Never store a production signing identity in the source checkout.
    checkout = Path(__file__).resolve().parents[1]
    if (checkout / ".git").exists() and (directory == checkout or checkout in directory.parents):
        raise ValueError('Keep the release signing directory outside the repository')
    current = json.loads(command(['gh', 'secret', 'list', '--repo', REPOSITORY, '--json', 'name']))
    names = {item['name'] for item in current}
    pin_result = subprocess.run(['gh', 'variable', 'get', 'BUNGEE_RELEASE_SIGNER_SHA256', '--repo', REPOSITORY], capture_output=True, check=False)
    pin = pin_result.stdout.decode().strip() if pin_result.returncode == 0 else None
    key = directory / 'bungee.p12'; password = directory / 'password'
    if names & SECRET_NAMES and (not pin or not key.is_file() or not password.is_file()):
        raise ValueError('Release signing is already configured. Restore its original local keystore, password and certificate pin; refusing to replace it')
    if key.is_file() != password.is_file():
        raise ValueError('Incomplete signing identity; restore the missing key/password from backup')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700); directory.chmod(0o700)
    if not key.exists():
        if pin:
            raise ValueError('The release certificate is already pinned. Restore its original key instead of generating another')
        password.write_text(secrets.token_urlsafe(48) + '\n'); password.chmod(0o600)
        pending = directory / 'pending.p12'
        if pending.exists():
            raise ValueError('An interrupted signing-key setup exists; preserve it and inspect it before retrying')
        command(['keytool', '-genkeypair', '-keystore', pending, '-storetype', 'PKCS12',
                 '-storepass:file', password, '-keypass:file', password, '-alias', alias,
                 '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
                 '-dname', 'CN=Bungee official Android releases', '-noprompt'])
        os.replace(pending, key)
    key.chmod(0o600); password.chmod(0o600)
    certificate = command(['keytool', '-exportcert', '-keystore', key, '-storepass:file', password, '-alias', alias])
    signer = hashlib.sha256(certificate).hexdigest()
    saved_pin = directory / 'signer.sha256'
    if (pin and pin != signer) or (saved_pin.exists() and saved_pin.read_text().strip() != signer):
        raise ValueError('Signing certificate differs from the established identity; no GitHub secrets were changed')
    saved_pin.write_text(signer + '\n')
    # Durable local identity precedes all remote configuration. Never send secrets in argv.
    for path in (key, password, saved_pin):
        with path.open('rb') as stream: os.fsync(stream.fileno())
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    # Establish the public pin first; an interrupted upload can safely retry with this same key.
    command(['gh', 'variable', 'set', 'BUNGEE_RELEASE_SIGNER_SHA256', '--repo', REPOSITORY, '--body', signer])
    command(['gh', 'variable', 'set', 'BUNGEE_RELEASE_KEY_ALIAS', '--repo', REPOSITORY, '--body', alias])
    command(['gh', 'secret', 'set', 'BUNGEE_RELEASE_KEYSTORE_BASE64', '--repo', REPOSITORY], data=base64.b64encode(key.read_bytes()))
    command(['gh', 'secret', 'set', 'BUNGEE_RELEASE_STORE_PASSWORD', '--repo', REPOSITORY], data=password.read_bytes().rstrip(b'\r\n'))
    return signer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path.home() / '.local/share/bungee-release-signing')
    parser.add_argument('--alias', default='bungee')
    args = parser.parse_args()
    signer = configure(args.directory, args.alias)
    print('Persistent GitHub release signer configured:', signer)
    print('Back up the signing directory securely:', args.directory.expanduser())
    print('GitHub and server downloads will use the same signed APK. Keep this identity for every release.')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
    except (OSError, subprocess.SubprocessError):
        raise SystemExit('Signing setup could not finish. Check keytool and gh authentication/repository administration access; existing local keys were preserved')
