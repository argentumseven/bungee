import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';

// Real UI against a real ephemeral server. All names, keys and telemetry are fixtures.
test('one phone view supports profile pairing, verified focus, diagnostics, manual targeting and revocation',async t=>{
 const f=await fixture(t),main=await phone(f,{runtime:true,name:'Avery’s Pixel',capabilities:['locate','message','clear_message','stop_all','ring','ring_flash','flash','best_guess']});
 const now=Math.floor(Date.now()/1000);
 const camera=(status='Ready in this profile')=>({armed:true,pending:0,dropped:0,status,failed_in_row:0,queued:[],reported_at:now});
 await main.request('/v1/telemetry',{battery:84,charging:false,device_owner:false,capabilities:['locate','message','clear_message','stop_all','ring','ring_flash','flash','best_guess'],gps_epoch:main.epoch});
 await main.request('/v1/sync',{report:{foreground_user:true,recovery_consent:true,secure_lock:true,unlock_monitoring:true,camera:camera(),android_version:'16',connection_health:{since:now-3600,reported_at:now,connection:'wifi',system_vpn:false,signal_dbm:-51,attempts:62,succeeded:62,last_rtt_ms:24,mean_rtt_ms:26,jitter_ms:3}}});
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1080},colorScheme:'light',timezoneId:'America/New_York'}),[name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.origin}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await mkdir('docs/screenshots',{recursive:true});
 const shot=async(name,locator=page.locator('.shell'))=>{await page.evaluate(()=>document.fonts.ready);await locator.screenshot({path:`docs/screenshots/profile-workflow-${name}.png`,animations:'disabled'});};
 const refresh=async()=>{await page.evaluate(()=>window.dispatchEvent(new Event('bungee:refresh')));};
 const openPhone=async()=>{await page.locator('.nav-phones').getByRole('button',{name:'Avery’s Pixel',exact:true}).click();};
 await page.goto(f.origin);await openPhone();await page.getByRole('region',{name:'Overall phone status'}).waitFor();
 assert.equal(await page.locator('.nav-profiles').count(),0);assert.equal(await page.getByRole('navigation',{name:'Phone profiles'}).count(),0);
 await shot('normal-phone');
 // The optional workflow asks which installation is main before a phone is paired.
 await page.getByRole('button',{name:'Add a device',exact:true}).click();
 await page.getByLabel('Device name',{exact:true}).fill('Example multi-profile phone');
 await page.getByLabel('This phone uses multiple sandbox profiles').check();
 await page.getByLabel('Main Android profile',{exact:true}).selectOption('Personal');
 await page.getByLabel('Phone’s WireGuard public key').fill(randomBytes(32).toString('base64'));
 await shot('choose-main',page.getByRole('dialog'));
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 // Existing normal phones can select their already-paired installation as main.
 await page.getByRole('button',{name:'Add Android profile',exact:true}).click();
 await page.getByLabel('Main Android profile',{exact:true}).selectOption('Owner');
 await page.getByRole('button',{name:'Use Owner as main',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Open Bungee in Owner'}).waitFor();
 const confirmed=await (await main.request('/v1/sync',{report:{profile_fingerprint:main.fingerprint,recovery_consent:true,foreground_user:false,camera:camera('Ready in Owner')}})).json();main.bundle.profile=confirmed.profile;
 await refresh();
 const setup=page.getByRole('region',{name:'Android profiles'});
 await setup.getByLabel('Profile name',{exact:true}).fill('Sandbox');await setup.getByLabel('Public key from that profile’s Bungee app').fill(randomBytes(32).toString('base64'));
 await setup.getByRole('button',{name:'Create profile invitation',exact:true}).click();await setup.getByLabel('Invitation text').waitFor();
 const bundle=JSON.parse(await setup.getByLabel('Invitation text').inputValue());
 assert.equal(bundle.profile.primary_device_id,main.id);
 await setup.getByRole('button',{name:'Hide invitation',exact:true}).click();
 await setup.getByText('Invitation pending',{exact:true}).waitFor();
 assert.equal(await page.locator('.nav-profiles').count(),0,'pending companions have no profile navigation');
 await shot('pending-invitation',setup);
 const sandbox=await phone(f,{bundle,primaryDeviceId:main.id,capabilities:['message','clear_message','stop_all']});
 const work=await phone(f,{primaryDeviceId:main.id,name:'Work',capabilities:['message','clear_message','stop_all']});
 const sandboxStart=Date.now()-5000, workStart=sandboxStart+3000;
 const syncProfile=async(phone, report)=>{
   const response=await phone.request('/v1/sync',{report});
   assert.equal(response.status,200,await response.text());
 };
 await syncProfile(sandbox,{foreground_user:true,foreground_since_ms:sandboxStart,app_version_code:40,recovery_consent:true,profile_capabilities:['message','clear_message','stop_all'],camera:camera()});
 await syncProfile(work,{foreground_user:false,app_version_code:40,recovery_consent:false,diagnostics_ready:false,profile_capabilities:[]});
 await refresh();await openPhone();
 const overview=page.getByRole('region',{name:'Overall phone status'});
 const statusList=overview.getByRole('list',{name:'Android profile status'});
 await statusList.getByRole('listitem').filter({hasText:'Sandbox'}).getByText('Active',{exact:true}).waitFor();
 assert.equal(await statusList.getByRole('button').count(),0);
 assert.equal(await statusList.locator('.profile-dot').count(),3);
 assert.equal(await page.locator('.nav-phones button').count(),1,'one physical phone');
 await shot('phone-overview');

 // Work's newer Android foreground transition wins even when Sandbox still reports
 // its earlier claim and the main installation polls more recently.
 await syncProfile(work,{foreground_user:true,foreground_since_ms:workStart,app_version_code:40,recovery_consent:false,diagnostics_ready:false,profile_capabilities:[]});
 await syncProfile(sandbox,{foreground_user:true,foreground_since_ms:sandboxStart,app_version_code:40,recovery_consent:true,profile_capabilities:['message','clear_message','stop_all'],camera:camera()});
 await main.request('/v1/commands',{});
 await refresh();
 await statusList.getByRole('listitem').filter({hasText:'Work'}).getByText('Active',{exact:true}).waitFor();
 await statusList.getByRole('listitem').filter({hasText:'Sandbox'}).getByText('Background',{exact:true}).waitFor();
 const diagnostics=page.getByRole('button',{name:/Check phone diagnostics/});
 await diagnostics.getByText(/Approve recovery commands/).waitFor();
 assert.equal(await diagnostics.isDisabled(),true);

 await syncProfile(work,{foreground_user:true,foreground_since_ms:workStart,app_version_code:40,recovery_consent:true,diagnostics_ready:true,profile_capabilities:['diagnostics','message','clear_message','stop_all']});
 await refresh();
 await diagnostics.click();
 const report=page.getByRole('region',{name:'Phone diagnostics'});
 await report.getByText(/Waiting for Work/).waitFor();
 const workCommands=(await (await work.request('/v1/commands',{})).json()).commands;
 assert.equal(workCommands.length,1);
 assert.equal(workCommands[0].kind,'diagnostics');
 assert.equal(workCommands[0].payload.require_foreground,true);
 assert.equal((await work.request('/v1/ack',{
   id:workCommands[0].id, status:'executed', result:'Diagnostics complete',
   attempted_at:Math.floor(Date.now()/1000),
   diagnostic_checks:[{label:'Android location services',status:'ok',detail:'Location is on.'}],
 })).status,200);
 await report.getByText('Location is on.',{exact:true}).waitFor();
 await report.getByText(/Work reported in at/).waitFor();

 // When the most recent foreground profile leaves focus, a delayed older
 // positive report must not become active again.
 await syncProfile(work,{foreground_user:false,app_version_code:40,recovery_consent:true,diagnostics_ready:true,profile_capabilities:['diagnostics','message','clear_message','stop_all']});
 await refresh();
 await overview.locator("dd").filter({hasText:/^Focus unconfirmed$/}).waitFor();
 await diagnostics.getByText(/No active profile reported/).waitFor();
 assert.equal(await diagnostics.isDisabled(),true);

 // Manual targeting stays on the phone page and does not depend on foreground.
 await page.getByLabel('Target for profile commands').selectOption(sandbox.id);
 await page.getByRole('button',{name:/^Leave a message/}).click();
 await page.getByLabel('Recovery message',{exact:true}).fill('Please contact Avery to return this phone.');
 await page.getByRole('button',{name:'Queue message',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Command queued for Sandbox'}).waitFor();
 const queued=(await (await sandbox.request('/v1/commands',{})).json()).commands;
 assert.equal(queued[0].kind,'message');
 assert.equal(queued[0].payload.require_foreground,undefined);
 assert.equal((await f.admin(`/api/devices/${main.id}/commands`,'POST',{kind:'ring',profile:sandbox.id})).status,400);
 await shot('sandbox-actions');

 f.sql('UPDATE devices SET last_contact=?,last_seen=? WHERE id=?',[now-5400,now-5400,main.id]);
 await refresh();
 await statusList.getByRole('listitem').filter({hasText:'Owner'}).getByText('No recent contact',{exact:true}).waitFor();
 assert.equal(await overview.locator('.phone-hero-heading').getByText('Connected',{exact:true}).count(),1);
 await shot('limited-connection');
 assert.equal((await sandbox.acquire({instance:'8c87740d-4bfc-4c38-96d0-55b53356c7a4',secret:randomBytes(32).toString('base64url')})).status,423);
 await refresh();await overview.getByText('Duplicate instance blocked',{exact:true}).waitFor();
 await shot('duplicate-blocked');
 await page.setViewportSize({width:390,height:844});await shot('mobile');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.setViewportSize({width:1440,height:1080});

 await page.getByRole('button',{name:'Pairing & history settings',exact:true}).click();
 await page.getByRole('button',{name:'Manage Android profiles',exact:true}).click();
 page.on('dialog',d=>d.accept());
 await setup.locator('article').filter({hasText:'Sandbox'}).getByRole('button',{name:'Revoke profile & erase data',exact:true}).click();
 await setup.getByRole('status').filter({hasText:'Sandbox revoked and its saved data erased'}).waitFor();
 await setup.locator('article').filter({hasText:'Sandbox'}).getByText('Disconnected',{exact:true}).waitFor();
 assert.equal((await main.request('/v1/commands',{})).status,200);
 assert.equal((await work.request('/v1/commands',{})).status,200);
 assert.equal((await sandbox.request('/v1/commands',{})).status,401);
 assert.equal(f.sql('SELECT COUNT(*) FROM commands WHERE device_id=?',[sandbox.id])[0][0],0);
 assert.deepEqual(errors,[]);
});
