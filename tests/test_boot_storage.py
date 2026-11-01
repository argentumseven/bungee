"""Storage boot repair must remain useful when the encrypted mount and Docker are down."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import secure_storage as storage


class BootStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.base=Path(self.temporary.name);self.root=self.base/'unmounted'
        self.boot=(self.base/'crypttab',self.base/'fstab');self.systemd=self.base/'systemd'
        self.vendor=self.base/'vendor';self.image=self.base/'storage.luks';self.key=self.base/'storage.key'
        for path in (self.image,self.key):path.write_bytes(b'original data');path.chmod(0o600)
        for module,name,value in [(storage,'BOOT_FILES',self.boot),(storage,'SYSTEMD',self.systemd),(storage,'IMAGE',self.image),(storage,'KEY',self.key),(storage,'SYSTEMD_VENDOR_ROOTS',(self.vendor,))]:
            p=patch.object(module,name,value);p.start();self.addCleanup(p.stop)
        self.components=('system/cryptsetup.target','system-generators/systemd-cryptsetup-generator','systemd-cryptsetup')
        for relative in self.components:
            path=self.vendor/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('test component');path.chmod(0o755)
        for path,entry in zip(self.boot,storage.boot_entries(self.root,legacy=True)):
            path.write_text('# keep comment\nother /other none defaults\n'+entry+'\n');path.chmod(0o640)
        self.dropin=self.systemd/'docker.service.d/bungee-storage.conf'
        self.dropin.parent.mkdir(parents=True);self.dropin.write_text(storage.storage_dropin(self.root))

    def test_debian_installs_a_target_and_generator_instead_of_a_service_template(self):
        self.assertFalse((self.vendor/'system/systemd-cryptsetup@.service').exists())
        storage.require_boot_support()

    def test_missing_unlock_components_are_detected_before_storage_allocation(self):
        for relative in self.components:
            path=self.vendor/relative;content=path.read_bytes();path.unlink()
            with patch.object(storage,'run') as run:
                with self.assertRaisesRegex(ValueError,'systemd-cryptsetup'):storage.provision(self.root)
                run.assert_not_called()
            self.assertEqual(self.key.read_bytes(),b'original data');self.assertFalse(self.root.exists())
            path.write_bytes(content);path.chmod(0o755)

    def test_repair_works_unmounted_keeps_keys_data_permissions_and_docker_requirement(self):
        with patch.object(storage,'private') as private,patch.object(storage,'run') as run:
            storage.repair_boot(self.root)
            self.assertEqual([c.args[0] for c in private.call_args_list],[self.image,self.key])
            run.assert_called_once_with(['systemctl','daemon-reload'])
        self.assertFalse(self.root.exists())
        for path,entry in zip(self.boot,storage.boot_entries(self.root)):
            self.assertIn(entry,path.read_text());self.assertIn('# keep comment\nother /other none defaults\n',path.read_text())
            self.assertEqual(path.stat().st_mode&0o777,0o640)
        self.assertIn('nofail',self.boot[0].read_text());self.assertIn('x-systemd.device-timeout=30s',self.boot[1].read_text())
        self.assertIn(f'RequiresMountsFor={self.root}',self.dropin.read_text())
        for path in (self.key,self.image):self.assertEqual(path.read_bytes(),b'original data')
        before=[p.stat().st_mtime_ns for p in (*self.boot,self.dropin)]
        with patch.object(storage,'private'),patch.object(storage,'run'):storage.repair_boot(self.root)
        self.assertEqual(before,[p.stat().st_mtime_ns for p in (*self.boot,self.dropin)])

    def test_foreign_or_duplicate_entries_refuse_before_any_write(self):
        for path in self.boot:
            original=path.read_text()
            for changed in [original.replace(str(self.image),'/foreign/image') if path==self.boot[0] else original.replace('ext4','xfs'),original+original]:
                path.write_text(changed);before=[p.read_bytes() for p in (*self.boot,self.dropin)]
                with patch.object(storage,'private'),patch.object(storage,'run') as run:
                    with self.assertRaises(ValueError):storage.repair_boot(self.root)
                    run.assert_not_called()
                self.assertEqual(before,[p.read_bytes() for p in (*self.boot,self.dropin)])
            path.write_text(original)

    def test_changed_docker_dependency_and_symlinks_refuse_before_boot_edits(self):
        for bad in ('[Unit]\nAfter=docker.service\n',None):
            self.dropin.unlink()
            if bad is None:self.dropin.symlink_to(self.key)
            else:self.dropin.write_text(bad)
            before=[p.read_bytes() for p in self.boot]
            with patch.object(storage,'private'),patch.object(storage,'run') as run:
                with self.assertRaises(ValueError):storage.repair_boot(self.root)
                run.assert_not_called()
            self.assertEqual(before,[p.read_bytes() for p in self.boot])

    def test_initial_entries_also_boot_without_requiring_the_optional_mount(self):
        for path in self.boot:path.write_text('# existing\n')
        storage.write_boot(storage.boot_edits(self.root,create=True))
        for path,entry in zip(self.boot,storage.boot_entries(self.root)):self.assertEqual(path.read_text(),'# existing\n'+entry+'\n')


class SystemdGeneratorTests(unittest.TestCase):
    def test_real_cryptsetup_generator_creates_an_optional_unlock_unit(self):
        vendors=[Path(os.environ['BUNGEE_TEST_SYSTEMD_DIR'])] if os.environ.get('BUNGEE_TEST_SYSTEMD_DIR') else list(storage.SYSTEMD_VENDOR_ROOTS)
        generator=next((base/'system-generators/systemd-cryptsetup-generator' for base in vendors if (base/'system-generators/systemd-cryptsetup-generator').is_file()),None)
        if generator is None:self.skipTest('systemd cryptsetup generator unavailable in this development environment')
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary);image=base/'storage.luks';key=base/'storage.key'
            image.write_bytes(b'generator-only fixture');key.write_bytes(b'generator-only fixture')
            crypttab=base/'crypttab';crypttab.write_text(f'bungee {image} {key} luks,nofail\n')
            for name in ('normal','early','late'):(base/name).mkdir()
            result=subprocess.run([str(generator),*[str(base/name) for name in ('normal','early','late')]],env={**os.environ,'SYSTEMD_CRYPTTAB':str(crypttab)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            unit=base/'normal/systemd-cryptsetup@bungee.service'
            self.assertTrue(unit.is_file(),result.stderr)
            self.assertIn(f'RequiresMountsFor={image}',unit.read_text())
            self.assertTrue((base/'normal/cryptsetup.target.wants/systemd-cryptsetup@bungee.service').is_symlink())
            self.assertFalse((base/'normal/cryptsetup.target.requires/systemd-cryptsetup@bungee.service').exists())

    @unittest.skipUnless(Path('/usr/lib/systemd/system-generators/systemd-fstab-generator').is_file(),'systemd fstab generator unavailable')
    def test_generated_mount_is_wanted_rather_than_required_by_host_boot(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary);fstab=base/'fstab';fstab.write_text(storage.boot_entries(Path('/opt/bungee'))[1]+'\n')
            for name in ('normal','early','late'):(base/name).mkdir()
            result=subprocess.run(['/usr/lib/systemd/system-generators/systemd-fstab-generator',*[str(base/name) for name in ('normal','early','late')]],env={**os.environ,'SYSTEMD_FSTAB':str(fstab)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            unit=base/'normal/opt-bungee.mount'
            if not unit.exists() and os.statvfs('/sys').f_flag & os.ST_RDONLY:self.skipTest('generator skips block-device mounts with read-only /sys in this container; runs on CI host')
            self.assertTrue(unit.exists(),result.stderr)
            self.assertTrue((base/'normal/local-fs.target.wants/opt-bungee.mount').is_symlink())
            self.assertFalse((base/'normal/local-fs.target.requires/opt-bungee.mount').exists())
            self.assertNotIn('Before=local-fs.target',unit.read_text())
            self.assertIn('What=/dev/mapper/bungee',unit.read_text())
            dropins=list((base/'normal/dev-mapper-bungee.device.d').glob('*.conf'))
            self.assertIn('JobRunningTimeoutSec=30s','\n'.join(p.read_text() for p in dropins))
