#!/usr/bin/env python3
"""Local Linux installer and transactional Compose updater. Never runs inside the app."""
import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import gzip
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
import termios

# GNU readline handles both common terminal erase codes and cursor editing.
try:
    import readline
except ImportError:
    readline = None

# Sibling modules are copied with this helper during installation.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import secure_storage
import tls_config
import regional_maps
import map_manager

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent
module_path = HERE / 'network_config.py' if (HERE / 'network_config.py').exists() else SOURCE / 'deploy/network_config.py'
spec = importlib.util.spec_from_file_location('network_config', module_path)
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)
REGISTRY = 'ghcr.io/argentumseven/bungee'
release_path = HERE / 'release.json' if (HERE / 'release.json').exists() else SOURCE / 'release.json'
RELEASE = json.loads(release_path.read_text())
VERSION = RELEASE['version']
PRIVATE_ENV = {**{name: '' for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')}, 'NO_PROXY': '*', 'no_proxy': '*'}
VOLUMES = ('server-data', 'gateway-private', 'gateway-peers', 'tls-data')


def run(args, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=True, timeout=kwargs.pop('timeout', 900), **kwargs).strip()


def child_guard(parent):
    # Host archive helpers must not outlive a killed updater and race recovery.
    def guard():
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            os._exit(125)
        if os.getppid() != parent: os._exit(125)
    return guard


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + secrets.token_hex(6))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(data if isinstance(data, str) else json.dumps(data, indent=2) + '\n')
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def read(path):
    with Path(path).open() as stream: return json.load(stream)


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): digest.update(block)
    return digest.hexdigest()


def default_basemap():
    for path in (HERE / 'basemap/world.mbtiles', SOURCE / 'basemap/world.mbtiles'):
        if path.is_file() and not path.is_symlink():
            expected = path.with_suffix('.mbtiles.sha256').read_text().split()[0]
            if not re.fullmatch(r'[a-f0-9]{64}', expected) or checksum(path) != expected:
                raise ValueError('Bundled basemap checksum failed; update the checkout before retrying')
            return path
    raise ValueError('Bundled basemap missing. Run this command from an updated source checkout')


def seed_geoip(directory):
    base = default_basemap().parent
    manifest = read(base / 'geoip.json')
    for version,name in (('ipv4','geoip.mmdb'),('ipv6','geoip-v6.mmdb')):
        target = Path(directory) / name
        if target.exists(): continue
        source = base / f'dbip-city-{version}.mmdb.gz'
        expected = manifest['assets'][source.name]
        if checksum(source) != expected['sha256']: raise ValueError('Bundled GeoIP checksum failed')
        temporary=target.with_name(target.name+'.'+secrets.token_hex(6))
        try:
            with gzip.open(source,'rb') as src, temporary.open('xb') as dst:
                shutil.copyfileobj(src,dst,1024*1024)
                dst.flush(); os.fsync(dst.fileno())
            if temporary.stat().st_size > 256*1024**2 or checksum(temporary) != expected['uncompressed_sha256']:
                raise ValueError('Bundled GeoIP expansion failed')
            temporary.chmod(0o644); os.replace(temporary,target)
        finally: temporary.unlink(missing_ok=True)


def copy_public_file(source, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.' + secrets.token_hex(6))
    try:
        with source.open('rb') as src, temporary.open('xb') as dst:
            shutil.copyfileobj(src, dst)
            dst.flush(); os.fsync(dst.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def version(value):
    if not isinstance(value, str): raise ValueError('Release version must be text')
    match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-alpha\.([1-9][0-9]*))?', value)
    if not match: raise ValueError('Unsupported release version')
    major, minor, patch, alpha = match.groups()
    return (int(major), int(minor), int(patch), 1 if alpha is None else 0, int(alpha or 0))


def release(data, channel, current=None):
    if not isinstance(data, dict) or set(data) != {'format', 'host_api', 'data_contract', 'version', 'published_at', 'images'}:
        raise ValueError('Invalid release manifest fields')
    if any(type(data[k]) is not int or data[k] != (1 if k == 'format' else RELEASE[k]) for k in ('format', 'host_api', 'data_contract')):
        raise ValueError('This release needs a reviewed installer/data-format migration')
    proposed = version(data['version'])
    if channel == 'stable' and proposed[3] != 1: raise ValueError('Stable updates cannot install previews')
    if type(data['published_at']) is not int or not 1 <= data['published_at'] <= int(time.time()) + 3600:
        raise ValueError('Invalid release time')
    if not isinstance(data['images'], dict) or set(data['images']) != {'server', 'gateway'}:
        raise ValueError('A release must name both runtime images')
    for service, image in data['images'].items():
        if not isinstance(image, str) or not re.fullmatch(re.escape(f'{REGISTRY}-{service}@sha256:') + r'[a-f0-9]{64}', image):
            raise ValueError('Only immutable images in the Bungee release repositories are permitted')
    if current:
        previous = version(current['version'])
        if proposed < previous: raise ValueError('Release downgrades are forbidden')
        if proposed[:2] != previous[:2]: raise ValueError('Automatic updates stay in the installed major/minor release train')
        if data['published_at'] <= current['published_at']: raise ValueError('Stale/replayed release refused')
    return data


def compose(config, images, root):
    c = network.validate(config)
    dataset = root / 'datasets' / c.get('geodata', 'empty')
    common = {'restart': 'unless-stopped', 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'read_only': True, 'ulimits': {'core': {'soft': 0, 'hard': 0}}}
    def bind(name, target, readonly=False):
        return {'type': 'bind', 'source': str(root / 'volumes' / name), 'target': target, 'read_only': readonly, 'bind': {'create_host_path': False}}
    def service(image, **values): return {**common, 'image': image, **values}
    dns = {'BUNGEE_DNS_UPSTREAM_IP': c.get('dns_upstream_ip', ''), 'BUNGEE_DNS_UPSTREAM_PORT': str(c.get('dns_upstream_port', 53))}
    return {'name': 'bungee', 'services': {
        'gateway': service(images['gateway'], cap_add=['NET_ADMIN', 'CHOWN', 'DAC_OVERRIDE'], tmpfs=['/run:mode=0700'],
            environment={**PRIVATE_ENV, **dns, 'BUNGEE_WG_PORT': str(c['wg_port']), 'BUNGEE_ADMIN_ADDRESS': c['bind_ip'], 'BUNGEE_ADMIN_SUBNETS': ' '.join(c['admin_subnets']), 'BUNGEE_UPDATE_CONTROL': '/control'},
            ports=[f"{network.bracket(c['bind_ip'])}:{c['web_port']}:8443/tcp", f"{c['wg_port']}:{c['wg_port']}/udp"],
            sysctls={'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0'},
            volumes=[bind('gateway-private', '/private'), bind('gateway-peers', '/peers'), {'type': 'bind', 'source': str(root / 'control'), 'target': '/control', 'read_only': True, 'bind': {'create_host_path': False}}],
            healthcheck={'test': ['CMD', 'wg', 'show', 'wg0'], 'interval': '10s', 'timeout': '3s', 'retries': 5}),
        'server': service(images['server'], network_mode='service:gateway', depends_on={'gateway': {'condition': 'service_healthy'}},
            environment={**PRIVATE_ENV, **dns, 'BUNGEE_PUBLIC_ORIGIN': network.origin(c), 'BUNGEE_ADMIN_BIND': '0.0.0.0:8443', 'BUNGEE_ADMIN_INTERFACE': 'eth0', 'BUNGEE_ADMIN_SUBNETS': ' '.join(c['admin_subnets']), 'BUNGEE_DEVICE_BIND': '10.77.0.1:8081', 'BUNGEE_WG_ENDPOINT': f"{network.bracket(c['endpoint_ip'])}:{c['wg_port']}", 'BUNGEE_TLS_CERT_FILE': '/tls/current/server.crt', 'BUNGEE_TLS_KEY_FILE': '/tls/current/server.key'},
            tmpfs=['/tmp:size=16m'], volumes=[bind('server-data', '/state'), bind('gateway-peers', '/state/wireguard'), bind('tls-data/issued', '/tls', True), {'type': 'bind', 'source': str(dataset), 'target': '/datasets', 'read_only': True, 'bind': {'create_host_path': False}}, *[{'type':'bind','source':str(root/source),'target':target,'read_only':readonly,'bind':{'create_host_path':False}} for source,target,readonly in [('maps','/maps',True),('map-control/status','/map-control/status',True),('map-control/requests','/map-control/requests',False)]]])
    }}


class Engine:
    def __init__(self, root, project='bungee', wait_timeout=150):
        if not re.fullmatch(r'bungee(?:-test-[a-z0-9-]+)?', project): raise ValueError('Invalid project scope')
        self.root = root; self.project = project; self.wait_timeout = wait_timeout
    def compose(self, generation, *args):
        return run(['docker', 'compose', '--project-name', self.project, '--file', self.root / 'generations' / generation / 'compose.json', *args])
    def pull(self, images):
        for image in images.values():
            run(['docker', 'image', 'inspect', image] if re.fullmatch(r'sha256:[a-f0-9]{64}', image) else ['docker', 'pull', image])
    def bundle(self, channel):
        tag = f'{REGISTRY}-release:{channel}'
        run(['docker', 'pull', '--platform', 'linux/amd64', tag])
        info = json.loads(run(['docker', 'image', 'inspect', tag]))[0]
        digests = [d for d in info['RepoDigests'] if d.startswith(f'{REGISTRY}-release@sha256:')]
        if len(digests) != 1: raise ValueError('Cannot identify immutable release bundle')
        container = run(['docker', 'create', '--platform', 'linux/amd64', digests[0]])
        temporary = self.root / ('manifest-' + secrets.token_hex(6))
        try:
            # Never start a release-bundle container or execute its contents.
            run(['docker', 'cp', f'{container}:/release.json', temporary])
            if temporary.is_symlink() or not temporary.is_file() or temporary.stat().st_size > 16384:
                raise ValueError('Release manifest must be a small regular JSON file')
            return read(temporary), digests[0]
        finally:
            temporary.unlink(missing_ok=True)
            run(['docker', 'rm', '--volumes', container])
    def check_geodata(self, directory, generation):
        image = read(self.root / 'generations' / generation / 'release.json')['images']['server']
        return run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--cpus', '1', '--pids-limit', '64', '--env', 'TOKIO_WORKER_THREADS=2', '--mount', f'type=bind,src={directory},dst=/datasets,readonly', image, '--check-geodata'])
    def hold(self, closed, generation=None):
        atomic(self.root / 'control/status', 'closed\n' if closed else 'open\n')
        if closed and generation:
            for _ in range(20):
                try:
                    if self.compose(generation, 'exec', '-T', 'gateway', 'cat', '/run/bungee-admission') == 'closed': return
                except subprocess.CalledProcessError: pass
                time.sleep(1)
            raise RuntimeError('Gateway did not confirm maintenance admission; update aborted')
    def no_restart(self, generation):
        ids = self.compose(generation, 'ps', '--all', '--quiet').split()
        if ids: run(['docker', 'update', '--restart=no', *ids])
    def down(self, generation): self.compose(generation, 'down', '--timeout', '45')
    def stop_helpers(self):
        ids = run(['docker', 'ps', '--all', '--quiet', '--filter', f'label=org.bungee.helper={self.project}-archive']).split()
        if ids: run(['docker', 'rm', '--force', '--volumes', *ids])
    def up(self, generation): self.compose(generation, 'up', '--detach', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', str(self.wait_timeout))
    def healthy(self, generation):
        output = self.compose(generation, 'ps', '--all', '--format', 'json')
        rows = json.loads(output) if output.startswith('[') else [json.loads(line) for line in output.splitlines()]
        if isinstance(rows, dict): rows = [rows]
        if len(rows) != 2 or {r['Service'] for r in rows} != {'gateway', 'server'} or any(r['State'] != 'running' or r.get('Health') != 'healthy' for r in rows):
            raise RuntimeError('Both runtime services must be running and healthy')
    def volumes(self):
        secure_storage.check(self.root)
        for name in VOLUMES:
            path = self.root / 'volumes' / name
            if path.is_symlink() or not path.is_dir(): raise ValueError('Missing encrypted data directory')
    def storage_ready(self, generation):
        self.volumes()
        required = sum(int(run(['du', '-sb', self.root / 'volumes' / name]).split()[0]) for name in VOLUMES) * 12 // 10 + 1024**3
        if shutil.disk_usage(self.root).free < required:
            raise ValueError('Insufficient encrypted backup space: reserve a full snapshot plus 20% and 1 GiB')
    def backup_key(self):
        path = secure_storage.KEY.parent / 'backup-identity'
        secure_storage.private(path)
        return path
    def archive(self, generation, directory, restore=False):
        self.volumes()
        key = self.backup_key()
        if restore:
            # Authenticate EVERY archive before removing any current data.
            for name in VOLUMES:
                subprocess.run(['age', '--decrypt', '--identity', str(key), str(directory / (name + '.tar.age'))], stdout=subprocess.DEVNULL, check=True, timeout=900)
        recipient = run(['age-keygen', '-y', key]) if not restore else None
        for name in VOLUMES:
            data = self.root / 'volumes' / name
            archive = directory / (name + '.tar.age')
            if restore:
                # Archives contain only our cold data directories and are authenticated.
                # Never extract host-owned external archives into a running service.
                for child in data.iterdir():
                    if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
                    else: child.unlink()
                first_args = ['age', '--decrypt', '--identity', str(key), str(archive)]
                second_args = ['tar', '--extract', '--preserve-permissions', '--file', '-', '--directory', str(data)]
                output = subprocess.DEVNULL
            else:
                first_args = ['tar', '--create', '--file', '-', '--directory', str(data), '.']
                second_args = ['age', '--encrypt', '--recipient', recipient]
                output = archive.open('xb')
            try:
                with subprocess.Popen(first_args, stdout=subprocess.PIPE, preexec_fn=child_guard(os.getpid())) as producer:
                    try:
                        subprocess.run(second_args, stdin=producer.stdout, stdout=output, check=True, timeout=900, preexec_fn=child_guard(os.getpid()))
                    finally: producer.stdout.close()
                    if producer.wait(timeout=900): raise RuntimeError('Snapshot pipeline failed')
            finally:
                if not restore: output.close()


class Host:
    def __init__(self, root, engine=None): self.root = Path(root); self.engine = engine or Engine(self.root)
    def current(self):
        gen = read(self.root / 'current.json')['generation']
        if not re.fullmatch(r'[a-f0-9]{24}', gen): raise ValueError('Invalid generation pointer; preserve files for local recovery')
        return gen
    def metadata(self, gen): return read(self.root / 'generations' / gen / 'release.json')
    def stage(self, config, metadata):
        map_manager.setup(self.root)
        for name in VOLUMES:
            (self.root / 'volumes' / name).mkdir(parents=True, exist_ok=True, mode=0o700)
        dataset = self.root / 'datasets' / config.get('geodata', 'empty')
        if config.get('geodata'):
            if not dataset.is_dir(): raise ValueError('Pinned dataset directory is missing; restore it before updating')
        else:
            dataset.mkdir(parents=True, exist_ok=True, mode=0o755)
            if not (dataset / 'map.mbtiles').exists():
                copy_public_file(default_basemap(), dataset / 'map.mbtiles')
            seed_geoip(dataset)
        dataset.chmod(0o755)
        gen = secrets.token_hex(12)
        directory = self.root / 'generations' / gen
        directory.mkdir(parents=True, mode=0o700)
        atomic(directory / 'config.json', config)
        atomic(directory / 'release.json', metadata)
        atomic(directory / 'compose.json', compose(config, metadata['images'], self.root))
        return gen
    def datasets(self, maps=None, geoip=None, clear_maps=False, clear_geoip=False, geoip_v6=None):
        self.recover()
        old = self.current()
        config = read(self.root / 'generations' / old / 'config.json')
        token = secrets.token_hex(12)
        directory = self.root / 'datasets' / token
        directory.mkdir(parents=True, mode=0o755)
        directory.chmod(0o755)
        try:
            for name, source, clear in (('map.mbtiles', None if maps and Path(maps).suffix=='.pmtiles' else maps, clear_maps or bool(maps and Path(maps).suffix=='.pmtiles')), ('map.pmtiles', maps if maps and Path(maps).suffix=='.pmtiles' else None, clear_maps or bool(maps and Path(maps).suffix!='.pmtiles')), ('geoip.mmdb', geoip, clear_geoip), ('geoip-v6.mmdb', geoip_v6, clear_geoip or bool(geoip and not geoip_v6))):
                if clear: continue
                source = Path(source) if source else self.root / 'datasets' / config.get('geodata', 'empty') / name
                if not source.exists():
                    explicit = maps if name in ('map.mbtiles','map.pmtiles') else geoip if name == 'geoip.mmdb' else None
                    if explicit: raise ValueError('Requested dataset file does not exist')
                    continue
                if source.is_symlink() or not source.is_file(): raise ValueError('Datasets must be local regular files, not symlinks or URLs')
                size = source.stat().st_size
                if size == 0 or (name.startswith('geoip') and size > 256 * 1024 * 1024): raise ValueError('Empty or oversized GeoIP dataset')
                if shutil.disk_usage(self.root).free < size + 1024 ** 3: raise ValueError('Insufficient space for the new dataset plus 1 GiB')
                target = directory / name
                with source.open('rb') as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                    dst.flush(); os.fsync(dst.fileno())
                target.chmod(0o644)
            for path in (directory, directory.parent):
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
                try: os.fsync(fd)
                finally: os.close(fd)
            result = json.loads(self.engine.check_geodata(directory, old))
            if any((directory / file).exists() != bool(result.get(key)) for file, key in (('map.mbtiles', 'maps'), ('map.pmtiles', 'vector'), ('geoip.mmdb', 'geoip'))):
                raise ValueError('Dataset validation did not confirm all supplied files')
            print('Validated offline data:', json.dumps(result))
            # A new immutable directory is pinned into this generation. Rollback keeps the old dataset.
            self.apply({**config, 'geodata': token}, self.metadata(old))
        except Exception:
            # Keep a referenced directory if recovery is pending; it is needed by the journal.
            if not (self.root / 'transaction.json').exists() and self.current() == old: shutil.rmtree(directory)
            raise
    def journal(self, value): atomic(self.root / 'transaction.json', value)
    def backup(self, gen, backup):
        backup.mkdir(parents=True, mode=0o700)
        self.engine.archive(gen, backup)
        for name in VOLUMES:
            with (backup / f'{name}.tar.age').open('rb') as stream: os.fsync(stream.fileno())
        sums = {name: checksum(backup / f'{name}.tar.age') for name in VOLUMES}
        atomic(backup / 'complete.json', sums)
    def restore(self, gen, backup):
        sums = read(backup / 'complete.json')
        if set(sums) != set(VOLUMES): raise ValueError('Incomplete recovery snapshot')
        for name in VOLUMES:
            if checksum(backup / f'{name}.tar.age') != sums[name]: raise ValueError('Recovery snapshot checksum mismatch')
        self.engine.archive(gen, backup, restore=True)
    def finish(self, gen):
        self.engine.healthy(gen)
        atomic(self.root / 'current.json', {'generation': gen})
        self.engine.hold(False)
        (self.root / 'transaction.json').unlink(missing_ok=True)
    def recover(self):
        path = self.root / 'transaction.json'
        if not path.exists(): return
        tx = read(path)
        self.engine.stop_helpers()
        if tx.get('phase') not in ('prepared', 'backed_up', 'candidate', 'accepted') or any(not re.fullmatch(r'[a-f0-9]{24}', tx.get(k, '')) for k in ('old', 'new', 'backup')):
            self.engine.hold(True)
            raise ValueError('Invalid recovery journal; preserve volumes and backups for local repair')
        old, new = tx['old'], tx['new']
        self.engine.hold(True)
        if tx['phase'] == 'accepted':
            # Data may have been admitted after acceptance. Never restore an old snapshot here.
            self.engine.up(new); self.finish(new)
            return
        self.engine.down(new)
        self.engine.down(old)
        if tx['phase'] in ('backed_up', 'candidate'):
            self.restore(old, self.root / 'backups' / tx['backup'])
        self.engine.up(old); self.engine.healthy(old)
        atomic(self.root / 'failed.json', {'bundle': tx.get('bundle'), 'at': int(time.time())})
        # Before reopening after rollback, durably end the restore phase too.
        # A crash after reopening must never replay an older snapshot over new data.
        tx['phase'] = 'accepted'; tx['new'] = old; self.journal(tx)
        self.finish(old)
    def apply(self, config, metadata, bundle=None):
        self.recover()
        old = self.current()
        self.engine.healthy(old)
        self.engine.storage_ready(old)
        self.engine.pull(metadata['images'])  # No downtime or snapshot until every image is local.
        new = self.stage(config, metadata)
        tx = {'old': old, 'new': new, 'phase': 'prepared', 'backup': new, 'bundle': bundle}
        self.journal(tx)
        try:
            self.engine.hold(True, old)
            self.engine.no_restart(old)
            self.engine.down(old)
            self.backup(old, self.root / 'backups' / new)
            tx['phase'] = 'backed_up'; self.journal(tx)
            tx['phase'] = 'candidate'; self.journal(tx)
            self.renew_tls(config)
            self.engine.up(new)
            self.engine.healthy(new)
            tx['phase'] = 'accepted'; self.journal(tx)
            self.finish(new)
        except Exception:
            try: self.recover()
            except Exception as recovery:
                raise RuntimeError('Recovery could not finish. Admission remains closed; keep volumes/backups and run recover from the local console.') from recovery
            raise
        # Keep the newest three complete snapshots. Primary history is never trimmed.
        backups = sorted((self.root / 'backups').iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        for backup in backups[3:]:
            if (backup / 'complete.json').is_file(): shutil.rmtree(backup)
    def renew_tls(self, config=None):
        config = config or read(self.root / 'generations' / self.current() / 'config.json')
        tls_config.ensure(self.root / 'volumes/tls-data', config['web_host'])
        for path in (self.root / 'volumes/tls-data/issued').rglob('*'):
            if not path.is_symlink(): os.chown(path, 10001, 10001)
        os.chown(self.root / 'volumes/tls-data/issued', 10001, 10001)

    def update(self, manual=False):
        self.recover()
        self.renew_tls()
        current = self.current()
        config = read(self.root / 'generations' / current / 'config.json')
        if not config['auto_updates'] and not manual: print('Automatic updates are disabled.'); return
        metadata, bundle = self.engine.bundle(config['channel'])
        if bundle == self.metadata(current).get('bundle'): print('Already current.'); return
        failed = read(self.root / 'failed.json') if (self.root / 'failed.json').exists() else {}
        if bundle == failed.get('bundle'): raise ValueError('This candidate already failed. Waiting for a newer release; inspect the local journal')
        release(metadata, config['channel'], self.metadata(current))
        metadata = {**metadata, 'bundle': bundle}
        if metadata['images'] == self.metadata(current)['images']:
            atomic(self.root / 'generations' / current / 'release.json', metadata)
            print('Image contents unchanged; no restart needed.'); return
        self.apply(config, metadata, bundle)
        print('Update accepted:', metadata['version'])


def edit_backspaces(value):
    result = []
    for char in value:
        if char in ('\b', '\x7f'):
            if result: result.pop()
        else: result.append(char)
    return ''.join(result)


def ask(prompt, default=None):
    value = edit_backspaces(input(prompt + (f' [{default}]' if default is not None else '') + ': ')).strip()
    return value or default or ''


def field(prompt, default, parse):
    while True:
        try: return parse(ask(prompt, default))
        except ValueError as exc: print('Please correct:', exc)


def choice(*values):
    def parse(value):
        if value not in values: raise ValueError('Choose ' + ' or '.join(values))
        return value
    return parse


def storage_size(value):
    value = int(value)
    if not 2 <= value <= 1048576: raise ValueError('Storage size must be 2–1048576 GiB')
    return value


def read_secret(prompt):
    # Read from the controlling terminal, never stdin (which may contain a script).
    # Handle both BS and DEL ourselves, including multibyte UTF-8 characters.
    try: fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    except OSError as exc: raise ValueError('A terminal is required for password entry; use --password-stdin for automation') from exc
    previous = termios.tcgetattr(fd)
    settings = termios.tcgetattr(fd)
    settings[3] &= ~(termios.ECHO | termios.ICANON)
    settings[6][termios.VMIN] = 1
    settings[6][termios.VTIME] = 0
    data = bytearray()
    try:
        termios.tcsetattr(fd, termios.TCSAFLUSH, settings)
        os.write(fd, prompt.encode())
        while True:
            char = os.read(fd, 1)
            if char in (b'\n', b'\r'): return data.decode('utf-8')
            if char in (b'', b'\x04'): raise EOFError('Password entry cancelled')
            if char == b'\x15': data.clear()
            elif char in (b'\x08', b'\x7f'):
                if data:
                    last = data.pop()
                    while last & 0xc0 == 0x80 and data: last = data.pop()
            else:
                data.extend(char)
                if len(data) > 65536: raise ValueError('Password input is too long')
    finally:
        data[:] = b'\0' * len(data)
        termios.tcsetattr(fd, termios.TCSAFLUSH, previous)
        os.write(fd, b'\n')
        os.close(fd)


def validate_password(password):
    if len(password) < 16 or len(password.encode('utf-8')) > 1024 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in password):
        raise ValueError('Use at least 16 characters, at most 1024 UTF-8 bytes, and no control characters')
    return password


def password_input(from_stdin=False):
    if from_stdin:
        # A dedicated stdin stream, never a command argument, environment variable or JSON field.
        return validate_password(sys.stdin.buffer.read(1025).decode('utf-8').removesuffix('\n').removesuffix('\r'))
    while True:
        password = read_secret('New administrator password (at least 16 characters): ')
        try: validate_password(password)
        except ValueError as exc:
            print(exc)
            continue
        if password == read_secret('Confirm administrator password: '): return password
        print('Passwords do not match. Try again.')


def choose_maps(selected=None):
    catalog=regional_maps.region_catalog(default_basemap().parent/'regions.json')
    chosen=set(selected or [])
    groups=list(dict.fromkeys(item['group'] for item in catalog.values()))
    print('\nRegional street maps. Sizes shown here are rough; exact sizes are planned before download.')
    while True:
        print('Selected total: approximately %.2f GiB (%d regions)' % (sum(catalog[key]['estimated_bytes'] for key in chosen)/1024**3,len(chosen)))
        for index,group in enumerate(groups,1): print(f'  {index}. {group}')
        group=ask('Choose a group number, or done to finish','1' if not chosen else 'done')
        if group=='done':
            if chosen or field('No street maps selected. Continue with overview only? yes/no','no',choice('yes','no'))=='yes':
                return sorted(chosen)
            continue
        if not group.isdecimal() or not 1<=int(group)<=len(groups): print('Choose a listed group.');continue
        rows=[item for item in catalog.values() if item['group']==groups[int(group)-1]]
        while True:
            for index,item in enumerate(rows,1): print(f'  [{"x" if item["id"] in chosen else " "}] {index}. {item["name"]} · ~{item["estimated_bytes"]/1024**3:.2f} GiB')
            print('Combined selection: ~%.2f GiB. Maximum 24 regions / 25 GB of installed street maps.' % (sum(catalog[key]['estimated_bytes'] for key in chosen)/1024**3))
            answer=ask('Numbers to toggle (commas/spaces), or back/done','back')
            if answer=='done':
                if chosen or field('No street maps selected. Continue with overview only? yes/no','no',choice('yes','no'))=='yes': return sorted(chosen)
                continue
            if answer=='back': break
            try:
                numbers=[int(value) for value in re.split('[, ]+',answer)]
                if any(value<1 or value>len(rows) for value in numbers): raise ValueError()
                updated=chosen.symmetric_difference(rows[value-1]['id'] for value in numbers)
                if len(updated)>24: raise ValueError()
                chosen=updated
            except ValueError: print('Choose listed numbers, up to 24 regions overall.')


def guided(existing=None):
    c = existing or {}
    print('Bungee local setup. No router settings, phone ownership or host firewall will be changed.')
    wg = field('WireGuard UDP port (51820 forbidden)', c.get('wg_port'), lambda value: network.port(value, True))
    web = field('Dashboard HTTPS TCP port', c.get('web_port', 8443), network.port)
    endpoint = field('Numeric home-server address reachable by phones', c.get('endpoint_ip'), lambda value: network.address(value, endpoint=True))
    bind = field('Internal management bind IP; 127.0.0.1 means local/SSH access only', c.get('bind_ip', '127.0.0.1'), network.management_address)
    host = field('Dashboard address used in your browser (no port)', c.get('web_host', bind), network.hostname)
    print('Use only your internal management IPs/prefixes. They must not overlap the phone C2 subnet.')
    nets = field('Allowed internal administrator networks', ' '.join(c['admin_subnets']) if c.get('admin_subnets') else None, network.admin_networks)
    dns = field('Optional DNS resolver IP (type off to disable)', c.get('dns_upstream_ip', ''), lambda value: network.dns_upstream('' if value == 'off' else value))
    dns_port = field('DNS resolver port', c.get('dns_upstream_port', 53), network.port) if dns else 53
    size = field('Encrypted storage capacity in GiB (new installations)', c.get('storage_size_gib', 32), storage_size)
    maps = choose_maps(c.get('map_regions',[]))
    channel = field('Update channel: stable or preview', c.get('channel', 'stable'), choice('stable', 'preview'))
    auto = field('Check daily for tested images in that channel? yes/no', 'yes' if c.get('auto_updates', True) else 'no', choice('yes', 'no'))
    return network.validate({**({'geodata': c['geodata']} if c.get('geodata') else {}), 'wg_port': wg, 'web_port': web, 'endpoint_ip': endpoint, 'bind_ip': bind, 'web_host': host, 'admin_subnets': nets, 'channel': channel, 'auto_updates': auto == 'yes', 'dns_upstream_ip': dns, 'dns_upstream_port': dns_port, 'storage_size_gib': size,'map_regions':maps})


def preflight(root, installing=False, config=None):
    if installing and config and config.get('map_regions'):
        regional_maps.selection(regional_maps.region_catalog(default_basemap().parent/'regions.json'),config['map_regions'])
    if sys.platform != 'linux' or os.geteuid() != 0: raise ValueError('Run on the local Linux server with sudo. --plan needs no root or Docker access')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(root)) or '..' in root.parts:
        raise ValueError('Use an absolute installation path without spaces or parent traversal')
    for path in [root, *root.parents]:
        if path.is_symlink(): raise ValueError('Installation paths cannot contain symlinks')
        if path.exists() and (path.stat().st_uid != 0 or path.stat().st_mode & 0o022):
            raise ValueError('Installation directory and parents must be root-owned and not group/world writable')
    if run(['docker', 'info', '--format', '{{.OSType}}']) != 'linux': raise ValueError('A Linux Docker engine is required')
    context = run(['docker', 'context', 'show'])
    endpoint = json.loads(run(['docker', 'context', 'inspect', context]))[0]['Endpoints']['docker']['Host']
    if os.environ.get('DOCKER_HOST', endpoint).startswith(('ssh:', 'tcp:', 'http:', 'https:')):
        raise ValueError('Install on the Docker host itself; remote Docker contexts are unsupported')
    v = run(['docker', 'compose', 'version', '--short']).lstrip('v').split('.')
    if tuple(int(n) for n in v[:2]) < (2, 24): raise ValueError('Docker Compose 2.24+ is required')
    if not Path('/run/systemd/system').exists(): raise ValueError('Guided installation requires systemd; manual Compose remains available')
    if not installing: secure_storage.check(root)
    swaps = run(['swapon', '--show', '--noheadings', '--raw', '--output', 'NAME'])
    for swap in swaps.splitlines():
        if not swap.startswith('/dev/') or run(['lsblk', '-dn', '-o', 'TYPE', swap]) != 'crypt':
            raise ValueError('Disable unencrypted swap or use encrypted swap before deployment')
    if installing:
        if root.exists(): raise ValueError('Installation directory already exists; use configure/status/update instead of overwriting it')
        if run(['docker', 'ps', '--all', '--quiet', '--filter', 'label=com.docker.compose.project=bungee']): raise ValueError('An existing Bungee stack exists; refusing to replace it')
        if run(['docker', 'volume', 'ls', '--quiet', '--filter', 'label=com.docker.compose.project=bungee']): raise ValueError('Existing Bungee volumes found; preserve them and follow migration instructions')
        for protocol, number in ((socket.SOCK_DGRAM, config['wg_port']), (socket.SOCK_STREAM, config['web_port'])):
            with socket.socket(socket.AF_INET6 if ':' in config['bind_ip'] else socket.AF_INET, protocol) as sock:
                sock.bind((config['bind_ip'] if protocol == socket.SOCK_STREAM else ('::' if ':' in config['bind_ip'] else '0.0.0.0'), number))


SYSTEMD = Path('/etc/systemd/system')
BOOT_FILES = (Path('/etc/crypttab'), Path('/etc/fstab'))
UNITS = ('bungee-update.timer', 'bungee-maps.service', 'bungee-update.service', 'bungee-recover.service')


def uninstall_plan(root, purge=False):
    if not root.is_absolute() or root == Path('/') or '..' in root.parts:
        raise ValueError('Use the absolute Bungee installation root')
    return {'root': str(root), 'stop': list(UNITS),
            'remove': ['Bungee Compose containers and network', 'Bungee systemd units and Docker storage dependency',
                       'Bungee crypttab/fstab entries'],
            'storage': 'DELETE encrypted storage, local snapshots and keys' if purge else 'Unmount and close; preserve encrypted storage and keys',
            'preserve': ['Docker and unrelated workloads', 'Docker images', 'external backups', 'phone apps and imported CA trust']}


def uninstall(root, purge=False):
    preflight(root)
    host = Host(root)
    generation = host.current()
    # Validate every shared host file before stopping anything. Never remove a
    # different installation's entries or follow symlinks into unrelated files.
    expected = (f'bungee {secure_storage.IMAGE} {secure_storage.KEY} luks',
                f'/dev/mapper/bungee {root} ext4 defaults,nodev,nosuid,noexec 0 2')
    edits = []
    for path, line in zip(BOOT_FILES, expected):
        if path.is_symlink(): raise ValueError(f'Refusing symlink: {path}')
        old = path.read_text()
        matches = [row for row in old.splitlines() if row.split() == line.split()]
        if len(matches) != 1: raise ValueError(f'Expected exactly one installer-owned entry in {path}')
        edits.append((path, ''.join(row for row in old.splitlines(keepends=True) if row.split() != line.split())))
    dropin = SYSTEMD / 'docker.service.d/bungee-storage.conf'
    if dropin.is_symlink() or dropin.read_text() != f'[Unit]\nRequiresMountsFor={root}\nAfter=systemd-cryptsetup@bungee.service\n':
        raise ValueError('Docker storage dependency differs from the installer; inspect it locally')
    for name in UNITS:
        path = SYSTEMD / name
        if path.is_symlink(): raise ValueError(f'Refusing symlink: {path}')
        content = path.read_text()
        if (name.endswith('.service') and f'ExecStart=/usr/bin/python3 {root}/bungee-host.py ' not in content) or 'Bungee' not in content:
            raise ValueError(f'Unit does not belong to this installation: {path}')
    # A running updater owns this lock. Refuse instead of killing a transaction.
    with (root / 'host.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(['systemctl', 'disable', '--now', 'bungee-update.timer'])
        run(['systemctl', 'disable', 'bungee-recover.service'])
        run(['systemctl', 'stop', 'bungee-update.service', 'bungee-recover.service'])
        host.engine.hold(True)
        host.engine.no_restart(generation)
        host.engine.stop_helpers()
        host.engine.down(generation)
        if run(['docker', 'ps', '--all', '--quiet', '--filter', 'label=com.docker.compose.project=bungee']):
            raise ValueError('Bungee containers remain; preserving storage and boot configuration')
    # Do not detach storage until the runtime is gone. An open host.lock would
    # itself keep the mount busy; release it before the normal (never lazy) unmount.
    run(['umount', root])
    run(['cryptsetup', 'close', secure_storage.MAPPER])
    for path, content in edits:
        # Keep system file permissions; atomic() deliberately creates private files.
        mode = path.stat().st_mode & 0o777
        atomic(path, content)
        path.chmod(mode)
    dropin.unlink()
    for name in UNITS: (SYSTEMD / name).unlink()
    run(['systemctl', 'daemon-reload'])
    if purge:
        secure_storage.IMAGE.unlink()
        secure_storage.KEY.unlink()
        (secure_storage.KEY.parent / 'backup-identity').unlink(missing_ok=True)
    # Only empty directories are removed, never recursively delete the mountpoint.
    for path in (root, dropin.parent, secure_storage.IMAGE.parent, secure_storage.KEY.parent):
        try: path.rmdir()
        except OSError: pass
    print('Bungee host uninstalled. ' + ('Local encrypted storage and keys deleted.' if purge else
          f'Encrypted data retained at {secure_storage.IMAGE}; keep {secure_storage.KEY.parent} with it for recovery.'))
    print('Docker images, external backups, phone apps and imported CA trust were preserved.')


def systemd(root):
    command = f'/usr/bin/python3 {root}/bungee-host.py'
    units = {
        'bungee-recover.service': f'[Unit]\nDescription=Recover an interrupted Bungee update\nRequires=docker.service\nRequiresMountsFor={root}\nAfter=docker.service\nBefore=bungee-update.service\n[Service]\nType=oneshot\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nUMask=0077\nLimitCORE=0\nExecStart={command} recover --root {root}\nTimeoutStartSec=900\n[Install]\nWantedBy=multi-user.target\n',
        'bungee-update.service': f'[Unit]\nDescription=Check and transactionally update Bungee\nRequires=docker.service\nRequiresMountsFor={root}\nAfter=docker.service bungee-recover.service\nOnFailure=bungee-recover.service\n[Service]\nType=oneshot\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nUMask=0077\nLimitCORE=0\nExecStart={command} update --root {root}\nTimeoutStartSec=1800\n',
        'bungee-update.timer': '[Unit]\nDescription=Daily Bungee security update check\n[Timer]\nOnBootSec=15min\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n'}
    units['bungee-maps.service']=f'[Unit]\nDescription=Bungee regional map downloads\nRequiresMountsFor={root}\nAfter=docker.service\n[Service]\nType=simple\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nUMask=0077\nLimitCORE=0\nMemoryMax=1G\nTasksMax=128\nExecStart={command} map-worker --root {root}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\n[Install]\nWantedBy=multi-user.target\n'
    for name, content in units.items(): atomic(SYSTEMD / name, content)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', 'bungee-recover.service'])
    run(['systemctl', 'enable', '--now', 'bungee-update.timer'])
    run(['systemctl', 'enable', '--now', 'bungee-maps.service'])


def install_helpers(root):
    for source, target in ((Path(__file__), root / 'bungee-host.py'), (module_path, root / 'network_config.py'), (release_path, root / 'release.json'), (HERE / 'secure_storage.py', root / 'secure_storage.py'), (HERE / 'tls_config.py', root / 'tls_config.py')):
        atomic(target, source.read_text())
    copy_public_file(HERE / 'regional_maps.py', root / 'regional_maps.py')
    copy_public_file(HERE / 'map_manager.py', root / 'map_manager.py')
    source = default_basemap()
    for name in ('geoip.json','dbip-city-ipv4.mmdb.gz','dbip-city-ipv6.mmdb.gz'):
        copy_public_file(source.parent / name,root / 'basemap' / name)
    copy_public_file(source.parent / 'us.geojson', root / 'basemap/us.geojson')
    copy_public_file(source.parent / 'regions.json', root / 'basemap/regions.json')
    copy_public_file(source, root / 'basemap/world.mbtiles')
    atomic(root / 'basemap/world.mbtiles.sha256', source.with_suffix('.mbtiles.sha256').read_text())
    map_manager.setup(root)
    if (root/'current.json').exists():
        systemd(root)
        run(['systemctl','restart','bungee-maps.service'])


def build_images():
    if not (SOURCE / 'Dockerfile').is_file(): raise ValueError('Run this command from a source checkout')
    tag = 'local-' + secrets.token_hex(8)
    run(['docker', 'build', '--pull', '-t', f'bungee-gateway:{tag}', '-f', 'deploy/wireguard/Dockerfile', 'deploy'], cwd=SOURCE, timeout=3600)
    run(['docker', 'build', '--pull', '-t', f'bungee-server:{tag}', '.'], cwd=SOURCE, timeout=3600)
    return {name: json.loads(run(['docker', 'image', 'inspect', f'bungee-{name}:{tag}']))[0]['Id'] for name in ('gateway', 'server')}


def rebuild(host):
    host.recover()
    old = host.current()
    if any(host.metadata(old)[key] != RELEASE[key] for key in ('host_api', 'data_contract')):
        raise ValueError('This checkout requires a separate host/data migration')
    images = build_images()
    metadata = {'format': 1, 'host_api': RELEASE['host_api'], 'data_contract': RELEASE['data_contract'], 'version': VERSION, 'published_at': int(time.time()), 'images': images}
    host.apply(read(host.root / 'generations' / old / 'config.json'), metadata)
    install_helpers(host.root)
    print('Local rebuild installed:', VERSION)


def install_basemap(host):
    host.recover()
    config = read(host.root / 'generations' / host.current() / 'config.json')
    existing = host.root / 'datasets' / config.get('geodata', 'empty') / 'map.mbtiles'
    source = default_basemap()
    if existing.exists():
        if checksum(existing) == checksum(source):
            print('The bundled world overview is already installed; no restart needed.')
            return
        raise ValueError('A different basemap is already installed and was preserved. Use datasets --maps to replace it explicitly')
    host.datasets(maps=source)
    print('Bundled world overview installed. Import a regional raster MBTiles archive for street-level detail.')


def install_default_geodata(host):
    host.recover()
    config=read(host.root/'generations'/host.current()/'config.json')
    current=host.root/'datasets'/config.get('geodata','empty')
    maps=default_basemap() if not (current/'map.mbtiles').exists() and not (current/'map.pmtiles').exists() else None
    import tempfile
    with tempfile.TemporaryDirectory(prefix='geoip-import-',dir=host.root/'datasets') as work:
        geoip=None; geoip_v6=None
        if not (current/'geoip.mmdb').exists():
            seed_geoip(Path(work)); geoip=Path(work)/'geoip.mmdb'; geoip_v6=Path(work)/'geoip-v6.mmdb'
        if maps or geoip: host.datasets(maps=maps,geoip=geoip,geoip_v6=geoip_v6)
        else: print('Existing map and GeoIP datasets preserved. This step does not install street detail.')


def install_selected_maps(host, identifiers, plan_only=False):
    host.recover()
    if version(host.metadata(host.current())['version']) < version('1.1.8'):
        raise ValueError('Update the server with this checkout before installing regional maps: python3 scripts/bungee-host.py rebuild')
    map_manager.setup(host.root)
    with (host.root/'maps.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        catalog_path=default_basemap().parent/'regions.json'
        installed={item['id'] for item in map_manager.library(host.root)['regions']}
        wanted=[identifier for identifier in identifiers if identifier not in installed]
        if not wanted:
            print('All selected regional street maps are already installed.');return
        progress=lambda message: print(message,flush=True)
        plan=map_manager.plan_selection(host.root,catalog_path,wanted,progress)
        disk=map_manager.capacity(host.root)
        print('Combined planned download: %.2f GiB; safe free capacity: %.2f GiB after reserves.' % (plan['planned_bytes']/1024**3,disk['available_bytes']/1024**3),flush=True)
        if not plan_only:
            map_manager.install_plan(host.root,catalog_path,plan,progress)
            map_manager.public_status(host.root,catalog_path,{'job':{'state':'completed','message':'Regional street maps installed.'}})
            print('US street map installed locally. Open Tracking in the dashboard.' if all(value.startswith('us-') for value in wanted) else 'Regional street maps installed locally. Open Tracking in the dashboard.')


def install_us_maps(host, plan_only=False):
    identifiers=[key for key in regional_maps.region_catalog(default_basemap().parent/'regions.json') if key.startswith('us-')]
    install_selected_maps(host,identifiers,plan_only)


def install(root, config, from_stdin=False):
    preflight(root, installing=True, config=config)
    images = build_images()
    password = password_input(from_stdin)
    try:
        verifier = run(['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', images['server'], '--hash-admin-password'], input=password)
    finally:
        del password
    if not verifier.startswith('$argon2id$'): raise ValueError('Server did not return an Argon2id verifier')
    run(['docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--entrypoint', 'sh', images['gateway'], '-ec', 'ip link add bungee-check type wireguard; ip link delete bungee-check'])
    secure_storage.provision(root, config.get('storage_size_gib', 32))
    run(['age-keygen', '-o', secure_storage.KEY.parent / 'backup-identity'])
    (secure_storage.KEY.parent / 'backup-identity').chmod(0o600)
    with (root / 'host.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        atomic(root / 'control/status', 'closed\n')
        install_helpers(root)
        credential = root / 'volumes/server-data/admin-password.hash'
        credential.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        atomic(credential, verifier + '\n')
        os.chown(credential, 10001, 10001)
        metadata = {'format': 1, 'host_api': RELEASE['host_api'], 'data_contract': RELEASE['data_contract'], 'version': VERSION, 'published_at': 0, 'images': images}
        host = Host(root)
        if args.command == 'map-worker':
            secure_storage.check(root)
            while True:
                map_manager.tick(root,default_basemap().parent/'regions.json')
                time.sleep(3)
        generation = host.stage(config, metadata)
        atomic(root / 'current.json', {'generation': generation})
        os.chown(root / 'volumes/server-data', 10001, 10001)
        host.renew_tls()
        try:
            host.engine.up(generation)
            host.engine.healthy(generation)
            certificate = (root / 'volumes/tls-data/root.crt').read_text()
            atomic(root / 'root.crt', certificate + '\n')
            # Recovery must be installed before external admission is opened.
            systemd(root)
            host.engine.hold(False)
        except Exception:
            host.engine.hold(True)
            host.engine.no_restart(generation)
            host.engine.down(generation)
            raise RuntimeError('Installation did not finish; admission is closed and existing volumes are preserved. Diagnose with status/local logs, then recover')
    try:
        with (root / 'host.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if config.get('map_regions'): install_selected_maps(host,config['map_regions'])
            else: print('Overview only selected. Add regional street maps in Settings → Maps & storage.')
    except Exception as error:
        print('Selected street-map downloads did not complete:', error)
        print('The server is running. Retry the selected maps in Settings → Maps & storage, or use the maps command.')
    print('Installed:', network.origin(config))
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest().upper()
    print('Local CA SHA-256 fingerprint:', ':'.join(fingerprint[i:i+2] for i in range(0, len(fingerprint), 2)))
    print('Public CA certificate:', root / 'root.crt')
    print('Trust the local CA using an authenticated channel before signing in. No TLS-verification bypass is provided.')
    print(f'Local operations: sudo python3 {root}/bungee-host.py status --root {root}')
    print('Sign in with the administrator password you chose. Change it in Settings → Administrator password.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'configure', 'update', 'recover', 'status', 'datasets', 'basemap', 'geodata', 'maps-us', 'maps', 'map-worker', 'uninstall', 'password', 'rebuild'])
    parser.add_argument('--password-stdin', action='store_true', help='With install/password: read the new password from a dedicated stdin pipe')
    parser.add_argument('--root', type=Path, default=Path('/opt/bungee'))
    parser.add_argument('--config', type=Path, help='Explicit JSON answers for unattended installation/configuration')
    parser.add_argument('--plan', action='store_true', help='With install/configure/uninstall: offline plan. With maps/maps-us: query provider sizes without installing archives')
    parser.add_argument('--purge', action='store_true', help='With uninstall: also delete local encrypted storage, snapshots and keys')
    parser.add_argument('--yes', action='store_true', help='With uninstall: apply without an interactive confirmation')
    parser.add_argument('--start', action='store_true', help='With recover: explicitly start a stopped/unfinished installation')
    parser.add_argument('--manual', action='store_true', help='With update: explicitly check even if automatic checks are disabled')
    parser.add_argument('--maps', type=Path, help='With datasets: local raster MBTiles or vector PMTiles v3 archive')
    parser.add_argument('--geoip', type=Path, help='With datasets: local City MMDB file')
    parser.add_argument('--clear-maps', action='store_true', help='With datasets: remove the basemap from the active generation')
    parser.add_argument('--clear-geoip', action='store_true', help='With datasets: disable future GeoIP enrichment; saved history remains')
    parser.add_argument('--regions', help='With maps: comma-separated region IDs; omitted opens the regional checklist')
    args = parser.parse_args()
    if args.regions and args.command != 'maps': parser.error('--regions requires maps')
    if args.password_stdin and args.command not in ('install', 'password'): parser.error('--password-stdin requires install/password')
    if (args.purge or args.yes) and args.command != 'uninstall': parser.error('--purge/--yes require uninstall')
    if any((args.maps, args.geoip, args.clear_maps, args.clear_geoip)) and args.command != 'datasets': parser.error('Dataset options require datasets')
    if args.command == 'datasets' and (not any((args.maps, args.geoip, args.clear_maps, args.clear_geoip)) or (args.maps and args.clear_maps) or (args.geoip and args.clear_geoip)): parser.error('Choose datasets to import or clear, without conflicting options')
    if args.start and args.command != 'recover': parser.error('--start is only valid with recover')
    if args.manual and args.command != 'update': parser.error('--manual is only valid with update')
    if args.config and args.command not in ('install', 'configure'): parser.error('--config is only valid with install/configure')
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        parser.error('Cannot disable host helper process dumps')
    try:
        root = args.root.absolute()
        if args.command == 'uninstall':
            print(json.dumps(uninstall_plan(root, args.purge), indent=2))
            if args.plan: sys.exit(0)
            confirmation = 'PURGE' if args.purge else 'UNINSTALL'
            if not args.yes and ask(f'Type {confirmation} to continue') != confirmation:
                sys.exit('No changes made')
            uninstall(root, args.purge)
            sys.exit(0)
        host = Host(root)
        if args.command in ('install', 'configure'):
            existing = read(root / 'generations' / host.current() / 'config.json') if args.command == 'configure' else None
            CONFIG = network.validate(read(args.config)) if args.config else guided(existing)
            print(json.dumps({**CONFIG, 'dashboard_url': network.origin(CONFIG)}, indent=2))
            if args.plan: sys.exit(0)
            if not args.config and ask('Apply this configuration? Type INSTALL' if args.command == 'install' else 'Apply this configuration? Type APPLY') != ('INSTALL' if args.command == 'install' else 'APPLY'):
                sys.exit('No changes made')
        elif args.plan: raise ValueError('--plan is for install/configure only')
        if args.command == 'install': install(root, CONFIG, args.password_stdin)
        else:
            preflight(root)
            with (root / 'host.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if args.command == 'recover':
                    host.recover()
                    host.renew_tls()
                    if args.start and not (root / 'transaction.json').exists():
                        host.engine.up(host.current()); host.engine.healthy(host.current()); systemd(root); host.finish(host.current())
                elif args.command == 'password':
                    host.recover()
                    password = password_input(args.password_stdin)
                    try:
                        print(run(['docker', 'compose', '--project-name', 'bungee', '--file', root / 'generations' / host.current() / 'compose.json', 'exec', '-T', 'server', '/usr/local/bin/bungee-server', '--set-admin-password'], input=password))
                    finally:
                        del password
                elif args.command == 'rebuild': rebuild(host)
                elif args.command == 'geodata': install_default_geodata(host)
                elif args.command == 'maps':
                    selected_maps=args.regions.split(',') if args.regions else choose_maps()
                    if selected_maps: install_selected_maps(host,selected_maps,args.plan)
                elif args.command == 'maps-us':
                    install_default_geodata(host)
                    install_us_maps(host,args.plan)
                elif args.command == 'basemap':
                    install_basemap(host)
                elif args.command == 'update': host.update(manual=args.manual)
                elif args.command == 'datasets': host.datasets(args.maps, args.geoip, args.clear_maps, args.clear_geoip)
                elif args.command == 'configure': host.apply(CONFIG, host.metadata(host.current()))
                else:
                    print('Version:', host.metadata(host.current())['version'])
                    print('Maintenance:', (root / 'control/status').read_text().strip())
                    print('Interrupted transaction:', (root / 'transaction.json').exists())
                    print(host.engine.compose(host.current(), 'ps', '--all'))
    except (ValueError, OSError, RuntimeError, EOFError, subprocess.SubprocessError) as exc:
        sys.exit(f'Bungee operation failed: {exc}. Inspect local status; phone configuration was not changed.')
