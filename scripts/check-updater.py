#!/usr/bin/env python3
"""Exercise actual Compose, maintenance firewall, cold snapshots and rollback in isolation.

Only kernel WireGuard interface creation is replaced: this cloud cannot create one.
The production admission code, real Rust/Caddy images and five real volumes are used.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location('host', Path(__file__).with_name('bungee-host.py'))
host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
PROJECT = 'bungee-test-' + secrets.token_hex(6)
assert PROJECT.startswith('bungee-test-') and PROJECT != 'bungee'
CONFIG = {'wg_port': 49271, 'web_port': 8443, 'endpoint_ip': '203.0.113.12', 'web_host': '127.0.0.1', 'bind_ip': '127.0.0.1', 'admin_subnets': ['172.16.0.0/12', '192.168.0.0/16', '127.0.0.1'], 'auto_updates': False, 'channel': 'stable'}


class Engine(host.Engine):
    def archive(self, generation, directory, restore=False):
        super().archive(generation, directory, restore)
        if not restore:
            # Production runs as root; make only this fixture's archives readable to its test UID.
            host.run(['docker', 'run', '--rm', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--entrypoint', 'sh', '--mount', f'type=bind,src={directory},dst=/backup', 'bungee-server:dev', '-ec', f'chown {os.getuid()}:{os.getgid()} /backup/*.tar'])


class Fixture(host.Host):
    trial = False
    def stage(self, config, metadata):
        generation = super().stage(config, metadata)
        path = self.root / 'generations' / generation / 'compose.json'
        value = host.read(path)
        gateway = value['services']['gateway']; gateway['ports'] = []
        # Retain the actual prefix validation, firewall, keys and admission function.
        prefix = (host.SOURCE / 'deploy/wireguard/entrypoint.sh').read_text().split('ip link add wg0')[0]
        gateway['entrypoint'] = ['sh', '-ec', prefix.replace('$', '$$') + "\ntrap 'exit 0' INT TERM\nwhile :; do refresh_admission; sleep 1 & wait $$!; done"]
        gateway['healthcheck'] = {'test': ['CMD', 'cat', '/run/bungee-admission'], 'interval': '1s', 'timeout': '1s', 'retries': 3}
        server = value['services']['server']
        server['environment']['BUNGEE_DEVICE_BIND'] = '127.0.0.1:8081'
        server['healthcheck'] = {'test': ['CMD', 'curl', '--fail', '--silent', 'http://127.0.0.1:8080/healthz'], 'interval': '1s', 'timeout': '1s', 'retries': 3, 'start_period': '1s'}
        value['services']['web']['healthcheck'].update(interval='1s', timeout='1s')
        if self.trial:
            server['entrypoint'] = ['sh', '-ec', 'echo synthetic-trial > /state/trial-marker; exec /usr/local/bin/bungee-server']
            server['healthcheck']['test'] = ['CMD', 'false']
        host.atomic(path, value)
        return generation


def db(command):
    return host.run(['docker', 'run', '--rm', '--network', 'none', '--user', '10001:10001', '--mount', f'type=volume,src={PROJECT}_server-data,dst=/state', '--entrypoint', 'python3', 'bungee-gateway:dev', '-c', command])


with tempfile.TemporaryDirectory(prefix='bungee-updater-') as directory:
    root = Path(directory)
    engine = Engine(root, project=PROJECT, wait_timeout=25)
    fixture = Fixture(root, engine)
    images = {s: json.loads(host.run(['docker', 'image', 'inspect', f'bungee-{s}:dev']))[0]['Id'] for s in ('server', 'gateway', 'web')}
    metadata = {'format': 1, 'host_api': 1, 'data_contract': 1, 'version': '0.1.0', 'published_at': 1, 'images': images}
    current = fixture.stage(CONFIG, metadata)
    host.atomic(root / 'current.json', {'generation': current})
    host.atomic(root / 'control/status', 'closed\n')
    try:
        engine.up(current); engine.healthy(current)
        engine.hold(False)
        for _ in range(20):
            if engine.compose(current, 'exec', '-T', 'gateway', 'cat', '/run/bungee-admission') == 'open': break
            time.sleep(.25)
        else: raise AssertionError('Admission did not open')
        target = json.loads(host.run(['docker', 'inspect', engine.compose(current, 'ps', '--quiet', 'gateway')]))[0]['NetworkSettings']['Networks'][f'{PROJECT}_default']['IPAddress']
        def reachable():
            return host.run(['docker', 'run', '--rm', '--network', f'{PROJECT}_default', '-e', f'TARGET={target}', 'node:24-bookworm-slim', 'node', '-e', "const s=require('net').connect(443,process.env.TARGET);s.on('connect',()=>{console.log('open');s.end()});s.on('error',()=>{console.log('closed')});s.setTimeout(1500,()=>{console.log('closed');s.destroy()})"])
        assert reachable() == 'open'
        engine.hold(True, current)
        assert reachable() == 'closed', 'Real maintenance firewall must deny a previously allowed client'
        engine.hold(False)
        db("import sqlite3; c=sqlite3.connect('/state/bungee.sqlite3'); c.execute('CREATE TABLE updater_fixture(value TEXT)'); c.execute(\"INSERT INTO updater_fixture VALUES ('synthetic retained history')\"); c.commit()")
        key_before = engine.compose(current, 'exec', '-T', 'gateway', 'sh', '-c', 'sha256sum /private/server-key')
        ca_before = engine.compose(current, 'exec', '-T', 'web', 'cat', '/data/caddy/pki/authorities/local/root.crt')
        fixture.trial = True
        try: fixture.apply(CONFIG, {**metadata, 'version': '0.1.1'})
        except subprocess.CalledProcessError: pass
        else: raise AssertionError('Deliberately unhealthy candidate was accepted')
        assert fixture.current() == current
        engine.healthy(current)
        assert db("import sqlite3; c=sqlite3.connect('file:/state/bungee.sqlite3?mode=ro', uri=True); print(c.execute('SELECT value FROM updater_fixture').fetchone()[0])") == 'synthetic retained history'
        assert engine.compose(current, 'exec', '-T', 'gateway', 'sh', '-c', 'sha256sum /private/server-key') == key_before
        assert engine.compose(current, 'exec', '-T', 'web', 'cat', '/data/caddy/pki/authorities/local/root.crt') == ca_before
        assert engine.compose(current, 'exec', '-T', 'server', 'sh', '-c', 'test ! -e /state/trial-marker && echo restored') == 'restored'
        assert (root / 'control/status').read_text().strip() == 'open'
        assert not (root / 'transaction.json').exists()
        fixture.trial = False
        fixture.apply(CONFIG, {**metadata, 'version': '0.1.1'})
        assert fixture.current() != current
        engine.healthy(fixture.current())
        print('PASS: real Compose/three services; maintenance blocks actual TCP; unhealthy trial restores SQLite data, WireGuard identity and CA from five cold volumes; healthy update commits. Kernel WireGuard creation is not tested.')
    except Exception:
        print(engine.compose(fixture.current(), 'logs', '--tail', '30'), flush=True)
        raise
    finally:
        engine.stop_helpers()
        engine.compose(fixture.current(), 'down', '--volumes', '--timeout', '10')
