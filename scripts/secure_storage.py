"""LUKS2 storage and boot ordering for the local Linux installer.

The unlock key stays on the host for unattended boot. It is never mounted into a
container or included in an application snapshot. No existing device is formatted.
"""
import json
import os
import re
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


BOOT_FILES = (Path('/etc/crypttab'), Path('/etc/fstab'))
SYSTEMD = Path('/etc/systemd/system')
SYSTEMD_VENDOR_ROOTS = (Path('/usr/lib/systemd'), Path('/lib/systemd'))
BOOT_COMPONENTS = (
    ('system/systemd-cryptsetup@.service', 'systemd cryptsetup service'),
    ('system-generators/systemd-cryptsetup-generator', 'systemd cryptsetup generator'),
    ('systemd-cryptsetup', 'systemd unlock helper'),
)


def require_boot_support():
    for relative, label in BOOT_COMPONENTS:
        if not any((base/relative).is_file() and (relative.startswith('system/') or os.access(base/relative, os.X_OK)) for base in SYSTEMD_VENDOR_ROOTS):
            raise ValueError(f'Missing {label}. On Debian install systemd-cryptsetup before installing or repairing Bungee')


def boot_entries(root, legacy=False):
    crypt_options = 'luks' if legacy else 'luks,nofail'
    mount_options = 'defaults,nodev,nosuid,noexec' + ('' if legacy else ',nofail,x-systemd.device-timeout=30s')
    return (f'{MAPPER} {IMAGE} {KEY} {crypt_options}',
            f'/dev/mapper/{MAPPER} {root} ext4 {mount_options} 0 2')


def storage_dropin(root):
    # nofail allows Debian to boot, but never allows Docker to bypass the mount.
    return f'[Unit]\nRequiresMountsFor={root}\nAfter=systemd-cryptsetup@{MAPPER}.service\n'


def boot_edits(root, create=False):
    root = Path(root)
    if str(root) == '/' or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(root)) or '..' in root.parts:
        raise ValueError('Use an absolute Bungee root without spaces or parent traversal')
    for parent in (root, *root.parents):
        if parent.is_symlink(): raise ValueError('Bungee root cannot contain symlinks')
    edits = []
    for index, (path, entry) in enumerate(zip(BOOT_FILES, boot_entries(root))):
        if path.is_symlink() or (path.exists() and (not path.is_file() or path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o022)):
            raise ValueError(f'Unsafe boot configuration: {path}')
        old = path.read_text() if path.exists() else ''
        rows = old.splitlines(keepends=True)
        def candidate(row):
            fields = row.split()
            if not fields or row.lstrip().startswith('#'): return False
            return fields[0] == MAPPER if index == 0 else fields[0] == f'/dev/mapper/{MAPPER}' or (len(fields) > 1 and fields[1] == str(root))
        matches = [i for i, row in enumerate(rows) if candidate(row)]
        if create:
            if matches: raise ValueError(f'Existing Bungee boot entry in {path}; existing configuration preserved')
            content = old + ('\n' if old and not old.endswith('\n') else '') + entry + '\n'
        else:
            allowed = (boot_entries(root, legacy=True)[index].split(), entry.split())
            if len(matches) != 1 or rows[matches[0]].split() not in allowed:
                raise ValueError(f'Expected one unchanged installer-owned Bungee entry in {path}; inspect custom configuration locally')
            # Preserve comments, whitespace and all unrelated records verbatim.
            if rows[matches[0]].split() == entry.split(): content = old
            else:
                rows[matches[0]] = entry + '\n'
                content = ''.join(rows)
        edits.append((path, content))
    dropin = SYSTEMD/'docker.service.d/bungee-storage.conf'
    if dropin.is_symlink() or (dropin.exists() and (not dropin.is_file() or dropin.stat().st_uid != os.geteuid() or dropin.stat().st_mode & 0o022 or dropin.read_text() != storage_dropin(root))):
        raise ValueError('Docker storage dependency differs from the installer; inspect it locally')
    if dropin.parent.is_symlink() or (dropin.parent.exists() and (dropin.parent.stat().st_uid != os.geteuid() or dropin.parent.stat().st_mode & 0o022)):
        raise ValueError('Docker drop-in directory must be owned by root and not writable by other users')
    edits.append((dropin, storage_dropin(root)))
    return edits


def write_boot(edits):
    for path, content in edits:
        if path.exists() and path.read_text() == content: continue
        path.parent.mkdir(parents=True, exist_ok=True)
        previous = path.stat() if path.exists() else None
        temporary = path.with_name(path.name + '.' + secrets.token_hex(8))
        try:
            with temporary.open('x') as stream:
                stream.write(content); stream.flush()
                os.fchmod(stream.fileno(), previous.st_mode & 0o777 if previous else 0o644)
                if previous: os.fchown(stream.fileno(), previous.st_uid, previous.st_gid)
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)
        finally: temporary.unlink(missing_ok=True)


def repair_boot(root):
    require_boot_support()
    private(IMAGE); private(KEY)
    # Works while /opt/bungee is unmounted and Docker cannot start. Never open,
    # format or replace storage, keys, pairing, containers or host data here.
    write_boot(boot_edits(root))
    run(['systemctl', 'daemon-reload'])


def provision(root, size_gib=8):
    root = Path(root)
    if type(size_gib) is not int or not 2 <= size_gib <= 1048576:
        raise ValueError('Storage size must be 2–1048576 GiB')
    require_boot_support()
    boot_edits(root, create=True)  # Refuse conflicts before allocating or formatting anything.
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
    write_boot(boot_edits(root, create=True))
    run(['systemctl', 'daemon-reload'])
    check(root)
