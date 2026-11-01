import importlib.util
import os
import json
import signal
import time
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import secure_storage
import tls_config
spec=importlib.util.spec_from_file_location('storage_host',Path(__file__).resolve().parents[1]/'scripts/bungee-host.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)

class StorageTests(unittest.TestCase):
    def test_wrong_mount_or_unencrypted_mapping_fails_closed(self):
        root=Path('/opt/bungee')
        for record in [[],[{'target':'/','fstype':'ext4','source':'/dev/sda1'}],[{'target':str(root),'fstype':'ext4','source':'/dev/sda1'}]]:
            import json
            with patch.object(secure_storage,'run',return_value=json.dumps({'filesystems':record})),self.assertRaises(ValueError): secure_storage.check(root)
    def test_luks_mapping_type_is_required_even_when_mount_path_matches(self):
        root=Path('/opt/bungee')
        output=json.dumps({'filesystems':[{'target':str(root),'fstype':'ext4','source':'/dev/mapper/bungee'}]})
        with patch.object(secure_storage,'run',side_effect=[output,'type: PLAIN']), self.assertRaises(ValueError):secure_storage.check(root)
    def test_key_permissions_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'key';path.write_bytes(b'synthetic')
            path.chmod(0o644)
            with self.assertRaises(ValueError):secure_storage.private(path)
            link=Path(directory)/'alias';link.symlink_to(path)
            with self.assertRaises(ValueError):secure_storage.private(link)
    def helper_dies_with_parent(self, guard):
        code="""import os,sys,subprocess,time
sys.path.insert(0,'scripts')
import importlib.util
s=importlib.util.spec_from_file_location('h','scripts/bungee-host.py');h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
import regional_maps
p=subprocess.Popen(['sleep','60'],preexec_fn=GUARD)
print(p.pid,flush=True)
time.sleep(60)
""".replace("GUARD",guard)
        parent=subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.PIPE,text=True)
        child=int(parent.stdout.readline())
        try:
            parent.kill();parent.wait(timeout=5)
            for _ in range(100):
                stat=Path(f'/proc/{child}/stat')
                if not stat.exists() or stat.read_text().split()[2]=='Z':break
                time.sleep(.01)
            else:self.fail('Child helper survived its parent')
        finally:
            parent.stdout.close()
            try:os.kill(child,signal.SIGKILL)
            except ProcessLookupError:pass
    def test_archive_helper_dies_with_its_updater(self):
        self.helper_dies_with_parent('h.child_guard(os.getpid())')
    def test_map_extractor_dies_with_its_downloader(self):
        self.helper_dies_with_parent('regional_maps._child_limits(1024)')
    def test_resolver_configuration_accepts_selected_public_or_lan_and_rejects_loops(self):
        for ip in ['1.1.1.1','8.8.8.8','192.168.1.53','fd00::53','2606:4700:4700::1111']:
            self.assertEqual(host.network.dns_upstream(ip),ip)
        for ip in ['10.77.0.1','127.0.0.11','169.254.169.254','0.0.0.0','::','ff02::1','::ffff:1.1.1.1','1.1.1.1;id']:
            with self.assertRaises(ValueError): host.network.dns_upstream(ip)
    def test_ca_persists_and_changed_hostname_renews_leaf(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'tls'
            self.assertTrue(tls_config.ensure(path,'127.0.0.1'))
            root=(path/'root.crt').read_bytes()
            first=(path/'issued/current/server.crt').read_bytes()
            self.assertFalse(tls_config.ensure(path,'127.0.0.1'))
            self.assertTrue(tls_config.ensure(path,'home.example'))
            self.assertEqual((path/'root.crt').read_bytes(),root)
            self.assertNotEqual((path/'issued/current/server.crt').read_bytes(),first)
            self.assertFalse((path/'issued/root.key').exists())
            subprocess.run(['openssl','verify','-CAfile',str(path/'root.crt'),str(path/'issued/current/server.crt')],check=True,stdout=subprocess.DEVNULL)

@unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'),'age host tools required')
class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.engine=host.Engine(self.root)
        self.engine.volumes=lambda: None # No kernel mount capability in this test host.
        self.key=self.root/'identity'
        subprocess.run(['age-keygen','-o',str(self.key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.engine.backup_key=lambda:self.key
        self.backup=self.root/'backup';self.backup.mkdir()
        for name in host.VOLUMES:
            data=self.root/'volumes'/name;data.mkdir(parents=True)
            (data/'secret').write_text('sensitive-'+name)
    def test_streamed_archive_is_encrypted_and_restores_all_identities(self):
        self.engine.archive('fixture',self.backup)
        for name in host.VOLUMES:
            archive=self.backup/(name+'.tar.age')
            self.assertNotIn(('sensitive-'+name).encode(),archive.read_bytes())
            self.assertEqual(archive.read_bytes()[:22],b'age-encryption.org/v1\n')
            (self.root/'volumes'/name/'secret').write_text('changed')
        self.engine.archive('fixture',self.backup,restore=True)
        for name in host.VOLUMES:self.assertEqual((self.root/'volumes'/name/'secret').read_text(),'sensitive-'+name)
        self.assertFalse(list(self.root.rglob('*.tar')))
    def test_corruption_or_wrong_key_cannot_partially_replace_current_data(self):
        self.engine.archive('fixture',self.backup)
        path=self.backup/(host.VOLUMES[-1]+'.tar.age')
        value=bytearray(path.read_bytes());value[-1]^=1;path.write_bytes(value)
        with self.assertRaises(subprocess.CalledProcessError):self.engine.archive('fixture',self.backup,restore=True)
        for name in host.VOLUMES:self.assertEqual((self.root/'volumes'/name/'secret').read_text(),'sensitive-'+name)
        self.key.unlink();subprocess.run(['age-keygen','-o',str(self.key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        with self.assertRaises(subprocess.CalledProcessError):self.engine.archive('fixture',self.backup,restore=True)
