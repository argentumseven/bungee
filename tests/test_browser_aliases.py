"""Explicit multi-host Bungee dashboard config and certificate regression tests."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


network = load('bungee_network_aliases', 'deploy/network_config.py')
tls = load('bungee_tls_aliases', 'scripts/tls_config.py')


class BrowserAliases(unittest.TestCase):
    def config(self):
        return {
            'wg_port': 49271, 'web_port': 8443,
            'endpoint_ip': '203.0.113.12', 'web_host': '10.10.201.27',
            'bind_ip': '10.10.201.27', 'admin_subnets': ['10.10.10.0/24'],
            'auto_updates': False, 'channel': 'stable',
        }

    def test_old_ip_only_configuration_is_still_valid(self):
        old = network.validate(self.config())
        self.assertEqual(old['web_aliases'], [])
        self.assertEqual(network.origins(old), ['https://10.10.201.27:8443'])

    def test_explicit_alias_keeps_canonical_ip_and_source_acl(self):
        config = self.config()
        config['web_aliases'] = ['BUNGEE.Example.ORG']
        configured = network.validate(config)
        self.assertEqual(configured['web_aliases'], ['bungee.example.org'])
        self.assertEqual(configured['admin_subnets'], ['10.10.10.0/24'])
        self.assertEqual(configured['bind_ip'], '10.10.201.27')
        self.assertEqual(network.origins(configured),
                         ['https://10.10.201.27:8443',
                          'https://bungee.example.org:8443'])

    def test_rejects_unbounded_invalid_or_duplicate_aliases(self):
        for value in [
            ['10.10.201.27'], ['x.example', 'x.example'],
            ['bad.example/path'], ['*.example.org'],
            ['bad.example\\nsubjectAltName=DNS:other.example'],
            ['one.test', 'two.test', 'three.test', 'four.test', 'five.test'],
        ]:
            with self.subTest(value=value):
                config = self.config()
                config['web_aliases'] = value
                with self.assertRaises(ValueError):
                    network.validate(config)

    def test_certificate_covers_both_names_without_rotating_ca(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            self.assertTrue(tls.ensure(base, '10.10.201.27'))
            root = (base / 'root.crt').read_bytes()
            self.assertTrue(tls.ensure(base, '10.10.201.27', ['bungee.example.org']))
            self.assertEqual(root, (base / 'root.crt').read_bytes())
            leaf = base / 'issued/current/server.crt'
            output = subprocess.check_output(
                ['openssl', 'x509', '-noout', '-ext', 'subjectAltName',
                 '-in', str(leaf)], text=True)
            self.assertIn('IP Address:10.10.201.27', output)
            self.assertIn('DNS:bungee.example.org', output)
            self.assertFalse(tls.ensure(base, '10.10.201.27', ['bungee.example.org']))
            with self.assertRaises(ValueError):
                tls.ensure(base, '10.10.201.27', ['evil.example\\nDNS:other.example'])
            self.assertEqual(root, (base / 'root.crt').read_bytes())


if __name__ == '__main__':
    unittest.main()
