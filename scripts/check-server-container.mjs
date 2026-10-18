// Exercise the built Rust image with synthetic keys and no reverse proxy.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,chmod,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
const name=`bungee-server-check-${process.pid}`;
const dir=await mkdtemp(join(tmpdir(),'bungee-container-tls-'));
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  execFileSync('python3',['-c',"import sys;sys.path.insert(0,'scripts');import tls_config;tls_config.ensure(sys.argv[1],'127.0.0.1')",join(dir,'tls')]);
  const issued=join(dir,'tls/issued');
  // Synthetic test-only keys must be readable by the image's UID 10001.
  async function readable(path){await chmod(path,0o755);for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())await readable(p);else if(!e.isSymbolicLink())await chmod(p,0o644);}}
  await readable(issued);
  docker(['run','-d','--rm','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--ulimit','core=0','--tmpfs','/state:uid=10001,gid=10001,mode=0700','--tmpfs','/tmp:size=16m','--mount',`type=bind,src=${issued},dst=/tls,readonly`,'-p','127.0.0.1::8443','--health-cmd','curl --fail --silent http://127.0.0.1:8081/healthz','-e','BUNGEE_PUBLIC_ORIGIN=https://127.0.0.1','-e','BUNGEE_ADMIN_BIND=0.0.0.0:8443','-e','BUNGEE_ADMIN_INTERFACE=eth0','-e','BUNGEE_ADMIN_SUBNETS=127.0.0.1/32 172.16.0.0/12 192.168.0.0/16','-e','BUNGEE_DEVICE_BIND=127.0.0.1:8081','-e','BUNGEE_TLS_CERT_FILE=/tls/current/server.crt','-e','BUNGEE_TLS_KEY_FILE=/tls/current/server.key','bungee-server:dev']);
  const port=Number(docker(['port',name,'8443/tcp']).split(':').at(-1));
  const ca=await readFile(join(issued,'root.crt'),'utf8');
  const query=path=>new Promise((res,rej)=>{const q=https.get({host:'127.0.0.1',port,path,ca,rejectUnauthorized:true,minVersion:'TLSv1.3',ecdhCurve:'X25519MLKEM768'},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>res({status:r.statusCode,body}));});q.on('error',rej);q.setTimeout(3000,()=>q.destroy(Error('timeout')));});
  let result;
  for(let n=0;n<100;n++){try{result=await query('/healthz');if(result.status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(result?.status,200,docker(['logs',name]));
  assert.equal(JSON.parse(result.body).status,'ok');
  assert.equal((await query('/api/devices')).status,401);
  await assert.rejects(new Promise((res,rej)=>{const s=tls.connect({host:'127.0.0.1',port,ca,ecdhCurve:'X25519',minVersion:'TLSv1.3'},res);s.on('error',rej);s.setTimeout(3000,()=>s.destroy(Error('timeout')));}));
  const info=JSON.parse(docker(['inspect',name]))[0];
  assert.equal(info.Config.User,'10001:10001');assert.ok(info.HostConfig.ReadonlyRootfs);assert.deepEqual(info.HostConfig.CapDrop,['ALL']);assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  console.log('PASS: built non-root/capability-free/read-only Rust image serves trusted direct hybrid HTTPS and protected API routes.');
} catch(e){try{console.error(docker(['logs',name]));}catch{}throw e;}
finally{try{docker(['rm','-f',name]);}catch{}await rm(dir,{recursive:true,force:true});}
