import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import release_signing
spec=importlib.util.spec_from_file_location('signing_setup',Path(__file__).resolve().parents[1]/'scripts/setup-release-signing.py')
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)


class SigningSetupTests(unittest.TestCase):
    def test_setup_uploads_secrets_over_stdin_and_reuses_the_same_local_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'identity';calls=[];remote={};certificate=b'test public certificate'
            def command(args,*,data=None):
                calls.append((args,data))
                if args[:3]==['gh','secret','list']:return json.dumps([{'name':n} for n in remote]).encode()
                if args[:2]==['keytool','-genkeypair']:
                    Path(args[args.index('-keystore')+1]).write_bytes(b'test private keystore');return b''
                if args[:2]==['keytool','-exportcert']:return certificate
                if args[:3]==['gh','variable','set']:
                    if args[3]=='BUNGEE_RELEASE_SIGNER_SHA256':remote['pin']=args[-1]
                    return b''
                if args[:3]==['gh','secret','set']:remote[args[3]]=data;return b''
                raise AssertionError(args)
            def pin(*args,**kwargs):return subprocess.CompletedProcess(args,0 if 'pin' in remote else 1,remote.get('pin','').encode(),b'')
            with patch.object(setup,'command',command),patch.object(setup.subprocess,'run',pin):
                first=setup.configure(directory);second=setup.configure(directory)
            self.assertEqual(first,second);self.assertEqual(first,hashlib.sha256(certificate).hexdigest())
            self.assertEqual(sum(args[:2]==['keytool','-genkeypair'] for args,_ in calls),1)
            self.assertEqual(base64.b64decode(remote['BUNGEE_RELEASE_KEYSTORE_BASE64']),b'test private keystore')
            secret=(directory/'password').read_text().strip()
            self.assertEqual(remote['BUNGEE_RELEASE_STORE_PASSWORD'].decode(),secret)
            self.assertFalse(any(secret in str(args) for args,_ in calls))
            self.assertEqual((directory/'bungee.p12').stat().st_mode & 0o777,0o600)
            self.assertEqual((directory/'password').stat().st_mode & 0o777,0o600)

    def test_missing_local_key_cannot_replace_an_established_github_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(setup,'command',return_value=b'[{"name":"BUNGEE_RELEASE_KEYSTORE_BASE64"}]') as command,patch.object(setup.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'a'*64,b'')):
                with self.assertRaisesRegex(ValueError,'Restore'):setup.configure(Path(temporary)/'identity')
                self.assertEqual(command.call_count,1)

    def test_changed_local_key_cannot_overwrite_repository_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary);(directory/'bungee.p12').write_bytes(b'wrong key');(directory/'password').write_text('not a real secret')
            def command(args,**kwargs):
                if args[:3]==['gh','secret','list']:return b'[]'
                if args[:2]==['keytool','-exportcert']:return b'different certificate'
                raise AssertionError('A mismatched key reached a remote write')
            with patch.object(setup,'command',command),patch.object(setup.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'a'*64,b'')):
                with self.assertRaisesRegex(ValueError,'differs'):setup.configure(directory)


class ReleaseSignerTests(unittest.TestCase):
    def test_missing_production_credentials_fail_before_signing(self):
        with patch.dict(os.environ,{},clear=True),patch.object(sys,'argv',['release_signing.py','source.apk','output']),patch.object(release_signing,'sign') as sign:
            with self.assertRaisesRegex(ValueError,'no disposable-key fallback'):release_signing.main()
            sign.assert_not_called()

    def test_certificate_parser_rejects_missing_multiple_and_malformed_signers(self):
        for text in ['', 'Signer #1 certificate SHA-256 digest: bad', '\n'.join(f'Signer #{i} certificate SHA-256 digest: '+str(i)*64 for i in (1,2))]:
            with self.assertRaises(ValueError):release_signing.fingerprint(text)
        self.assertEqual(release_signing.fingerprint('Signer #1 certificate SHA-256 digest: '+'a'*64),'a'*64)
