import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).resolve().parents[1] / 'scripts/cleanup-releases.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.backup = Path(self.temporary.name) / 'backup'
        notes = Path(self.temporary.name) / 'notes.md'
        notes.write_text('Reviewed release notes\n<!-- android-source-run: 153 -->\n')
        self.plan = {'repository':cleanup.REPOSITORY, 'notes_file':str(notes),
                     'keep':{'id':2,'tag':'android-new','commit':'a'*40,'version':'1.1.22','android_version_code':38,'source_run':153},
                     'retire':{'id':1,'tag':'android-old','commit':'b'*40,'version':'1.1.21','android_version_code':37}}
        self.releases = [self.release(self.plan[key]) for key in ('keep', 'retire')]
        self.latest = 2
        self.calls = []
        self.fail_edit = False
        self.addCleanup(patch.stopall)
        patch.object(cleanup, 'api', self.api).start()
        patch.object(cleanup, 'gh', self.gh).start()

    def release(self, expected):
        return {'id':expected['id'],'tag_name':expected['tag'],'target_commitish':expected['commit'],
                'name':expected['version'],'body':'Original notes','draft':False,'prerelease':False,
                'updated_at':'2026-11-13T22:41:07Z','assets':[{'name':name,'id':i,'size':10,'digest':'x','download_count':0} for i,name in enumerate(sorted(cleanup.ASSETS))]}

    def api(self, path):
        if path == 'releases?per_page=100': return copy.deepcopy(self.releases)
        if path == 'releases/latest': return {'id':self.latest}
        for key in ('keep', 'retire'):
            expected = self.plan[key]
            if path == 'contents/release.json?ref=' + expected['commit']:
                return {'content':base64.b64encode(json.dumps({'version':expected['version'],'android_version_code':expected['android_version_code']}).encode()).decode()}
        raise AssertionError(path)

    def gh(self, *args):
        self.calls.append(args)
        if args[:2] == ('release', 'download'):
            expected = next(self.plan[key] for key in ('keep','retire') if self.plan[key]['tag'] == args[2])
            directory = Path(args[args.index('--dir')+1]);apk = expected['tag'].encode()
            digest = hashlib.sha256(apk).hexdigest()
            (directory/'bungee.apk').write_bytes(apk)
            (directory/'bungee.apk.sha256').write_text(digest+'  bungee.apk\n')
            (directory/'build.json').write_text(json.dumps({'version':expected['version'],'android_version_code':expected['android_version_code'],
                                                          'commit':expected['commit'],'sha256':digest,'signing':'publisher-v1'}))
        if args[:2] == ('release','edit') and self.fail_edit:
            raise RuntimeError('GitHub edit failed')
        if args[:2] == ('release','delete'):
            self.releases = [r for r in self.releases if r['tag_name'] != args[2]]
        return ''

    def run_cleanup(self, apply=False):
        cleanup.run(self.plan, self.backup, apply)

    def mutations(self):
        return [call for call in self.calls if call[:2] in (('release','edit'),('release','delete'))]

    def test_preview_backs_up_both_apks_and_changes_no_releases(self):
        self.run_cleanup()
        self.assertEqual(self.mutations(), [])
        for key in ('keep','retire'):
            self.assertEqual({p.name for p in (self.backup/self.plan[key]['tag']).iterdir()}, cleanup.ASSETS|{'release.json'})

    def test_apply_requires_preview_and_verified_backups(self):
        with self.assertRaisesRegex(ValueError, 'preview/back up'):
            self.run_cleanup(True)
        self.assertEqual(self.mutations(), [])

    def test_apply_edits_replacement_before_deletion_and_keeps_source_tag(self):
        self.run_cleanup()
        for release in self.releases:
            for asset in release['assets']: asset['download_count'] += 1
        self.run_cleanup(True)
        self.assertEqual([call[:2] for call in self.mutations()], [('release','edit'),('release','delete')])
        self.assertNotIn('--cleanup-tag', self.mutations()[-1])
        self.assertEqual([r['id'] for r in self.releases], [2])

    def test_corrupted_backup_cannot_delete_a_release(self):
        self.run_cleanup()
        (self.backup/'android-old'/'bungee.apk').write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.run_cleanup(True)
        self.assertEqual(self.mutations(), [])

    def test_changed_release_notes_or_assets_require_another_review(self):
        self.run_cleanup()
        self.releases[1]['body'] = 'Changed by someone else'
        with self.assertRaisesRegex(ValueError, 'changed after backup'):
            self.run_cleanup(True)
        self.assertEqual(self.mutations(), [])

    def test_another_latest_release_cannot_be_rolled_back_by_an_old_plan(self):
        self.latest = 3
        with self.assertRaisesRegex(ValueError, 'Another release is latest'):
            self.run_cleanup()
        self.assertEqual(self.calls, [])

    def test_missing_replacement_or_incomplete_assets_prevent_cleanup(self):
        self.releases[0]['assets'].pop()
        with self.assertRaisesRegex(ValueError, 'complete regular'):
            self.run_cleanup()
        self.releases = self.releases[1:]
        with self.assertRaisesRegex(ValueError, 'Replacement release is missing'):
            self.run_cleanup()
        self.assertEqual(self.calls, [])

    def test_changed_source_identity_prevents_any_download_or_mutation(self):
        self.releases[1]['target_commitish'] = 'c'*40
        with self.assertRaisesRegex(ValueError, 'identity/source changed'):
            self.run_cleanup()
        self.assertEqual(self.calls, [])

    def test_failure_updating_the_good_release_never_deletes_the_old_one(self):
        self.run_cleanup();self.fail_edit = True
        with self.assertRaisesRegex(RuntimeError, 'GitHub edit failed'):
            self.run_cleanup(True)
        self.assertEqual([r['id'] for r in self.releases], [2,1])
        self.assertFalse(any(call[:2] == ('release','delete') for call in self.calls))

    def test_repeated_cleanup_when_old_release_is_absent_is_a_noop(self):
        self.releases = self.releases[:1]
        self.run_cleanup(True)
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()
