import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {fixture} from './support/server.mjs';

test('map library: single and regional downloads, capacity checks, stop, confirmed deletion and mobile layouts',async t=>{
 const f=await fixture(t),control=join(f.dir,'map-control'),requestRoot=join(control,'requests');
 await mkdir(requestRoot,{recursive:true});await mkdir(join(control,'status'));await mkdir(join(f.dir,'maps'));
 const region=(id,name,group,estimated_bytes)=>({id,name,group,estimated_bytes,max_zoom:15,bounds:[-125,32,-113,50]});
 const catalog=[region('us-pacific','Pacific','United States',300e6),region('us-mountain','Mountain','United States',200e6),region('us-south-atlantic','South Atlantic','United States',180e6),region('france','France','Europe',150e6),region('iceland','Iceland','Europe',50e6)];
 const installed=(item,bytes)=>({...item,bytes,filename:item.id+'-0123456789abcdef.pmtiles'});
 const state={updated_at:Math.floor(Date.now()/1000),catalog,installed:[installed(catalog[0],250e6)],map_limit_bytes:1e9,legacy_map_bytes:0,job:{id:'initial',state:'completed',message:'Ready'},disk:{available_bytes:750e6,free_bytes:4e9,total_bytes:8e9,reserve_bytes:3.25e9,swap_used_bytes:0,swap_total_bytes:1e9,swap_growth_reserve_bytes:1e9,backing_free_bytes:9e9,note:'Synthetic capacity fixture'}};
 const publish=async()=>{state.updated_at=Math.floor(Date.now()/1000);await writeFile(join(control,'status/state.json'),JSON.stringify(state));await writeFile(join(f.dir,'maps/library.json'),JSON.stringify({format:1,regions:state.installed}));};await publish();
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1100}}),[name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.origin}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin);await page.getByRole('button',{name:'Settings',exact:true}).click();const manager=page.locator('.map-manager');await manager.getByRole('button',{name:'Download Mountain map'}).waitFor();
 const refresh=async()=>{const loaded=page.waitForResponse(r=>r.url().endsWith('/api/maps/manage')&&r.status()===200);await manager.getByRole('button',{name:'Refresh map status'}).click();await loaded;};
 async function request(action,click){const responding=page.waitForResponse(r=>r.url().endsWith('/api/maps/jobs')&&r.request().method()==='POST'&&r.status()===202);await click();const {id}=await (await responding).json();const body=JSON.parse(await readFile(join(requestRoot,id+'.json'),'utf8'));assert.equal(body.action,action);await unlink(join(requestRoot,id+'.json'));return {id,...body};}
 async function plan(job,bytes){state.job={id:job.id,state:'completed',action:'plan',message:'Download plan ready'};state.last_plan={id:job.id,created_at:Math.floor(Date.now()/1000),planned_bytes:bytes,regions:job.regions.map(id=>({...catalog.find(r=>r.id===id),planned_bytes:bytes/job.regions.length}))};await publish();await refresh();await manager.getByRole('button',{name:/Download selected maps/}).waitFor();}
 await manager.screenshot({path:'work/map-library-desktop-light.png'});
 for(const dark of [true,false]){
  await page.emulateMedia({colorScheme:dark?'dark':'light'});await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile map controls must fit');
  const refreshBox=await manager.getByRole('button',{name:'Refresh map status'}).boundingBox();assert.ok(refreshBox.height<=48&&refreshBox.width>=40,'refresh stays a compact touch button');
  await manager.screenshot({path:`work/map-library-mobile-${dark?'dark':'light'}.png`});
 }
 await page.setViewportSize({width:1440,height:1100});await page.emulateMedia({colorScheme:'dark'});await manager.screenshot({path:'work/map-library-desktop-dark.png'});await page.emulateMedia({colorScheme:'light'});
 await manager.getByLabel('Region group').selectOption('Europe');
 let job=await request('plan',()=>manager.getByRole('button',{name:'Download France map'}).click());assert.deepEqual(job.regions,['france']);await plan(job,120e6);
 assert.equal(await manager.getByRole('heading',{name:'Review France'}).count(),1);
 let download=await request('install',()=>manager.getByRole('button',{name:/Download selected maps/}).click());assert.deepEqual(download.regions,['france']);assert.equal(download.plan_id,job.id);
 state.installed.push(installed(catalog[3],120e6));state.job={id:download.id,state:'completed',action:'install',message:'Street maps installed',regions:['france'],completed:1,total:1};delete state.last_plan;await publish();await refresh();await manager.getByRole('button',{name:'Delete France map'}).waitFor();
 await manager.getByLabel('Region group').selectOption('United States');
 job=await request('plan',()=>manager.getByRole('button',{name:'Download all 2 United States maps'}).click());assert.deepEqual(job.regions,['us-mountain','us-south-atlantic']);await plan(job,300e6);
 state.disk.available_bytes=200e6;await publish();await refresh();await manager.getByText(/This selection exceeds/).waitFor();assert.equal(await manager.getByRole('button',{name:/Download selected maps/}).isDisabled(),true);
 state.disk.available_bytes=750e6;await publish();await refresh();
 download=await request('install',()=>manager.getByRole('button',{name:/Download selected maps/}).click());state.job={id:download.id,state:'running',action:'install',regions:download.regions,completed:0,total:2,message:'Downloading Mountain: 20 / 140 MiB'};await publish();await refresh();
 const stopping=page.waitForResponse(r=>r.url().endsWith(`/api/maps/jobs/${download.id}`)&&r.request().method()==='DELETE');await manager.getByRole('button',{name:'Stop',exact:true}).click();assert.equal((await stopping).status(),200);assert.equal((await readFile(join(requestRoot,'cancel-'+download.id))).length,0);await unlink(join(requestRoot,'cancel-'+download.id));
 state.installed.push(installed(catalog[1],140e6));state.job={...state.job,state:'canceled',completed:1,message:'Map operation stopped; completed maps remain downloaded'};delete state.last_plan;await publish();await refresh();await manager.getByText('Operation stopped',{exact:true}).waitFor();await manager.getByText(/1 of 2 maps ready/).waitFor();
 await manager.getByRole('button',{name:/Downloaded maps/}).click();await manager.getByRole('button',{name:'Delete all downloads',exact:true}).click();let dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/Delete 3 downloaded maps/);await dialog.getByRole('button',{name:'Keep maps'}).click();assert.equal(await page.getByRole('dialog').count(),0);
 await manager.getByRole('button',{name:'Delete France map'}).click();dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/Phone pairing, GPS history/);
 const removed=await request('remove',()=>dialog.getByRole('button',{name:'Delete map',exact:true}).click());assert.deepEqual(removed.regions,['france']);state.installed=state.installed.filter(r=>r.id!=='france');state.job={id:removed.id,state:'completed',action:'remove',message:'Selected maps removed'};await publish();await refresh();
 await manager.getByRole('button',{name:'Browse & download',exact:true}).click();await manager.getByLabel('Region group').selectOption('Europe');await manager.getByRole('button',{name:'Download France map'}).waitFor();assert.equal(await manager.getByRole('button',{name:'Download France map'}).isEnabled(),true,'deleted pieces can be downloaded again');
 await manager.getByRole('button',{name:/Downloaded maps/}).click();await manager.getByRole('button',{name:'Select all downloaded'}).click();await manager.getByRole('button',{name:'Delete selected (2)'}).click();dialog=page.getByRole('dialog');await dialog.waitFor();await page.emulateMedia({colorScheme:'dark'});await dialog.screenshot({path:'work/map-library-delete-dark.png'});await page.emulateMedia({colorScheme:'light'});
 const all=await request('remove',()=>dialog.getByRole('button',{name:'Delete 2 maps',exact:true}).click());assert.deepEqual(all.regions,['us-pacific','us-mountain']);state.installed=[];state.job={id:all.id,state:'completed',action:'remove',message:'Selected maps removed'};await publish();await refresh();await manager.getByText('No street maps downloaded yet',{exact:true}).waitFor();assert.equal(await manager.getByText(/^World overview/).count(),1);assert.deepEqual(errors,[]);
});
