#!/usr/bin/env python3
"""Exercise the actual keytool/zipalign/apksigner pipeline twice with a disposable key."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import app_updates
import map_manager
parser=argparse.ArgumentParser()
parser.add_argument('apk',type=Path)
parser.add_argument('--local-tools',action='store_true')
args=parser.parse_args()
source=Path(__file__).resolve().parents[1]
release=json.loads((source/'release.json').read_text())
original_run=app_updates.run
commit='a'*40
with tempfile.TemporaryDirectory(prefix='bungee-signer-check-') as temporary:
    root=Path(temporary);(root/'volumes/tls-data').mkdir(parents=True);(root/'signer-context').mkdir()
    shutil.copyfile(source/'deploy/android-signer.Dockerfile',root/'android-signer.Dockerfile')
    def run(command):
        if command[:4]==['docker','image','inspect','bungee-server:test']:
            return json.dumps([{'Config':{'Labels':{'dev.bungee.source-commit':commit}}}])
        if args.local_tools:
            if command[:3]==['docker','image','inspect']: return '[]'
            if command[:2]==['docker','run']:
                mounts=[command[i+1].split(':')[0] for i,v in enumerate(command) if v=='-v']
                at=next(i for i,v in enumerate(command) if str(v).startswith('bungee-android-signer:'))
                tool=command[at+1]; rest=command[at+2:]
                rest=[str(v).replace('/keys/',mounts[0]+'/').replace('/work/',mounts[1]+'/') for v in rest]
                binary='keytool' if tool=='keytool' else str(Path(os.environ['ANDROID_HOME'])/'build-tools/35.0.0'/tool)
                return original_run([binary,*rest])
        return original_run(command)
    def fetch(url,target=None,limit=65536):
        if target is not None: shutil.copyfile(args.apk,target);return target.stat().st_size
        return {'commit':commit,'version':release['version'],'android_version_code':release['android_version_code'],'sha256':app_updates.digest(args.apk)}
    metadata={'version':release['version'],'images':{'server':'bungee-server:test'}}
    with patch.object(app_updates,'run',run),patch.object(app_updates,'fetch',fetch),patch.object(map_manager,'capacity',return_value={'available_bytes':10*1024**3}):
        app_updates.prepare(root,metadata)
        first=json.loads((root/'app-updates/release.json').read_text())
        key_digest=app_updates.digest(root/'volumes/tls-data/android-signing/bungee.p12')
        commit='b'*40
        app_updates.prepare(root,metadata)
        second=json.loads((root/'app-updates/release.json').read_text())
        assert first['signer_sha256']==second['signer_sha256']
        assert key_digest==app_updates.digest(root/'volumes/tls-data/android-signing/bungee.p12')
        assert second['version_code']==release['android_version_code']
        (root/'volumes/tls-data/android-signing/bungee.p12').unlink()
        commit='c'*40
        try: app_updates.prepare(root,metadata)
        except ValueError as error: assert 'restore' in str(error)
        else: raise AssertionError('Missing original signing key silently replaced')
    print('Verified real APK signatures, persistent signing identity, package/version and refusal to replace a lost key.')
