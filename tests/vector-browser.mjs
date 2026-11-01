import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,mkdir,writeFile,readFile,unlink,stat,chmod,copyFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {chromium} from "playwright-core";
import {fixture} from "./support/server.mjs";
import {phone} from "./support/phone.mjs";

test("the included overview renders with unreadable regional metadata and the download panel recovers after repair",async t=>{
 const data=await mkdtemp(join(tmpdir(),'bungee-map-permissions-browser-'));t.after(()=>rm(data,{recursive:true,force:true}));
 await copyFile('basemap/world.mbtiles',join(data,'map.mbtiles'));
 const f=await fixture(t,{geodata:data}),p=await phone(f);
 await mkdir(join(f.dir,'maps'));await mkdir(join(f.dir,'map-control/status'),{recursive:true});await mkdir(join(f.dir,'map-control/requests'));
 const library=join(f.dir,'maps/library.json'),status=join(f.dir,'map-control/status/state.json');
 await writeFile(library,JSON.stringify({format:1,regions:[]}));
 await writeFile(status,JSON.stringify({enabled:true,updated_at:Math.floor(Date.now()/1000),catalog:[{id:'us-pacific',name:'Pacific',group:'United States',estimated_bytes:1048576}],installed:[],disk:{available_bytes:2e9,free_bytes:3e9,total_bytes:4e9,reserve_bytes:1e9,swap_used_bytes:0,swap_total_bytes:0,swap_growth_reserve_bytes:1e9,backing_free_bytes:4e9},job:{id:'ready',state:'completed',message:'Ready'}}));
 await chmod(library,0o000);await chmod(status,0o000);
 assert.equal((await p.request('/v1/telemetry',{battery:90,charging:false,device_owner:false,capabilities:['locate'],gps_epoch:p.epoch,location:{latitude:33,longitude:-80,accuracy:10,observed_at:Math.floor(Date.now()/1000)}})).status,200);
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const context=await browser.newContext(),[name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.origin}]);const page=await context.newPage();
 const tile=page.waitForResponse(r=>/\/api\/maps\/\d+\/\d+\/\d+$/.test(r.url())&&r.status()===200);
 await page.goto(f.origin);await page.getByRole('button',{name:'Tracking',exact:true}).click();await tile;
 await page.locator('.leaflet-tile-loaded').first().waitFor();
 assert.ok(await page.locator('.leaflet-tile-loaded').first().evaluate(img=>img.naturalWidth>0));
 await page.screenshot({path:'work/map-permissions-overview.png'});
 await page.getByRole('button',{name:'Settings',exact:true}).click();const manager=page.locator('.map-manager');
 await manager.getByText(/Map metadata permissions need repair/).waitFor();
 assert.equal(await manager.getByText('Loading maps and capacity…',{exact:true}).count(),0);
 await chmod(library,0o644);await chmod(status,0o644);
 await manager.getByRole('button',{name:'Refresh map status'}).click();
 await manager.getByText('Pacific',{exact:true}).waitFor();assert.equal(await manager.getByRole('alert').count(),0);
});

test("an old broad saved GPS fix remains visible after reconnect, including failed street tiles",async t=>{
 const data=await mkdtemp(join(tmpdir(),"bungee-coarse-history-"));t.after(()=>rm(data,{recursive:true,force:true}));
 execFileSync("python3",["tests/fixtures/vector_map.py",join(data,"map.pmtiles")]);
 const f=await fixture(t,{geodata:data}),p=await phone(f);
 f.sql('INSERT INTO location_history(device_id,observed_at,received_at,latitude,longitude,accuracy) VALUES(?,100,101,33,-80,800)',[p.id]);
 await f.stop();await f.launch();
 await f.admin(`/api/devices/${p.id}/disconnect`,'POST');
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/chromium",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader"]});t.after(()=>browser.close());
 const context=await browser.newContext(),[name,value]=f.cookie.split("=");await context.addCookies([{name,value,url:f.origin}]);const page=await context.newPage();
 await page.route('**/api/maps/archive.pmtiles',route=>route.abort());
 await page.goto(f.origin);await page.getByRole('button',{name:'Tracking',exact:true}).click();
 await page.locator('.saved-gps-marker.uncertain').waitFor();
 assert.match(await page.locator('.care-card').first().innerText(),/33\.000000, -80\.000000/);
 assert.match(await page.locator('.saved-gps-marker').getAttribute('title'),/800 m/);
 await page.screenshot({path:'work/saved-location-without-tiles.png'});
 await page.getByRole('button',{name:'GPS history',exact:true}).click();
 await page.getByText('Restore GPS history from CSV',{exact:true}).click();
 await page.getByLabel('GPS CSV to restore').setInputFiles({name:'restored.csv',mimeType:'text/csv',buffer:Buffer.from('observed_at_utc,received_at_utc,latitude,longitude,accuracy_m,source,samples,system_vpn\n2026-01-01T00:00:00Z,2026-01-01T00:00:01Z,33,-80,800,passive,1,\n')});
 await page.getByRole('button',{name:'Restore these rows',exact:true}).click();
 await page.getByText(/Restored from CSV/).waitFor();
 assert.equal(f.sql('SELECT COUNT(*) FROM location_history WHERE device_id=?',[p.id])[0][0],2);
});

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
 const archiveResponse=page.waitForResponse(r=>r.url().endsWith("/api/maps/archive.pmtiles")&&r.status()===206);
 await page.goto(f.origin);
 await page.locator(".phone-card").click();
 await page.locator(".maplibregl-canvas").waitFor();
 await archiveResponse;
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
 const install=manager.getByRole("button",{name:/^Download selected maps/});await install.waitFor();await install.click();const installing=await (await installResponse).json();
 await unlink(join(root,"requests",installing.id+".json"));
 const filename="us-south-atlantic-0123456789abcdef.pmtiles",archive=join(f.dir,"maps","archives",filename);execFileSync("python3",["tests/fixtures/vector_map.py",archive,"--detail"]);
 const installed={...region,filename,bytes:(await stat(archive)).size};await writeFile(join(f.dir,"maps","library.json"),JSON.stringify({format:1,regions:[installed]}));
 state.installed=[installed];state.job={id:installing.id,state:"completed",action:"install",message:"Street maps installed"};delete state.last_plan;await publish();
 await manager.getByText("Street maps installed",{exact:true}).waitFor();
 await manager.screenshot({path:"docs/screenshots/maps-storage.png"});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await manager.screenshot({path:"docs/screenshots/mobile-maps-storage.png"});
 await page.setViewportSize({width:1440,height:1050});await page.getByRole("button",{name:"Tracking",exact:true}).click();await page.getByRole("button",{name:"GPS history",exact:true}).click();
 await page.locator(".maplibregl-canvas").waitFor();await page.getByText(/Nearby mapped street: Synthetic Main Street/).waitFor({timeout:15000});
 assert.equal(await page.locator(".history-trail").count(),0);assert.equal(await page.locator(".history-selection").count(),1);
 await page.screenshot({path:"docs/screenshots/regional-street-tracking.png"});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});


test("server APK is easy to download and its signing details fit the mobile manager",async t=>{
 const f=await fixture(t),dir=join(f.dir,'app-updates'),release=JSON.parse(await readFile('release.json','utf8'));
 await mkdir(dir);const bytes=Buffer.from('synthetic APK download fixture'),sha='a'.repeat(64);
 await writeFile(join(dir,sha+'.apk'),bytes);await writeFile(join(dir,'release.json'),JSON.stringify({version:release.version,version_code:release.android_version_code,sha256:sha,signer_sha256:'b'.repeat(64),size:bytes.length,commit:'c'.repeat(40)}));
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:390,height:844}}),[name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.origin}]);const page=await context.newPage();
 await page.goto(f.origin);await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByText('Signing identity',{exact:true}).click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Download this server’s APK'}).click();const downloaded=await downloading;
 assert.equal(downloaded.suggestedFilename(),'bungee.apk');assert.deepEqual(await readFile(await downloaded.path()),bytes);
});

test("phone update preparation shows bytes and errors, and signer recovery keeps retained records explicit",async t=>{
 const f=await fixture(t),dir=join(f.dir,'app-updates');await mkdir(dir);
 const status=join(dir,'status.json');
 await writeFile(status,JSON.stringify({state:'preparing',message:'Downloading the server APK…',downloaded_bytes:52428800,total_bytes:104857600}));
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:390,height:844}}),[name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.origin}]);const page=await context.newPage();
 await page.goto(f.origin);await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByText('50% · 50.0 / 100.0 MiB',{exact:true}).waitFor();
 assert.equal(await page.getByRole('progressbar',{name:'Server APK preparation'}).getAttribute('value'),'52428800');
 await writeFile(status,JSON.stringify({state:'waiting',message:'APK signing identity is missing; restore its encrypted backup'}));
 await page.getByText('APK signing identity is missing; restore its encrypted backup',{exact:true}).waitFor();
 assert.equal(await page.getByRole('progressbar',{name:'Server APK preparation'}).count(),0);
 await page.getByText('Phone says “different signing key”?',{exact:true}).click();
 assert.match(await page.locator('.apk-recovery').innerText(),/Do not purge/);
 assert.match(await page.locator('.apk-recovery').innerText(),/Uninstalling removes unsent data/);
 assert.match(await page.locator('.apk-recovery').innerText(),/Reconnect · keep history/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});
