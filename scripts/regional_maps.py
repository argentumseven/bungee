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

VERSION = '1.31.2'
BINARIES = {
    'x86_64': '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
    'aarch64': 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1',
}
LIMIT = 25_000_000_000

def download(url, target, limit):
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(url, timeout=120) as response, Path(target).open('xb') as stream:
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
        actual=download(f'https://github.com/protomaps/go-pmtiles/releases/download/v{VERSION}/{asset}',archive,32*1024**2)
        if actual!=BINARIES[machine]: raise ValueError('Map extraction tool checksum failed')
        with tarfile.open(archive) as tar:
            member=next(m for m in tar.getmembers() if m.name=='pmtiles')
            if not member.isfile(): raise ValueError('Unexpected map tool archive')
            binary=work/'pmtiles'
            with tar.extractfile(member) as src, binary.open('xb') as dst: shutil.copyfileobj(src,dst)
            binary.chmod(0o700)
        with urllib.request.urlopen('https://build-metadata.protomaps.dev/builds.json',timeout=60) as response:
            catalog=json.loads(response.read(2*1024**2))
        build=current_build(catalog)
        url='https://build.protomaps.com/'+build['key']
        chosen=None
        for zoom in (15,14):
            command=[str(binary),'extract',url,str(destination),'--region',str(region),'--maxzoom',str(zoom),'--download-threads','4']
            plan=subprocess.run([*command,'--dry-run'],check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=600).stdout
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
