import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { phone } from "./support/phone.mjs";
import { fixture,pause } from "./support/server.mjs";

test("streamed history export: large data, filters, cancellation and authorization", async t=>{
  const f=await fixture(t);
  const id="1b9426b2-3572-4000-bf90-b360b3bc5550";
  f.sql("INSERT INTO devices(id,name,wg_key,address,created,public_key) VALUES(?,?,'export-fixture-key','10.77.0.2',1,'fixture-signing-key')",[id,"Synthetic export fixture"]);
  f.sql("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500000) INSERT INTO location_history SELECT ?,x,x,1.0,2.0,3.0 FROM n",[id]);
  const path=`/api/devices/${id}/history.csv?from=0&to=600000`;
  const rowCount=async response=>{
    assert.equal(response.status,200);
    let count=0;
    for await(const chunk of response.body) { for(const byte of chunk) if(byte===10)count++; }
    return count-1;
  };
  await t.test("500000 GPS rows use one bounded stream and preserve headers/time range",async()=>{
    const rss=async()=>Number((await readFile(`/proc/${f.pid}/status`,"utf8")).match(/^VmRSS:\s+(\d+)/m)[1])*1024;
    const before=await rss(); let peak=before;
    const timer=setInterval(()=>{rss().then(n=>peak=Math.max(peak,n)).catch(()=>{});},20);
    try {
      const response=await f.admin(path);
      assert.match(response.headers.get("content-type"),/^text\/csv/);
      assert.match(response.headers.get("content-disposition"),/attachment/);
      assert.equal(response.headers.get("cache-control"),"no-store");
      assert.equal(await rowCount(response),500000);
      assert.ok(peak-before<64*1024*1024,`Unexpected stream memory growth: ${peak-before}`);
      console.log(`HOST ONLY: 500000-row CSV peak RSS increase ${peak-before} bytes; not a universal capacity guarantee`);
    } finally {clearInterval(timer);}
  });
  await t.test("interval/daily sampling matches JSON history and cannot silently change its selection",async()=>{
    for(const suffix of ["&every=86400","&daily=09:00&timezone=UTC&tolerance=7200"]) {
      const json=await (await f.admin(path.replace("history.csv","history")+suffix+"&limit=1000")).json();
      const csv=await (await f.admin(path+suffix)).text();
      const times=csv.trim().split("\n").slice(1).map(line=>Date.parse(line.split(",")[0])/1000);
      assert.deepEqual(times,json.records.map(r=>r.observed_at));
    }
    assert.equal((await f.admin(path+"&every=0")).status,400);
    assert.equal((await f.admin(path,"GET",undefined,{Cookie:""})).status,401);
  });
  await t.test("interval scans have finite spans/buckets and do not monopolize telemetry writes",async()=>{
    assert.equal((await f.admin(path.replace("to=600000","to=9999999999")+"&every=60")).status,400);
    assert.equal((await f.admin(`/api/devices/${id}/history?from=0&to=600000&every=60`)).status,400); // 10001 buckets.
    const p=await phone(f);
    const scans=[f.admin(path.replace("history.csv","history").replace("to=600000","to=599999")+"&every=60"),f.admin(path.replace("history.csv","history").replace("to=600000","to=599999")+"&every=60")];
    await pause(10);
    const started=performance.now();
    const uploaded=await p.request("/v1/telemetry",{battery:21,charging:false,device_owner:false,capabilities:[],location:null,gps_epoch:p.epoch});
    const latency=performance.now()-started;assert.equal(uploaded.status,200);await uploaded.json();assert.ok(latency<2000,`Telemetry took ${latency} ms during two 500000-row scans`);
    const results=await Promise.all(scans);for(const r of results){assert.equal(r.status,200);await r.json();}
    console.log(`HOST ONLY: telemetry ${latency.toFixed(1)} ms during two recurring 500000-row reads; not a universal latency guarantee`);
  });
  const hold=()=>new Promise((resolve,reject)=>{
    const req=request(f.origin+path,{headers:{Cookie:f.cookie}},res=>{res.pause();resolve({req,res});});
    req.on("error",reject);req.end();
  });
  await t.test("two stalled downloads are bounded and browser cancellation releases a slot",async()=>{
    const first=await hold(),second=await hold();
    try {
      assert.equal(first.res.statusCode,200);assert.equal(second.res.statusCode,200);
      assert.equal((await f.admin(path)).status,429);
      first.res.destroy();first.req.destroy();
      let response;
      for(let n=0;n<100;n++) {response=await f.admin(path);if(response.status===200)break;await pause(20);}
      assert.equal(response.status,200);await response.body.cancel();
    } finally {first.res.destroy();first.req.destroy();second.res.destroy();second.req.destroy();}
    await pause(100);
  });
  await t.test("administrator logout cancels an existing export",async()=>{
    const active=await hold();
    try {
      assert.equal(active.res.statusCode,200);
      assert.equal((await f.admin("/api/session","DELETE")).status,204);
      let ended=false,failed=false;
      active.res.on("error",()=>{failed=true;});active.res.on("end",()=>{ended=true;});
      const closed=new Promise(r=>active.res.once("close",r));active.res.resume();await closed;
      assert.ok(failed || !ended,"An unauthorized snapshot must not finish successfully");
      await f.login();
    } finally {active.res.destroy();active.req.destroy();}
  });
  await t.test("history erasure interrupts an existing snapshot instead of exporting removed data indefinitely",async()=>{
    const active=await hold();
    try {
      assert.equal(active.res.statusCode,200);
      assert.equal((await f.admin(`/api/devices/${id}/location`,"DELETE")).status,200);
      let ended=false,failed=false;
      active.res.on("error",()=>{failed=true;});
      active.res.on("end",()=>{ended=true;});
      const closed=new Promise(r=>active.res.once("close",r));
      active.res.resume();await closed;
      assert.ok(failed || !ended,"A cancelled snapshot must not report a successful complete CSV");
      assert.equal(await rowCount(await f.admin(path)),0);
    } finally {active.res.destroy();active.req.destroy();}
  });
});
