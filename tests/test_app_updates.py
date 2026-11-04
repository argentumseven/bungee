import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import io
import urllib.error
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import app_updates as updates

class AppUpdateTests(unittest.TestCase):
    def test_exact_server_build_and_version_code_required(self):
        build={'commit':'a'*40,'version':'1.1.9','sha256':'b'*64,'android_version_code':25}
        self.assertEqual(updates.validate_build(build,'a'*40,'1.1.9'),25)
        for value in ({**build,'commit':'c'*40},{**build,'version':'1.1.8'},{**build,'sha256':'../apk'},{**build,'android_version_code':True}):
            with self.assertRaises(ValueError): updates.validate_build(value,'a'*40,'1.1.9')

    def test_failed_preparation_keeps_existing_apk_and_retries_without_secret_details(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);updates.setup(root)
            (root/'app-updates/release.json').write_text('{"old":true}')
            with patch.object(updates,'prepare',side_effect=OSError('private tool detail')):
                updates.tick(root,lambda:{})
            self.assertEqual(json.loads((root/'app-updates/release.json').read_text()),{'old':True})
            status=json.loads((root/'app-updates/status.json').read_text())
            self.assertEqual(status['state'],'waiting');self.assertNotIn('private',status['message'])

    def test_running_transaction_prevents_signing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'transaction.json').write_text('{}')
            with patch.object(updates,'prepare') as prepare:
                updates.tick(root,lambda:{})
                prepare.assert_not_called()

    def test_download_reports_bytes_and_enforces_limit(self):
        payload=b'x'*(1024*1024+31)
        class Response(io.BytesIO):
            headers={'Content-Length':str(len(payload))}
        with tempfile.TemporaryDirectory() as temporary:
            events=[];target=Path(temporary)/'source.apk'
            with patch.object(updates.urllib.request,'urlopen',return_value=Response(payload)):
                self.assertEqual(updates.fetch('https://example.invalid/apk',target,len(payload),lambda done,total:events.append((done,total))),len(payload))
            self.assertEqual(events,[(0,len(payload)),(1024*1024,len(payload)),(len(payload),len(payload))])
            self.assertEqual(target.read_bytes(),payload)
            with patch.object(updates.urllib.request,'urlopen',return_value=Response(payload)):
                with self.assertRaisesRegex(ValueError,'size limit'): updates.fetch('https://example.invalid/apk',Path(temporary)/'too-large.apk',1)

    def test_waiting_status_preserves_version_and_stage_without_exposing_http_body(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);updates.setup(root)
            updates.atomic(root/'app-updates/status.json',{'state':'preparing','version':'1.1.12','stage':'metadata'})
            error=urllib.error.HTTPError('https://example.invalid/private',403,'private upstream details',{},None)
            with patch.object(updates,'prepare',side_effect=error): updates.tick(root,lambda:{})
            status=json.loads((root/'app-updates/status.json').read_text())
            self.assertEqual(status['version'],'1.1.12');self.assertEqual(status['stage'],'metadata')
            self.assertIn('HTTP 403',status['message']);self.assertNotIn('private',status['message'])

class PublisherUpdateTests(unittest.TestCase):
    def fixture(self, root, *, legacy=False, pin=None, signer=None):
        public=root/'app-updates';keys=root/'volumes/tls-data/android-signing';keys.mkdir(parents=True)
        (root/'android-signer.Dockerfile').write_text('test fixture')
        if pin:(keys/'publisher.sha256').write_text(pin+'\n')
        if legacy:
            public.mkdir();(keys/'bungee.p12').write_bytes(b'original legacy key');(keys/'password').write_text('fixture password')
            (public/'release.json').write_text(json.dumps({'commit':'c'*40,'sha256':'d'*64,'signer_sha256':'b'*64}))
        payload=b'verified official apk bytes';build={'version':'1.1.17','android_version_code':33,'commit':'a'*40,'sha256':updates.hashlib.sha256(payload).hexdigest(),'signing':'publisher-v1','signer_sha256':'a'*64}
        def fetch(url,target=None,limit=65536,progress=None):
            if target is None:return build
            target.write_bytes(payload);return len(payload)
        def run(args):
            if args[:4]==['docker','image','inspect','server:fixture']:return json.dumps([{'Config':{'Labels':{'dev.bungee.source-commit':'a'*40}}}])
            if args[:3]==['docker','image','inspect']:return '[]'
            mounts=[args[i+1] for i,v in enumerate(args) if v=='-v'];work=Path(next(v for v in mounts if v.endswith(':/work')).removesuffix(':/work'))
            if 'aapt' in args:return "package: name='org.bungee.app' versionCode='33' versionName='1.1.17'"
            if 'zipalign' in args:return ''
            if 'sign' in args:
                self.assertIn(str(keys)+':/keys:ro',mounts);(work/'legacy.apk').write_bytes(b'legacy signed bytes');return ''
            if 'verify' in args:
                if args[-1]=='/work/source.apk':
                    self.assertFalse(any(':/keys' in v for v in mounts));fingerprint=signer or 'a'*64
                else:fingerprint='b'*64
                return 'Signer #1 certificate SHA-256 digest: '+fingerprint
            raise AssertionError(args)
        return payload,build,fetch,run

    def test_official_download_is_byte_identical_to_github_without_a_new_server_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);payload,build,fetch,run=self.fixture(root)
            with patch.object(updates,'fetch',fetch),patch.object(updates,'run',run),patch('map_manager.capacity',return_value={'available_bytes':10*1024**3}):updates.prepare(root,{'version':'1.1.17','images':{'server':'server:fixture'}})
            descriptor=json.loads((root/'app-updates/release.json').read_text())
            self.assertEqual((root/'app-updates'/f"{descriptor['sha256']}.apk").read_bytes(),payload)
            self.assertEqual(descriptor['sha256'],build['sha256']);self.assertEqual(descriptor['signer_sha256'],build['signer_sha256'])
            self.assertFalse((root/'volumes/tls-data/android-signing/bungee.p12').exists())

    def test_legacy_identity_remains_available_without_changing_the_official_apk(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);payload,build,fetch,run=self.fixture(root,legacy=True)
            with patch.object(updates,'fetch',fetch),patch.object(updates,'run',run),patch('map_manager.capacity',return_value={'available_bytes':10*1024**3}):updates.prepare(root,{'version':'1.1.17','images':{'server':'server:fixture'}})
            official=json.loads((root/'app-updates/release.json').read_text());legacy=json.loads((root/'app-updates/legacy-release.json').read_text())
            self.assertEqual(official['sha256'],build['sha256']);self.assertEqual(official['signer_sha256'],'a'*64)
            self.assertEqual(legacy['signer_sha256'],'b'*64);self.assertNotEqual(legacy['sha256'],official['sha256'])
            self.assertEqual((root/'volumes/tls-data/android-signing/bungee.p12').read_bytes(),b'original legacy key')

    def test_changed_publisher_pin_or_actual_apk_certificate_cannot_be_published(self):
        for options in [{'pin':'c'*64},{'signer':'c'*64}]:
            with self.subTest(options=options),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);_,_,fetch,run=self.fixture(root,**options)
                with patch.object(updates,'fetch',fetch),patch.object(updates,'run',run),patch('map_manager.capacity',return_value={'available_bytes':10*1024**3}):
                    with self.assertRaisesRegex(ValueError,'certificate'):updates.prepare(root,{'version':'1.1.17','images':{'server':'server:fixture'}})
                self.assertFalse((root/'app-updates/release.json').exists())
