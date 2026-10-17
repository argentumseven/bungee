// Actual Rust TLS, including direct source admission. Node 24/OpenSSL 3.5 required.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
async function port() { const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p; }
const dir=await mkdtemp(join(tmpdir(),'bungee-rust-tls-'));
let server, logs='';
try {
  execFileSync('python3',['-c',"import sys;sys.path.insert(0,'scripts');import tls_config;tls_config.ensure(sys.argv[1],'127.0.0.1')",join(dir,'tls')]);
  const ca=await readFile(join(dir,'tls/root.crt'),'utf8');
  const p=await port(), dp=await port();
  const env={...process.env,BUNGEE_STATE_DIR:join(dir,'state'),BUNGEE_PUBLIC_ORIGIN:`https://127.0.0.1:${p}`,BUNGEE_ADMIN_BIND:`127.0.0.1:${p}`,BUNGEE_ADMIN_SUBNETS:'127.0.0.1/32',BUNGEE_DEVICE_BIND:`127.0.0.1:${dp}`,BUNGEE_TLS_CERT_FILE:join(dir,'tls/issued/current/server.crt'),BUNGEE_TLS_KEY_FILE:join(dir,'tls/issued/current/server.key'),BUNGEE_TRUST_LOOPBACK_PROXY:'false'};
  server=spawn(resolve('server/target/debug/bungee-server'),[],{env,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
  const request=(localAddress='127.0.0.1',headers={})=>new Promise((res,rej)=>{
    const req=https.get({host:'127.0.0.1',port:p,path:'/api/session',ca,rejectUnauthorized:true,minVersion:'TLSv1.3',ecdhCurve:'X25519MLKEM768',localAddress,headers},r=>{r.resume();r.on('end',()=>res(r.statusCode));});req.on('error',rej);req.setTimeout(3000,()=>req.destroy(Error('timeout')));
  });
  let ready=false;
  for(let n=0;n<200;n++){try{if([200,401].includes(await request())){ready=true;break;}}catch{}if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,25));}
  assert.ok(ready,logs);
  const handshake=(ecdhCurve,minVersion='TLSv1.3',maxVersion='TLSv1.3')=>new Promise(res=>{
    const s=tls.connect({host:'127.0.0.1',port:p,ca,rejectUnauthorized:true,ecdhCurve,minVersion,maxVersion},()=>{const result={authorized:s.authorized,protocol:s.getProtocol(),group:s.getEphemeralKeyInfo().name};s.end();res(result);});s.once('error',e=>res({error:e.code}));s.setTimeout(3000,()=>{s.destroy();res({error:'timeout'});});
  });
  assert.deepEqual(await handshake('X25519MLKEM768'),{authorized:true,protocol:'TLSv1.3',group:'X25519MLKEM768'});
  assert.ok((await handshake('X25519')).error,'classical-only must fail');
  assert.ok((await handshake('X25519','TLSv1.2','TLSv1.2')).error,'TLS 1.2 must fail');
  assert.equal(await request('127.0.0.2',{'X-Bungee-Admin-IP':'127.0.0.1','X-Forwarded-For':'127.0.0.1'}),403);
  assert.equal(await request(),401);
  // A client without the local CA cannot authenticate the server.
  await assert.rejects(new Promise((res,rej)=>{const r=https.get({host:'127.0.0.1',port:p},res);r.on('error',rej);}));
  console.log('PASS: direct Rust trusted hybrid HTTPS; classical/TLS1.2/untrusted CA rejected; source restrictions resist forged proxy headers.');
} finally {
  if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill('SIGINT');await done;}
  await rm(dir,{recursive:true,force:true});
}
