"""Explicit host-side US extract acquisition. Runtime containers never download maps."""
import hashlib
import json
from pathlib import Path
import platform
import re
import resource
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import urllib.error
from urllib.parse import urlsplit

VERSION = '1.31.2'
BINARIES = {
    'x86_64': '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
    'aarch64': 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1',
}
LIMIT = 25_000_000_000
USER_AGENT = 'Bungee map installer'
CATALOG_URL = 'https://build-metadata.protomaps.dev/builds.json'

def open_download(url, label, timeout=120):
    """Identify this client and retain the failed stage, without exposing redirect queries."""
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        endpoint = urlsplit(error.url)
        raise RuntimeError(f'{label}: HTTP {error.code} from {endpoint.netloc}{endpoint.path}. '
                           'The street map was not installed. Check access to this download on the host; '
                           'existing map data was preserved') from error
    except urllib.error.URLError as error:
        raise RuntimeError(f'{label}: could not reach {urlsplit(url).netloc}: {error.reason}. '
                           'Existing map data was preserved') from error

def download(url, target, limit):
    digest = hashlib.sha256()
    total = 0
    with open_download(url, 'Map extraction tool download') as response, Path(target).open('xb') as stream:
        while block := response.read(1024*1024):
            total += len(block)
            if total > limit: raise ValueError('Download exceeded its size limit')
            stream.write(block); digest.update(block)
    return digest.hexdigest()

def archive_size(text):
    match = re.search(r'archive size of ([\d.]+)\s*([kMGT]?B)', text)
    if not match: raise ValueError('Could not determine extract size; no map download started')
    # CLI uses rounded decimal human-readable units. Leave room for rounding and metadata.
    return int(float(match[1])*{'B':1,'kB':1000,'MB':1000**2,'GB':1000**3,'TB':1000**4}[match[2]]*1.02)+1024**2

def current_build(catalog):
    if not isinstance(catalog, list) or any(not isinstance(item, dict) for item in catalog):
        raise ValueError('Map catalogue has an unexpected format; existing map data was preserved')
    candidates = [item for item in catalog if re.fullmatch(r'\d{8}\.pmtiles', item.get('key','')) and str(item.get('version','')).startswith(('4.','5.'))]
    if not candidates: raise ValueError('No compatible Protomaps street-map build is available')
    return max(candidates, key=lambda item:item['key'])

def acquire(root, region, destination):
    """Keep a working copy + import copy within available encrypted capacity; never overwrite live data."""
    machine=platform.machine()
    if machine not in BINARIES: raise ValueError('US downloader supports Linux amd64/arm64 hosts')
    budget=min(LIMIT, (shutil.disk_usage(root).free-2*1024**3)//2)
    if budget < 1024**3: raise ValueError('US maps need at least 4 GiB of free encrypted space; the running overview was preserved')
    with tempfile.TemporaryDirectory(prefix='bungee-map-tool-') as work:
        work=Path(work)
        arch='arm64' if machine=='aarch64' else 'x86_64'
        asset=f'go-pmtiles_{VERSION}_Linux_{arch}.tar.gz'
        archive=work/asset
        print('Downloading the checksum-verified map extraction tool from GitHub…',flush=True)
        actual=download(f'https://github.com/protomaps/go-pmtiles/releases/download/v{VERSION}/{asset}',archive,32*1024**2)
        if actual!=BINARIES[machine]: raise ValueError('Map extraction tool checksum failed')
        with tarfile.open(archive) as tar:
            member=next(m for m in tar.getmembers() if m.name=='pmtiles')
            if not member.isfile(): raise ValueError('Unexpected map tool archive')
            binary=work/'pmtiles'
            with tar.extractfile(member) as src, binary.open('xb') as dst: shutil.copyfileobj(src,dst)
            binary.chmod(0o700)
        print(f'Reading the street-map catalogue from {CATALOG_URL}…',flush=True)
        with open_download(CATALOG_URL, 'Street-map catalogue download', timeout=60) as response:
            content=response.read(2*1024**2+1)
        if len(content)>2*1024**2: raise ValueError('Map catalogue exceeded 2 MiB; existing map data was preserved')
        try: catalog=json.loads(content)
        except (ValueError,UnicodeError) as error:
            raise ValueError('Map catalogue did not contain valid JSON; existing map data was preserved') from error
        build=current_build(catalog)
        url='https://build.protomaps.com/'+build['key']
        chosen=None
        for zoom in (15,14):
            command=[str(binary),'extract',url,str(destination),'--region',str(region),'--maxzoom',str(zoom),'--download-threads','4']
            print(f'Checking regional coverage and size at zoom {zoom}…',flush=True)
            try:
                plan=subprocess.run([*command,'--dry-run'],check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=600).stdout
            except subprocess.CalledProcessError as error:
                raise RuntimeError(f'Street-map size check failed for {url}: {(error.stdout or "")[-4096:].strip()}. '
                                   'No street-map import was started; existing map data was preserved') from error
            size=archive_size(plan)
            print(f'US street map zoom 0–{zoom}: approximately {size/1000**3:.2f} GB; available budget {budget/1000**3:.2f} GB',flush=True)
            if size <= budget: chosen=(command,zoom,size); break
        if chosen is None: raise ValueError('US street maps exceed available storage. Overview preserved; free more encrypted space and rerun maps-us')
        command,zoom,size=chosen
        def bound_file(): resource.setrlimit(resource.RLIMIT_FSIZE,(budget,budget))
        print('Downloading only US tiles (including Alaska and Hawaii). This can take a while.',flush=True)
        subprocess.run(command,check=True,timeout=6*3600,preexec_fn=bound_file)
        if destination.stat().st_size > budget: raise ValueError('US map exceeded its planned size')
        subprocess.run([str(binary),'verify',str(destination)],check=True,timeout=600)
        return {'source':url,'region':'United States, including Alaska and Hawaii','max_zoom':zoom,'bytes':destination.stat().st_size,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest() if destination.stat().st_size<1024**2 else file_digest(destination)}

def file_digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()
