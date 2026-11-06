import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';

const caps=['locate','flash','ring','message','clear_message','stop_all'];
const invite=(f,parent,name='Work')=>f.admin('/api/enrollments','POST',{name,wg_public_key:randomBytes(32).toString('base64'),primary_device_id:parent});

test('one phone groups independent profile credentials and enforces the action-only role',async t=>{
 const f=await fixture(t),main=await phone(f,{name:'My phone',capabilities:caps});
 const profile=await phone(f,{name:'Sandbox',primaryDeviceId:main.id,capabilities:caps});
 assert.equal(profile.bundle.profile.primary_device_id,main.id);assert.equal(profile.bundle.profile.primary_name,'My phone');
 const at=Math.floor(Date.now()/1000);
 await writeFile(join(f.dir,'wireguard/endpoints.json'),JSON.stringify({sampled_at:at,peers:[main,profile].map(p=>({public_key:p.bundle.wireguard.client_public_key,ip:'203.0.113.20',observed_at:at}))}));
 const list=await (await f.admin('/api/devices')).json();
 assert.equal(list.devices.length,1);assert.equal(list.devices[0].id,main.id);
 assert.equal(list.devices[0].profiles.length,1);assert.equal(list.devices[0].profiles[0].id,profile.id);
 assert.notEqual(list.devices[0].address,list.devices[0].profiles[0].address);
 assert.deepEqual(list.devices[0].profiles[0].capabilities,['message','clear_message','stop_all']);
 assert.equal((await profile.request('/v1/telemetry',{battery:50,charging:false,capabilities:caps,device_owner:false,gps_epoch:profile.epoch,location:{latitude:12,longitude:34,accuracy:4,observed_at:Math.floor(Date.now()/1000)}})).status,403);
 assert.equal((await profile.request('/v1/sync',{report:{connection_health:{}}})).status,400);
 const camera={armed:true,pending:0,dropped:0,status:'Ready in Sandbox',failed_in_row:2,queued:[],reported_at:Math.floor(Date.now()/1000)};
 const status=await profile.request('/v1/sync',{report:{foreground_user:true,camera}});assert.equal(status.status,200);assert.equal((await status.json()).profile_companion,true);
 assert.deepEqual(f.sql('SELECT count(*) FROM location_history WHERE device_id=?',[profile.id]),[[0]]);
 assert.deepEqual(f.sql('SELECT count(*) FROM state_history WHERE device_id=?',[profile.id]),[[0]]);
 assert.deepEqual(f.sql('SELECT count(*) FROM network_history WHERE device_id=?',[profile.id]),[[0]]);
 assert.deepEqual(f.sql('SELECT count(*) FROM network_history WHERE device_id=?',[main.id]),[[1]],'only the primary contributes observed network history');
 assert.equal(f.sql('SELECT management_report FROM devices WHERE id=?',[main.id])[0][0],null);
 // Even a forged capability report or old queued command cannot grant a shared action.
 f.sql('UPDATE devices SET capabilities=? WHERE id=?',[JSON.stringify(caps),profile.id]);
 assert.equal((await f.admin(`/api/devices/${profile.id}/commands`,'POST',{kind:'flash'})).status,403);
 assert.equal((await f.admin(`/api/devices/${profile.id}/policy`,'POST',{expected_revision:0,policy:{lost_mode:true,recovery_message:'x'}})).status,403);
 assert.equal((await f.admin(`/api/devices/${main.id}/commands`,'POST',{kind:'flash'})).status,200);
 assert.equal((await f.admin(`/api/devices/${profile.id}/commands`,'POST',{kind:'message',message:'Only in Sandbox'})).status,200);
 const polled=await (await profile.request('/v1/commands',{})).json();assert.deepEqual(polled.commands.map(c=>c.kind),['message']);
 assert.equal(polled.commands[0].payload.message,'Only in Sandbox');
 assert.deepEqual((await (await main.request('/v1/commands',{})).json()).commands.map(c=>c.kind),['flash']);
 const forged=profile.prepare('/v1/commands',{});forged.headers['X-Bungee-Device']=main.id;
 assert.equal((await fetch(f.deviceOrigin+'/v1/commands',{method:'POST',headers:forged.headers,body:forged.text})).status,401);
 assert.equal((await invite(f,profile.id)).status,400,'companions cannot own another profile');
 assert.equal((await f.admin(`/api/devices/${main.id}/commands`,'POST',{kind:'stop_all'})).status,200);
 assert.deepEqual((await (await profile.request('/v1/commands',{})).json()).commands.map(c=>c.kind),['stop_all'],'phone stop clears pending actions in linked profiles');
});

test('profile photos join the same phone album with source labels and independent erasure fences',async t=>{
 const f=await fixture(t),main=await phone(f),profile=await phone(f,{name:'Sandbox',primaryDeviceId:main.id});
 const jpeg=await readFile('tests/fixtures/recovery-test.jpg');
 const photo={id:randomUUID(),captured_at:Math.floor(Date.now()/1000),failed_attempts:3,reason:'failed_unlock',jpeg:jpeg.toString('base64')};
 const body={photo_epoch:profile.photoEpoch,photo};
 assert.equal((await profile.request('/v1/photos',body)).status,200);
 const album=await (await f.admin(`/api/devices/${main.id}/photos`)).json();
 assert.equal(album.photos.length,1);assert.equal(album.photos[0].profile_name,'Sandbox');assert.equal(album.photos[0].source_device_id,profile.id);
 assert.equal((await f.admin(`/api/devices/${profile.id}/photos/${photo.id}`)).status,200);
 const all=await (await f.admin('/api/photos')).json();assert.equal(all.photos[0].device_id,main.id);assert.equal(all.photos[0].source_device_id,profile.id);
 assert.equal((await f.admin(`/api/devices/${main.id}/photos`,'DELETE')).status,200);
 const stale=await profile.request('/v1/photos',body);assert.equal(stale.status,200);
 assert.equal((await stale.json()).accepted_photo,null,'an older companion queue cannot resurrect an erased album');
 assert.deepEqual((await (await f.admin(`/api/devices/${main.id}/photos`)).json()).photos,[]);
 assert.notEqual((await (await main.request('/v1/commands',{})).json()).photo_epoch,main.photoEpoch);
 assert.equal((await f.admin(`/api/devices/${profile.id}/disconnect`,'POST',{})).status,200);
 assert.equal((await profile.request('/v1/commands',{})).status,401);
 assert.equal((await main.request('/v1/commands',{})).status,200,'disconnecting one profile preserves primary access');
});

test('primary disconnection and archive deletion include all linked profile credentials and saved photos',async t=>{
 const f=await fixture(t),main=await phone(f),profile=await phone(f,{primaryDeviceId:main.id});
 assert.equal((await f.admin(`/api/devices/${main.id}/disconnect`,'POST',{})).status,200);
 assert.equal((await main.request('/v1/commands',{})).status,401);
 assert.equal((await profile.request('/v1/commands',{})).status,401);
 assert.deepEqual(f.sql('SELECT count(*) FROM devices WHERE (id=? OR primary_device_id=?) AND (revoked=0 OR binding_released=0)',[main.id,main.id]),[[0]]);
 assert.equal((await f.admin(`/api/devices/${main.id}/archive`,'DELETE')).status,200);
 assert.deepEqual(f.sql('SELECT count(*) FROM devices'),[[0]]);
});

test('phone revocation disables profile access while an unrelated phone stays connected',async t=>{
 const f=await fixture(t),main=await phone(f),profile=await phone(f,{primaryDeviceId:main.id}),other=await phone(f);
 assert.equal((await f.admin(`/api/devices/${main.id}`,'DELETE')).status,200);
 assert.equal((await profile.request('/v1/commands',{})).status,401);
 assert.equal((await other.request('/v1/commands',{})).status,200);
 assert.equal((await invite(f,main.id)).status,400,'a revoked primary cannot accept another profile');
 assert.deepEqual(f.sql('SELECT revoked FROM devices WHERE id=?',[profile.id]),[[1]]);
});

test('profile-local message approval refreshes capabilities without sending device telemetry',async t=>{
 const f=await fixture(t),main=await phone(f),profile=await phone(f,{primaryDeviceId:main.id,capabilities:[]});
 assert.equal((await f.admin(`/api/devices/${profile.id}/commands`,'POST',{kind:'message',message:'Hello'})).status,400);
 const update=report=>profile.request('/v1/sync',{report});
 assert.equal((await update({recovery_consent:true,profile_capabilities:['message','clear_message','stop_all']})).status,200);
 assert.equal((await f.admin(`/api/devices/${profile.id}/commands`,'POST',{kind:'message',message:'Hello'})).status,200);
 assert.equal((await update({recovery_consent:true,profile_capabilities:['flash']})).status,400);
 assert.equal((await update({recovery_consent:false,profile_capabilities:[]})).status,200);
 assert.equal((await f.admin(`/api/devices/${profile.id}/commands`,'POST',{kind:'message',message:'Hello'})).status,400);
 assert.deepEqual(f.sql('SELECT count(*) FROM state_history'),[[0]]);
});

test('an older app cannot redeem a profile invitation as a normal telemetry phone',async t=>{
 const f=await fixture(t),main=await phone(f),wg=randomBytes(32).toString('base64');
 const invitation=await (await f.admin('/api/enrollments','POST',{name:'Sandbox',wg_public_key:wg,primary_device_id:main.id})).json();
 const keys=generateKeyPairSync('ec',{namedCurve:'P-256'}),publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
 const proof=sign('sha256',Buffer.from(`BUNGEE-ENROLL-V1\n${invitation.token}\n${wg}\n${publicKey}`),keys.privateKey).toString('base64');
 const body={token:invitation.token,public_key:publicKey,wg_public_key:wg,proof,capabilities:['locate']};
 assert.equal((await f.device('/v1/enroll',body)).status,400);
 assert.equal((await f.device('/v1/enroll',{...body,profile_companion:true})).status,200,'the rejected legacy request does not consume the invitation');
 assert.equal(f.sql('SELECT telemetry FROM devices WHERE id=?',[invitation.device_id])[0][0],null);
});

test('eight companion slots are enforced through reconnect while an enabled profile can rotate its key',async t=>{
 const f=await fixture(t),main=await phone(f),retired=await phone(f,{name:'Retired',primaryDeviceId:main.id});
 assert.equal((await f.admin(`/api/devices/${retired.id}/disconnect`,'POST',{})).status,200);
 const active=[];
 for(let n=0;n<8;n++)active.push(await phone(f,{name:`Profile ${n+1}`,primaryDeviceId:main.id}));
 assert.equal((await invite(f,main.id,'Ninth profile')).status,400);
 assert.equal((await f.admin(`/api/devices/${retired.id}/reconnect`,'POST',{wg_public_key:randomBytes(32).toString('base64')})).status,400,'reconnect cannot reactivate a ninth companion');
 assert.equal((await f.admin('/api/enrollments','POST',{name:'Duplicate',wg_public_key:active[1].bundle.wireguard.client_public_key,primary_device_id:main.id})).status,400,'one bound profile key cannot create a second binding');
 const replacement=await f.admin(`/api/devices/${active[0].id}/reconnect`,'POST',{wg_public_key:randomBytes(32).toString('base64')});
 assert.equal(replacement.status,200,'rotating an enabled profile keeps its reserved slot');
 const bundle=await replacement.json();assert.equal(bundle.device_id,active[0].id);assert.equal(bundle.profile.primary_device_id,main.id);
 assert.equal((await active[0].request('/v1/commands',{})).status,401,'the earlier profile identity is retired before its replacement pairs');
 assert.deepEqual(f.sql('SELECT count(*) FROM devices WHERE primary_device_id=? AND revoked=0',[main.id]),[[8]]);
});

test('simultaneously connected companions keep reports and messages separate from a delayed main profile',async t=>{
 const f=await fixture(t),main=await phone(f),first=await phone(f,{name:'Sandbox',primaryDeviceId:main.id,capabilities:['message']}),second=await phone(f,{name:'Work',primaryDeviceId:main.id,capabilities:['message']});
 const stale=Math.floor(Date.now()/1000)-600;f.sql('UPDATE devices SET last_contact=? WHERE id=?',[stale,main.id]);
 const report=label=>({report:{foreground_user:true,camera:{armed:true,pending:0,dropped:0,status:label,failed_in_row:0,queued:[],reported_at:Math.floor(Date.now()/1000)}}});
 const responses=await Promise.all([first.request('/v1/sync',report('Sandbox ready')),second.request('/v1/sync',report('Work ready'))]);
 for(const response of responses)assert.equal(response.status,200);
 const devices=await (await f.admin('/api/devices')).json(),device=devices.devices[0];
 assert.equal(devices.devices.length,1);assert.equal(device.last_contact,stale,'a companion does not make the main profile appear fresh');
 assert.equal(device.management,null);
 for(const [p,label]of [[first,'Sandbox ready'],[second,'Work ready']])assert.equal(device.profiles.find(r=>r.id===p.id).management.camera.status,label);
 const queued=await Promise.all([f.admin(`/api/devices/${first.id}/commands`,'POST',{kind:'message',message:'Sandbox only'}),f.admin(`/api/devices/${second.id}/commands`,'POST',{kind:'message',message:'Work only'})]);
 for(const response of queued)assert.equal(response.status,200);
 const polled=await Promise.all([first.request('/v1/commands',{}).then(r=>r.json()),second.request('/v1/commands',{}).then(r=>r.json())]);
 assert.deepEqual(polled.map(r=>r.commands.map(c=>c.payload.message)),[['Sandbox only'],['Work only']]);
 assert.notEqual(polled[0].commands[0].id,polled[1].commands[0].id);
});
