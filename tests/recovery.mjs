import test from "node:test";
import assert from "node:assert/strict";
import {fixture} from "./support/server.mjs";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {phone} from "./support/phone.mjs";

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
