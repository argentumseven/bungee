#!/usr/bin/env python3
"""Local Linux installer and transactional Compose updater. Never runs inside the app."""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent
module_path = HERE / 'network_config.py' if (HERE / 'network_config.py').exists() else SOURCE / 'deploy/network_config.py'
spec = importlib.util.spec_from_file_location('network_config', module_path)
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)
REGISTRY = 'ghcr.io/argentumseven/bungee'
VERSION = '0.1.0-alpha.7'
VOLUMES = ('server-data', 'gateway-private', 'gateway-peers', 'caddy-data', 'caddy-config')


def run(args, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=True, timeout=kwargs.pop('timeout', 900), **kwargs).strip()


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


def version(value):
    if not isinstance(value, str): raise ValueError('Release version must be text')
    match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-alpha\.([1-9][0-9]*))?', value)
    if not match: raise ValueError('Unsupported release version')
    major, minor, patch, alpha = match.groups()
    return (int(major), int(minor), int(patch), 1 if alpha is None else 0, int(alpha or 0))


def release(data, channel, current=None):
    if not isinstance(data, dict) or set(data) != {'format', 'host_api', 'data_contract', 'version', 'published_at', 'images'}:
        raise ValueError('Invalid release manifest fields')
    if any(type(data[k]) is not int or data[k] != 1 for k in ('format', 'host_api', 'data_contract')):
        raise ValueError('This release needs a reviewed installer/data-format migration')
    proposed = version(data['version'])
    if channel == 'stable' and proposed[3] != 1: raise ValueError('Stable updates cannot install previews')
    if type(data['published_at']) is not int or not 1 <= data['published_at'] <= int(time.time()) + 3600:
        raise ValueError('Invalid release time')
    if not isinstance(data['images'], dict) or set(data['images']) != {'server', 'gateway', 'web'}:
        raise ValueError('A release must name all three images')
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
    common = {'restart': 'unless-stopped', 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'read_only': True}
    def service(image, **values): return {**common, 'image': image, **values}
    return {'name': 'bungee', 'services': {
        'gateway': service(images['gateway'], cap_add=['NET_ADMIN', 'CHOWN', 'DAC_OVERRIDE'], tmpfs=['/run:mode=0700'],
            environment={'BUNGEE_WG_PORT': str(c['wg_port']), 'BUNGEE_ADMIN_SUBNETS': ' '.join(c['admin_subnets']), 'BUNGEE_UPDATE_CONTROL': '/control'},
            ports=[f"{network.bracket(c['bind_ip'])}:{c['web_port']}:443/tcp", f"{c['wg_port']}:{c['wg_port']}/udp"],
            sysctls={'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0'},
            volumes=['gateway-private:/private', 'gateway-peers:/peers', {'type': 'bind', 'source': str(root / 'control'), 'target': '/control', 'read_only': True}],
            healthcheck={'test': ['CMD', 'wg', 'show', 'wg0'], 'interval': '10s', 'timeout': '3s', 'retries': 5}),
        'server': service(images['server'], network_mode='service:gateway', depends_on={'gateway': {'condition': 'service_healthy'}},
            environment={'BUNGEE_PUBLIC_ORIGIN': network.origin(c), 'BUNGEE_ADMIN_BIND': '127.0.0.1:8080', 'BUNGEE_DEVICE_BIND': '10.77.0.1:8081', 'BUNGEE_WG_ENDPOINT': f"{network.bracket(c['endpoint_ip'])}:{c['wg_port']}"},
            tmpfs=['/tmp:size=16m'], volumes=['server-data:/state', 'gateway-peers:/state/wireguard']),
        'web': service(images['web'], network_mode='service:gateway', depends_on={'server': {'condition': 'service_healthy'}},
            cap_add=['NET_BIND_SERVICE'], tmpfs=['/tmp:size=16m'],
            environment={'BUNGEE_DOMAIN': c['web_host'], 'BUNGEE_ADMIN_SUBNETS': ' '.join(c['admin_subnets'])},
            volumes=['caddy-data:/data', 'caddy-config:/config'],
            healthcheck={'test': ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8090/healthz'], 'interval': '10s', 'timeout': '3s', 'retries': 5})
    }, 'volumes': {v: {} for v in VOLUMES}}


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
        if len(rows) != 3 or {r['Service'] for r in rows} != {'gateway', 'server', 'web'} or any(r['State'] != 'running' or r.get('Health') != 'healthy' for r in rows):
            raise RuntimeError('All three services must be running and healthy')
    def volumes(self):
        for name in VOLUMES:
            real = self.project + '_' + name
            value = json.loads(run(['docker', 'volume', 'inspect', real]))[0]
            if (value.get('Labels') or {}).get('com.docker.compose.project') != self.project or value['Labels'].get('com.docker.compose.volume') != name:
                raise ValueError('Refusing an unowned volume')
    def storage_ready(self, generation):
        self.volumes()
        image = read(self.root / 'generations' / generation / 'release.json')['images']['server']
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--entrypoint', 'du']
        for index, name in enumerate(VOLUMES): args += ['--mount', f'type=volume,src={self.project}_{name},dst=/data{index},readonly']
        sizes = run([*args, image, '-sb', *[f'/data{i}' for i in range(len(VOLUMES))]])
        required = sum(int(line.split()[0]) for line in sizes.splitlines()) * 12 // 10 + 1024 ** 3
        if shutil.disk_usage(self.root).free < required:
            raise ValueError('Insufficient backup space: free a full snapshot plus 20% and 1 GiB before updating; primary history is never automatically deleted')
    def archive(self, generation, directory, restore=False):
        self.volumes()
        image = read(self.root / 'generations' / generation / 'release.json')['images']['server']
        for name in VOLUMES:
            args = ['docker', 'run', '--rm', '--label', f'org.bungee.helper={self.project}-archive', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true', '--entrypoint', 'sh', '--mount', f'type=volume,src={self.project}_{name},dst=/data' + ('' if restore else ',readonly'), '--mount', f'type=bind,src={directory},dst=/backup' + (',readonly' if restore else ''), image, '-ec']
            if restore:
                command = f'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {{}} +; tar -xpf /backup/{name}.tar -C /data'
            else:
                command = f'umask 077; tar -cpf /backup/{name}.tar -C /data .'
            try: run([*args, command])
            finally: self.stop_helpers()


class Host:
    def __init__(self, root, engine=None): self.root = Path(root); self.engine = engine or Engine(self.root)
    def current(self):
        gen = read(self.root / 'current.json')['generation']
        if not re.fullmatch(r'[a-f0-9]{24}', gen): raise ValueError('Invalid generation pointer; preserve files for local recovery')
        return gen
    def metadata(self, gen): return read(self.root / 'generations' / gen / 'release.json')
    def stage(self, config, metadata):
        gen = secrets.token_hex(12)
        directory = self.root / 'generations' / gen
        directory.mkdir(parents=True, mode=0o700)
        atomic(directory / 'config.json', config)
        atomic(directory / 'release.json', metadata)
        atomic(directory / 'compose.json', compose(config, metadata['images'], self.root))
        return gen
    def journal(self, value): atomic(self.root / 'transaction.json', value)
    def backup(self, gen, backup):
        backup.mkdir(parents=True, mode=0o700)
        self.engine.archive(gen, backup)
        for name in VOLUMES:
            with (backup / f'{name}.tar').open('rb') as stream: os.fsync(stream.fileno())
        sums = {name: checksum(backup / f'{name}.tar') for name in VOLUMES}
        atomic(backup / 'complete.json', sums)
    def restore(self, gen, backup):
        sums = read(backup / 'complete.json')
        if set(sums) != set(VOLUMES): raise ValueError('Incomplete recovery snapshot')
        for name in VOLUMES:
            if checksum(backup / f'{name}.tar') != sums[name]: raise ValueError('Recovery snapshot checksum mismatch')
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
    def update(self, manual=False):
        self.recover()
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


def ask(prompt, default=None):
    value = input(prompt + (f' [{default}]' if default is not None else '') + ': ').strip()
    return value or default or ''


def guided(existing=None):
    c = existing or {}
    print('Bungee local setup. No router settings, phone ownership or host firewall will be changed.')
    while True:
        try:
            wg = network.port(ask('WireGuard UDP port (51820 forbidden)', c.get('wg_port')), True)
            web = network.port(ask('Dashboard HTTPS TCP port', c.get('web_port', 8443)))
            endpoint = network.address(ask('Numeric home-server address reachable by phones', c.get('endpoint_ip')), endpoint=True)
            bind = network.address(ask('Dashboard bind IP; 127.0.0.1 means local/SSH access only', c.get('bind_ip', '127.0.0.1')))
            host = network.hostname(ask('Dashboard address used in your browser (no port)', c.get('web_host', bind if bind not in ('0.0.0.0', '::') else None)))
            print('Enter administrator IPs/prefixes separated by spaces or commas. No allow-everyone option.')
            nets = network.admin_networks(ask('Allowed administrator networks', ' '.join(c['admin_subnets']) if c.get('admin_subnets') else None))
            channel = ask('Update channel: stable or preview', c.get('channel', 'stable'))
            auto = ask('Check daily for tested images in that channel? yes/no', 'yes' if c.get('auto_updates', True) else 'no')
            if auto not in ('yes', 'no'): raise ValueError('Answer yes or no')
            return network.validate({'wg_port': wg, 'web_port': web, 'endpoint_ip': endpoint, 'bind_ip': bind, 'web_host': host, 'admin_subnets': nets, 'channel': channel, 'auto_updates': auto == 'yes'})
        except ValueError as exc: print('Please correct:', exc)


def preflight(root, installing=False, config=None):
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
    if installing:
        if root.exists(): raise ValueError('Installation directory already exists; use configure/status/update instead of overwriting it')
        if run(['docker', 'ps', '--all', '--quiet', '--filter', 'label=com.docker.compose.project=bungee']): raise ValueError('An existing Bungee stack exists; refusing to replace it')
        if run(['docker', 'volume', 'ls', '--quiet', '--filter', 'label=com.docker.compose.project=bungee']): raise ValueError('Existing Bungee volumes found; preserve them and follow migration instructions')
        for protocol, number in ((socket.SOCK_DGRAM, config['wg_port']), (socket.SOCK_STREAM, config['web_port'])):
            with socket.socket(socket.AF_INET6 if ':' in config['bind_ip'] else socket.AF_INET, protocol) as sock:
                sock.bind((config['bind_ip'] if protocol == socket.SOCK_STREAM else ('::' if ':' in config['bind_ip'] else '0.0.0.0'), number))


def systemd(root):
    command = f'/usr/bin/python3 {root}/bungee-host.py'
    units = {
        'bungee-recover.service': f'[Unit]\nDescription=Recover an interrupted Bungee update\nRequires=docker.service\nAfter=docker.service\nBefore=bungee-update.service\n[Service]\nType=oneshot\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nUMask=0077\nExecStart={command} recover --root {root}\nTimeoutStartSec=900\n[Install]\nWantedBy=multi-user.target\n',
        'bungee-update.service': f'[Unit]\nDescription=Check and transactionally update Bungee\nRequires=docker.service\nAfter=docker.service bungee-recover.service\nOnFailure=bungee-recover.service\n[Service]\nType=oneshot\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=full\nUMask=0077\nExecStart={command} update --root {root}\nTimeoutStartSec=1800\n',
        'bungee-update.timer': '[Unit]\nDescription=Daily Bungee security update check\n[Timer]\nOnBootSec=15min\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n'}
    for name, content in units.items(): atomic(Path('/etc/systemd/system') / name, content)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', 'bungee-recover.service'])
    run(['systemctl', 'enable', '--now', 'bungee-update.timer'])


def install(root, config):
    preflight(root, installing=True, config=config)
    # Invocation-specific tags prevent two first-install builds from mixing images.
    install_tag = 'install-' + secrets.token_hex(8)
    run(['docker', 'build', '--pull', '-t', f'bungee-gateway:{install_tag}', '-f', 'deploy/wireguard/Dockerfile', 'deploy'], cwd=SOURCE)
    run(['docker', 'build', '--pull', '-t', f'bungee-server:{install_tag}', '.'], cwd=SOURCE)
    run(['docker', 'build', '--pull', '-t', f'bungee-web:{install_tag}', '-f', 'deploy/web.Dockerfile', 'deploy'], cwd=SOURCE)
    run(['docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--entrypoint', 'sh', f'bungee-gateway:{install_tag}', '-ec', 'ip link add bungee-check type wireguard; ip link delete bungee-check'])
    root.mkdir(mode=0o700)
    with (root / 'host.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        atomic(root / 'control/status', 'closed\n')
        for source, target in ((Path(__file__), root / 'bungee-host.py'), (module_path, root / 'network_config.py')):
            atomic(target, source.read_text())
        images = {name: json.loads(run(['docker', 'image', 'inspect', f'bungee-{name}:{install_tag}']))[0]['Id'] for name in ('gateway', 'server', 'web')}
        metadata = {'format': 1, 'host_api': 1, 'data_contract': 1, 'version': VERSION, 'published_at': 0, 'images': images}
        host = Host(root)
        generation = host.stage(config, metadata)
        atomic(root / 'current.json', {'generation': generation})
        try:
            host.engine.up(generation)
            host.engine.healthy(generation)
            certificate = host.engine.compose(generation, 'exec', '-T', 'web', 'cat', '/data/caddy/pki/authorities/local/root.crt')
            atomic(root / 'root.crt', certificate + '\n')
            # Recovery must be installed before external admission is opened.
            systemd(root)
            host.engine.hold(False)
        except Exception:
            host.engine.hold(True)
            host.engine.no_restart(generation)
            host.engine.down(generation)
            raise RuntimeError('Installation did not finish; admission is closed and existing volumes are preserved. Diagnose with status/local logs, then recover')
    print('Installed:', network.origin(config))
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest().upper()
    print('Local CA SHA-256 fingerprint:', ':'.join(fingerprint[i:i+2] for i in range(0, len(fingerprint), 2)))
    print('Public CA certificate:', root / 'root.crt')
    print('Trust the local CA using an authenticated channel before signing in. No TLS-verification bypass is provided.')
    print(f'Local operations: sudo python3 {root}/bungee-host.py status --root {root}')
    print('Read the password locally with docker compose -p bungee -f', root / 'generations' / generation / 'compose.json', 'exec -T server cat /state/admin-password')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'configure', 'update', 'recover', 'status'])
    parser.add_argument('--root', type=Path, default=Path('/opt/bungee'))
    parser.add_argument('--config', type=Path, help='Explicit JSON answers for unattended installation/configuration')
    parser.add_argument('--plan', action='store_true', help='Validate answers and print a plan; write nothing and contact no services')
    parser.add_argument('--start', action='store_true', help='With recover: explicitly start a stopped/unfinished installation')
    parser.add_argument('--manual', action='store_true', help='With update: explicitly check even if automatic checks are disabled')
    args = parser.parse_args()
    if args.start and args.command != 'recover': parser.error('--start is only valid with recover')
    if args.manual and args.command != 'update': parser.error('--manual is only valid with update')
    if args.config and args.command not in ('install', 'configure'): parser.error('--config is only valid with install/configure')
    os.umask(0o077)
    try:
        root = args.root.absolute()
        host = Host(root)
        if args.command in ('install', 'configure'):
            existing = read(root / 'generations' / host.current() / 'config.json') if args.command == 'configure' else None
            CONFIG = network.validate(read(args.config)) if args.config else guided(existing)
            print(json.dumps({**CONFIG, 'dashboard_url': network.origin(CONFIG)}, indent=2))
            if args.plan: sys.exit(0)
            if not args.config and ask('Apply this configuration? Type INSTALL' if args.command == 'install' else 'Apply this configuration? Type APPLY') != ('INSTALL' if args.command == 'install' else 'APPLY'):
                sys.exit('No changes made')
        elif args.plan: raise ValueError('--plan is for install/configure only')
        if args.command == 'install': install(root, CONFIG)
        else:
            preflight(root)
            with (root / 'host.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if args.command == 'recover':
                    host.recover()
                    if args.start and not (root / 'transaction.json').exists():
                        host.engine.up(host.current()); host.engine.healthy(host.current()); systemd(root); host.finish(host.current())
                elif args.command == 'update': host.update(manual=args.manual)
                elif args.command == 'configure': host.apply(CONFIG, host.metadata(host.current()))
                else:
                    print('Version:', host.metadata(host.current())['version'])
                    print('Maintenance:', (root / 'control/status').read_text().strip())
                    print('Interrupted transaction:', (root / 'transaction.json').exists())
                    print(host.engine.compose(host.current(), 'ps', '--all'))
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        sys.exit(f'Bungee operation failed: {exc}. Inspect local status; phone configuration was not changed.')
