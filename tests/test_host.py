import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'scripts/bungee-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

CONFIG = {'wg_port': 49271, 'web_port': 8443, 'endpoint_ip': '203.0.113.12', 'web_host': '192.168.1.10', 'bind_ip': '192.168.1.10', 'admin_subnets': ['192.168.1.0/24'], 'auto_updates': True, 'channel': 'stable'}


def metadata():
    return {'format': 1, 'host_api': host.RELEASE['host_api'], 'data_contract': host.RELEASE['data_contract'], 'version': '0.1.1', 'published_at': int(time.time()), 'images': {s: f'{host.REGISTRY}-{s}@sha256:' + 'a' * 64 for s in ('server', 'gateway')}}


class FakeEngine:
    def __init__(self, root): self.root = root; self.events = []; self.old = None; self.fail = None; self.restores = 0
    def event(self, name):
        self.events.append(name)
        if self.fail == name: raise RuntimeError(name)
    def pull(self, images): self.event('pull')
    def storage_ready(self, gen): self.event('storage')
    def healthy(self, gen): self.event('healthy-old' if gen == self.old else 'healthy-new')
    def hold(self, closed, generation=None):
        host.atomic(self.root / 'control/status', 'closed' if closed else 'open')
        self.event('close' if closed else 'open')
    def no_restart(self, gen): self.event('disable-restart')
    def down(self, gen): self.event('down-old' if gen == self.old else 'down-new')
    def up(self, gen): self.event('up-old' if gen == self.old else 'up-new')
    def stop_helpers(self): self.event('stop-helpers')
    def archive(self, gen, directory, restore=False):
        self.event('restore' if restore else 'backup')
        if restore: self.restores += 1
        else:
            for name in host.VOLUMES: (directory / f'{name}.tar.age').write_bytes(b'coherent fixture')


class SetupTests(unittest.TestCase):
    def test_shared_release_version_survives_standalone_helper_install(self):
        manifest = json.loads((host.SOURCE / 'release.json').read_text())
        self.assertEqual(host.VERSION, manifest['version'])
        host.version(manifest['version'])
        self.assertGreater(manifest['android_version_code'], 0)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for source, target in [(host.HERE / 'bungee-host.py', 'bungee-host.py'), (host.module_path, 'network_config.py'), (host.release_path, 'release.json'), (host.HERE / 'secure_storage.py', 'secure_storage.py'), (host.HERE / 'tls_config.py', 'tls_config.py'), (host.HERE / 'regional_maps.py', 'regional_maps.py')]:
                (root / target).write_text(source.read_text())
            script = "import importlib.util,sys; s=importlib.util.spec_from_file_location('installed',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.VERSION)"
            result = subprocess.check_output(['python3', '-c', script, str(root / 'bungee-host.py')], text=True)
            self.assertEqual(result.strip(), host.VERSION)
    def test_bare_hosts_canonical_prefixes_ipv6_and_no_shell_input(self):
        self.assertEqual(host.network.admin_networks('192.168.1.15,192.168.1.99/24 fd12::4'), ['192.168.1.15/32', '192.168.1.0/24', 'fd12::4/128'])
        for value in ['', [], '0.0.0.0/0', '::/0', '128.0.0.0/1', '192.168.1', '::ffff:192.168.1.1', '192.168.1.1;id', 'fe80::1%eth0', '224.0.0.0/8', '10.0.0.0/8', '10.77.0.0/24', '10.77.0.2/32', '10.77.0.255']:
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)): host.network.admin_networks(value)
    def test_management_publication_cannot_bind_a_wildcard_or_phone_overlay(self):
        for bind in ['0.0.0.0', '::', '10.77.0.1', '10.77.0.254', '::ffff:10.77.0.1', 'fe80::1']:
            with self.subTest(bind=bind), self.assertRaises(ValueError): host.network.validate({**CONFIG, 'bind_ip': bind})
        for bind in ['127.0.0.1', '::1', '192.168.1.10', 'fd12::10']:
            with self.subTest(bind=bind): self.assertEqual(host.network.validate({**CONFIG, 'bind_ip': bind})['bind_ip'], bind)
    def test_invalid_ports_addresses_and_names_are_refused(self):
        for value in [0, 65536, '3.2', '-1', True, '$(id)']:
            with self.subTest(value=value), self.assertRaises(ValueError): host.network.port(value)
        with self.assertRaises(ValueError): host.network.port(51820, True)
        for value in ['evil { respond yes }', 'https://home:8443', '0.0.0.0', '192.168.1.999', '*.example', 'a..b', 'a.-b']:
            with self.subTest(value=value), self.assertRaises(ValueError): host.network.hostname(value)
        for value in ['0.0.0.0', '127.0.0.1', 'ff02::1', 'fe80::1%eth0']:
            with self.assertRaises(ValueError): host.network.address(value, endpoint=True)
    def test_exact_origin_and_no_privileged_socket_or_extra_published_apis(self):
        c = host.compose(CONFIG, metadata()['images'], Path('/opt/bungee'))
        self.assertEqual(c['services']['server']['environment']['BUNGEE_PUBLIC_ORIGIN'], 'https://192.168.1.10:8443')
        self.assertEqual(c['services']['server']['environment']['BUNGEE_ADMIN_BIND'], '0.0.0.0:8443')
        self.assertEqual(c['services']['server']['environment']['BUNGEE_ADMIN_INTERFACE'], 'eth0')
        self.assertIn('192.168.1.10:8443:8443/tcp', c['services']['gateway']['ports'])
        self.assertNotIn('web', c['services'])
        self.assertEqual(host.network.origin({**CONFIG, 'web_port': 443}), 'https://192.168.1.10')
        self.assertEqual(host.network.origin({**CONFIG, 'web_host': 'fd12::1'}), 'https://[fd12::1]:8443')
        for s in c['services'].values():
            self.assertEqual(s['cap_drop'], ['ALL']); self.assertTrue(s['read_only'])
            self.assertEqual(s['environment']['HTTP_PROXY'], '')
            self.assertEqual(s['environment']['http_proxy'], '')
            self.assertEqual(s['environment']['NO_PROXY'], '*')
        self.assertNotIn('docker.sock', json.dumps(c))
        self.assertNotIn('storage.key', json.dumps(c))
        self.assertNotIn('backup-identity', json.dumps(c))
        tls = c['services']['server']['volumes'][2]
        self.assertTrue(tls['read_only'])
        self.assertTrue(tls['source'].endswith('/tls-data/issued'))
        self.assertFalse(tls['bind']['create_host_path'])
        self.assertNotIn('ports', c['services']['server'])
    def test_plan_needs_no_docker_root_or_external_services_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'untouched'
            config = Path(directory) / 'input.json'; config.write_text(json.dumps(CONFIG))
            result = subprocess.run(['python3', str(host.HERE / 'bungee-host.py'), 'install', '--plan', '--config', str(config), '--root', str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('192.168.1.0/24', result.stdout); self.assertFalse(root.exists())
    def test_release_downgrade_replay_wrong_repo_mutable_tags_and_breaking_contract_refused(self):
        current = {**metadata(), 'version': '0.1.0', 'published_at': 1}
        self.assertEqual(host.release(metadata(), 'stable', current)['version'], '0.1.1')
        bad = [dict(metadata(), version='0.1.1-alpha.1'), dict(metadata(), version='0.2.0'), dict(metadata(), version='0.0.9'), dict(metadata(), published_at=1), dict(metadata(), host_api=999), dict(metadata(), data_contract=999)]
        for images in [{'server': 'evil.example/server:latest', 'gateway': 'x'}, {**metadata()['images'], 'server': host.REGISTRY + '-server:latest'}]: bad.append(dict(metadata(), images=images))
        for data in bad:
            with self.subTest(data=data), self.assertRaises(ValueError): host.release(data, 'stable', current)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tls_patch = patch.object(host.Host, 'renew_tls'); self.tls_patch.start(); self.addCleanup(self.tls_patch.stop)
        self.engine = FakeEngine(self.root); self.host = host.Host(self.root, self.engine)
        self.old = self.host.stage(CONFIG, {**metadata(), 'version': '0.1.0', 'published_at': 1})
        self.engine.old = self.old
        host.atomic(self.root / 'current.json', {'generation': self.old})
        host.atomic(self.root / 'control/status', 'open')
    def test_local_rebuild_preserves_configuration_and_refreshes_helper_after_acceptance(self):
        images = {service: 'sha256:' + 'b' * 64 for service in ('server', 'gateway')}
        with patch.object(host, 'build_images', return_value=images), patch.object(host, 'install_helpers') as helper:
            host.rebuild(self.host)
        self.assertNotEqual(self.host.current(), self.old)
        self.assertEqual(self.host.metadata(self.host.current())['images'], images)
        self.assertEqual(host.read(self.root / 'generations' / self.host.current() / 'config.json'), CONFIG)
        self.assertIn('backup', self.engine.events)
        self.assertEqual(self.engine.events[-1], 'open')
        helper.assert_called_once_with(self.root)
    def test_failed_local_rebuild_rolls_back_without_replacing_installed_helper(self):
        self.engine.fail = 'healthy-new'
        with patch.object(host, 'build_images', return_value=metadata()['images']), patch.object(host, 'install_helpers') as helper:
            with self.assertRaises(RuntimeError): host.rebuild(self.host)
        self.assertEqual(self.host.current(), self.old)
        self.assertIn('restore', self.engine.events)
        helper.assert_not_called()
    def test_download_failure_causes_no_downtime_or_backup(self):
        self.engine.fail = 'pull'
        with self.assertRaises(RuntimeError): self.host.apply(CONFIG, metadata())
        self.assertEqual(self.engine.events, ['healthy-old', 'storage', 'pull'])
        self.assertEqual((self.root / 'control/status').read_text(), 'open')
        self.assertFalse((self.root / 'transaction.json').exists())
    def test_disabled_automatic_checks_make_no_provider_request(self):
        host.atomic(self.root / 'generations' / self.old / 'config.json', {**CONFIG, 'auto_updates': False})
        self.host.update()
        self.assertEqual(self.engine.events, [])
    def test_explicit_manual_check_can_update_metadata_without_restart_for_identical_images(self):
        host.atomic(self.root / 'generations' / self.old / 'config.json', {**CONFIG, 'auto_updates': False})
        self.engine.bundle = lambda channel: (metadata(), 'synthetic-bundle')
        self.host.update(manual=True)
        self.assertEqual(self.engine.events, [])
        self.assertEqual(self.host.metadata(self.old)['bundle'], 'synthetic-bundle')
    def test_a_previously_failed_bundle_is_not_retried(self):
        host.atomic(self.root / 'failed.json', {'bundle': 'failed-bundle'})
        self.engine.bundle = lambda channel: (metadata(), 'failed-bundle')
        with self.assertRaises(ValueError): self.host.update()
        self.assertEqual(self.engine.events, [])
    def test_insufficient_storage_keeps_old_stack_and_avoids_downloads(self):
        self.engine.fail = 'storage'
        with self.assertRaises(RuntimeError): self.host.apply(CONFIG, metadata())
        self.assertEqual(self.engine.events, ['healthy-old', 'storage'])
        self.assertFalse((self.root / 'transaction.json').exists())
        self.assertEqual((self.root / 'control/status').read_text(), 'open')
    def test_success_admits_only_after_health_and_a_complete_cold_snapshot(self):
        self.host.apply(CONFIG, metadata())
        self.assertNotEqual(self.host.current(), self.old)
        e = self.engine.events
        self.assertLess(e.index('pull'), e.index('close'))
        self.assertLess(e.index('down-old'), e.index('backup'))
        self.assertLess(e.index('backup'), e.index('up-new'))
        self.assertLess(e.index('healthy-new'), e.index('open'))
        self.assertEqual(self.engine.restores, 0)
        self.assertFalse((self.root / 'transaction.json').exists())
    def test_failed_candidate_restores_before_old_start_and_external_admission(self):
        self.engine.fail = 'healthy-new'
        with self.assertRaises(RuntimeError): self.host.apply(CONFIG, metadata(), 'failed-bundle')
        self.assertEqual(self.host.current(), self.old)
        self.assertEqual(self.engine.restores, 1)
        e = self.engine.events
        self.assertLess(e.index('restore'), e.index('up-old')); self.assertLess(e.index('up-old'), e.index('open'))
        self.assertEqual(host.read(self.root / 'failed.json')['bundle'], 'failed-bundle')
    def test_failed_snapshot_restarts_original_data_without_restoring_incomplete_backup(self):
        self.engine.fail = 'backup'
        with self.assertRaises(RuntimeError): self.host.apply(CONFIG, metadata())
        self.assertEqual(self.host.current(), self.old); self.assertEqual(self.engine.restores, 0)
        self.assertEqual(self.engine.events[-2:], ['healthy-old', 'open'])
    def test_interrupted_trial_rolls_back_but_accepted_trial_never_discards_later_data(self):
        for phase in ['candidate', 'accepted']:
            with self.subTest(phase=phase):
                new = self.host.stage(CONFIG, metadata()); self.host.backup(self.old, self.root / 'backups' / new)
                self.host.journal({'old': self.old, 'new': new, 'phase': phase, 'backup': new})
                before = self.engine.restores; self.host.recover()
                self.assertEqual(self.host.current(), new if phase == 'accepted' else self.old)
                self.assertEqual(self.engine.restores - before, 0 if phase == 'accepted' else 1)
    def test_corrupt_backup_leaves_admission_closed_and_does_not_overwrite_live_state(self):
        new = self.host.stage(CONFIG, metadata()); self.host.backup(self.old, self.root / 'backups' / new)
        (self.root / 'backups' / new / 'server-data.tar.age').write_bytes(b'corrupt')
        self.host.journal({'old': self.old, 'new': new, 'phase': 'candidate', 'backup': new})
        with self.assertRaises(ValueError): self.host.recover()
        self.assertEqual((self.root / 'control/status').read_text(), 'closed')
        self.assertEqual(self.engine.restores, 0); self.assertTrue((self.root / 'transaction.json').exists())
    def test_restore_failure_keeps_journal_and_maintenance_for_local_repair(self):
        new = self.host.stage(CONFIG, metadata()); self.host.backup(self.old, self.root / 'backups' / new)
        self.host.journal({'old': self.old, 'new': new, 'phase': 'candidate', 'backup': new})
        self.engine.fail = 'restore'
        with self.assertRaises(RuntimeError): self.host.recover()
        self.assertNotIn('open', self.engine.events)
        self.assertTrue((self.root / 'transaction.json').exists())
    def test_interruption_after_rollback_opens_cannot_replay_snapshot_over_later_data(self):
        new = self.host.stage(CONFIG, metadata()); self.host.backup(self.old, self.root / 'backups' / new)
        self.host.journal({'old': self.old, 'new': new, 'phase': 'candidate', 'backup': new})
        original = Path.unlink
        def interrupted(path, *args, **kwargs):
            if path.name == 'transaction.json': raise OSError('power-loss fixture after admission')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'unlink', interrupted), self.assertRaises(OSError): self.host.recover()
        tx = host.read(self.root / 'transaction.json')
        self.assertEqual(tx['phase'], 'accepted'); self.assertEqual(tx['new'], self.old)
        self.assertEqual(self.engine.restores, 1)
        self.host.recover()
        self.assertEqual(self.engine.restores, 1, 'A recovery after admission must preserve later observations')


if __name__ == '__main__': unittest.main()

class DatasetTests(unittest.TestCase):
    setUp = TransactionTests.setUp
    def test_dataset_import_is_validated_before_downtime_and_pins_read_only_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'City.mmdb'; data.write_bytes(b'fixture-public-data')
            self.engine.check_geodata = lambda path, gen: json.dumps({'maps': {'name': 'Bundled world overview'}, 'geoip': {'database_type': 'fixture'}})
            previous = os.umask(0o077)
            try: self.host.datasets(geoip=data)
            finally: os.umask(previous)
            config = host.read(self.root / 'generations' / self.host.current() / 'config.json')
            dataset = self.root / 'datasets' / config['geodata']
            self.assertEqual((dataset / 'geoip.mmdb').read_bytes(), data.read_bytes())
            self.assertEqual(dataset.stat().st_mode & 0o777, 0o755)
            service = host.read(self.root / 'generations' / self.host.current() / 'compose.json')['services']['server']
            self.assertTrue(service['volumes'][-1]['read_only'])
            self.assertEqual(service['volumes'][-1]['source'], str(dataset))
    def test_invalid_dataset_causes_no_downtime_or_current_pointer_change(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'invalid.mmdb'; data.write_bytes(b'bad')
            self.engine.check_geodata = lambda path, gen: '{}'
            with self.assertRaises(ValueError): self.host.datasets(geoip=data)
            self.assertEqual(self.host.current(), self.old)
            self.assertNotIn('close', self.engine.events)
            self.assertEqual([p.name for p in (self.root / 'datasets').iterdir()], ['empty'])
    def test_failed_dataset_trial_keeps_old_dataset_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'City.mmdb'; data.write_bytes(b'fixture')
            self.engine.check_geodata = lambda path, gen: json.dumps({'maps': {'name': 'Bundled world overview'}, 'geoip': {'database_type': 'fixture'}})
            self.engine.fail = 'healthy-new'
            with self.assertRaises(RuntimeError): self.host.datasets(geoip=data)
            self.assertEqual(self.host.current(), self.old)
            config = host.read(self.root / 'generations' / self.old / 'compose.json')
            self.assertTrue(config['services']['server']['volumes'][-1]['source'].endswith('/empty'))
