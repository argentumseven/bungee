"""LUKS2 storage and boot ordering for the local Linux installer.

The unlock key stays on the host for unattended boot. It is never mounted into a
container or included in an application snapshot. No existing device is formatted.
"""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

IMAGE = Path('/var/lib/bungee/storage.luks')
KEY = Path('/etc/bungee/storage.key')
MAPPER = 'bungee'


def run(args):
    return subprocess.check_output([str(a) for a in args], text=True).strip()


def private(path, directory=False):
    path = Path(path)
    if path.is_symlink() or not (path.is_dir() if directory else path.is_file()):
        raise ValueError('Storage/key path must be a regular file or directory without symlinks')
    st = path.stat()
    if st.st_uid != 0 or st.st_mode & 0o077:
        raise ValueError('Storage/key paths must be root-owned with no group/other access')


def check(root):
    """Require the exact encrypted mount, not an unmounted fallback directory."""
    root = Path(root)
    result = json.loads(run(['findmnt', '--json', '--mountpoint', root, '--output', 'SOURCE,FSTYPE,TARGET']))['filesystems']
    if len(result) != 1 or result[0]['target'] != str(root) or result[0]['fstype'] != 'ext4':
        raise ValueError('Bungee requires its dedicated encrypted ext4 mount')
    source = Path(result[0]['source'])
    if source.resolve() != Path('/dev/mapper/' + MAPPER).resolve():
        raise ValueError('Bungee storage must be mounted from its LUKS mapper')
    status = run(['cryptsetup', 'status', MAPPER])
    if 'LUKS2' not in status:
        raise ValueError('Bungee storage is not an active LUKS2 mapping')
    private(root, directory=True)
    private(KEY)
    private(IMAGE)


def provision(root, size_gib=8):
    root = Path(root)
    if type(size_gib) is not int or not 2 <= size_gib <= 1048576:
        raise ValueError('Storage size must be 2–1048576 GiB')
    for command in ('cryptsetup', 'mkfs.ext4', 'mount', 'findmnt', 'fallocate', 'age', 'age-keygen', 'openssl'):
        if not shutil.which(command): raise ValueError('Install required host tool: ' + command)
    for parent in (IMAGE.parent, KEY.parent):
        if parent.is_symlink(): raise ValueError('Storage parents cannot be symlinks')
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        private(parent, directory=True)
    if root.exists() or IMAGE.exists() or KEY.exists() or Path('/dev/mapper/' + MAPPER).exists():
        raise ValueError('Storage already exists; refusing to overwrite it. Preserve it for local recovery')
    swap_line=next((line for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('SwapTotal:')),'SwapTotal: 0 kB')
    swap_growth_gib=2 if int(swap_line.split()[1]) else 1
    if shutil.disk_usage(IMAGE.parent).free < (size_gib + 2 + swap_growth_gib) * 1024**3:
        raise ValueError('Insufficient host space for encrypted storage plus system and swap-growth reserves')
    # O_EXCL/O_NOFOLLOW prevents replacing an existing key or backing image.
    for path, content in ((KEY, secrets.token_bytes(64)), (IMAGE, b'')):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
    for directory in (KEY.parent, IMAGE.parent):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    run(['fallocate', '--length', str(size_gib * 1024**3), IMAGE])
    run(['cryptsetup', 'luksFormat', '--batch-mode', '--type', 'luks2', '--cipher', 'aes-xts-plain64', '--key-size', '512', '--pbkdf', 'argon2id', '--key-file', KEY, IMAGE])
    run(['cryptsetup', 'open', '--key-file', KEY, IMAGE, MAPPER])
    run(['mkfs.ext4', '-q', '/dev/mapper/' + MAPPER])
    root.mkdir(mode=0o700)
    run(['mount', '-o', 'nodev,nosuid,noexec', '/dev/mapper/' + MAPPER, root])
    root.chmod(0o700)
    # fstab + crypttab unlock without an interactive password and fail closed.
    # Docker must wait too: container restart policies can run before Bungee units.
    for path, line in ((Path('/etc/crypttab'), f'{MAPPER} {IMAGE} {KEY} luks'),
                       (Path('/etc/fstab'), f'/dev/mapper/{MAPPER} {root} ext4 defaults,nodev,nosuid,noexec 0 2')):
        old = path.read_text() if path.exists() else ''
        if any(l.split() and not l.lstrip().startswith('#') and (l.split()[0] == MAPPER if path.name == 'crypttab' else len(l.split()) > 1 and l.split()[1] == str(root)) for l in old.splitlines()):
            raise ValueError('Existing boot storage entry needs local review; it was not overwritten')
        with path.open('a') as stream:
            stream.write('\n' + line + '\n'); stream.flush(); os.fsync(stream.fileno())
    dropin = Path('/etc/systemd/system/docker.service.d')
    dropin.mkdir(parents=True, exist_ok=True)
    (dropin / 'bungee-storage.conf').write_text(f'[Unit]\nRequiresMountsFor={root}\nAfter=systemd-cryptsetup@{MAPPER}.service\n')
    run(['systemctl', 'daemon-reload'])
    check(root)
