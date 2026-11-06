import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';
const candidate=()=>({instance:randomUUID(),secret:randomBytes(32).toString('base64url')});

test('runtime conflicts do not refresh presence; retry, process handoff and expiry fence the previous holder',async t=>{
 const f=await fixture(t),p=await phone(f,{runtime:true});
 const original={...p.lease},duplicate=candidate();
 f.sql('UPDATE devices SET last_contact=1 WHERE id=?',[p.id]);
 assert.equal((await p.acquire(duplicate)).status,423);
 assert.deepEqual(f.sql('SELECT last_contact FROM devices WHERE id=?',[p.id]),[[1]]);
 assert.equal(f.sql('SELECT conflicts FROM device_runtimes WHERE device_id=?',[p.id])[0][0],1);
 const retry=await p.acquire(original);assert.equal(retry.status,200);assert.equal((await retry.json()).generation,1,'lost-response retries are idempotent');
 const prepared=p.prepare('/v1/sync',{report:{runtime_sequence:2,foreground_user:true}},{raw:true});
 assert.equal((await p.acquire(duplicate,[original.secret])).status,200);
 const stale=await fetch(f.deviceOrigin+'/v1/sync',{method:'POST',headers:prepared.headers,body:prepared.text});
 assert.equal(stale.status,428);assert.equal(f.sql('SELECT management_report FROM devices WHERE id=?',[p.id])[0][0],null);
 assert.equal((await p.request('/v1/commands',{}, {session:original})).status,428);
 assert.equal((await p.request('/v1/commands',{}, {session:null})).status,428,'a legacy signature cannot bypass an upgraded identity');
 assert.equal((await p.request('/v1/commands',{})).status,200);
 f.sql('UPDATE device_runtimes SET expires=1 WHERE device_id=?',[p.id]);
 const afterExpiry=candidate();assert.equal((await p.acquire(afterExpiry)).status,200);
 assert.equal((await p.request('/v1/commands',{}, {session:duplicate})).status,428);
});

test('late and duplicate reports cannot overwrite current camera/foreground state; commands have one execution claim',async t=>{
 const f=await fixture(t),p=await phone(f,{profiles:true,capabilities:['message','stop_all']});
 const report=(seq,foreground)=>p.request('/v1/sync',{report:{runtime_sequence:seq,foreground_user:foreground,recovery_consent:true,profile_fingerprint:p.fingerprint}},{raw:true});
 assert.equal((await report(7,true)).status,200);
 const acceptedAt=f.sql('SELECT management_report_at FROM devices WHERE id=?',[p.id])[0][0];
 for(const seq of [6,7]) {const r=await report(seq,false);assert.equal(r.status,200);assert.equal((await r.json()).report_accepted,false);}
 const stored=JSON.parse(f.sql('SELECT management_report FROM devices WHERE id=?',[p.id])[0][0]);assert.equal(stored.foreground_user,true);assert.equal(stored.runtime_sequence,7);
 assert.equal(f.sql('SELECT management_report_at FROM devices WHERE id=?',[p.id])[0][0],acceptedAt);
 assert.equal((await p.request('/v1/sync',{report:{}})).status,200,'lost enrollment confirmation is read only');
 await f.admin(`/api/devices/${p.id}/commands`,'POST',{kind:'message',message:'Only once'});
 const command=(await (await p.request('/v1/commands',{})).json()).commands[0];
 const responses=await Promise.all(Array.from({length:8},()=>p.request('/v1/command-check',{id:command.id})));
 const permissions=await Promise.all(responses.map(r=>r.json()));assert.equal(permissions.filter(r=>r.allowed).length,1);
 const old={...p.lease};await p.acquire(candidate(),[old.secret]);
 assert.equal((await (await p.request('/v1/command-check',{id:command.id})).json()).allowed,false,'handoff cannot repeat an unknown physical action');
});

test('main selection is explicit, invitations stay separate, and duplicate Android-profile pairing preserves its invitation',async t=>{
 const f=await fixture(t),normal=await phone(f,{runtime:true});
 const childKey=randomBytes(32).toString('base64');
 const issue=()=>f.admin('/api/enrollments','POST',{name:'Sandbox',wg_public_key:childKey,primary_device_id:normal.id});
 assert.equal((await issue()).status,409,'normal pairing does not silently become multi-profile');
 assert.equal((await f.admin(`/api/devices/${normal.id}/profiles/setup`,'POST',{main_profile_name:'Personal'})).status,200);
 assert.equal((await issue()).status,409,'wait for the main installation to confirm its user identity');
 const fingerprint=randomBytes(32).toString('hex');
 assert.equal((await normal.request('/v1/sync',{report:{profile_fingerprint:fingerprint}})).status,200);
 const invitation=await (await issue()).json();
 const grouped=(await (await f.admin('/api/devices')).json()).devices[0];
 assert.equal(grouped.profiles.length,0);assert.equal(grouped.profile_invitations.length,1);assert.equal(grouped.main_profile_name,'Personal');
 // Use a real signed enrollment request with a duplicate scoped identity.
 const {generateKeyPairSync,sign}=await import('node:crypto'),keys=generateKeyPairSync('ec',{namedCurve:'P-256'}),pub=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
 const body={token:invitation.token,public_key:pub,wg_public_key:childKey,proof:sign('sha256',Buffer.from(`BUNGEE-ENROLL-V1\n${invitation.token}\n${childKey}\n${pub}`),keys.privateKey).toString('base64'),capabilities:['message'],profile_companion:true,runtime_protocol:1,profile_fingerprint:fingerprint};
 assert.equal((await f.device('/v1/enroll',body)).status,409);
 body.profile_fingerprint=randomBytes(32).toString('hex');assert.equal((await f.device('/v1/enroll',body)).status,200);
 const paired=(await (await f.admin('/api/devices')).json()).devices[0];assert.equal(paired.profiles.length,1);assert.equal(paired.profile_invitations.length,0);
 assert.equal((await normal.request('/v1/runtime',{...candidate(),profile_fingerprint:'0'.repeat(64)}, {session:null})).status,409,'a different Android user cannot assume the saved main identity');
});
