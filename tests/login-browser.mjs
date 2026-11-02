import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {chromium,firefox} from 'playwright-core';
import {existsSync} from 'node:fs';
import {tlsFixture} from './support/tls-server.mjs';
import {fixture} from './support/server.mjs';

const engines=[['Chromium',chromium],['Firefox',firefox]];
for(const [name,engine] of engines)test(`fresh ${name} sign-in: native autofill, typing, paste and distinct cookie/password errors`,{skip:name==='Firefox'&&!existsSync(firefox.executablePath())},async t=>{
 const password='  a long autofilled passphrase 🔐  ';
 const browser=await engine.launch(name==='Chromium'?{executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});t.after(()=>browser.close());
 async function fresh(){
  const f=await fixture(t);
  execFileSync(resolve('server/target/debug/bungee-server'),['--set-admin-password'],{env:{...process.env,BUNGEE_STATE_DIR:f.dir},input:password,stdio:['pipe','pipe','pipe']});
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.goto(f.origin);await page.getByRole('heading',{name:'Sign in to Bungee'}).waitFor();return {context,page};
 }
 for(const method of ['native autofill without input events','typed','paste'])await t.test(method,async()=>{
  const {context,page}=await fresh();
  if(method.startsWith('native'))await page.locator('#password').evaluate((input,value)=>{input.value=value},password);
  else if(method==='typed')await page.locator('#password').pressSequentially(password);
  else await page.locator('#password').fill(password);
  const submitted=page.waitForRequest(r=>r.url().endsWith('/api/session')&&r.method()==='POST');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  assert.equal((await submitted).postDataJSON().password,password,'the exact native value must be submitted without trimming or Unicode normalization');
  await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
  assert.ok((await context.cookies()).some(c=>c.name==='bungee_session'&&c.httpOnly&&c.sameSite==='Strict'));
  await page.reload();await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 });
 await t.test('wrong password remains editable and reports the actual failure',async()=>{
  const {page}=await fresh();await page.locator('#password').fill('an incorrect test password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Incorrect administrator password'}).waitFor();
  assert.equal(await page.locator('#password').inputValue(),'an incorrect test password');
  await page.locator('#password').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 });
 await t.test('accepted password with a blocked cookie never flashes household data',async()=>{
  const {page}=await fresh();let attemptedDevices=false;
  page.on('request',r=>{if(r.url().endsWith('/api/devices'))attemptedDevices=true;});
  await page.evaluate(()=>{const request=window.fetch.bind(window);window.fetch=(input,init)=>request(input,{...init,credentials:'omit'});});
  await page.locator('#password').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Your password was accepted, but this browser could not confirm its session'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Overview',exact:true}).count(),0);assert.equal(attemptedDevices,false);
 });
});

for(const [name,engine] of engines)test(`fresh ${name} accepts a local certificate exception and retains its secure sign-in cookie`,{skip:name==='Firefox'&&!existsSync(firefox.executablePath())},async t=>{
 const f=await tlsFixture(t);
 const browser=await engine.launch(name==='Chromium'?{executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
 await page.goto(f.origin);await page.getByRole('heading',{name:'Sign in to Bungee'}).waitFor();
 await page.locator('#password').pressSequentially(f.password);
 const accepted=page.waitForResponse(r=>r.url().endsWith('/api/session')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();assert.equal((await accepted).status(),200);
 await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 const cookie=(await context.cookies()).find(c=>c.name==='bungee_session');assert.ok(cookie);assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Strict');
 await page.reload();await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
});
