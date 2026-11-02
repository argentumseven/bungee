import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import https from 'node:https';

async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
export async function tlsFixture(t){
 const dir=await mkdtemp(join(tmpdir(),'bungee-login-tls-'));
 let server,logs='';
 t.after(async()=>{if(server?.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGINT');await stopped;}await rm(dir,{recursive:true,force:true});});
 execFileSync('python3',['-c',"import sys;sys.path.insert(0,'scripts');import tls_config;tls_config.ensure(sys.argv[1],'127.0.0.1')",join(dir,'tls')]);
 const admin=await port();let device=await port();while(device===admin)device=await port();
 const origin=`https://127.0.0.1:${admin}`,password='synthetic typed HTTPS login passphrase';
 const env={...process.env,BUNGEE_STATE_DIR:join(dir,'state'),BUNGEE_PUBLIC_ORIGIN:origin,BUNGEE_ADMIN_BIND:`127.0.0.1:${admin}`,BUNGEE_ADMIN_SUBNETS:'127.0.0.1/32',BUNGEE_DEVICE_BIND:`127.0.0.1:${device}`,BUNGEE_TLS_CERT_FILE:join(dir,'tls/issued/current/server.crt'),BUNGEE_TLS_KEY_FILE:join(dir,'tls/issued/current/server.key'),BUNGEE_WEB_DIR:resolve('web/dist')};
 execFileSync(resolve('server/target/debug/bungee-server'),['--set-admin-password'],{env,input:password,stdio:['pipe','pipe','pipe']});
 server=spawn(resolve('server/target/debug/bungee-server'),[],{env,stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
 const ca=await readFile(join(dir,'tls/root.crt'));
 const ready=()=>new Promise((resolve,reject)=>{const req=https.get(origin+'/healthz',{ca,rejectUnauthorized:true,minVersion:'TLSv1.3',ecdhCurve:'X25519MLKEM768'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode===200));});req.on('error',reject);req.setTimeout(2000,()=>req.destroy(Error('Fixture startup timeout')));});
 let up=false;for(let n=0;n<150;n++){try{if(await ready()){up=true;break;}}catch{}if(server.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,30));}
 assert.ok(up,logs);return {origin,password};
}
