import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
export const pause = ms => new Promise(r=>setTimeout(r,ms));
async function freePort() {
  const listener=createServer(); await new Promise(r=>listener.listen(0,"127.0.0.1",r));
  const port=listener.address().port; await new Promise(r=>listener.close(r)); return port;
}
export async function fixture(t, {legacy = false, geodata = undefined} = {}) {
  const dir=await mkdtemp(join(tmpdir(),"bungee-review2-"));
  const port=await freePort(), devicePort=await freePort();
  const origin=`http://127.0.0.1:${port}`, deviceOrigin=`http://127.0.0.1:${devicePort}`;
  const password=randomBytes(24).toString("base64url");
  const verifier = legacy ? password : execFileSync(resolve("server/target/debug/bungee-server"), ["--hash-admin-password"], {input:password, encoding:"utf8"});
  await writeFile(join(dir,legacy ? "admin-password" : "admin-password.hash"),verifier,{mode:0o600});
  await mkdir(join(dir,"wireguard"));
  await writeFile(join(dir,"wireguard/server-public-key"),randomBytes(32).toString("base64"));
  let server, logs="", cookie="";
  const stop=async()=>{
    if(server?.exitCode===null) { const exited=new Promise(r=>server.once("exit",r)); server.kill("SIGINT"); await exited; }
  };
  const admin=(path,method="GET",body,extra={})=>fetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json",...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const login=async(credential=password)=>{
    const response=await admin("/api/session","POST",{password:credential});assert.equal(response.status,200);
    cookie=response.headers.get("set-cookie").split(";")[0];
  };
  const launch=async(credential=password)=>{
    server=spawn(resolve("server/target/debug/bungee-server"),[],{env:{...process.env,BUNGEE_STATE_DIR:dir,...(geodata?{BUNGEE_GEODATA_DIR:geodata}:{}),BUNGEE_ADMIN_BIND:`127.0.0.1:${port}`,BUNGEE_DEVICE_BIND:`127.0.0.1:${devicePort}`,BUNGEE_PUBLIC_ORIGIN:origin,BUNGEE_WG_ENDPOINT:"203.0.113.10:47937"},stdio:["ignore","pipe","pipe"]});
    server.stdout.on("data",b=>logs+=b); server.stderr.on("data",b=>logs+=b);
    let ready=false;
    for(let n=0;n<200;n++) { try { if((await fetch(origin+"/healthz")).ok) {ready=true;break;} } catch {} if(server.exitCode!==null)throw Error(logs); await pause(25); }
    assert.ok(ready,logs);
    const health=await (await fetch(origin+"/healthz")).json();
    assert.equal(health.version,JSON.parse(await readFile(resolve("release.json"),"utf8")).version);
    await login(credential);
  };
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  await launch();
  const sql=(statement,parameters=[])=>JSON.parse(execFileSync("python3",["-c","import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); r=c.execute(sys.argv[2],json.loads(sys.argv[3])); v=r.fetchall(); c.commit(); print(json.dumps(v))",join(dir,"bungee.sqlite3"),statement,JSON.stringify(parameters)],{encoding:"utf8"}));
  const device=(path,body)=>fetch(deviceOrigin+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  return {dir,origin,deviceOrigin,admin,device,sql,stop,launch,login,password,get cookie(){return cookie;},get pid(){return server.pid;},get logs(){return logs;}};
}
