import importlib.util
import fcntl
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'scripts/bungee-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class UninstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.root = base / 'root'
        self.root.mkdir()
        self.systemd = base / 'systemd'
        self.systemd.mkdir()
        self.image = base / 'data/storage.luks'
        self.key = base / 'keys/storage.key'
        for path in (self.image, self.key):
            path.parent.mkdir()
            path.write_text('retained')
        (self.key.parent / 'backup-identity').write_text('backup key')
        self.boot = (base / 'crypttab', base / 'fstab')
        self.boot[0].write_text(f'# existing\nother /dev/other none luks\nbungee {self.image} {self.key} luks\n')
        self.boot[1].write_text(f'# existing\n/dev/other /other ext4 defaults 0 2\n/dev/mapper/bungee {self.root} ext4 defaults,nodev,nosuid,noexec 0 2\n')
        for path in self.boot: path.chmod(0o644)
        self.events = []
        def run(args, **kwargs):
            self.events.append([str(arg) for arg in args])
            return ''
        self.run = run
        for target, name, value in ((host, 'SYSTEMD', self.systemd), (host, 'BOOT_FILES', self.boot),
                                    (host.secure_storage, 'IMAGE', self.image), (host.secure_storage, 'KEY', self.key),
                                    (host, 'preflight', lambda root: None), (host, 'run', run)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        host.systemd(self.root)
        dropin = self.systemd / 'docker.service.d/bungee-storage.conf'
        dropin.parent.mkdir()
        dropin.write_text(f'[Unit]\nRequiresMountsFor={self.root}\nAfter=systemd-cryptsetup@bungee.service\n')
        (self.systemd / 'unrelated.service').write_text('keep')
        host.atomic(self.root / 'current.json', {'generation': 'a' * 24})
        self.events.clear()

    def test_default_preserves_data_and_unrelated_configuration(self):
        host.uninstall(self.root)
        self.assertTrue(self.image.exists())
        self.assertTrue(self.key.exists())
        self.assertTrue((self.key.parent / 'backup-identity').exists())
        self.assertEqual(self.boot[0].read_text(), '# existing\nother /dev/other none luks\n')
        self.assertEqual(self.boot[1].read_text(), '# existing\n/dev/other /other ext4 defaults 0 2\n')
        self.assertEqual(self.boot[0].stat().st_mode & 0o777, 0o644)
        self.assertTrue((self.systemd / 'unrelated.service').exists())
        self.assertFalse((self.systemd / 'bungee-update.timer').exists())
        down = next(i for i, row in enumerate(self.events) if 'down' in row)
        unmount = self.events.index(['umount', str(self.root)])
        close = self.events.index(['cryptsetup', 'close', 'bungee'])
        self.assertLess(down, unmount)
        self.assertLess(unmount, close)
        self.assertFalse(any('prune' in row or row[:2] == ['docker', 'rmi'] for row in self.events))

    def test_uninstall_accepts_repaired_boot_entries_and_keeps_other_mounts(self):
        for path,line in zip(self.boot,host.secure_storage.boot_entries(self.root)):
            path.write_text(path.read_text().replace(host.secure_storage.boot_entries(self.root,legacy=True)[self.boot.index(path)],line))
        host.uninstall(self.root)
        self.assertNotIn('bungee',self.boot[0].read_text())
        self.assertIn('/dev/other /other',self.boot[1].read_text())
        self.assertTrue(self.key.exists());self.assertTrue(self.image.exists())

    def test_purge_deletes_only_known_storage_after_detaching(self):
        extra = self.key.parent / 'unrelated'
        extra.write_text('keep')
        host.uninstall(self.root, purge=True)
        self.assertFalse(self.image.exists())
        self.assertFalse(self.key.exists())
        self.assertFalse((self.key.parent / 'backup-identity').exists())
        self.assertTrue(extra.exists())

    def test_changed_host_entry_refuses_before_mutation(self):
        self.boot[0].write_text('bungee /some/other/image /some/key luks\n')
        with self.assertRaises(ValueError): host.uninstall(self.root, purge=True)
        self.assertEqual(self.events, [])
        self.assertTrue(self.image.exists())

    def test_failed_unmount_keeps_keys_and_boot_configuration(self):
        before = [path.read_text() for path in self.boot]
        def fail(args, **kwargs):
            if args[0] == 'umount': raise subprocess.CalledProcessError(1, args)
            return self.run(args, **kwargs)
        with patch.object(host, 'run', fail), self.assertRaises(subprocess.CalledProcessError):
            host.uninstall(self.root, purge=True)
        self.assertTrue(self.image.exists())
        self.assertTrue(self.key.exists())
        self.assertEqual([path.read_text() for path in self.boot], before)
        self.assertNotIn(['cryptsetup', 'close', 'bungee'], self.events)

    def test_leftover_containers_prevent_detaching_storage(self):
        def remaining(args, **kwargs):
            if args[:2] == ['docker', 'ps']: return 'container-id'
            return self.run(args, **kwargs)
        with patch.object(host, 'run', remaining), self.assertRaises(ValueError): host.uninstall(self.root, True)
        self.assertTrue(self.key.exists())
        self.assertFalse(any(row[0] == 'umount' for row in self.events))

    def test_busy_updater_refuses_before_stopping_services(self):
        with (self.root / 'host.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): host.uninstall(self.root)
        self.assertEqual(self.events, [])
        self.assertTrue(self.key.exists())

    def test_symlinked_shared_configuration_is_never_followed(self):
        target = self.boot[0].with_name('other-file')
        self.boot[0].rename(target)
        self.boot[0].symlink_to(target)
        before = target.read_text()
        with self.assertRaises(ValueError): host.uninstall(self.root, True)
        self.assertEqual(target.read_text(), before)
        self.assertEqual(self.events, [])

    def test_failed_container_teardown_prevents_unmount_and_purge(self):
        def fail(args, **kwargs):
            if 'down' in args: raise subprocess.CalledProcessError(1, args)
            return self.run(args, **kwargs)
        with patch.object(host, 'run', fail), self.assertRaises(subprocess.CalledProcessError):
            host.uninstall(self.root, True)
        self.assertFalse(any(row[0] == 'umount' for row in self.events))
        self.assertTrue(self.image.exists())
        self.assertTrue(self.key.exists())

    def test_plan_runs_without_host_tools_and_does_not_write(self):
        root = Path(self.tmp.name) / 'absent'
        result = subprocess.run(['bash', str(host.HERE / 'uninstall.sh'), '--plan', '--purge', '--root', str(root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DELETE', json.loads(result.stdout)['storage'])
        self.assertFalse(root.exists())


if __name__ == '__main__':
    unittest.main()
