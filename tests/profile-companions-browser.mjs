import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';

test('profile companions stay under one phone, route messages to the selected user, and pair without a duplicate device card',async t=>{
 const f=await fixture(t),main=await phone(f,{name:'My phone'});
 const companion=await phone(f,{name:'Sandbox',primaryDeviceId:main.id,capabilities:['message','clear_message','stop_all']});
 await companion.request('/v1/sync',{report:{foreground_user:true,camera:{armed:true,pending:0,dropped:0,status:'Ready in Sandbox',failed_in_row:2,queued:[],reported_at:Math.floor(Date.now()/1000)}}});
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'}),[name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.origin}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin);await page.getByRole('button',{name:'Device care',exact:true}).click();
 const panel=page.getByRole('region',{name:'Android profiles'});await panel.getByRole('heading',{name:'Sandbox',exact:true}).waitFor();
 assert.equal(await page.locator('#care-device option').count(),1,'the companion is not another phone');
 await panel.getByLabel('Message for Sandbox').fill('Show this only in Sandbox');await panel.getByRole('button',{name:'Send to Sandbox',exact:true}).click();
 await panel.getByRole('status').filter({hasText:'Request queued for Sandbox'}).waitFor();
 assert.deepEqual(f.sql('SELECT device_id,kind FROM commands'),[[companion.id,'message']]);
 await panel.locator('summary').click();await panel.getByLabel('Profile name',{exact:true}).fill('Work');await panel.getByLabel('Public key from that profile’s Bungee app').fill(randomBytes(32).toString('base64'));
 await panel.getByRole('button',{name:'Create profile invitation',exact:true}).click();await panel.getByLabel('Invitation text').waitFor();
 const bundle=JSON.parse(await panel.getByLabel('Invitation text').inputValue());assert.equal(bundle.profile.primary_device_id,main.id);assert.equal(bundle.profile.role,'companion');
 await panel.getByRole('button',{name:'Hide invitation',exact:true}).click();await panel.screenshot({path:'work/profile-companions-desktop.png'});
 await page.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:'work/profile-companions-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 page.on('dialog',d=>d.accept());await panel.getByRole('button',{name:'Disconnect profile',exact:true}).click();await panel.getByRole('status').filter({hasText:'Sandbox disconnected'}).waitFor();
 assert.equal((await main.request('/v1/commands',{})).status,200);assert.equal((await companion.request('/v1/commands',{})).status,401);
 await panel.getByRole('button',{name:'Reconnect profile · keep photos',exact:true}).waitFor();assert.deepEqual(errors,[]);
});
