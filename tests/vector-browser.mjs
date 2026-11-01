import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
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
