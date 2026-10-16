import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture, pause } from "./support/server.mjs";

test("enrollment lifecycle and storage-failure recovery", async t=>{
  const f=await fixture(t);
  const invite=(key,name="Lifecycle test phone")=>f.admin("/api/enrollments","POST",{name,wg_public_key:key});
  const redeem=bundle=>{
    const key=generateKeyPairSync("ec",{namedCurve:"P-256"});
    const publicKey=key.publicKey.export({type:"spki",format:"der"}).toString("base64");
    return f.device("/v1/enroll",{token:bundle.token,public_key:publicKey,wg_public_key:bundle.wireguard.client_public_key,proof:sign("sha256",Buffer.from(`BUNGEE-ENROLL-V1\n${bundle.token}\n${bundle.wireguard.client_public_key}\n${publicKey}`),key.privateKey).toString("base64"),capabilities:[]});
  };
  let paired;
  await t.test("expired and cleaned invitations reissue the same phone key/address with fresh secrets",async()=>{
    const key=randomBytes(32).toString("base64");
    const first=await (await invite(key)).json();
    f.sql("UPDATE enrollments SET expires=? WHERE device_id=?",[Math.floor(Date.now()/1000)-1,first.device_id]);
    await f.stop(); await f.launch();
    for(let n=0;n<100 && (await readFile(join(f.dir,"wireguard/peers.conf"),"utf8")).includes(key);n++) await pause(20);
    assert.equal(f.sql("SELECT COUNT(*) FROM enrollments WHERE device_id=?",[first.device_id])[0][0],0);
    const devices=(await (await f.admin("/api/devices")).json()).devices;
    assert.equal(devices.find(d=>d.id===first.device_id).enrollment_state,"expired");
    const renewedResponse=await invite(key); assert.equal(renewedResponse.status,200);
    paired=await renewedResponse.json();
    assert.equal(paired.device_id,first.device_id); assert.equal(paired.wireguard.address,first.wireguard.address);
    assert.notEqual(paired.token,first.token); assert.notEqual(paired.wireguard.preshared_key,first.wireguard.preshared_key);
    assert.equal((await redeem(first)).status,401); assert.equal((await redeem(paired)).status,200);
    assert.equal((await invite(key)).status,400,"A paired signing identity must never be rebound");
  });
  await t.test("reissuing a live or revoked never-enrolled invitation invalidates earlier tokens",async()=>{
    const key=randomBytes(32).toString("base64");
    const first=await (await invite(key)).json();
    const second=await (await invite(key)).json();
    assert.equal(first.device_id,second.device_id); assert.notEqual(first.token,second.token);
    assert.equal((await redeem(first)).status,401);
    assert.equal((await f.admin(`/api/devices/${second.device_id}`,"DELETE")).status,200);
    const third=await (await invite(key)).json();
    assert.equal((await redeem(second)).status,401); assert.equal((await redeem(third)).status,200);
  });
  await t.test("device insert, invitation insert and audit failures roll back without publishing peers",async()=>{
    for(const [table,condition] of [["devices","NEW.name='Injected fault'"],["enrollments","NEW.device_id IN (SELECT id FROM devices WHERE name='Injected fault')"],["audit","NEW.action='enrollment.created'"]]) {
      const key=randomBytes(32).toString("base64");
      const peers=await readFile(join(f.dir,"wireguard/peers.conf"),"utf8");
      f.sql(`CREATE TRIGGER enrollment_fault AFTER INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
      assert.equal((await invite(key,"Injected fault")).status,500);
      assert.equal(f.sql("SELECT COUNT(*) FROM devices WHERE wg_key=?",[key])[0][0],0);
      assert.equal(await readFile(join(f.dir,"wireguard/peers.conf"),"utf8"),peers);
      f.sql("DROP TRIGGER enrollment_fault");
      assert.equal((await invite(key)).status,200);
    }
  });
  await t.test("post-commit peer rename failure remains reissuable and recovers without new phone keys",async()=>{
    const key=randomBytes(32).toString("base64");
    await rm(join(f.dir,"wireguard/peers.conf")); await mkdir(join(f.dir,"wireguard/peers.conf"));
    assert.equal((await invite(key)).status,503);
    const pending=f.sql("SELECT d.id,e.hash FROM devices d JOIN enrollments e ON e.device_id=d.id WHERE wg_key=?",[key]);
    assert.equal(pending.length,1);
    await rm(join(f.dir,"wireguard/peers.conf"),{recursive:true});
    const response=await invite(key); assert.equal(response.status,200);
    const repaired=await response.json(); assert.equal(repaired.device_id,pending[0][0]);
    assert.notEqual(f.sql("SELECT hash FROM enrollments WHERE device_id=?",[repaired.device_id])[0][0],pending[0][1]);
    assert.ok((await readFile(join(f.dir,"wireguard/peers.conf"),"utf8")).includes(key));
    assert.equal((await redeem(repaired)).status,200);
    assert.equal(f.sql("SELECT public_key IS NOT NULL FROM devices WHERE id=?",[paired.device_id])[0][0],1);
  });
  await t.test("expired unpaired address pressure cannot permanently exhaust enrollment or erase paired history",async()=>{
    f.sql("INSERT INTO location_history VALUES(?,1,1,1,2,3)",[paired.device_id]);
    f.sql("WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<254) INSERT OR IGNORE INTO devices(id,name,wg_key,address,created) SELECT 'unpaired-fixture-'||x,'Expired fixture','unpaired-key-'||x,'10.77.0.'||x,1 FROM n");
    assert.equal(f.sql("SELECT COUNT(*) FROM devices")[0][0],253);
    const response=await invite(randomBytes(32).toString("base64")); assert.equal(response.status,200);
    assert.equal(f.sql("SELECT COUNT(*) FROM devices")[0][0],253);
    assert.equal(f.sql("SELECT COUNT(*) FROM location_history WHERE device_id=?",[paired.device_id])[0][0],1);
    assert.equal(f.sql("SELECT public_key IS NOT NULL FROM devices WHERE id=?",[paired.device_id])[0][0],1);
  });
});
