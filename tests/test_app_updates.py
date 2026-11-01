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
