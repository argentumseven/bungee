// Exercise the built Rust image with synthetic keys and no reverse proxy.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,chmod,readdir,readFile,rm,mkdir,writeFile,copyFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
const name=`bungee-server-check-${process.pid}`;
const dir=await mkdtemp(join(tmpdir(),'bungee-container-tls-'));
const requests=join(dir,'map-requests');
const docker=(args,input)=>execFileSync('docker',args,{input,encoding:'utf8',stdio:[input === undefined ? 'ignore' : 'pipe','pipe','pipe']}).trim();
try {
  const verifier = docker(['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','bungee-server:dev','--hash-admin-password'], 'test-only-container-password-not-a-secret');
  execFileSync('python3',['-c',"import sys;sys.path.insert(0,'scripts');import tls_config;tls_config.ensure(sys.argv[1],'127.0.0.1')",join(dir,'tls')]);
  const issued=join(dir,'tls/issued');
  // Synthetic test-only keys must be readable by the image's UID 10001.
  async function readable(path){await chmod(path,0o755);for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())await readable(p);else if(!e.isSymbolicLink())await chmod(p,0o644);}}
  await readable(issued);
  const updates=join(dir,'app-updates');await mkdir(updates);await chmod(updates,0o755);
  const maps=join(dir,'maps'),status=join(dir,'map-status');
  for(const path of [maps,status,requests]){await mkdir(path);await chmod(path,0o755);}
  await chmod(requests,0o700);
  // Use the real host publisher under the systemd/CLI umask. A hand-written
  // fixture followed by chmod would conceal the UID-10001 permission regression.
  const publish=(path,value)=>execFileSync('python3',['-c',"import os,sys,json;sys.path.insert(0,'scripts');import map_manager;os.umask(0o077);map_manager.atomic(sys.argv[1],json.loads(sys.argv[2]))",path,JSON.stringify(value)]);
  publish(join(maps,'library.json'),{format:1,regions:[]});
  publish(join(status,'state.json'),{catalog:[{id:'us-pacific',name:'Pacific'}],job:{state:'completed'},updated_at:Math.floor(Date.now()/1000)});
  assert.equal((await stat(join(maps,'library.json'))).mode&0o777,0o644);
  assert.equal((await stat(join(status,'state.json'))).mode&0o777,0o644);
  const datasets=join(dir,'datasets');await mkdir(datasets);await chmod(datasets,0o755);
  await copyFile('basemap/world.mbtiles',join(datasets,'map.mbtiles'));await chmod(join(datasets,'map.mbtiles'),0o644);
  docker(['run','--rm','--user','0:0','--network','none','--cap-drop','ALL','--cap-add','CHOWN','--mount',`type=bind,src=${requests},dst=/requests`,'--entrypoint','chown','bungee-server:dev','10001:10001','/requests']);
  const mapMounts=['--mount',`type=bind,src=${datasets},dst=/datasets,readonly`,'--mount',`type=bind,src=${updates},dst=/app-updates,readonly`,'--mount',`type=bind,src=${maps},dst=/maps,readonly`,'--mount',`type=bind,src=${status},dst=/map-control/status,readonly`,'--mount',`type=bind,src=${requests},dst=/map-control/requests`];
  docker(['run','-d','--rm','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--ulimit','core=0','--tmpfs','/state:uid=10001,gid=10001,mode=0700','--tmpfs','/tmp:size=16m','--mount',`type=bind,src=${issued},dst=/tls,readonly`,...mapMounts,'-p','127.0.0.1::8443','--health-cmd','curl --fail --silent http://127.0.0.1:8081/healthz','-e','BUNGEE_PUBLIC_ORIGIN=https://127.0.0.1','-e','BUNGEE_ADMIN_BIND=0.0.0.0:8443','-e','BUNGEE_ADMIN_INTERFACE=eth0','-e','BUNGEE_ADMIN_SUBNETS=127.0.0.1/32 172.16.0.0/12 192.168.0.0/16','-e','BUNGEE_DEVICE_BIND=127.0.0.1:8081','-e','BUNGEE_TLS_CERT_FILE=/tls/current/server.crt','-e','BUNGEE_TLS_KEY_FILE=/tls/current/server.key','--entrypoint','sh','bungee-server:dev','-ec','printf "%s\\n" "$1" > /state/admin-password.hash; exec /usr/local/bin/bungee-server','bootstrap',verifier]);
  const port=Number(docker(['port',name,'8443/tcp']).split(':').at(-1));
  const ca=await readFile(join(issued,'root.crt'),'utf8');
  const query=(path,method='GET',data=undefined,cookie='')=>new Promise((res,rej)=>{const payload=data===undefined?undefined:JSON.stringify(data);const q=https.request({host:'127.0.0.1',port,path,method,headers:{Origin:'https://127.0.0.1',Cookie:cookie,'Content-Type':'application/json',...(payload?{'Content-Length':Buffer.byteLength(payload)}:{})},ca,rejectUnauthorized:true,minVersion:'TLSv1.3',ecdhCurve:'X25519MLKEM768'},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>res({status:r.statusCode,body,headers:r.headers}));});q.on('error',rej);q.setTimeout(5000,()=>q.destroy(Error('timeout')));q.end(payload);});
  let result;
  for(let n=0;n<100;n++){try{result=await query('/healthz');if(result.status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(result?.status,200,docker(['logs',name]));
  assert.equal(JSON.parse(result.body).status,'ok');
  assert.equal((await query('/api/devices')).status,401);
  assert.equal((await query('/api/maps/manage')).status,401);
  assert.equal((await query('/api/app-updates')).status,401);
  const login=await query('/api/session','POST',{password:'test-only-container-password-not-a-secret'});assert.equal(login.status,200);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await query('/api/maps/manage','GET',undefined,cookie)).status,200);
  assert.equal(JSON.parse((await query('/api/geography','GET',undefined,cookie)).body).maps.overview,true);
  await chmod(join(maps,'library.json'),0o000);
  const fallback=await query('/api/geography','GET',undefined,cookie);assert.equal(fallback.status,200);
  assert.equal(JSON.parse(fallback.body).maps.overview,true);assert.match(JSON.parse(fallback.body).regional_error,/permissions.*repair/i);
  assert.equal((await query('/api/maps/0/0/0','GET',undefined,cookie)).status,200);
  await chmod(join(maps,'library.json'),0o644);

  assert.equal((await query('/api/app-updates','GET',undefined,cookie)).status,200);
  const job=await query('/api/maps/jobs','POST',{action:'plan',regions:['us-pacific']},cookie);assert.equal(job.status,202,job.body);
  const jobId=JSON.parse(job.body).id,request=JSON.parse(docker(['exec',name,'cat',`/map-control/requests/${jobId}.json`]));assert.deepEqual(request.regions,['us-pacific']);
  for(const path of ['/maps/not-allowed','/map-control/status/not-allowed','/app-updates/not-allowed'])assert.throws(()=>docker(['exec',name,'sh','-ec',`printf x > ${path}`]));
  await assert.rejects(new Promise((res,rej)=>{const s=tls.connect({host:'127.0.0.1',port,ca,ecdhCurve:'X25519',minVersion:'TLSv1.3'},res);s.on('error',rej);s.setTimeout(3000,()=>s.destroy(Error('timeout')));}));
  const info=JSON.parse(docker(['inspect',name]))[0];
  assert.equal(info.Config.User,'10001:10001');assert.ok(info.HostConfig.ReadonlyRootfs);assert.deepEqual(info.HostConfig.CapDrop,['ALL']);assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  console.log('PASS: built non-root/capability-free/read-only Rust image serves trusted direct hybrid HTTPS, protects API routes and queues map jobs through writable requests while archives/status stay read-only.');
} catch(e){try{console.error(docker(['logs',name]));}catch{}throw e;}
finally{try{docker(['rm','-f',name]);}catch{}try{docker(['run','--rm','--user','0:0','--network','none','--cap-drop','ALL','--cap-add','CHOWN','--mount',`type=bind,src=${requests},dst=/requests`,'--entrypoint','chown','bungee-server:dev',`${process.getuid()}:${process.getgid()}`,'/requests']);}catch{}await rm(dir,{recursive:true,force:true});}
