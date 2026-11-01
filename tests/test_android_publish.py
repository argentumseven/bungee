import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publish', Path(__file__).resolve().parents[1] / 'scripts/publish-android.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
REPO = 'argentumseven/bungee'
RUN = {'id': 123, 'head_sha': 'a' * 40, 'head_repository': {'full_name': REPO}, 'head_branch': 'main',
       'event': 'push', 'path': '.github/workflows/check.yml', 'run_number': 7, 'html_url': 'https://example.test/build'}


class PublishingTests(unittest.TestCase):
    def test_only_own_main_builds_are_publishable(self):
        self.assertTrue(publish.trusted_run(RUN, REPO))
        for updates in ({'event':'pull_request'}, {'head_branch':'feature'}, {'head_repository':None},
                        {'head_repository':{'full_name':'other/fork'}}, {'path':'.github/workflows/other.yml'}):
            self.assertFalse(publish.trusted_run({**RUN, **updates}, REPO))

    def simulate(self, *, checksum_ok=True, android_passed=True, releases=None):
        calls = []
        def api(repo, path):
            self.assertEqual(repo, REPO)
            if path == 'actions/workflows/check.yml/runs?branch=main&per_page=30': return {'workflow_runs':[RUN]}
            if path == 'actions/runs/123/jobs?per_page=100': return {'jobs':[{'name':'android','conclusion':'success' if android_passed else 'failure'}]}
            if path == 'actions/runs/123/artifacts': return {'artifacts':[{'name':'bungee-android-debug','expired':False}]}
            if path == 'releases?per_page=100': return releases or []
            if path == 'contents/release.json?ref=' + 'a' * 40:
                return {'content':base64.b64encode(json.dumps({'version':'1.1.4','android_version_code':20}).encode()).decode()}
            raise AssertionError(path)
        def gh(*args):
            calls.append(args)
            if args[:2] == ('run','download'):
                directory = Path(args[args.index('--dir')+1])
                (directory/'bungee-debug.apk').write_bytes(b'test apk bytes')
                digest = hashlib.sha256(b'test apk bytes').hexdigest() if checksum_ok else '0' * 64
                (directory/'bungee-debug.apk.sha256').write_text(digest + '  bungee-debug.apk\n')
            if args[:2] == ('release','upload'):
                files = [Path(name) for name in args[3:6]]
                self.assertEqual([file.name for file in files], ['bungee.apk','bungee.apk.sha256','build.json'])
                self.assertEqual(files[0].read_bytes(), b'test apk bytes')
                self.assertTrue(files[1].read_text().endswith('  bungee.apk\n'))
                self.assertEqual(json.loads(files[2].read_text())['commit'], 'a' * 40)
            return ''
        with patch.dict(os.environ, {'GH_REPO':REPO,'BUNGEE_BUILD_RUN_ID':''}, clear=True), patch.object(publish,'api',api), patch.object(publish,'gh',gh):
            publish.main()
        return calls

    def test_release_is_hidden_until_verified_assets_are_uploaded(self):
        calls = self.simulate()
        self.assertEqual(calls[1][:2], ('release','create'))
        self.assertIn('--draft', calls[1])
        self.assertEqual(calls[2][:2], ('release','upload'))
        self.assertEqual(calls[3][:2], ('release','edit'))
        self.assertIn('--latest', calls[3])

    def test_failed_android_job_or_older_run_cannot_replace_latest(self):
        self.assertEqual(self.simulate(android_passed=False), [])
        self.assertEqual(self.simulate(releases=[{'draft':False,'body':'<!-- android-source-run: 8 -->'}]), [])

    def test_bad_checksum_prevents_release_creation(self):
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.simulate(checksum_ok=False)

    def test_complete_release_is_not_uploaded_again(self):
        existing = {'draft':False,'tag_name':'android-'+'a'*12,'body':'<!-- android-source-run: 7 -->',
                    'html_url':'https://example.test/release','assets':[{'name':n} for n in ('bungee.apk','bungee.apk.sha256','build.json')]}
        self.assertEqual(self.simulate(releases=[existing]), [])


if __name__ == '__main__': unittest.main()
