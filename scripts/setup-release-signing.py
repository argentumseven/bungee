#!/usr/bin/env python3
"""Configure one persistent GitHub Actions signer from a trusted administrator machine."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

REPOSITORY = 'argentumseven/bungee'
SECRET_NAMES = {'BUNGEE_RELEASE_KEYSTORE_BASE64', 'BUNGEE_RELEASE_STORE_PASSWORD'}


class SetupError(RuntimeError):
    """An actionable failure that is safe to display without subprocess output."""


def command(args, *, step, data=None):
    try:
        return subprocess.check_output([str(v) for v in args], input=data, stderr=subprocess.PIPE)
    except FileNotFoundError:
        package = 'gh' if args[0] == 'gh' else 'default-jre-headless'
        raise SetupError(f'{step}: {args[0]} was not found. On Debian run apt-get install -y {package}.') from None
    except subprocess.CalledProcessError as error:
        # Classify errors internally. Never echo stderr, stdout, stdin or argv:
        # any of them could contain credentials, key material or a local path.
        detail = (error.stderr or b'').decode('utf-8', errors='replace').lower()
        if args[0] == 'gh':
            permission = 'Secrets' if args[1] == 'secret' else 'Variables'
            match = re.search(r'\bhttp\s+(\d{3})\b', detail)
            status = int(match[1]) if match else None
            if status == 401 or any(value in detail for value in ('bad credentials', 'gh auth login', 'not logged', 'requires authentication')):
                reason = 'GitHub authentication failed. Authenticate gh with a token for argentumseven/bungee.'
            elif 'rate limit' in detail:
                reason = 'GitHub rate limit reached. Retry after the limit resets.'
            elif status in (403, 404):
                reason = (f'GitHub denied this operation (HTTP {status}). Select argentumseven/bungee in the token and grant '
                          f'the repository {permission} permission: Read and write.')
            elif any(value in detail for value in ('unknown command', 'unknown flag', 'unknown json field')):
                reason = 'This GitHub CLI version does not support the command. Update gh and retry.'
            elif any(value in detail for value in ('dial tcp', 'timeout', 'x509', 'tls', 'could not resolve', 'no such host')):
                reason = 'Could not reach GitHub. Check this host\'s DNS, HTTPS connectivity and certificate trust.'
            else:
                reason = f'GitHub CLI failed with exit code {error.returncode}.'
            overridden = next((name for name in ('GH_TOKEN', 'GITHUB_TOKEN') if os.environ.get(name)), None)
            if overridden:
                reason += f' gh is using {overridden} from the environment instead of its saved login.'
        else:
            reason = f'Java keytool failed with exit code {error.returncode}. Check Java, the keystore alias and its saved password.'
        raise SetupError(f'{step}: {reason} Subprocess output was withheld; existing signing files were preserved.') from None


def configure(directory, alias='bungee'):
    directory = directory.expanduser().resolve()
    # Never store a production signing identity in the source checkout.
    checkout = Path(__file__).resolve().parents[1]
    if (checkout / ".git").exists() and (directory == checkout or checkout in directory.parents):
        raise ValueError('Keep the release signing directory outside the repository')
    command(['keytool', '-help'], step='Check Java keytool')
    current = json.loads(command(['gh', 'secret', 'list', '--repo', REPOSITORY, '--json', 'name'], step='Read repository signing secrets'))
    names = {item['name'] for item in current}
    variables = json.loads(command(['gh', 'variable', 'list', '--repo', REPOSITORY, '--json', 'name,value'], step='Read repository certificate pin'))
    pin = next((item['value'] for item in variables if item['name'] == 'BUNGEE_RELEASE_SIGNER_SHA256'), None)
    if pin is not None and not re.fullmatch('[a-f0-9]{64}', pin):
        raise ValueError('The repository certificate pin is empty or invalid. Restore its established value before retrying')
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
                 '-dname', 'CN=Bungee official Android releases', '-noprompt'], step='Generate local release keystore')
        os.replace(pending, key)
    key.chmod(0o600); password.chmod(0o600)
    certificate = command(['keytool', '-exportcert', '-keystore', key, '-storepass:file', password, '-alias', alias], step='Read local signing certificate')
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
    command(['gh', 'variable', 'set', 'BUNGEE_RELEASE_SIGNER_SHA256', '--repo', REPOSITORY, '--body', signer], step='Save repository certificate pin')
    command(['gh', 'variable', 'set', 'BUNGEE_RELEASE_KEY_ALIAS', '--repo', REPOSITORY, '--body', alias], step='Save repository signing alias')
    command(['gh', 'secret', 'set', 'BUNGEE_RELEASE_KEYSTORE_BASE64', '--repo', REPOSITORY], data=base64.b64encode(key.read_bytes()), step='Upload release keystore')
    command(['gh', 'secret', 'set', 'BUNGEE_RELEASE_STORE_PASSWORD', '--repo', REPOSITORY], data=password.read_bytes().rstrip(b'\r\n'), step='Upload release password')
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
    except (ValueError, SetupError) as error:
        raise SystemExit(str(error))
    except OSError as error:
        raise SystemExit(f'Local signing files could not be accessed: {os.strerror(error.errno) if error.errno else "filesystem error"}. Existing signing files were preserved')
