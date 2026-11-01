"""Explicit host-side US extract acquisition. Runtime containers never download maps."""
import hashlib
import contextlib
import ctypes
import json
from pathlib import Path
import platform
import os
import re
import resource
import signal
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit

VERSION = '1.31.2'
BINARIES = {
    'x86_64': '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
    'aarch64': 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1',
}
LIMIT = 25_000_000_000
MAX_REGIONS = 256

class MapCancelled(ValueError):
    pass
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


def region_catalog(path):
    data=json.loads(Path(path).read_text())
    regions=data['regions']
    if data.get('format')!=1 or len(regions)>512: raise ValueError('Invalid region catalogue')
    result={}
    for item in regions:
        identifier=item['id']
        if not re.fullmatch('[a-z][a-z0-9-]{1,47}',identifier) or identifier in result:
            raise ValueError('Invalid or duplicate map region')
        result[identifier]=item
    return result


@contextlib.contextmanager
def extraction_tool(progress=lambda message: None):
    machine=platform.machine()
    if machine not in BINARIES: raise ValueError('Map downloads support Linux amd64/arm64 hosts')
    with tempfile.TemporaryDirectory(prefix='bungee-map-tool-') as directory:
        work=Path(directory)
        arch='arm64' if machine=='aarch64' else 'x86_64'
        asset=f'go-pmtiles_{VERSION}_Linux_{arch}.tar.gz'
        archive=work/asset
        progress('Downloading and verifying the map extraction tool')
        if download(f'https://github.com/protomaps/go-pmtiles/releases/download/v{VERSION}/{asset}',archive,32*1024**2)!=BINARIES[machine]:
            raise ValueError('Map extraction tool checksum failed')
        binary=work/'pmtiles'
        with tarfile.open(archive) as tar:
            member=next(m for m in tar.getmembers() if m.name=='pmtiles')
            if not member.isfile(): raise ValueError('Unexpected map tool archive')
            with tar.extractfile(member) as src,binary.open('xb') as dst: shutil.copyfileobj(src,dst)
        binary.chmod(0o700)
        yield binary,work


def published_build():
    with open_download(CATALOG_URL,'Street-map catalogue download',timeout=60) as response:
        content=response.read(2*1024**2+1)
    if len(content)>2*1024**2: raise ValueError('Map catalogue exceeded 2 MiB')
    try: return current_build(json.loads(content))['key']
    except (ValueError,UnicodeError) as error: raise ValueError('No usable compatible street-map build in the catalogue') from error


def selection(catalog, identifiers):
    if not isinstance(identifiers,list) or not 1<=len(identifiers)<=MAX_REGIONS or any(not isinstance(value,str) for value in identifiers) or len(set(identifiers))!=len(identifiers):
        raise ValueError('Select 1–256 distinct map regions')
    if any(not isinstance(identifier,str) or identifier not in catalog for identifier in identifiers):
        raise ValueError('Unknown map region')
    return [catalog[identifier] for identifier in identifiers]


def _child_limits(max_bytes=None):
    parent=os.getpid()
    def guard():
        if max_bytes is not None: resource.setrlimit(resource.RLIMIT_FSIZE,(max_bytes,max_bytes))
        if ctypes.CDLL(None,use_errno=True).prctl(1,signal.SIGKILL,0,0,0)!=0 or os.getppid()!=parent:
            os._exit(125)
    return guard


def checked_tool(command, log, cancelled, timeout=600):
    """Permit prompt cancellation while a size check or archive verification runs."""
    with Path(log).open('w+') as output, subprocess.Popen(command,stdout=output,stderr=subprocess.STDOUT,preexec_fn=_child_limits(4*1024**2)) as process:
        started=time.monotonic()
        try:
            while process.poll() is None:
                if cancelled(): raise MapCancelled('Map operation stopped; completed maps remain downloaded')
                if time.monotonic()-started>timeout: raise ValueError('Map check timed out')
                time.sleep(0.2)
            output.seek(0);text=output.read(4*1024**2)
            if process.returncode: raise RuntimeError('Map check failed: '+text[-2048:].strip())
            if cancelled(): raise MapCancelled('Map operation stopped; completed maps remain downloaded')
            return text
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill();process.wait()


def make_plan(catalog_path, identifiers, progress=lambda message: None, cancelled=lambda:False):
    regions=selection(region_catalog(catalog_path),identifiers)
    progress('Reading the street-map catalogue')
    build=published_build()
    entries=[]
    with extraction_tool(progress) as (binary,work):
        for item in regions:
            progress(f'Calculating download size: {item["name"]}')
            boundary=work/(item['id']+'.geojson')
            boundary.write_text(json.dumps(item['geometry']))
            command=[str(binary),'extract','https://build.protomaps.com/'+build,str(work/'plan.pmtiles'),
                     '--region',str(boundary),'--maxzoom','15','--download-threads','4','--dry-run']
            output=checked_tool(command,work/'plan.log',cancelled)
            entries.append({key:item[key] for key in ('id','name','group','bounds','max_zoom')}|{'planned_bytes':archive_size(output)})
            if sum(item['planned_bytes'] for item in entries)>LIMIT: raise ValueError('Selection exceeds the 25 GB map budget; choose fewer regions')
    return {'build':build,'created_at':int(time.time()),'regions':entries,'planned_bytes':sum(item['planned_bytes'] for item in entries)}


def extract_regions(catalog_path, plan, staging, progress, available, cancelled=lambda:False, completed=None):
    """Download regional ranges only; keep a hard file limit and monitor live free space."""
    if not re.fullmatch(r'\d{8}\.pmtiles',plan['build']): raise ValueError('Invalid planned map build')
    catalog=region_catalog(catalog_path)
    selection(catalog,[entry['id'] for entry in plan['regions']])
    results=[]
    with extraction_tool(progress) as (binary,work):
        for entry in plan['regions']:
            if cancelled(): raise MapCancelled('Map operation stopped; completed maps remain downloaded')
            item=catalog[entry['id']]
            limit=entry['planned_bytes']
            if type(limit) is not int or not 0<limit<=LIMIT or available()<limit:
                raise ValueError('Not enough safe free space for the planned map; existing maps preserved')
            boundary=work/(item['id']+'.geojson');boundary.write_text(json.dumps(item['geometry']))
            target=Path(staging)/(item['id']+'.pmtiles')
            command=[str(binary),'extract','https://build.protomaps.com/'+plan['build'],str(target),
                     '--region',str(boundary),'--maxzoom','15','--download-threads','4']
            progress(f'Downloading {item["name"]}')
            log=work/'extract.log'
            with log.open('w+') as output,subprocess.Popen(command,stdout=output,stderr=subprocess.STDOUT,preexec_fn=_child_limits(limit)) as process:
                started=time.monotonic()
                try:
                    while process.poll() is None:
                        if cancelled(): raise MapCancelled('Map operation stopped; completed maps remain downloaded')
                        if available()<0: raise ValueError('Free space fell below the system/swap reserve; download stopped')
                        if time.monotonic()-started>6*3600: raise ValueError('Map download timed out')
                        written=target.stat().st_size if target.exists() else 0
                        progress(f'Downloading {item["name"]}: {written/1024**2:.0f} / {limit/1024**2:.0f} MiB')
                        time.sleep(2)
                    if process.returncode:
                        output.seek(max(0,output.tell()-2048))
                        raise RuntimeError(f'Map extraction failed: {output.read()[-2048:].strip()}')
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try: process.wait(timeout=10)
                        except subprocess.TimeoutExpired: process.kill();process.wait()
            progress(f'Verifying {item["name"]}')
            checked_tool([str(binary),'verify',str(target)],work/'verify.log',cancelled)
            if target.stat().st_size>limit: raise ValueError('Downloaded map exceeded its planned bound')
            results.append({key:entry[key] for key in ('id','name','group','bounds','max_zoom')}|
                           {'bytes':target.stat().st_size,'sha256':file_digest(target),'build':plan['build'],'path':str(target)})
            if completed: completed(results[-1])
    return results
