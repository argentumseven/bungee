import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {fixture} from './support/server.mjs';
import {phone} from './support/phone.mjs';

test('pairing and history actions are visible, target the correct phone and distinguish keeping from erasing records',async t=>{
 const f=await fixture(t),first=await phone(f),second=await phone(f),at=Math.floor(Date.now()/1000),bucket=Math.floor(at/300)*300;
 for(const [p,name]of [[first,'First phone'],[second,'Second phone']]){
  f.sql('UPDATE devices SET name=? WHERE id=?',[name,p.id]);
  f.sql('INSERT INTO location_history(device_id,observed_at,received_at,latitude,longitude,accuracy) VALUES(?,?,?,?,?,?)',[p.id,at,at,12,34,5]);
  f.sql('INSERT INTO dns_summary VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[p.id,bucket,'example.org',1,1,Math.floor(at/10),at,at,1,0,0,1,0,0,0]);
 }
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark'}),[name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.origin}]);const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(f.origin);await page.getByRole('button',{name:'Pairing & history',exact:true}).click();
 const card=name=>page.getByRole('region',{name:`Pairing and history for ${name}`});
 await card('Second phone').getByRole('button',{name:'Revoke & erase data',exact:true}).waitFor();
 assert.equal(await card('Second phone').locator('details').count(),0);
 await page.locator('#records-phone').selectOption(second.id);await page.screenshot({path:'work/device-records-desktop.png',fullPage:true});
 await card('Second phone').getByRole('button',{name:'Revoke & erase data',exact:true}).click();const dialog=page.getByRole('dialog');
 await dialog.getByRole('heading',{name:'Revoke access and erase saved data?'}).waitFor();await dialog.getByText('Second phone',{exact:true}).waitFor();await dialog.getByText('Recovery photos and DNS logs',{exact:true}).waitFor();
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(f.sql('SELECT revoked FROM devices WHERE id=?',[second.id])[0][0],0);
 await page.locator('#records-phone').selectOption(first.id);await card('First phone').getByRole('button',{name:'Disconnect · keep history',exact:true}).click();
 await dialog.getByRole('button',{name:'Disconnect · keep history',exact:true}).click();await page.getByText('Phone disconnected. Saved GPS and history were kept.',{exact:true}).waitFor();
 assert.equal(f.sql('SELECT revoked FROM devices WHERE id=?',[first.id])[0][0],1);assert.equal(f.sql('SELECT COUNT(*) FROM location_history WHERE device_id=?',[first.id])[0][0],1);assert.equal(f.sql('SELECT COUNT(*) FROM dns_summary WHERE device_id=?',[first.id])[0][0],1);
 await card('First phone').getByRole('button',{name:'Delete phone record & history',exact:true}).click();await dialog.getByRole('heading',{name:'Delete this phone record and history?'}).waitFor();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(f.sql('SELECT COUNT(*) FROM devices WHERE id=?',[first.id])[0][0],1);
 await page.locator('#records-phone').selectOption(second.id);await card('Second phone').getByRole('button',{name:'Revoke & erase data',exact:true}).click();await dialog.getByRole('button',{name:'Revoke & erase data',exact:true}).click();await page.getByRole('status').filter({hasText:'Device revoked.'}).waitFor();
 assert.equal(f.sql('SELECT COUNT(*) FROM location_history WHERE device_id=?',[second.id])[0][0],0);assert.equal(f.sql('SELECT COUNT(*) FROM dns_summary WHERE device_id=?',[second.id])[0][0],0);assert.equal(f.sql('SELECT COUNT(*) FROM location_history WHERE device_id=?',[first.id])[0][0],1);
 await card('Second phone').getByRole('button',{name:'Remove inactive pairing',exact:true}).waitFor();assert.equal(await card('Second phone').getByRole('button',{name:'Delete phone record & history',exact:true}).isDisabled(),true);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'work/device-records-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
