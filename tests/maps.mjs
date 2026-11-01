import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,readFile,writeFile,copyFile,mkdtemp,rm,chmod,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fixture} from "./support/server.mjs";
test("unreadable regional metadata cannot suppress the bundled overview or its authenticated tiles",async t=>{
 const data=await mkdtemp(join(tmpdir(),'bungee-overview-fallback-'));t.after(()=>rm(data,{recursive:true,force:true}));
 await copyFile('basemap/world.mbtiles',join(data,'map.mbtiles'));
 const f=await fixture(t,{geodata:data});await setup(f);
 const library=join(f.dir,'maps/library.json');await chmod(library,0o000);
 const status=await f.admin('/api/geography');assert.equal(status.status,200);
 const geography=await status.json();assert.equal(geography.maps.overview,true);assert.deepEqual(geography.regions,[]);assert.match(geography.regional_error,/permissions.*repair/i);
 const tile=await f.admin('/api/maps/0/0/0');assert.equal(tile.status,200);assert.equal(tile.headers.get('content-type'),'image/png');
 await chmod(library,0o644);assert.equal((await (await f.admin('/api/geography')).json()).regional_error,undefined);
});
async function setup(f){
 const root=join(f.dir,"map-control");await mkdir(join(root,"requests"),{recursive:true});await mkdir(join(root,"status"));await mkdir(join(f.dir,"maps","archives"),{recursive:true});
 const region={id:"us-pacific",name:"Pacific",group:"United States",estimated_bytes:1024,max_zoom:15,bounds:[-125,32,-113,50]};
 const state={updated_at:Math.floor(Date.now()/1000),catalog:[region],installed:[],disk:{available_bytes:1e9},job:{id:randomUUID(),state:"completed",message:"Ready"}};
 await writeFile(join(root,"status","state.json"),JSON.stringify(state));await writeFile(join(f.dir,"maps","library.json"),JSON.stringify({format:1,regions:[]}));return {root,state,region};
}
test("map jobs require an admin session, valid origin, allowlisted regions and a reviewed plan",async t=>{
 const f=await fixture(t),{root,state}=await setup(f);
 assert.equal((await fetch(f.origin+"/api/maps/manage")).status,401);
 const queue=(body,headers={})=>f.admin("/api/maps/jobs","POST",body,headers);
 assert.equal((await queue({action:"plan",regions:["us-pacific"]},{Origin:"https://evil.invalid"})).status,403);
 for(const body of [{action:"run",regions:["us-pacific"]},{action:"plan",regions:["../../etc"]},{action:"plan",regions:["unknown"]},{action:"plan",regions:["us-pacific"],url:"https://evil.invalid"},{action:"install",regions:["us-pacific"]},{action:"install",regions:["us-pacific"],plan_id:randomUUID()}])assert.ok([400,422].includes((await queue(body)).status));
 const result=await queue({action:"plan",regions:["us-pacific"]});assert.equal(result.status,202);const job=await result.json();
 const request=JSON.parse(await readFile(join(root,"requests",job.id+".json"),"utf8"));assert.deepEqual(request.regions,["us-pacific"]);assert.equal(request.action,"plan");
 assert.equal((await queue({action:"plan",regions:["us-pacific"]})).status,409);
 const status=await (await f.admin("/api/maps/manage")).json();assert.equal(status.enabled,true);assert.equal(status.job.state,"queued");assert.equal(status.job.id,job.id);
});
test("managed archives appear in geography and use authenticated bounded byte ranges without a server restart",async t=>{
 const f=await fixture(t),{region}=await setup(f);
 let geography=await (await f.admin("/api/geography")).json();assert.deepEqual(geography.regions,[]);
 const filename="us-pacific-0123456789abcdef.pmtiles",path=join(f.dir,"maps","archives",filename);execFileSync("python3",["tests/fixtures/vector_map.py",path]);
 await writeFile(join(f.dir,"maps","library.json"),JSON.stringify({format:1,regions:[{...region,filename,bytes:300}]}));
 geography=await (await f.admin("/api/geography")).json();assert.equal(geography.regions[0].id,"us-pacific");
 const route="/api/maps/regions/us-pacific/archive.pmtiles";
 assert.equal((await fetch(f.origin+route,{headers:{Range:"bytes=0-126"}})).status,401);
 assert.equal((await f.admin(route)).status,400);
 assert.equal((await f.admin(route,"GET",undefined,{Range:"bytes=0-16777216"})).status,400);
 const response=await f.admin(route,"GET",undefined,{Range:"bytes=0-126"});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,127);
});

test("whole-region batches exceed 24 pieces, queued work can be stopped, and deletion uses the installed library",async t=>{
 const f=await fixture(t),{root,state,region}=await setup(f);
 state.catalog=Array.from({length:40},(_,i)=>({...region,id:`country-${i}`}));
 const status=join(root,'status/state.json');await writeFile(status,JSON.stringify(state));
 let response=await f.admin('/api/maps/jobs','POST',{action:'plan',regions:state.catalog.map(r=>r.id)});assert.equal(response.status,202);
 const queued=await response.json();assert.equal((await f.admin(`/api/maps/jobs/${queued.id}`,'DELETE')).status,200);
 assert.equal((await readFile(join(root,'requests',`cancel-${queued.id}`))).length,0);
 await unlink(join(root,'requests',queued.id+'.json'));await unlink(join(root,'requests',`cancel-${queued.id}`));
 state.job={id:queued.id,state:'completed',message:'Done'};await writeFile(status,JSON.stringify(state));
 assert.equal((await (await f.admin(`/api/maps/jobs/${queued.id}`,'DELETE')).json()).already_finished,true);
 state.installed=[{...region,id:'retired-region',filename:'retired-region-0123456789abcdef.pmtiles',bytes:123}];await writeFile(status,JSON.stringify(state));
 response=await f.admin('/api/maps/jobs','POST',{action:'remove',regions:['retired-region']});assert.equal(response.status,202);
});
