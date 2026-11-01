import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import {fixture} from "./support/server.mjs";
import {phone} from "./support/phone.mjs";
test("a personal phone's signed DNS diagnostic reaches the configured resolver and records a labelled test",async t=>{
 const udp=dgram.createSocket("udp4");await new Promise(r=>udp.bind(0,"127.0.0.1",r));t.after(()=>udp.close());
 const received=[];udp.on("message",(data,peer)=>{received.push(data);const response=Buffer.from(data);response.writeUInt16BE(0x8180,2);udp.send(response,peer.port,peer.address);});
 const f=await fixture(t,{dns:{ip:"127.0.0.1",port:udp.address().port}}),p=await phone(f);
 const settings={available:true,servers:["10.10.20.3"],private_dns_active:false,private_dns_name:null,captured_by_bungee:false};
 assert.equal((await p.request("/v1/sync",{report:{system_dns:settings}})).status,200);
 assert.deepEqual((await (await f.admin(`/api/devices/${p.id}/policy`)).json()).report.system_dns,settings);
 assert.equal((await p.request("/v1/sync",{report:{system_dns:{...settings,captured_by_bungee:true}}})).status,400);
 assert.equal((await f.device("/v1/dns-check",{})).status,401);
 assert.equal((await p.request("/v1/dns-check",{name:"private.internal"})).status,400);assert.equal(received.length,0);
 const response=await p.request("/v1/dns-check",{});assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.reachable,true);assert.equal(result.upstream,`127.0.0.1:${udp.address().port}`);assert.equal(result.phone_dns_routed,false);assert.equal(result.routing,"app_only");assert.equal(received.length,1);
 assert.ok(received[0].includes(Buffer.from("example")));
 const now=Math.floor(Date.now()/1000),summary=await (await f.admin(`/api/devices/${p.id}/dns?from=${now-60}&to=${now+60}`)).json();
 assert.equal(summary.queries,1);assert.equal(summary.records[0].domain,"[Bungee DNS path test]");assert.equal(summary.phone_dns_routed,false);
});
test("DNS diagnostics report missing configuration and stay off the administrator listener",async t=>{
 const f=await fixture(t),p=await phone(f);
 assert.equal((await p.request("/v1/dns-check",{})).status,503);
 assert.ok([404,405].includes((await f.admin("/v1/dns-check","POST",{})).status));
});
