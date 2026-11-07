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
            def command(args,*,step,data=None):
                calls.append((args,data))
                if args==['keytool','-help']:return b''
                if args[:3]==['gh','secret','list']:return json.dumps([{'name':n} for n in remote]).encode()
                if args[:3]==['gh','variable','list']:
                    return json.dumps([{'name':'BUNGEE_RELEASE_SIGNER_SHA256','value':remote['pin']}] if 'pin' in remote else []).encode()
                if args[:2]==['keytool','-genkeypair']:
                    Path(args[args.index('-keystore')+1]).write_bytes(b'test private keystore');return b''
                if args[:2]==['keytool','-exportcert']:return certificate
                if args[:3]==['gh','variable','set']:
                    if args[3]=='BUNGEE_RELEASE_SIGNER_SHA256':remote['pin']=args[-1]
                    return b''
                if args[:3]==['gh','secret','set']:remote[args[3]]=data;return b''
                raise AssertionError(args)
            with patch.object(setup,'command',command):
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
            def command(args,**kwargs):
                if args==['keytool','-help']:return b''
                if args[:3]==['gh','secret','list']:return b'[{"name":"BUNGEE_RELEASE_KEYSTORE_BASE64"}]'
                if args[:3]==['gh','variable','list']:return b'[]'
                raise AssertionError('A missing established key reached a remote write')
            with patch.object(setup,'command',side_effect=command) as calls:
                with self.assertRaisesRegex(ValueError,'Restore'):setup.configure(Path(temporary)/'identity')
                self.assertEqual(calls.call_count,3)

    def test_changed_local_key_cannot_overwrite_repository_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary);(directory/'bungee.p12').write_bytes(b'wrong key');(directory/'password').write_text('not a real secret')
            def command(args,**kwargs):
                if args==['keytool','-help']:return b''
                if args[:3]==['gh','secret','list']:return b'[]'
                if args[:3]==['gh','variable','list']:return json.dumps([{'name':'BUNGEE_RELEASE_SIGNER_SHA256','value':'a'*64}]).encode()
                if args[:2]==['keytool','-exportcert']:return b'different certificate'
                raise AssertionError('A mismatched key reached a remote write')
            with patch.object(setup,'command',command):
                with self.assertRaisesRegex(ValueError,'differs'):setup.configure(directory)

    def test_unreadable_pin_stops_before_creating_or_overwriting_any_signing_files(self):
        for existing in (False,True):
            with self.subTest(existing=existing),tempfile.TemporaryDirectory() as temporary:
                directory=Path(temporary)/'identity'
                if existing:
                    directory.mkdir();(directory/'bungee.p12').write_bytes(b'PRIVATE_KEY');(directory/'password').write_bytes(b'PRIVATE_PASSWORD')
                def execute(args,**kwargs):
                    if args==['keytool','-help']:return b''
                    if args[:3]==['gh','secret','list']:return b'[]'
                    if args[:3]==['gh','variable','list']:
                        raise subprocess.CalledProcessError(1,args,output=b'PRIVATE_STDOUT',stderr=b'HTTP 403 PRIVATE_TOKEN')
                    raise AssertionError('An unreadable pin reached key generation or a remote write')
                with patch.object(setup.subprocess,'check_output',side_effect=execute):
                    with self.assertRaisesRegex(setup.SetupError,'Read repository certificate pin:.*HTTP 403.*Variables') as caught:
                        setup.configure(directory)
                self.assertNotIn('PRIVATE',str(caught.exception))
                if existing:
                    self.assertEqual((directory/'bungee.p12').read_bytes(),b'PRIVATE_KEY')
                    self.assertEqual((directory/'password').read_bytes(),b'PRIVATE_PASSWORD')
                else:self.assertFalse(directory.exists())

    def test_missing_java_is_named_before_any_password_file_is_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'identity'
            with patch.object(setup.subprocess,'check_output',side_effect=FileNotFoundError) as execute:
                with self.assertRaisesRegex(setup.SetupError,'Check Java keytool: keytool was not found.*default-jre-headless'):
                    setup.configure(directory)
            self.assertEqual(execute.call_count,1)
            self.assertFalse(directory.exists())

    def test_failed_commands_never_echo_credentials_or_subprocess_output(self):
        cases=[(['gh','secret','list'],b'HTTP 401 Bad credentials PRIVATE_TOKEN','authentication failed'),
               (['gh','secret','set'],b'HTTP 403 PRIVATE_TOKEN','Secrets permission: Read and write'),
               (['gh','variable','set'],b'HTTP 404 PRIVATE_TOKEN','Variables permission: Read and write'),
               (['gh','variable','list'],b'dial tcp: timeout PRIVATE_TOKEN','Could not reach GitHub'),
               (['keytool','-exportcert'],b'PRIVATE_KEY PRIVATE_PASSWORD','Java keytool failed')]
        for args,stderr,expected in cases:
            with self.subTest(args=args),patch.dict(os.environ,{'GH_TOKEN':'PRIVATE_ENV_TOKEN'},clear=True):
                error=subprocess.CalledProcessError(1,args,output=b'PRIVATE_STDOUT',stderr=stderr)
                with patch.object(setup.subprocess,'check_output',side_effect=error):
                    with self.assertRaisesRegex(setup.SetupError,expected) as caught:
                        setup.command(args,step='Named setup step',data=b'PRIVATE_STDIN')
                self.assertNotIn('PRIVATE',str(caught.exception))
                self.assertTrue(str(caught.exception).startswith('Named setup step:'))
                if args[0]=='gh':self.assertIn('GH_TOKEN',str(caught.exception))


class ReleaseSignerTests(unittest.TestCase):
    def test_missing_production_credentials_fail_before_signing(self):
        with patch.dict(os.environ,{},clear=True),patch.object(sys,'argv',['release_signing.py','source.apk','output']),patch.object(release_signing,'sign') as sign:
            with self.assertRaisesRegex(ValueError,'no disposable-key fallback'):release_signing.main()
            sign.assert_not_called()

    def test_certificate_parser_rejects_missing_multiple_and_malformed_signers(self):
        for text in ['', 'Signer #1 certificate SHA-256 digest: bad', '\n'.join(f'Signer #{i} certificate SHA-256 digest: '+str(i)*64 for i in (1,2))]:
            with self.assertRaises(ValueError):release_signing.fingerprint(text)
        self.assertEqual(release_signing.fingerprint('Signer #1 certificate SHA-256 digest: '+'a'*64),'a'*64)
