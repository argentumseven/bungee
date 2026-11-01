"""Prepare APKs for the exact running server; signing secrets never enter the app container."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request

MAX_APK = 256 * 1024**2
REPOSITORY = 'https://github.com/argentumseven/bungee'


def atomic(path, value, private=False):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + secrets.token_hex(6))
    try:
        with temporary.open('x') as stream:
            stream.write(value if isinstance(value, str) else json.dumps(value) + '\n')
            stream.flush(); os.fsync(stream.fileno())
        temporary.chmod(0o600 if private else 0o644)
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally: temporary.unlink(missing_ok=True)


def setup(root):
    public = Path(root) / 'app-updates'
    if public.is_symlink(): raise ValueError('Invalid APK directory')
    public.mkdir(exist_ok=True); public.chmod(0o755)


def fetch(url, target=None, limit=64*1024, progress=None):
    request = urllib.request.Request(url, headers={'User-Agent': 'Bungee server APK updater', 'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if int(response.headers.get('Content-Length', 0)) > limit: raise ValueError('APK download exceeds size limit')
        if target is None:
            data = response.read(limit+1)
            if len(data) > limit: raise ValueError('APK metadata exceeds size limit')
            return json.loads(data)
        size = 0
        total = int(response.headers.get('Content-Length', 0))
        if progress: progress(0, total)
        with target.open('xb') as output:
            while chunk := response.read(1024*1024):
                size += len(chunk)
                if size > limit: raise ValueError('APK download exceeds size limit')
                output.write(chunk)
                if progress: progress(size, total)
            output.flush(); os.fsync(output.fileno())
        return size


def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_build(build, commit, version):
    if build.get('commit') != commit or build.get('version') != version:
        raise ValueError('APK does not match the running server')
    if not re.fullmatch('[a-f0-9]{64}', build.get('sha256', '')):
        raise ValueError('Invalid APK checksum')
    code = build.get('android_version_code')
    if type(code) is not int or not 1 <= code <= 2_100_000_000:
        raise ValueError('APK release has no valid version code')
    return code


def run(args):
    # Never put passwords in argv, Docker environment, logs, or release metadata.
    return subprocess.check_output([str(arg) for arg in args], text=True, stderr=subprocess.PIPE, timeout=900).strip()


def prepare(root, metadata):
    root = Path(root)
    setup(root)
    public = root / 'app-updates'
    def report(stage, message, **details):
        atomic(public/'status.json', {'state':'preparing','version':metadata['version'],'stage':stage,'message':message,**details})
    report('resolving', 'Checking the APK for server ' + metadata['version'] + '…')
    image = metadata['images']['server']
    inspected = json.loads(run(['docker', 'image', 'inspect', image]))[0]
    commit = (inspected.get('Config', {}).get('Labels') or {}).get('dev.bungee.source-commit', '')
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('Running server has no official source commit; APK preparation unavailable for this custom build')
    existing = json.loads((public/'release.json').read_text()) if (public/'release.json').exists() else {}
    if existing and (not (root/'volumes/tls-data/android-signing/bungee.p12').is_file() or not (root/'volumes/tls-data/android-signing/password').is_file()):
        raise ValueError('APK signing identity is missing; restore its encrypted backup')
    if existing.get('commit') == commit and (public / (existing['sha256']+'.apk')).is_file():
        atomic(public/'status.json', {'state':'ready','version':metadata['version']}); return
    # Reuse the map storage calculation: filesystem free space, swap growth,
    # system headroom and the next complete encrypted backup are reserved.
    import map_manager
    if map_manager.capacity(root)['available_bytes'] < 2*MAX_APK + 512*1024**2:
        raise ValueError('Not enough safe free space to stage the APK and signing tools')
    base = REPOSITORY + '/releases/download/android-' + commit[:12] + '/'
    report('metadata', 'Finding the verified APK for server ' + metadata['version'] + '…')
    build = fetch(base+'build.json')
    code = validate_build(build, commit, metadata['version'])
    signer_file = root/'android-signer.Dockerfile'
    signer_image = 'bungee-android-signer:' + digest(signer_file)[:16]
    try: run(['docker','image','inspect',signer_image])
    except subprocess.CalledProcessError:
        report('tools', 'Installing the APK signing tools. The first preparation can take several minutes.')
        run(['docker','build','--pull','-t',signer_image,'-f',signer_file,signer_file.parent/'signer-context'])
    # tls-data is encrypted and already part of every authenticated cold snapshot.
    # Only tls-data/issued is mounted in the runtime container, never these keys.
    keys = root/'volumes/tls-data/android-signing'
    keys.mkdir(exist_ok=True, mode=0o700); keys.chmod(0o700)
    key = keys/'bungee.p12'; password = keys/'password'
    if not key.exists() and existing:
        raise ValueError('APK signing key is missing; restore its encrypted backup instead of generating a different identity')
    if not password.exists():
        if key.exists(): raise ValueError('APK signing password is missing; restore its encrypted backup')
        atomic(password, secrets.token_urlsafe(48)+'\n', private=True)
    with tempfile.TemporaryDirectory(prefix='.prepare-', dir=public) as temporary:
        work = Path(temporary)
        def tool(*args):
            return run(['docker','run','--rm','--user',f'{os.getuid()}:{os.getgid()}','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','64','--tmpfs','/tmp:size=64m',
                '--label','org.bungee.helper=bungee-archive','--ulimit','core=0','-v',str(keys)+':/keys','-v',str(work)+':/work',signer_image,*args])
        if not key.exists():
            (keys/'pending.p12').unlink(missing_ok=True)
            tool('keytool','-genkeypair','-keystore','/keys/pending.p12','-storetype','PKCS12','-storepass:file','/keys/password','-keypass:file','/keys/password','-alias','bungee','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=Bungee household updates','-noprompt')
            os.replace(keys/'pending.p12',key); key.chmod(0o600)
            with key.open('rb') as stream: os.fsync(stream.fileno())
            fd=os.open(keys,os.O_RDONLY|os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)
        def download_progress(size, total):
            report('downloading', 'Downloading server ' + metadata['version'] + ' APK…', downloaded_bytes=size, total_bytes=total)
        fetch(base+'bungee.apk', work/'source.apk', MAX_APK, progress=download_progress)
        report('verifying', 'Verifying the downloaded APK checksum, package and version…')
        if digest(work/'source.apk') != build['sha256']: raise ValueError('Published APK checksum mismatch')
        badging_all = tool('aapt','dump','badging','/work/source.apk')
        if 'application-debuggable' in badging_all: raise ValueError('Debuggable APK cannot be distributed as a server update')
        badging=badging_all.splitlines()[0]
        if f"name='org.bungee.app'" not in badging or f"versionCode='{code}'" not in badging or f"versionName='{metadata['version']}'" not in badging:
            raise ValueError('APK package/version does not match release metadata')
        # Keep Gradle’s native-library page alignment intact (including 16 KiB phones).
        tool('zipalign','-c','-p','4','/work/source.apk')
        report('signing', 'Signing the APK with this server’s existing signing identity…')
        tool('apksigner','sign','--ks','/keys/bungee.p12','--ks-key-alias','bungee','--ks-pass','file:/keys/password','--out','/work/signed.apk','/work/source.apk')
        verification = tool('apksigner','verify','--print-certs','/work/signed.apk')
        match = re.search(r'Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})',verification)
        if not match: raise ValueError('Cannot verify server APK signature')
        signer = match.group(1)
        if existing and existing.get('signer_sha256') != signer: raise ValueError('APK signing identity changed; restore the original key')
        sha = digest(work/'signed.apk'); size = (work/'signed.apk').stat().st_size
        (work/'signed.apk').chmod(0o644)
        os.replace(work/'signed.apk',public/(sha+'.apk'))
        atomic(public/'release.json',{'version':metadata['version'],'version_code':code,'commit':commit,'sha256':sha,'signer_sha256':signer,'size':size,'chunk_size':131072})
        atomic(public/'status.json',{'state':'ready','version':metadata['version']})
    # Keep the previous file for a phone already downloading. No unbounded APK growth.
    files = sorted(public.glob('*.apk'), key=lambda p:p.stat().st_mtime, reverse=True)
    for old in files[2:]: old.unlink()


def tick(root, metadata):
    setup(root)
    with (Path(root)/'host.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return
        if (Path(root)/'transaction.json').exists(): return
        for stale in (Path(root)/'app-updates').glob('.prepare-*'):
            if stale.is_dir() and not stale.is_symlink(): shutil.rmtree(stale)
        try: prepare(root, metadata())
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            # Never publish subprocess output, command arguments or secret paths.
            previous = {}
            try: previous = json.loads((Path(root)/'app-updates/status.json').read_text())
            except (OSError, ValueError): pass
            if not isinstance(previous, dict): previous = {}
            if isinstance(error, ValueError): message = str(error)
            elif isinstance(error, urllib.error.HTTPError): message = f'APK download returned HTTP {error.code}; automatic retry in one minute'
            elif isinstance(error, subprocess.SubprocessError): message = 'APK signing tool failed; check bungee-app-updates.service on the host. Automatic retry in one minute.'
            else: message = 'APK download or storage unavailable; check host connectivity and free space. Automatic retry in one minute.'
            atomic(Path(root)/'app-updates/status.json',{'state':'waiting','version':previous.get('version'),'stage':previous.get('stage'),'message':message[:240]})
