import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/security-refresh.yml').read_text()


def script():
    """The real shell step from the workflow, not a copy of it."""
    block = re.search(r'^        run: \|\n((?:          .*\n|\n)+)', WORKFLOW, re.M)
    assert block, 'security-refresh run step not found'
    return '\n'.join(line[10:] for line in block.group(1).splitlines()) + '\n'


# A stand-in for the GitHub CLI: `gh api --paginate URL --jq FILTER` applies the real filter with jq to
# the canned release list, and `gh workflow run ...` is recorded instead of dispatched.
FAKE_GH = r'''#!/bin/bash
set -u
if [[ "$1" == api ]]; then
  [[ -n "${FAKE_GH_FAIL:-}" ]] && { echo "$FAKE_GH_FAIL" >&2; exit 1; }
  while [[ $# -gt 0 ]]; do [[ "$1" == --jq ]] && { filter="$2"; break; }; shift; done
  jq -r "$filter" "$FAKE_GH_RELEASES"
elif [[ "$1" == workflow ]]; then
  echo "$*" >> "$FAKE_GH_LOG"
else
  exit 2
fi
'''


def release(tag, draft=False, prerelease=False):
    return {'tag_name': tag, 'draft': draft, 'prerelease': prerelease}


@unittest.skipUnless(shutil.which('jq') and shutil.which('bash'), 'jq and bash are required')
class SecurityRefreshTests(unittest.TestCase):
    def run_step(self, releases, fail=None):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'gh').write_text(FAKE_GH)
            (directory / 'gh').chmod(0o755)
            (directory / 'releases.json').write_text(json.dumps(releases))
            env = {**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}', 'REPOSITORY': 'owner/repo',
                   'FAKE_GH_RELEASES': str(directory / 'releases.json'), 'FAKE_GH_LOG': str(directory / 'log')}
            if fail:
                env['FAKE_GH_FAIL'] = fail
            result = subprocess.run(['bash', '-e', '-c', script()], cwd=directory, env=env, capture_output=True, text=True)
            log = (directory / 'log').read_text().splitlines() if (directory / 'log').exists() else []
            return result, log

    def test_android_only_releases_promote_nothing_and_succeed(self):
        # This is the situation that made every nightly run fail: the newest release is an APK release.
        result, log = self.run_step([release('android-14196fb8286f'), release('android-dde1a89945a2')])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('nothing is promoted', result.stdout)
        self.assertEqual(log, [])

    def test_no_releases_at_all_succeeds(self):
        result, log = self.run_step([])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(log, [])

    def test_newest_stable_server_release_is_checked_even_behind_apk_releases(self):
        result, log = self.run_step([
            release('android-14196fb8286f'),
            release('v1.4.0', draft=True),
            release('v1.3.0-rc1', prerelease=True),
            release('v0.1.0-alpha.11'),
            release('v1.2.3'),
            release('android-dde1a89945a2'),
            release('v1.2.2'),
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(log, ['workflow run check.yml --repo owner/repo --ref v1.2.3'])

    def test_a_github_api_failure_still_fails_the_run(self):
        result, log = self.run_step([], fail='HTTP 502: bad gateway')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('HTTP 502', result.stderr)
        self.assertEqual(log, [])

    def test_workflow_keeps_its_least_privilege_and_does_not_touch_signing(self):
        self.assertIn('contents: read', WORKFLOW)
        self.assertNotIn('BUNGEE_RELEASE', WORKFLOW)
        self.assertNotIn('secrets.BUNGEE', WORKFLOW)


if __name__ == '__main__':
    unittest.main()
