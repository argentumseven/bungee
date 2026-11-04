import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';
import {readFileSync} from 'node:fs';
const release=JSON.parse(readFileSync('release.json'));
test('only authenticated paired phones can fetch bounded immutable APK chunks; admin APK is streamed',async t=>{
 const f=await fixture(t),p=await phone(f),dir=join(f.dir,'app-updates');await mkdir(dir);
 const data=Buffer.alloc(131072+31,42),sha=createHash('sha256').update(data).digest('hex');
 const manifest={version:release.version,version_code:release.android_version_code,sha256:sha,signer_sha256:'a'.repeat(64),size:data.length,commit:'b'.repeat(40)};
 await writeFile(join(dir,sha+'.apk'),data);await writeFile(join(dir,'release.json'),JSON.stringify(manifest));
 assert.equal((await f.device('/v1/app-update/chunk',{sha256:sha,offset:0})).status,401);
 const preparation={state:'preparing',version:release.version,stage:'downloading',message:'Downloading the server APK…',downloaded_bytes:524288,total_bytes:1048576};
 await writeFile(join(dir,'status.json'),JSON.stringify(preparation));
 const check=await (await p.request('/v1/app-update',{})).json();
 assert.deepEqual(check.release,manifest);assert.deepEqual(check.preparation,preparation);assert.equal(check.server_version,release.version);
 const syncResponse=await p.request('/v1/sync',{report:{}});assert.equal(syncResponse.status,200);
 const sync=await syncResponse.json();assert.deepEqual(sync.app_update_preparation,preparation);assert.equal(sync.server_version,release.version);
 const first=await (await p.request('/v1/app-update/chunk',{sha256:sha,offset:0})).json();assert.deepEqual(Buffer.from(first.data,'base64'),data.subarray(0,131072));
 const last=await (await p.request('/v1/app-update/chunk',{sha256:sha,offset:131072})).json();assert.deepEqual(Buffer.from(last.data,'base64'),data.subarray(131072));
 assert.equal((await p.request('/v1/app-update/chunk',{sha256:sha,offset:1})).status,400);
 assert.equal((await p.request('/v1/app-update/chunk',{sha256:'../../etc/passwd',offset:0})).status,400);
 assert.equal((await f.admin('/api/app-updates/bungee.apk','GET',undefined,{Cookie:''})).status,401);
 const downloaded=await f.admin('/api/app-updates/bungee.apk');assert.match(downloaded.headers.get('content-disposition'),/bungee.apk/);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),data);
 await writeFile(join(dir,'release.json'),JSON.stringify({...manifest,version_code:manifest.version_code+1}));
 const notReady=await (await p.request('/v1/app-update',{})).json();
 assert.equal(notReady.release,null,'running server controls offered version');assert.deepEqual(notReady.preparation,preparation);
 const failure={state:'waiting',message:'APK signing identity is missing; restore its encrypted backup'};
 await writeFile(join(dir,'status.json'),JSON.stringify(failure));
 assert.deepEqual((await (await p.request('/v1/app-update',{})).json()).preparation,failure);
});

test('official GitHub/server APK is the default download while older household clients retain a compatible update',async t=>{
 const f=await fixture(t),p=await phone(f),dir=join(f.dir,'app-updates');await mkdir(dir);
 const make=async(bytes,signer,signing,name)=>{
  const sha=createHash('sha256').update(bytes).digest('hex');
  const descriptor={version:release.version,version_code:release.android_version_code,sha256:sha,signer_sha256:signer,size:bytes.length,commit:'c'.repeat(40),signing};
  await writeFile(join(dir,sha+'.apk'),bytes);await writeFile(join(dir,name),JSON.stringify(descriptor));return descriptor;
 };
 const official=await make(Buffer.from('exact GitHub bytes'),'a'.repeat(64),'publisher-v1','release.json');
 const legacy=await make(Buffer.from('legacy compatibility bytes'),'b'.repeat(64),'household-legacy','legacy-release.json');
 const check=async signer=>await (await p.request('/v1/app-update',signer?{installed_signer_sha256:signer}:{})).json();
 assert.deepEqual((await check('a'.repeat(64))).release,official);
 assert.deepEqual((await check('b'.repeat(64))).release,legacy);
 assert.deepEqual((await check()).release,legacy,'pre-upgrade clients keep their old signing identity');
 assert.deepEqual((await check('d'.repeat(64))).release,official,'a retired GitHub identity sees the official release and its real certificate');
 assert.equal((await p.request('/v1/app-update',{installed_signer_sha256:'not a certificate'})).status,400);
 for(const signer of [official.signer_sha256,legacy.signer_sha256]){
  const r=await p.request('/v1/sync',{report:{app_signer_sha256:signer}});assert.equal(r.status,200);
  assert.deepEqual((await r.json()).app_update,signer===official.signer_sha256?official:legacy);
 }
 assert.equal((await p.request('/v1/sync',{report:{app_signer_sha256:'invalid'}})).status,400);
 const download=await f.admin('/api/app-updates/bungee.apk');assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from('exact GitHub bytes'));
 assert.deepEqual((await (await f.admin('/api/app-updates')).json()).release,official);
});
