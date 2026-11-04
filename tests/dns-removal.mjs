import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';

test('upgrade removes DNS state and diagnostics while preserving pairing, GPS, photos and other commands',async t=>{
 const f=await fixture(t),p=await phone(f),at=Math.floor(Date.now()/1000);
 f.sql('INSERT INTO location_history(device_id,observed_at,received_at,latitude,longitude,accuracy) VALUES(?,?,?,?,?,?)',[p.id,at,at,12,34,5]);
 f.sql("INSERT INTO recovery_photos(device_id,photo_id,captured_at,received_at,failed_attempts,reason,jpeg) VALUES(?,?,?,?,0,'local_test',X'FFD8FFD9')",[p.id,'saved-photo',at,at]);
 const command=await (await f.admin(`/api/devices/${p.id}/commands`,'POST',{kind:'locate'})).json();
 const binding=f.sql('SELECT public_key,wg_key,wg_psk,gps_epoch,photo_epoch FROM devices WHERE id=?',[p.id]);
 await f.stop();
 f.sql('CREATE TABLE dns_summary(device_id TEXT,domain TEXT)');
 f.sql('INSERT INTO dns_summary VALUES(?,?)',[p.id,'example.org']);
 f.sql('CREATE TABLE dns_profiles(device_id TEXT,hostname TEXT)');
 f.sql('INSERT INTO dns_profiles VALUES(?,?)',[p.id,'old.dns.example.org']);
 f.sql("UPDATE devices SET management_report=?,capabilities=? WHERE id=?",[JSON.stringify({revision:0,dns_active:true,system_dns:{servers:['10.77.0.1']},secure_lock:true}),JSON.stringify(['locate','dns_check']),p.id]);
 f.sql("INSERT INTO commands(id,device_id,kind,payload,created,expires) VALUES(?,?,'dns_check','{}',?,?)",['retired-test',p.id,at,at+300]);
 await f.launch();
 assert.deepEqual(f.sql("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dns_profiles','dns_summary')"),[]);
 assert.deepEqual(f.sql('SELECT public_key,wg_key,wg_psk,gps_epoch,photo_epoch FROM devices WHERE id=?',[p.id]),binding);
 assert.equal(f.sql('SELECT COUNT(*) FROM location_history WHERE device_id=?',[p.id])[0][0],1);
 assert.equal(f.sql('SELECT COUNT(*) FROM recovery_photos WHERE device_id=?',[p.id])[0][0],1);
 const commands=(await (await p.request('/v1/commands',{})).json()).commands;
 assert.deepEqual(commands.map(c=>c.id),[command.id]);
 const devices=await (await f.admin('/api/devices')).json();
 const saved=devices.devices.find(d=>d.id===p.id);
 assert.deepEqual(saved.capabilities,['locate']);assert.equal(saved.management.secure_lock,true);
 assert.equal('dns_active' in saved.management,false);assert.equal('system_dns' in saved.management,false);
 assert.equal((await f.admin(`/api/devices/${p.id}/commands`,'POST',{kind:'dns_check'})).status,400);
 for(const path of ['/v1/dns-check','/v1/private-dns'])assert.equal((await p.request(path,{})).status,404);
 for(const path of ['/api/dns',`/api/devices/${p.id}/dns`,`/api/devices/${p.id}/private-dns`]){
  const r=await f.admin(path);assert.ok(r.status===404||!r.headers.get('content-type')?.includes('application/json'),`${path} must not expose a DNS API`);
 }
});

test('old phones may sync retired fields during upgrade; the server discards them and refuses activation',async t=>{
 const f=await fixture(t),p=await phone(f);
 const report={revision:0,secure_lock:true,system_dns:{available:true,servers:['10.10.20.3'],private_dns_active:true,private_dns_name:'old.dns.example.org',captured_by_bungee:false},dns_active:false};
 const sync=await p.request('/v1/sync',{report});assert.equal(sync.status,200);
 const desired=await sync.json();assert.equal('dns_available' in desired,false);assert.equal('managed_dns' in desired.policy,false);
 const stored=JSON.parse(f.sql('SELECT management_report FROM devices WHERE id=?',[p.id])[0][0]);
 assert.equal(stored.secure_lock,true);assert.equal('system_dns' in stored,false);assert.equal('dns_active' in stored,false);
 const telemetry=await p.request('/v1/telemetry',{battery:50,charging:false,device_owner:false,capabilities:['locate','dns_check']});assert.equal(telemetry.status,200);
 assert.deepEqual(JSON.parse(f.sql('SELECT capabilities FROM devices WHERE id=?',[p.id])[0][0]),['locate']);
 const policy=await (await f.admin(`/api/devices/${p.id}/policy`)).json();
 assert.equal('dns_configured' in policy,false);assert.equal('dns_upstream' in policy,false);
 assert.equal((await f.admin(`/api/devices/${p.id}/policy`,'POST',{expected_revision:0,policy:{managed_dns:true,always_on:true}})).status,400);
});
