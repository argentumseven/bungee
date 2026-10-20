"""Generate/renew a local CA-signed certificate on encrypted host storage."""
import ipaddress
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time


def run(args):
    return subprocess.check_output([str(a) for a in args], stderr=subprocess.PIPE, text=True).strip()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def ensure(directory, hostname):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Public CA material can be exported. Every private key remains under this mount.
    root_key, root_cert = directory / 'root.key', directory / 'root.crt'
    if root_key.exists() != root_cert.exists():
        raise ValueError('Incomplete CA; restore its key/certificate rather than replacing its identity')
    if not root_key.exists():
        staging = directory / ('ca-' + secrets.token_hex(8))
        staging.mkdir(mode=0o700)
        try:
            run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-sha256', '-days', '3650', '-subj', '/CN=Bungee local administrator CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', staging / 'root.key', '-out', staging / 'root.crt'])
            for name in ('root.key', 'root.crt'):
                with (staging / name).open('rb') as stream: os.fsync(stream.fileno())
                os.replace(staging / name, directory / name)
            sync_dir(directory)
        finally: shutil.rmtree(staging)
    issued = directory / 'issued'
    issued.mkdir(exist_ok=True, mode=0o700)
    public = issued / ('.root-' + secrets.token_hex(8))
    shutil.copyfile(root_cert, public)
    with public.open('rb') as stream: os.fsync(stream.fileno())
    os.replace(public, issued / 'root.crt')
    sync_dir(issued)
    (issued / 'root.crt').chmod(0o644)
    current = issued / 'current'
    # Renew for changed names or fewer than 30 days remaining. No network/ACME.
    if current.exists() and (current / 'hostname').read_text() == hostname:
        if subprocess.run(['openssl', 'x509', '-checkend', str(30*86400), '-noout', '-in', str(current / 'server.crt')], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE).returncode == 0:
            return False
    token = 'leaf-' + secrets.token_hex(8)
    leaf = issued / token; leaf.mkdir(mode=0o700)
    try:
        try: ipaddress.ip_address(hostname); san = 'IP:' + hostname
        except ValueError: san = 'DNS:' + hostname
        extensions = leaf / 'extensions'
        extensions.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=' + san + '\n')
        run(['openssl', 'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=Bungee administrator', '-keyout', leaf / 'server.key', '-out', leaf / 'server.csr'])
        run(['openssl', 'x509', '-req', '-in', leaf / 'server.csr', '-CA', root_cert, '-CAkey', root_key, '-set_serial', str(secrets.randbits(159) or 1), '-days', '90', '-sha256', '-extfile', extensions, '-out', leaf / 'server.crt'])
        (leaf / 'hostname').write_text(hostname)
        (leaf / 'server.csr').unlink(); extensions.unlink()
        for file in leaf.iterdir(): file.chmod(0o600)
        # Only the leaf key is exposed to Rust; the CA private key stays host-only.
        for file in leaf.iterdir():
            with file.open('rb') as stream: os.fsync(stream.fileno())
        sync_dir(leaf)
        link = issued / ('.current-' + secrets.token_hex(8))
        link.symlink_to(token); os.replace(link, current)
        sync_dir(issued)
    except Exception:
        shutil.rmtree(leaf); raise
    for old in issued.glob('leaf-*'):
        if old != leaf and time.time() - old.stat().st_mtime > 86400: shutil.rmtree(old)
    return True
