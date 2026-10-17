import test from "node:test";
import assert from "node:assert/strict";
import {request as httpRequest} from "node:http";
import {fixture,pause} from "./support/server.mjs";
import {phone} from "./support/phone.mjs";

test("privacy generation and locate commit admission against the live server",async t=>{
  const f=await fixture(t),p=await phone(f),now=()=>Math.floor(Date.now()/1000);
  let epoch=p.epoch;
  const fix=(offset=60)=>({latitude:1,longitude:2,accuracy:3,observed_at:now()+offset});
  const report=(point,generation=epoch)=>({battery:42,charging:false,device_owner:false,capabilities:["locate"],location:point,gps_epoch:generation});
  const erase=async()=>{assert.equal((await f.admin(`/api/devices/${p.id}/location`,"DELETE")).status,200);};
  const reconcile=async()=>{const r=await p.request("/v1/commands",{});assert.equal(r.status,200);epoch=(await r.json()).gps_epoch;};
  const empty=async()=>{
    const r=await f.admin(`/api/devices/${p.id}/history?from=0&to=${now()+120}`);assert.equal(r.status,200);assert.deepEqual((await r.json()).records,[]);
    const d=(await (await f.admin("/api/devices")).json()).devices.find(d=>d.id===p.id);assert.equal(d.telemetry?.location ?? null,null);
  };
  await t.test("future-dated pre-erasure fix cannot restore history or last-known point",async()=>{
    const old=epoch,body=report(fix());
    await erase();
    const r=await p.request("/v1/telemetry",body);assert.equal(r.status,200);
    const result=await r.json();assert.equal(result.gps_accepted,false);assert.deepEqual(result.accepted_observations,[]);assert.notEqual(result.gps_epoch,old);
    await empty();await reconcile();
  });
  await t.test("a signed slow body prepared before erasure is rejected on eventual arrival",async()=>{
    const prepared=p.prepare("/v1/telemetry",report(fix()));
    let request;
    const completed=new Promise((resolve,reject)=>{
      request=httpRequest(f.deviceOrigin+"/v1/telemetry",{method:"POST",headers:{...prepared.headers,"Content-Length":Buffer.byteLength(prepared.text)}},r=>{
        let body="";r.setEncoding("utf8");r.on("data",b=>body+=b);r.on("end",()=>resolve({status:r.statusCode,body:JSON.parse(body)}));
      });request.on("error",reject);request.write(prepared.text.slice(0,-1));
    });
    await pause(20);await erase();request.end(prepared.text.slice(-1));
    const r=await completed;assert.equal(r.status,200);assert.equal(r.body.gps_accepted,false);await empty();await reconcile();
  });
  await t.test("erase/upload transactions serialize safely, including repeated erasure",async()=>{
    for(let n=0;n<5;n++) {
      const body=report(fix());
      const [uploaded]=await Promise.all([p.request("/v1/telemetry",body),erase()]);
      assert.equal(uploaded.status,200);await uploaded.json();await empty();await reconcile();
    }
  });
  await t.test("restart retains the generation; a fresh-generation fix can be accepted",async()=>{
    const saved=epoch;await f.stop();await f.launch();await reconcile();assert.equal(epoch,saved);
    const old=await p.request("/v1/telemetry",report(fix(),p.epoch));assert.equal((await old.json()).gps_accepted,false);await empty();
    const point=fix();const current=await p.request("/v1/telemetry",report(point));assert.equal(current.status,200);assert.ok((await current.json()).accepted_observations.includes(point.observed_at));
    await erase();await reconcile();await empty();
  });
  await t.test("legacy location payload fails explicitly instead of silently acknowledging a dropped backlog",async()=>{
    const body=report(fix());delete body.gps_epoch;
    assert.equal((await p.request("/v1/telemetry",body)).status,409);await empty();
  });
  await t.test("locate needs an offered, unexpired command and acknowledges its exact stored fix",async()=>{
    const created=await f.admin(`/api/devices/${p.id}/commands`,"POST",{kind:"locate"});assert.equal(created.status,200);
    const command=await created.json();
    const id=command.id;
    assert.ok(id);
    const payload={...report(fix()),locate_command:id};
    assert.equal((await p.request("/v1/telemetry",payload)).status,409); // Not offered yet.
    await reconcile();
    assert.equal((await p.request("/v1/telemetry",{...payload,location:null})).status,409);
    const accepted=await p.request("/v1/telemetry",payload);assert.equal(accepted.status,200);
    assert.deepEqual((await accepted.json()).accepted_observations,[payload.location.observed_at]);
    const conflict=await p.request("/v1/telemetry",{...payload,location:{...payload.location,latitude:4}});
    assert.deepEqual((await conflict.json()).accepted_observations,[]);
    // Force expiry after the first admission check but before the final commit check.
    const later={...payload,location:{...payload.location,observed_at:now()+90}};
    f.sql(`CREATE TRIGGER expire_locate_during_insert AFTER INSERT ON location_history BEGIN UPDATE commands SET expires=1 WHERE id='${id}'; END`);
    assert.equal((await p.request("/v1/telemetry",later)).status,409);
    assert.equal(f.sql("SELECT count(*) FROM location_history WHERE device_id=? AND observed_at=?",[p.id,later.location.observed_at])[0][0],0);
    f.sql("DROP TRIGGER expire_locate_during_insert");
    f.sql("UPDATE commands SET expires=? WHERE id=?",[now()-1,id]);
    const before=f.sql("SELECT count(*) FROM state_history WHERE device_id=?",[p.id])[0][0];
    assert.equal((await p.request("/v1/telemetry",payload)).status,409);
    assert.equal(f.sql("SELECT count(*) FROM state_history WHERE device_id=?",[p.id])[0][0],before);
  });
});
