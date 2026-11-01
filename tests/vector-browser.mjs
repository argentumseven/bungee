import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,mkdir,writeFile,readFile,unlink,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {chromium} from "playwright-core";
import {fixture} from "./support/server.mjs";
import {phone} from "./support/phone.mjs";

test("vector archive renders with a local worker, local assets and authenticated byte ranges",async t=>{
 const data=await mkdtemp(join(tmpdir(),"bungee-vector-browser-"));t.after(()=>rm(data,{recursive:true,force:true}));
 execFileSync("python3",["tests/fixtures/vector_map.py",join(data,"map.pmtiles")]);
 const f=await fixture(t,{geodata:data}),p=await phone(f);
 assert.equal((await p.request("/v1/telemetry",{battery:90,charging:false,device_owner:false,capabilities:["locate"],gps_epoch:p.epoch,location:{latitude:33,longitude:-80,accuracy:10,observed_at:Math.floor(Date.now()/1000)}})).status,200);
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/chromium",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader"]});t.after(()=>browser.close());
 const context=await browser.newContext();
 const [name,value]=f.cookie.split("=");await context.addCookies([{name,value,url:f.origin}]);
 const page=await context.newPage();const external=[],errors=[],ranges=[];
 page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
 page.on("request",r=>{if(!r.url().startsWith(f.origin)&&!r.url().startsWith("data:"))external.push(r.url());});
 page.on("response",r=>{if(r.url().endsWith("/api/maps/archive.pmtiles"))ranges.push(r.status());});
 await page.goto(f.origin);
 await page.locator(".phone-card").click();
 await page.locator(".maplibregl-canvas").waitFor();
 await page.waitForResponse(r=>r.url().endsWith("/api/maps/archive.pmtiles")&&r.status()===206);
 await page.waitForFunction(()=>document.querySelector(".maplibregl-canvas")?.getBoundingClientRect().width>0);
 // Allow the worker/GPU to present a frame before checking resource/console errors.
 await page.waitForTimeout(1000);
 await page.screenshot({path:"work/vector-map-browser.png"});
 assert.ok(ranges.length>0);assert.ok(ranges.every(status=>status===206));assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 assert.equal(await page.getByText(/could not be rendered|needs WebGL/).count(),0);
});


test("regional maps can be planned in Settings and render labelled streets in GPS history",async t=>{
 const f=await fixture(t),p=await phone(f),root=join(f.dir,"map-control");
 await mkdir(join(root,"requests"),{recursive:true});await mkdir(join(root,"status"));await mkdir(join(f.dir,"maps","archives"),{recursive:true});
 const region={id:"us-south-atlantic",name:"South Atlantic",group:"United States",estimated_bytes:1048576,bounds:[-81,32,-79,34],max_zoom:15};
 const state={updated_at:Math.floor(Date.now()/1000),catalog:[region],installed:[],legacy_map_bytes:0,map_limit_bytes:25e9,job:{id:"initial",state:"completed",message:"Ready"},disk:{total_bytes:16*1024**3,free_bytes:10*1024**3,available_bytes:7*1024**3,reserve_bytes:3*1024**3,swap_total_bytes:2*1024**3,swap_used_bytes:0,swap_growth_reserve_bytes:2*1024**3,backing_free_bytes:20*1024**3,note:"Synthetic capacity fixture"}};
 const publish=()=>writeFile(join(root,"status","state.json"),JSON.stringify(state));await publish();await writeFile(join(f.dir,"maps","library.json"),JSON.stringify({format:1,regions:[]}));
 const now=Math.floor(Date.now()/1000);
 for(let i=0;i<2;i++)assert.equal((await p.request("/v1/telemetry",{battery:90,charging:false,device_owner:false,capabilities:["locate","stop_all"],gps_epoch:p.epoch,location:{latitude:33,longitude:-80+i*.00001,accuracy:10,observed_at:now-10+i}})).status,200);
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/chromium",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader"]});t.after(()=>browser.close());
 const context=await browser.newContext(),[name,value]=f.cookie.split("=");await context.addCookies([{name,value,url:f.origin}]);const page=await context.newPage();const errors=[],external=[];
 page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(!r.url().startsWith(f.origin)&&!r.url().startsWith("data:"))external.push(r.url());});
 await page.goto(f.origin);await page.getByRole("button",{name:"Settings",exact:true}).click();
 const manager=page.locator(".map-manager");await manager.getByText("South Atlantic",{exact:true}).waitFor();
 await manager.locator('.map-checklist input[type="checkbox"]').check();
 const planResponse=page.waitForResponse(r=>r.url().endsWith("/api/maps/jobs")&&r.request().method()==="POST"&&r.status()===202);
 await manager.getByRole("button",{name:"Calculate download sizes",exact:true}).click();const planned=await (await planResponse).json();
 const request=JSON.parse(await readFile(join(root,"requests",planned.id+".json"),"utf8"));assert.deepEqual(request.regions,[region.id]);
 await unlink(join(root,"requests",planned.id+".json"));state.job={id:planned.id,state:"completed",message:"Plan ready"};state.last_plan={id:planned.id,planned_bytes:1048576,regions:[{...region,planned_bytes:1048576}]};await publish();
 const installResponse=page.waitForResponse(r=>r.url().endsWith("/api/maps/jobs")&&r.status()===202);
 const install=manager.getByRole("button",{name:"Download selected maps",exact:true});await install.waitFor();await install.click();const installing=await (await installResponse).json();
 await unlink(join(root,"requests",installing.id+".json"));
 const filename="us-south-atlantic-0123456789abcdef.pmtiles",archive=join(f.dir,"maps","archives",filename);execFileSync("python3",["tests/fixtures/vector_map.py",archive,"--detail"]);
 const installed={...region,filename,bytes:(await stat(archive)).size};await writeFile(join(f.dir,"maps","library.json"),JSON.stringify({format:1,regions:[installed]}));
 state.installed=[installed];state.job={id:installing.id,state:"completed",message:"Street maps installed"};delete state.last_plan;await publish();
 await manager.getByText("Street maps installed",{exact:true}).waitFor();
 await manager.screenshot({path:"docs/screenshots/maps-storage.png"});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await manager.screenshot({path:"docs/screenshots/mobile-maps-storage.png"});
 await page.setViewportSize({width:1440,height:1050});await page.getByRole("button",{name:"Tracking",exact:true}).click();await page.getByRole("button",{name:"GPS history",exact:true}).click();
 await page.locator(".maplibregl-canvas").waitFor();await page.getByText(/Nearby mapped street: Synthetic Main Street/).waitFor({timeout:15000});
 assert.equal(await page.locator(".history-trail").count(),0);assert.equal(await page.locator(".history-selection").count(),1);
 await page.screenshot({path:"docs/screenshots/regional-street-tracking.png"});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
