import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

async function freePort() {
  const listener = createServer();
  await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  return port;
}
test("administrator budgets behind an explicitly trusted loopback proxy", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bungee-proxy-"));
  const port = await freePort(), devicePort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString("base64url");
  await writeFile(join(dir, "admin-password"), password, {mode:0o600});
  let logs = "";
  const server = spawn(resolve("server/target/debug/bungee-server"), [], {
    env: {...process.env, BUNGEE_STATE_DIR:dir, BUNGEE_ADMIN_BIND:`127.0.0.1:${port}`, BUNGEE_DEVICE_BIND:`127.0.0.1:${devicePort}`, BUNGEE_PUBLIC_ORIGIN:origin, BUNGEE_TRUST_LOOPBACK_PROXY:"true"},
    stdio:["ignore","pipe","pipe"],
  });
  server.stdout.on("data",b=>logs+=b); server.stderr.on("data",b=>logs+=b);
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = new Promise(r=>server.once("exit",r)); server.kill("SIGINT"); await exited;
    }
    await rm(dir,{recursive:true,force:true});
  });
  let ready = false;
  for(let n=0;n<100;n++) {
    try { if((await fetch(origin+"/healthz")).ok) { ready=true; break; } } catch {}
    if(server.exitCode !== null) throw Error(logs);
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(ready,logs);
  const login = (source,value="incorrect",extra={}) => fetch(origin+"/api/session",{
    method:"POST", headers:{Origin:origin,"Content-Type":"application/json",...(source?{"X-Bungee-Admin-IP":source}:{}),...extra}, body:JSON.stringify({password:value}),
  });
  await t.test("missing or ambiguous trusted identity fails closed", async () => {
    assert.equal((await login(null,password)).status,401);
    assert.equal((await login("192.0.2.10,192.0.2.11",password)).status,401);
  });
  await t.test("one administrator source cannot spend another source's login budget", async () => {
    for(let n=0;n<5;n++) assert.equal((await login("192.0.2.10")).status,401);
    assert.equal((await login("192.0.2.10",password,{"X-Forwarded-For":"192.0.2.11"})).status,429);
    const admitted = await login("192.0.2.11",password);
    assert.equal(admitted.status,200);
    assert.match(admitted.headers.get("set-cookie"),/HttpOnly; SameSite=Strict/);
  });
});
