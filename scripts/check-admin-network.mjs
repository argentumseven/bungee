// Real Caddy TLS and source-address checks. Isolated synthetic Docker clients only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const prefix = `bungee-admin-test-${process.pid}`;
const caddy = `${prefix}-web`, allowed = `${prefix}-allowed`, denied = `${prefix}-denied`, backend = `${prefix}-backend`;
const image = "bungee-web:dev";
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  docker(["network", "create", prefix]);
  for (const name of [allowed, denied]) docker(["run", "--detach", "--rm", "--name", name, "--network", prefix, "node:24-bookworm-slim", "node", "-e", "setInterval(()=>{},60000)"]);
  const ip = name => docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${prefix}").IPAddress}}`, name]);
  const source = ip(allowed);
  docker(["run", "--detach", "--rm", "--name", caddy, "--network", prefix, "--read-only", "--tmpfs", "/data:mode=0700", "--tmpfs", "/config:mode=0700", "-e", "BUNGEE_DOMAIN=127.0.0.1", "-e", `BUNGEE_ADMIN_SUBNETS=${source}/32`, "-v", `${resolve("deploy/Caddyfile")}:/etc/caddy/Caddyfile:ro`, image]);
  let ca;
  for (let n = 0; n < 100; n++) {
    try { ca = docker(["exec", caddy, "cat", "/data/caddy/pki/authorities/local/root.crt"]); if (ca.includes("BEGIN CERTIFICATE")) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ca?.includes("BEGIN CERTIFICATE"));
  const query = String.raw`
    const https=require('https');
    const req=https.get({host:process.env.TARGET,servername:'127.0.0.1',port:443,path:process.env.PATHNAME,ca:process.env.CA,rejectUnauthorized:true,minVersion:'TLSv1.3',ecdhCurve:'X25519MLKEM768',headers:{Host:'127.0.0.1','X-Forwarded-For':process.env.SPOOF,'X-Real-IP':process.env.SPOOF,'X-Bungee-Admin-IP':process.env.SPOOF}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>{if(process.env.EXPECT_SOURCE && JSON.parse(body).ip!==process.env.EXPECT_SOURCE){console.error('Proxy identity was not replaced');process.exitCode=1}else console.log(res.statusCode)})});
    req.setTimeout(5000,()=>req.destroy(new Error('timeout')));req.on('error',e=>{console.error(e.message);process.exitCode=1});`;
  function status(client, path, spoof, expected = '') {
    return Number(docker(["exec", "-e", `TARGET=${ip(caddy)}`, "-e", `CA=${ca}`, "-e", `PATHNAME=${path}`, "-e", `SPOOF=${spoof}`, "-e", `EXPECT_SOURCE=${expected}`, client, "node", "-e", query]));
  }
  docker(['run','--detach','--rm','--name',backend,'--network',`container:${caddy}`,'--cap-drop','ALL','--read-only','node:24-bookworm-slim','node','-e',"require('http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ip:req.headers['x-bungee-admin-ip']}))}).listen(8080,'127.0.0.1')"]);
  assert.equal(status(allowed, '/', ip(denied), source), 200, 'Caddy replaces a forged administrator identity with the actual TCP source');
  for (const path of ['/', '/api/session', '/healthz']) {
    assert.equal(status(allowed, path, ip(denied), source), 200, 'Allowed source reaches the backend with its actual source identity');
    assert.equal(status(denied, path, source), 403, 'Unlisted source stays denied despite spoofed forwarding headers');
  }
  for (const nets of ['', 'garbage']) {
    assert.throws(() => docker(['run', '--rm', '-e', 'BUNGEE_DOMAIN=127.0.0.1', '-e', `BUNGEE_ADMIN_SUBNETS=${nets}`, '-v', `${resolve('deploy/Caddyfile')}:/etc/caddy/Caddyfile:ro`, image, 'caddy', 'adapt', '--validate', '--config', '/etc/caddy/Caddyfile']));
  }
  console.log('PASS: actual TLS verifies; only the configured source reaches Caddy upstream; denied clients cannot spoof admission; Caddy overwrites the administrator identity header; empty/malformed lists fail configuration.');
} catch (error) {
  try { console.error(docker(['logs', '--tail', '30', caddy])); } catch {}
  throw error;
} finally {
  for (const name of [backend, caddy, allowed, denied]) { try { docker(['rm', '--force', name]); } catch {} }
  try { docker(['network', 'rm', prefix]); } catch {}
}
