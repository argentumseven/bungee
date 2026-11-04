#!/usr/bin/env python3
"""Exercise the actual keytool/zipalign/apksigner pipeline twice with a disposable key."""
import argparse
import base64
import hashlib
import secrets
import subprocess
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
import release_signing
parser=argparse.ArgumentParser()
parser.add_argument('apk',type=Path)
parser.add_argument('--local-tools',action='store_true')
args=parser.parse_args()
source=Path(__file__).resolve().parents[1]
release=json.loads((source/'release.json').read_text())
original_run=app_updates.run
commit='a'*40
official=False
source_apk=args.apk
with tempfile.TemporaryDirectory(prefix='bungee-signer-check-') as temporary:
    root=Path(temporary);(root/'volumes/tls-data').mkdir(parents=True);(root/'signer-context').mkdir()
    shutil.copyfile(source/'deploy/android-signer.Dockerfile',root/'android-signer.Dockerfile')
    def run(command):
        if command[:4]==['docker','image','inspect','bungee-server:test']:
            return json.dumps([{'Config':{'Labels':{'dev.bungee.source-commit':commit}}}])
        if args.local_tools:
            if command[:3]==['docker','image','inspect']: return '[]'
            if command[:2]==['docker','run']:
                mounts={}
                for i,v in enumerate(command):
                    if v=='-v':
                        source_path,target,*_=command[i+1].split(':');mounts[target]=source_path
                at=next(i for i,v in enumerate(command) if str(v).startswith('bungee-android-signer:'))
                tool=command[at+1]; rest=command[at+2:]
                for target,source_path in mounts.items():rest=[str(v).replace(target+'/',source_path+'/') for v in rest]
                binary='keytool' if tool=='keytool' else str(Path(os.environ['ANDROID_HOME'])/'build-tools/35.0.0'/tool)
                return original_run([binary,*rest])
        return original_run(command)
    def fetch(url,target=None,limit=65536,progress=None):
        if target is not None:
            shutil.copyfile(source_apk,target)
            if progress: progress(target.stat().st_size,target.stat().st_size)
            return target.stat().st_size
        return {'commit':commit,'version':release['version'],'android_version_code':release['android_version_code'],'sha256':app_updates.digest(source_apk),**({'signing':'publisher-v1','signer_sha256':publisher} if official else {})}
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
        # A separate disposable publisher identity exercises the same signing
        # helper used by the protected release job; no production key enters CI tests.
        publisher_key=root/'fixture-publisher.p12';publisher_password=root/'fixture-publisher-password'
        publisher_password.write_text(secrets.token_urlsafe(32)+'\n');publisher_password.chmod(0o600)
        original_run(['keytool','-genkeypair','-keystore',publisher_key,'-storetype','PKCS12','-storepass:file',publisher_password,'-keypass:file',publisher_password,'-alias','bungee','-keyalg','RSA','-keysize','3072','-validity','100','-dname','CN=Bungee signing test','-noprompt'])
        public_certificate=subprocess.check_output(['keytool','-exportcert','-keystore',str(publisher_key),'-storepass:file',str(publisher_password),'-alias','bungee'],stderr=subprocess.PIPE)
        publisher=hashlib.sha256(public_certificate).hexdigest()
        signed=release_signing.sign(args.apk,root/'release-artifact',publisher_key,publisher_password,'bungee',publisher,release)
        assert signed['signer_sha256']==publisher and publisher!=first['signer_sha256']
        unsigned=root/'build-input.apk';shutil.copyfile(args.apk,unsigned)
        unsigned.with_name(unsigned.name+'.sha256').write_text(app_updates.digest(unsigned)+'  '+unsigned.name+'\n')
        test_env={**os.environ,'BUNGEE_RELEASE_KEYSTORE_BASE64':base64.b64encode(publisher_key.read_bytes()).decode(),
                  'BUNGEE_RELEASE_STORE_PASSWORD':publisher_password.read_text().strip(),'BUNGEE_RELEASE_SIGNER_SHA256':publisher,'BUNGEE_RELEASE_KEY_ALIAS':'bungee'}
        subprocess.check_output([sys.executable,str(source/'scripts/release_signing.py'),str(unsigned),str(root/'cli-artifact')],env=test_env,stderr=subprocess.PIPE)
        assert json.loads((root/'cli-artifact/signing.json').read_text())['signer_sha256']==publisher
        unsigned.with_name(unsigned.name+'.sha256').write_text('0'*64+'  '+unsigned.name+'\n')
        rejected=subprocess.run([sys.executable,str(source/'scripts/release_signing.py'),str(unsigned),str(root/'bad-input-artifact')],env=test_env,capture_output=True)
        assert rejected.returncode!=0 and b'checksum mismatch' in rejected.stderr
        assert not (root/'bad-input-artifact').exists()

        try: release_signing.sign(args.apk,root/'wrong-key-artifact',publisher_key,publisher_password,'bungee','0'*64,release)
        except ValueError as error: assert 'certificate changed' in str(error)
        else: raise AssertionError('A changed release certificate was accepted')
        source_apk=root/'release-artifact/bungee.apk'
        official=True;commit='c'*40
        app_updates.prepare(root,metadata)
        main=json.loads((root/'app-updates/release.json').read_text())
        legacy=json.loads((root/'app-updates/legacy-release.json').read_text())
        assert main['signer_sha256']==publisher and main['sha256']==app_updates.digest(source_apk)
        assert (root/'app-updates'/f"{main['sha256']}.apk").read_bytes()==source_apk.read_bytes()
        assert legacy['signer_sha256']==first['signer_sha256']
        assert key_digest==app_updates.digest(root/'volumes/tls-data/android-signing/bungee.p12')
        fresh=root/'fresh';(fresh/'volumes/tls-data').mkdir(parents=True)
        shutil.copyfile(root/'android-signer.Dockerfile',fresh/'android-signer.Dockerfile')
        app_updates.prepare(fresh,metadata)
        assert not (fresh/'volumes/tls-data/android-signing/bungee.p12').exists()
        assert json.loads((fresh/'app-updates/release.json').read_text())['sha256']==main['sha256']
        (root/'volumes/tls-data/android-signing/bungee.p12').unlink()
        commit='d'*40
        try: app_updates.prepare(root,metadata)
        except ValueError as error: assert 'restore' in str(error)
        else: raise AssertionError('Missing original signing key silently replaced')
    print('Verified persistent release signing, byte-identical GitHub/server APKs, no new server key, compatible legacy updates and refusal to replace lost keys.')
