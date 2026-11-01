"""Allowlisted host map jobs. The app container never runs Docker or downloads providers."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import tempfile
import time
import regional_maps

GIB=1024**3
OVERHEAD=128*1024**2
JOB_ID=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')


def atomic(path, value):
    path=Path(path)
    temporary=path.with_name(path.name+'.'+secrets.token_hex(8))
    try:
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
        with os.fdopen(fd,'w') as stream:
            json.dump(value,stream,separators=(',',':'));stream.write('\n');stream.flush()
            # The host and systemd workers intentionally use umask 0077. These
            # two public metadata files must still be readable by runtime UID 10001.
            os.fchmod(stream.fileno(),0o644)
            os.fsync(stream.fileno())
        os.replace(temporary,path)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally: temporary.unlink(missing_ok=True)


def setup(root):
    root=Path(root)
    for relative in ('maps','maps/archives','map-control','map-control/status','map-control/requests'):
        path=root/relative
        if path.is_symlink(): raise ValueError('Map control directories cannot be symlinks')
        path.mkdir(exist_ok=True)
        path.chmod(0o700 if relative.endswith('requests') else 0o755)
    if os.geteuid()==0: os.chown(root/'map-control/requests',10001,10001)
    for relative in ('maps/library.json','map-control/status/state.json'):
        try: fd=os.open(root/relative,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        except FileNotFoundError: continue
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:
                raise ValueError('Map metadata must be a single-link regular file')
            if stat.S_IMODE(info.st_mode)!=0o644:
                os.fchmod(fd,0o644);os.fsync(fd)
        finally: os.close(fd)
    if not (root/'maps/library.json').exists(): atomic(root/'maps/library.json',{'format':1,'regions':[]})


def free_bytes(path):
    info=os.statvfs(path)
    return info.f_bavail*info.f_frsize,info.f_blocks*info.f_frsize


def capacity(root):
    root=Path(root)
    free,total=free_bytes(root)
    memory={}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key,value=line.split(':',1);memory[key]=int(value.split()[0])*1024
    swap=memory.get('SwapTotal',0);used=swap-memory.get('SwapFree',0)
    swap_growth=2*GIB if swap else GIB
    # Existing swap files and old map generations already reduce f_bavail.
    # Never subtract their allocation twice. Keep additional growth headroom.
    backing=Path('/var/lib/bungee')
    if not backing.exists(): backing=root
    backing_free,backing_total=free_bytes(backing)
    shared=os.stat(backing).st_dev==os.stat(root).st_dev
    history_reserve=max(2*GIB,min(8*GIB,total//20))
    # Cold tar/age snapshots need another full logical copy of private volumes.
    # Sparse files are counted logically because the archive may materialize them.
    snapshot_bytes=0;entries=0
    for path in (root/'volumes').rglob('*'):
        entries+=1
        if entries>10000: raise ValueError('Too many private-volume files to budget a safe map download')
        try: info=path.lstat()
        except FileNotFoundError: continue # SQLite may retire a WAL between observations.
        if stat.S_ISREG(info.st_mode): snapshot_bytes+=info.st_size
    snapshot_reserve=int(snapshot_bytes*1.05)+OVERHEAD if snapshot_bytes else 0
    target_reserve=history_reserve+snapshot_reserve+(swap_growth if shared else 0)
    return {'total_bytes':total,'free_bytes':free,'reserve_bytes':target_reserve,
            'available_bytes':max(0,free-target_reserve-OVERHEAD),'swap_total_bytes':swap,'swap_used_bytes':used,
            'swap_growth_reserve_bytes':swap_growth,'backing_free_bytes':backing_free,'backing_total_bytes':backing_total,
            'snapshot_reserve_bytes':snapshot_reserve,
            'backing_has_tool_space':shared or backing_free>=swap_growth+OVERHEAD,
            'note':'Existing swap files and retained datasets are already counted as used space. Additional headroom protects a fresh private-data snapshot, history, staging and swap growth.'}


def library(root):
    return json.loads((Path(root)/'maps/library.json').read_text())


def legacy_bytes(root):
    try:
        current=json.loads((root/'current.json').read_text())['generation']
        config=json.loads((root/'generations'/current/'config.json').read_text())
        path=root/'datasets'/config.get('geodata','empty')/'map.pmtiles'
        return path.stat().st_size if path.exists() else 0
    except (OSError,KeyError,ValueError): return 0


def check_plan(root, plan):
    disk=capacity(root)
    planned=plan['planned_bytes']
    current=library(root)['regions']
    if len(current)+len(plan['regions'])>regional_maps.MAX_REGIONS: raise ValueError('Map catalogue region limit exceeded')
    installed=sum(item['bytes'] for item in current)+legacy_bytes(root)
    if planned+installed>regional_maps.LIMIT: raise ValueError('Selected and installed street maps exceed the 25 GB map limit; remove maps or select fewer regions')
    if planned>disk['available_bytes'] or not disk['backing_has_tool_space']:
        raise ValueError('Selected maps exceed safe free space after staging, history and swap reserves')
    return disk


def public_status(root, catalog_path, state):
    catalog=regional_maps.region_catalog(catalog_path)
    value={**state,'updated_at':int(time.time()),'disk':capacity(root),'installed':library(root)['regions'],
           'legacy_map_bytes':legacy_bytes(root),'map_limit_bytes':regional_maps.LIMIT,
           'catalog':[{key:item[key] for key in ('id','name','group','estimated_bytes','bounds','max_zoom')} for item in catalog.values()]}
    if value.get('job',{}).get('action')=='install':
        ids=value['job'].get('regions',[])
        value['job']['total']=len(ids)
        value['job']['completed']=sum(item['id'] in ids for item in value['installed'])
    atomic(root/'map-control/status/state.json',value)
    return value


def read_request(path):
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>16384 or info.st_uid not in (0,10001,os.getuid()):
            raise ValueError('Invalid map request file')
        value=json.loads(stream.read(16385))
    if not isinstance(value,dict) or set(value)-{'action','regions','plan_id'} or value.get('action') not in ('plan','install','remove'):
        raise ValueError('Invalid map request')
    return value


def plan_selection(root, catalog_path, identifiers, progress, cancelled=lambda:False):
    catalog=regional_maps.region_catalog(catalog_path)
    regional_maps.selection(catalog,identifiers)
    disk=capacity(root)
    if disk['available_bytes']<=0 or not disk['backing_has_tool_space']:
        raise ValueError('Insufficient safe space even for map planning/tool downloads; existing maps preserved')
    installed={item['id'] for item in library(root)['regions']}
    wanted=[identifier for identifier in identifiers if identifier not in installed]
    if not wanted: raise ValueError('The selected regions are already installed')
    plan=regional_maps.make_plan(catalog_path,wanted,progress,cancelled)
    check_plan(root,plan)
    return plan


def install_plan(root,catalog_path,plan,progress,cancelled=lambda:False):
    check_plan(root,plan)
    existing=library(root)
    if any(item['id'] in {r['id'] for r in existing['regions']} for item in plan['regions']):
        raise ValueError('Installed maps changed; calculate the selection again')
    # Commit verified regions one at a time. Stopping or losing a later download
    # keeps completed pieces available, and a new plan selects only the remainder.
    with tempfile.TemporaryDirectory(prefix='.staging-',dir=root/'maps') as staging:
        def remaining():
            disk=capacity(root)
            return disk['free_bytes']-disk['reserve_bytes'] if disk['backing_has_tool_space'] else -1
        def publish(item):
            with Path(item['path']).open('rb') as stream: header=stream.read(127)
            if len(header)!=127 or header[:8]!=b'PMTiles\x03' or header[99]!=1 or not header[100]<=header[101]<=22 or header[101]<14 or header[97] not in (1,2) or header[98] not in (1,2):
                raise ValueError('Downloaded archive does not contain street-level vector maps')
            value={key:value for key,value in item.items() if key!='path'}
            filename=f'{item["id"]}-{item["sha256"][:16]}.pmtiles'
            destination=root/'maps/archives'/filename
            try:
                os.chmod(item['path'],0o644);os.replace(item['path'],destination)
                with destination.open('rb') as stream: os.fsync(stream.fileno())
                fd=os.open(root/'maps/archives',os.O_RDONLY|os.O_DIRECTORY)
                try: os.fsync(fd)
                finally: os.close(fd)
                value['filename']=filename
                current=library(root)['regions']
                atomic(root/'maps/library.json',{'format':1,'regions':current+[value]})
            except Exception:
                if filename not in {item['filename'] for item in library(root)['regions']}: destination.unlink(missing_ok=True)
                raise
            progress(f'{item["name"]} is downloaded and ready')
        regional_maps.extract_regions(catalog_path,plan,staging,progress,remaining,cancelled,publish)


def remove_regions(root, identifiers):
    value=library(root)
    removed=[item for item in value['regions'] if item['id'] in identifiers]
    if not removed: raise ValueError('No selected installed maps to remove')
    if len(removed)!=len(set(identifiers)): raise ValueError('Some selected maps are no longer installed; refresh the library')
    for item in removed:
        filename=item['filename']
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,47}-[a-f0-9]{16}\.pmtiles',filename): raise ValueError('Invalid stored map filename')
    atomic(root/'maps/library.json',{'format':1,'regions':[item for item in value['regions'] if item['id'] not in identifiers]})
    for item in removed:
        filename=item['filename']
        (root/'maps/archives'/filename).unlink(missing_ok=True)


def tick(root, catalog_path):
    root=Path(root);setup(root)
    with (root/'maps.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return
        # The lock excludes a live CLI/worker download before cleanup runs.
        for stale in (root/'maps').glob('.staging-*'):
            if stale.is_dir() and not stale.is_symlink(): shutil.rmtree(stale)
        referenced={item['filename'] for item in library(root)['regions']}
        for orphan in (root/'maps/archives').glob('*.pmtiles'):
            if re.fullmatch(r'[a-z][a-z0-9-]{1,47}-[a-f0-9]{16}\.pmtiles',orphan.name) and orphan.name not in referenced: orphan.unlink()
        state={}
        with contextlib.suppress(OSError,ValueError): state=json.loads((root/'map-control/status/state.json').read_text())
        state={key:state[key] for key in ('job','last_plan') if key in state}
        if state.get('job',{}).get('state')=='running':
            state['job'].update(state='failed',message='Map worker restarted; existing maps were preserved. Plan and retry the selection.')
        paths=sorted(p for p in (root/'map-control/requests').iterdir() if JOB_ID.fullmatch(p.stem) and p.suffix=='.json')
        if not paths: public_status(root,catalog_path,state);return
        path=paths[0];job_id=path.stem
        cancel=root/'map-control/requests'/('cancel-'+job_id)
        state['job']={'id':job_id,'state':'running','message':'Checking map selection'}
        def progress(message):
            state['job']['message']=message
            public_status(root,catalog_path,state)
        try:
            request=read_request(path)
            allowed=({item['id']:item for item in library(root)['regions']} if request['action']=='remove' else regional_maps.region_catalog(catalog_path))
            regional_maps.selection(allowed,request.get('regions'))
            state['job'].update(action=request['action'],regions=request['regions'])
            if cancel.exists(): raise regional_maps.MapCancelled('Map operation stopped; completed maps remain downloaded')
            public_status(root,catalog_path,state)
            path.unlink()
            if request['action']=='plan':
                state['last_plan']=plan_selection(root,catalog_path,request['regions'],progress,cancel.exists)|{'id':job_id}
                message='Download plan ready. Review the total and available space before installing.'
            elif request['action']=='install':
                plan=state.get('last_plan',{})
                if plan.get('id')!=request.get('plan_id') or int(time.time())-plan.get('created_at',0)>3600 or sorted(request['regions'])!=sorted(item['id'] for item in plan.get('regions',[])):
                    raise ValueError('Download plan expired or selection changed; calculate sizes again')
                install_plan(root,catalog_path,plan,progress,cancel.exists)
                state.pop('last_plan',None)
                message='Street maps installed. Tracking maps refresh automatically.'
            else:
                remove_regions(root,request['regions']);state.pop('last_plan',None)
                message='Selected maps removed.'
            state['job'].update(state='completed',message=message)
        except Exception as error:
            stopped=isinstance(error,regional_maps.MapCancelled) or cancel.exists()
            state['job'].update(state='canceled' if stopped else 'failed',message='Map operation stopped; completed maps remain downloaded' if stopped else str(error)[:2048])
        finally:
            path.unlink(missing_ok=True);cancel.unlink(missing_ok=True)
            public_status(root,catalog_path,state)
