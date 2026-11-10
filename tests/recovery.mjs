import test from "node:test";
import assert from "node:assert/strict";
import {fixture} from "./support/server.mjs";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {phone} from "./support/phone.mjs";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";

test("manual profile pictures target only the selected locally enabled profile",async t=>{
 const f=await fixture(t),main=await phone(f,{profiles:true,capabilities:["take_picture","stop_all"]});
 const sandbox=await phone(f,{name:"Sandbox",primaryDeviceId:main.id,capabilities:["take_picture","stop_all"]});
 const other=await phone(f,{name:"Work",primaryDeviceId:main.id,capabilities:["stop_all"]});
 assert.equal((await f.admin(`/api/devices/${other.id}/commands`,"POST",{kind:"take_picture"})).status,400);
 const response=await f.admin(`/api/devices/${sandbox.id}/commands`,"POST",{kind:"take_picture"});assert.equal(response.status,200);
 const queued=await response.json();
 assert.deepEqual((await (await main.request("/v1/commands",{})).json()).commands,[]);
 assert.deepEqual((await (await other.request("/v1/commands",{})).json()).commands,[]);
 const offered=(await (await sandbox.request("/v1/commands",{})).json()).commands;
 assert.deepEqual(offered.map(c=>[c.id,c.kind]),[[queued.id,"take_picture"]]);
 assert.equal((await (await sandbox.request("/v1/command-check",{id:queued.id})).json()).allowed,true);
 assert.equal((await (await sandbox.request("/v1/command-check",{id:queued.id})).json()).allowed,false,"runtime execution claims prevent repeated pictures");
 assert.equal((await f.admin(`/api/devices/${main.id}/commands`,"POST",{kind:"stop_all"})).status,200);
 assert.deepEqual((await (await sandbox.request("/v1/commands",{})).json()).commands.map(c=>c.kind),["stop_all"]);
});

test("manual pictures require a granted capability and use normal receipts, cancellation and photo storage",async t=>{
 const f=await fixture(t),p=await phone(f),other=await phone(f),path=`/api/devices/${p.id}/commands`;
 const queue=()=>f.admin(path,"POST",{kind:"take_picture"});
 assert.equal((await queue()).status,400,"older/disarmed phones have no manual camera capability");
 assert.equal((await p.request("/v1/telemetry",{battery:70,charging:false,device_owner:false,capabilities:["take_picture","stop_all"]})).status,200);
 assert.equal((await fetch(f.origin+path,{method:"POST",headers:{Origin:f.origin,"Content-Type":"application/json"},body:JSON.stringify({kind:"take_picture"})})).status,401);
 assert.equal((await f.admin(path,"POST",{kind:"take_picture"},{Origin:"https://evil.invalid"})).status,403);
 assert.equal((await f.admin(`/api/devices/${other.id}/commands`,"POST",{kind:"take_picture"})).status,400);
 const response=await queue();assert.equal(response.status,200);const queued=await response.json();
 const offered=await (await p.request("/v1/commands",{})).json();
 assert.deepEqual(offered.commands.map(c=>[c.id,c.kind]),[[queued.id,"take_picture"]]);
 assert.equal(f.sql("SELECT expires-created FROM commands WHERE id=?",[queued.id])[0][0],300);
 assert.equal((await (await p.request("/v1/command-check",{id:queued.id})).json()).allowed,true);
 const photo={id:randomUUID(),captured_at:Math.floor(Date.now()/1000),failed_attempts:0,reason:"remote_manual",jpeg:(await readFile("tests/fixtures/recovery-test.jpg")).toString("base64")};
 const upload={photo_epoch:offered.photo_epoch,photo};
 assert.equal((await p.request("/v1/photos",{...upload,photo:{...photo,failed_attempts:3}})).status,400);
 for(let i=0;i<2;i++){
  const accepted=await p.request("/v1/photos",upload);assert.equal(accepted.status,200);assert.equal((await accepted.json()).accepted_photo,photo.id);
 }
 const gallery=await (await f.admin(`/api/devices/${p.id}/photos`)).json();
 assert.equal(gallery.photos.length,1);assert.equal(gallery.photos[0].reason,"remote_manual");assert.equal(gallery.photos[0].failed_attempts,0);
 const report=await p.request("/v1/sync",{report:{recovery_consent:true,camera:{armed:true,pending:1,reported_at:photo.captured_at,queued:[{id:photo.id,captured_at:photo.captured_at,reason:photo.reason}]}}});
 assert.equal(report.status,200,"pending manual photo metadata is accepted in signed status reports");
 const receipt={id:queued.id,status:"executed",result:"Picture captured and queued for upload",attempted_at:photo.captured_at};
 assert.equal((await p.request("/v1/ack",receipt)).status,200);
 assert.deepEqual((await (await p.request("/v1/commands",{})).json()).commands,[]);
 const canceled=await (await queue()).json();
 assert.equal((await f.admin(`${path}/${canceled.id}`,"DELETE")).status,200);
 assert.deepEqual((await (await p.request("/v1/commands",{})).json()).commands,[]);
 const pending=await (await queue()).json();await p.request("/v1/commands",{});
 assert.equal((await f.admin(path,"POST",{kind:"stop_all"})).status,200);
 assert.equal((await (await p.request("/v1/command-check",{id:pending.id})).json()).allowed,false);
 const expired=await (await queue()).json();f.sql("UPDATE commands SET expires=? WHERE id=?",[Math.floor(Date.now()/1000)-1,expired.id]);
 assert.ok((await (await p.request("/v1/commands",{})).json()).commands.every(c=>c.id!==expired.id));
 assert.equal((await p.request("/v1/telemetry",{battery:70,charging:false,device_owner:false,capabilities:[]})).status,200);
 assert.equal((await queue()).status,400,"withdrawing the camera capability prevents new requests");
});

test("individual cancellation stops delivery and preserves truthful late receipts",async t=>{
 const f=await fixture(t),p=await phone(f);
 const queue=async()=>{const r=await f.admin(`/api/devices/${p.id}/commands`,"POST",{kind:"locate"});assert.equal(r.status,200);return (await r.json()).id;};
 const path=id=>`/api/devices/${p.id}/commands/${id}`;
 const one=await queue(),two=await queue();
 assert.equal((await f.admin(path(one),"DELETE",undefined,{Origin:"https://example.invalid"})).status,403);
 assert.equal((await f.admin(path(one),"DELETE")).status,200);
 const batch=await (await p.request("/v1/commands",{})).json();
 assert.deepEqual(batch.commands.map(c=>c.id),[two]);
 assert.equal((await (await p.request("/v1/command-check",{id:two})).json()).allowed,true);
 const canceled=await (await f.admin(path(two),"DELETE")).json();assert.equal(canceled.already_offered,true);
 assert.equal((await (await p.request("/v1/command-check",{id:two})).json()).allowed,false);
 assert.deepEqual((await (await p.request("/v1/commands",{})).json()).commands,[]);
 const receipt=await p.request("/v1/ack",{id:two,status:"executed",result:"Already started",attempted_at:Math.floor(Date.now()/1000)});
 assert.equal((await receipt.json()).settled,true);
 const record=(await (await f.admin("/api/devices")).json()).commands.find(c=>c.id===two);
 assert.equal(record.status,"canceled");assert.match(record.result,/phone later reported executed/);
 assert.equal((await f.admin(path(one),"DELETE")).status,200);
});

test("GPS collection filters precede pagination and recurrence; CSV keeps the same source",async t=>{
 const f=await fixture(t),p=await phone(f),now=Math.floor(Date.now()/1000);
 for(let i=0;i<12;i++){
  const location={latitude:33,longitude:-80,accuracy:10,observed_at:now-120+i,source:i%2?"best_guess":"passive",samples:8,system_vpn:true};
  assert.equal((await p.request("/v1/telemetry",{battery:50,charging:false,device_owner:false,capabilities:["locate","best_guess","flash","ring_flash"],gps_epoch:p.epoch,location})).status,200);
 }
 const base=`/api/devices/${p.id}/history?from=${now-200}&to=${now}&source=best_guess`;
 let rows=(await (await f.admin(base+"&limit=2")).json());assert.equal(rows.records.length,2);assert.ok(rows.next_before);
 assert.ok(rows.records.every(r=>r.source==="best_guess"&&r.samples===8&&r.system_vpn===true));
 const rest=(await (await f.admin(base+`&before=${rows.next_before}&limit=20`)).json()).records;assert.equal(rest.length,4);
 for(const suffix of ["","&every=60","&daily=00:00&timezone=UTC&tolerance=7200"]){
  const json=await (await f.admin(base+suffix)).json();
  const csv=await (await f.admin(base.replace("/history?","/history.csv?")+suffix)).text();
  assert.match(csv,/source,samples,system_vpn/);
  const entries=csv.trim().split("\n").slice(1);assert.equal(entries.length,json.records.length);assert.ok(entries.every(row=>row.endsWith(",best_guess,8,true")));
 }
 assert.equal((await f.admin(base.replace("best_guess","arbitrary"))).status,400);
 const command=await (await f.admin(`/api/devices/${p.id}/commands`,"POST",{kind:"best_guess"})).json();
 await p.request("/v1/commands",{});
 await f.admin(`/api/devices/${p.id}/commands/${command.id}`,"DELETE");
 const late=await p.request("/v1/telemetry",{battery:50,charging:false,device_owner:false,capabilities:["locate"],gps_epoch:p.epoch,locate_command:command.id,location:{latitude:33,longitude:-80,accuracy:10,observed_at:now,source:"best_guess",samples:30}});
 assert.equal(late.status,409);
});

test("bundled production GeoIP decodes both address families and map byte ranges stay authenticated",async t=>{
 const data=await mkdtemp(join(tmpdir(),"bungee-default-data-"));t.after(()=>rm(data,{recursive:true,force:true}));
 execFileSync("python3",["-c","import gzip,pathlib,sys; root=pathlib.Path(sys.argv[1]); [(root/name).write_bytes(gzip.decompress(pathlib.Path('basemap/'+source).read_bytes())) for source,name in [('dbip-city-ipv4.mmdb.gz','geoip.mmdb'),('dbip-city-ipv6.mmdb.gz','geoip-v6.mmdb')]]",data]);
 execFileSync("python3",["tests/fixtures/vector_map.py",join(data,"map.pmtiles")]);
 const f=await fixture(t,{geodata:data}),p=await phone(f),now=Math.floor(Date.now()/1000),wg=f.sql("SELECT wg_key FROM devices WHERE id=?",[p.id])[0][0];
 for(const [index,ip] of ["1.1.1.1","2606:4700:4700::1111"].entries()){
  await writeFile(join(f.dir,"wireguard/endpoints.json"),JSON.stringify({sampled_at:now,peers:[{public_key:wg,ip,observed_at:now-2+index}]}));
  const device=(await (await f.admin("/api/devices")).json()).devices[0];
  assert.equal(device.network.ip,ip);assert.ok(device.network.geoip.country);assert.ok(Number.isFinite(device.network.geoip.latitude));assert.ok(Number.isFinite(device.network.geoip.longitude));assert.match(device.network.geoip.database_type,/DBIP/);
 }
 const path="/api/maps/archive.pmtiles";
 assert.equal((await fetch(f.origin+path,{headers:{Range:"bytes=0-126"}})).status,401);
 assert.equal((await f.admin(path)).status,400);
 assert.equal((await f.admin(path,"GET",undefined,{Range:"bytes=0-999999999"})).status,400);
 const r=await f.admin(path,"GET",undefined,{Range:"bytes=0-126"});assert.equal(r.status,206);assert.equal(r.headers.get("cache-control"),"no-store");assert.match(r.headers.get("content-range"),/^bytes 0-126/);assert.equal((await r.arrayBuffer()).byteLength,127);
});

test("Stop all bypasses a full queue, invalidates offers, resets lost mode, and gets urgent delivery",async t=>{
 const f=await fixture(t),p=await phone(f);
 assert.equal((await p.request("/v1/telemetry",{battery:70,charging:false,device_owner:false,capabilities:["locate","ring","stop_all"]})).status,200);
 assert.equal((await p.request("/v1/sync",{report:{recovery_consent:true}})).status,200);
 assert.equal((await f.admin(`/api/devices/${p.id}/policy`,"POST",{expected_revision:0,policy:{lost_mode:true,haste:true,recovery_message:"Find this phone"}})).status,200);
 const ids=[];
 for(let n=0;n<10;n++){const r=await f.admin(`/api/devices/${p.id}/commands`,"POST",{kind:"ring"});assert.equal(r.status,200);ids.push((await r.json()).id);}
 assert.deepEqual((await (await p.request("/v1/commands",{only_stop:true})).json()).commands,[]);
 assert.equal(f.sql("SELECT COUNT(*) FROM commands WHERE status='pending'")[0][0],10);
 assert.equal((await (await p.request("/v1/commands",{})).json()).commands.length,10);
 assert.equal((await (await p.request("/v1/command-check",{id:ids[0]})).json()).allowed,true);
 assert.equal((await f.admin(`/api/devices/${p.id}/commands`,"POST",{kind:"stop_all"}, {Origin:"https://evil.invalid"})).status,403);
 const r=await f.admin(`/api/devices/${p.id}/commands`,"POST",{kind:"stop_all"});assert.equal(r.status,200);const stop=await r.json();
 assert.equal((await (await p.request("/v1/command-check",{id:ids[0]})).json()).allowed,false);
 assert.equal(f.sql("SELECT COUNT(*) FROM commands WHERE status='canceled'")[0][0],10);
 const policy=await (await f.admin(`/api/devices/${p.id}/policy`)).json();assert.equal(policy.policy.lost_mode,false);assert.equal(policy.policy.haste,false);assert.equal(policy.policy.recovery_message,"");
 const urgent=await (await p.request("/v1/commands",{only_stop:true})).json();assert.deepEqual(urgent.commands.map(c=>c.id),[stop.id]);
 assert.equal(urgent.commands[0].kind,"stop_all");
 assert.equal((await (await p.request("/v1/ack",{id:stop.id,status:"executed",result:"Bungee actions stopped",attempted_at:Math.floor(Date.now()/1000)})).json()).accepted,true);
 assert.deepEqual((await (await p.request("/v1/commands",{})).json()).commands,[]);
});
