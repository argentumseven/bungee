import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';
const TEST='[Bungee DNS path test]';

test('DNS workspace aggregates phones, keeps tests separate, and scopes/searches/paginates received activity',async t=>{
 const f=await fixture(t),first=await phone(f),second=await phone(f),at=Math.floor(Date.now()/1000),bucket=Math.floor(at/300)*300;
 f.sql('UPDATE devices SET name=? WHERE id=?',['First phone',first.id]);f.sql('UPDATE devices SET name=? WHERE id=?',['Second phone',second.id]);
 const row=(id,domain,queries,activities=1,when=bucket)=>f.sql('INSERT INTO dns_summary VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,when,domain,queries,activities,Math.floor(at/10),at-60,at,queries,0,0,queries,0,0,0]);
 row(first.id,'example.org',3,2);row(second.id,'example.org',5,4);row(second.id,'other.example',2);row(first.id,TEST,2);row(second.id,TEST,1);row(first.id,'old.example',99,1,bucket-40*86400);
 const base=`/api/dns?from=${at-86400}&to=${at}`;
 assert.equal((await f.admin(base,'GET',undefined,{Cookie:''})).status,401);
 const read=async suffix=>{const r=await f.admin(base+suffix);assert.equal(r.status,200);return r.json();};
 const all=await read('');assert.equal(all.kind,'traffic');assert.equal(all.queries,10);assert.equal(all.activities,7);assert.equal(all.domains,2);assert.equal(all.phones,2);assert.equal(all.phone_dns_routed,false);
 assert.deepEqual(all.counts,{traffic:10,diagnostics:3});assert.deepEqual(all.records.map(r=>r.domain),['example.org','other.example']);assert.equal(all.records[0].devices,2);
 assert.equal(all.devices.find(p=>p.id===first.id).queries,3);assert.equal(all.devices.find(p=>p.id===second.id).queries,7);
 const selected=await read(`&device_id=${first.id}`);assert.equal(selected.queries,3);assert.equal(selected.domains,1);assert.equal(selected.devices.length,1);assert.equal(selected.devices[0].id,first.id);
 const checks=await read('&kind=diagnostics');assert.equal(checks.queries,3);assert.equal(checks.records[0].domain,TEST);assert.equal(checks.phones,2);
 assert.equal((await read('&kind=all')).queries,13);
 const page=await read('&limit=1');assert.equal(page.records.length,1);assert.equal(page.has_more,true);
 const next=await read('&limit=1&offset=1');assert.equal(next.records[0].domain,'other.example');assert.equal(next.has_more,false);
 const searched=await read('&q=EXAMPLE.ORG');assert.equal(searched.queries,8);assert.equal(searched.domains,1);
 assert.equal((await read('&q=%25')).queries,0,'SQL wildcard characters are searched literally');
 assert.equal((await read('&q='+encodeURIComponent("' OR 1=1 --"))).queries,0);
 for(const suffix of ['&limit=0','&limit=101','&offset=10001','&kind=bad','&q='+ 'a'.repeat(255),'&q=%0A'])assert.equal((await f.admin(base+suffix)).status,400,suffix);
 assert.equal((await f.admin(`/api/dns?from=${at-32*86400}&to=${at}`)).status,400);
 assert.equal((await f.admin(base+'&device_id=unknown')).status,404);
 // Archived phones keep their saved DNS visible, but cannot run a new diagnostic.
 f.sql('UPDATE devices SET revoked=1,public_key=NULL WHERE id=?',[second.id]);
 const archived=await read(`&device_id=${second.id}`);assert.equal(archived.queries,7);assert.equal(archived.devices[0].can_test,false);assert.equal(archived.devices[0].revoked,true);
 assert.equal((await f.admin(`/api/devices/${first.id}/dns`,'DELETE')).status,200);
 const remaining=await read('&kind=all');assert.equal(remaining.queries,8);assert.equal(remaining.devices.find(p=>p.id===first.id).queries,0);
 assert.equal(f.sql('SELECT COUNT(*) FROM devices')[0][0],2,'DNS erasure keeps phone records');
});
