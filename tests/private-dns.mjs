import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import tls from 'node:tls';
import dgram from 'node:dgram';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';
function query(name){const h=Buffer.alloc(12);h.writeUInt16BE(56);h.writeUInt16BE(0x100,2);h.writeUInt16BE(1,4);return Buffer.concat([h,...name.split('.').flatMap(s=>[Buffer.from([s.length]),Buffer.from(s)]),Buffer.from([0,0,1,0,1])]);}
async function exchange(f,host,ca,name='www.example.org'){
 const q=query(name),h=Buffer.alloc(2);h.writeUInt16BE(q.length);
 return new Promise((resolve,reject)=>{const socket=tls.connect({host:'127.0.0.1',port:f.dotPort,servername:host,ca},()=>socket.write(Buffer.concat([h,q])));let buffer=Buffer.alloc(0);socket.setTimeout(3000,()=>socket.destroy(Error('DNS timeout')));socket.on('error',reject);socket.on('data',d=>{buffer=Buffer.concat([buffer,d]);if(buffer.length>=2&&buffer.length>=2+buffer.readUInt16BE(0)){socket.destroy();resolve(buffer.subarray(2));}});socket.on('end',()=>resolve(null));});
}
const report=(revision,state='active',extra={})=>({revision,state,active:state==='active',consent:state!=='removed',permission:true,detail:'test',at:Math.floor(Date.now()/1000),...extra});
test('Private DNS uses per-phone TLS profiles, preserves the relay during restoration and removes only after acknowledgement',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-dot-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cert=join(dir,'cert.pem'),key=join(dir,'key.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=*.dns.example.test','-addext','subjectAltName=DNS:*.dns.example.test','-keyout',key,'-out',cert],{stdio:'ignore'});const ca=await readFile(cert);
 const udp=dgram.createSocket('udp4');await new Promise(r=>udp.bind(0,'127.0.0.1',r));t.after(()=>udp.close());let received=0;
 udp.on('message',(data,peer)=>{received++;const response=Buffer.from(data);response.writeUInt16BE(0x8180,2);udp.send(response,peer.port,peer.address);});
 const f=await fixture(t,{dns:{ip:'127.0.0.1',port:udp.address().port},privateDns:{host:'dns.example.test',cert,key}}),first=await phone(f),second=await phone(f);
 const set=(p,revision,action='enable',fallback=true)=>f.admin(`/api/devices/${p.id}/private-dns`,'POST',{expected_revision:revision,action,fallback});
 assert.equal((await f.device('/v1/private-dns',report(0))).status,401);
 assert.equal((await first.request('/v1/private-dns',report(0,'disabled'))).status,200);
 let response=await set(first,0);assert.equal(response.status,200);const a=await response.json();assert.match(a.hostname,/^[a-f0-9]{32}\.dns\.example\.test$/);assert.equal(a.fallback,true);
 response=await set(second,0);const b=await response.json();assert.notEqual(a.hostname,b.hostname);
 const answer=await exchange(f,a.hostname,ca);assert.equal(answer.readUInt16BE(0),56);assert.equal(answer.readUInt16BE(2)&15,0);
 await exchange(f,b.hostname,ca,'other.example.net');assert.equal(received,2);
 assert.deepEqual(f.sql('SELECT device_id,SUM(queries) FROM dns_summary GROUP BY device_id ORDER BY device_id'),[[first.id,1],[second.id,1]].sort((x,y)=>x[0].localeCompare(y[0])));
 const now=Math.floor(Date.now()/1000),summary=await(await f.admin(`/api/dns?from=${now-60}&to=${now+60}`)).json();assert.equal(summary.counts.traffic,2);assert.equal(summary.counts.diagnostics,0);assert.equal(summary.private_dns_configured,true);
 assert.equal((await set(first,0)).status,409);
 assert.equal(await exchange(f,`${'f'.repeat(32)}.dns.example.test`,ca),null);assert.equal(received,2);
 assert.equal((await first.request('/v1/private-dns',report(1))).status,200);
 response=await set(first,1,'disable');assert.equal(response.status,200);
 assert.ok(await exchange(f,a.hostname,ca)); // Strict mode must continue working while the phone is offline.
 await first.request('/v1/private-dns',report(2,'error',{active:false}));assert.ok(await exchange(f,a.hostname,ca)); // An error is not an acknowledgement of restoration.
 await first.request('/v1/private-dns',report(2,'disabled'));assert.equal(await exchange(f,a.hostname,ca),null);
 response=await set(first,2,'enable',false);const retry=await response.json();assert.equal(retry.fallback,false);assert.equal(retry.hostname,a.hostname);
 await first.request('/v1/private-dns',report(3));response=await set(first,3,'remove');assert.equal(response.status,200);assert.ok(await exchange(f,a.hostname,ca));
 await first.request('/v1/private-dns',report(4,'removed'));assert.equal(await exchange(f,a.hostname,ca),null);assert.equal(f.sql('SELECT hostname FROM dns_profiles WHERE device_id=?',[first.id])[0][0],'');assert.equal(f.sql('SELECT COUNT(*) FROM devices')[0][0],2);
 assert.ok(await exchange(f,b.hostname,ca));assert.equal((await f.admin(`/api/devices/${second.id}`,'DELETE')).status,200);assert.equal(await exchange(f,b.hostname,ca),null);
 assert.equal((await f.admin(`/api/devices/${second.id}/private-dns`,'POST',{expected_revision:1,action:'confirm_restored',fallback:true})).status,400);
 const confirmed=await f.admin(`/api/devices/${second.id}/private-dns`,'POST',{expected_revision:1,action:'confirm_restored',fallback:true,restored_locally:true});assert.equal(confirmed.status,200);assert.equal((await confirmed.json()).hostname,'');assert.equal(f.sql("SELECT COUNT(*) FROM audit WHERE action='dns.local_restoration_confirmed'")[0][0],1);
});
test('DNS setup cannot enable without a TLS endpoint, while Off/removal and validation remain available',async t=>{
 const f=await fixture(t),p=await phone(f);
 let r=await f.admin(`/api/devices/${p.id}/private-dns`);assert.equal(r.status,200);assert.equal((await r.json()).configured,false);
 const set=(body)=>f.admin(`/api/devices/${p.id}/private-dns`,'POST',body);
 assert.equal((await set({expected_revision:0,action:'enable',fallback:true})).status,503);
 assert.equal((await set({expected_revision:0,action:'disable',fallback:true})).status,200);
 assert.equal((await p.request('/v1/private-dns',report(2))).status,400);
 assert.equal((await p.request('/v1/private-dns',report(1,'made_up'))).status,400);
 assert.equal((await p.request('/v1/private-dns',report(1,'disabled'))).status,200);
 assert.equal((await set({expected_revision:1,action:'remove',fallback:true})).status,200);
});
