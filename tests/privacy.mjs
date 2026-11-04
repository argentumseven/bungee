import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("server rejects default ports and DNS-dependent endpoints before listening", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bungee-endpoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "admin-password"),
    "test-only-password-not-a-real-secret",
    { mode: 0o600 },
  );
  for (const endpoint of [
    "203.0.113.10:51820",
    "203.0.113.10:0",
    "home.example.com:47937",
    "0.0.0.0:47937",
    "[ff02::1]:47937",
  ]) {
    const child = spawn(resolve("server/target/debug/bungee-server"), [], {
      env: {
        ...process.env,
        BUNGEE_STATE_DIR: dir,
        BUNGEE_WG_ENDPOINT: endpoint,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (b) => (error += b));
    const code = await new Promise((r) => child.once("exit", r));
    assert.notEqual(code, 0, endpoint);
    assert.match(error, /custom WireGuard port|literal IP:port/);
  }
});

test("device listener rejects wildcard, public, unrelated LAN and DNS binds at startup", async t=>{
  const dir=await mkdtemp(join(tmpdir(),"bungee-device-bind-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const bind of ["0.0.0.0:8081","[::]:8081","203.0.113.10:8081","192.168.1.5:8081","10.77.0.2:8081","10.77.0.1:9090","localhost:8081","127.0.0.1:0"]) {
    const child=spawn(resolve("server/target/debug/bungee-server"),[],{env:{...process.env,BUNGEE_STATE_DIR:dir,BUNGEE_DEVICE_BIND:bind},stdio:["ignore","ignore","pipe"]});
    let error=""; child.stderr.on("data",b=>error+=b);
    const code=await new Promise(r=>child.once("exit",r));
    assert.notEqual(code,0,bind); assert.match(error,/BUNGEE_DEVICE_BIND/);
  }
});

test("gateway validates the chosen port and installs outbound-deny rules for the shared namespace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bungee-gateway-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  await mkdir(bin);
  const log = join(dir, "firewall.log");
  for (const name of ["iptables", "ip6tables", "ip", "chown"]) {
    await writeFile(
      join(bin, name),
      '#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$TEST_FIREWALL_LOG"\n',
      { mode: 0o700 },
    );
  }
  await writeFile(
    join(bin, "wg"),
    '#!/bin/sh\ncase "$1" in genkey) printf "test-private-key\\n";; pubkey) cat >/dev/null; printf "test-public-key\\n";; syncconf) exit 73;; esac\n',
    { mode: 0o700 },
  );
  const original = await readFile("deploy/wireguard/entrypoint.sh", "utf8");
  const script = join(dir, "entrypoint.sh");
  await writeFile(
    script,
    original
      .replaceAll("/private", join(dir, "private"))
      .replace(/\/peers(?=[/\s"]|$)/g, join(dir, "peers"))
      .replaceAll("/run/wg0.conf", join(dir, "wg0.conf"))
      .replaceAll("/run/bungee-admission", join(dir, "admission"))
      .replaceAll("/usr/local/lib/bungee/network_config.py", resolve("deploy/network_config.py")),
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TEST_FIREWALL_LOG: log,
    BUNGEE_ADMIN_SUBNETS: "127.0.0.1 ::1",
  };
  for (const port of ["", "51820", "0", "65536", "123;bad", "-2"]) {
    const rejected = spawnSync("sh", [script], {
      env: { ...env, BUNGEE_WG_PORT: port },
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Choose a custom UDP port|Invalid UDP port|Ports must|51820 is not permitted/);
  }
  assert.equal(
    spawnSync("sh", [script], { env: { ...env, BUNGEE_WG_PORT: "47937" } })
      .status,
    73,
  );
  const calls = await readFile(log, "utf8");
  for (const command of ["iptables", "ip6tables"]) {
    assert.ok(calls.includes(`${command} -P OUTPUT DROP`));
    assert.ok(calls.includes(`${command} -P FORWARD DROP`));
    assert.ok(
      calls.includes(`${command} -A INPUT -p udp --dport 47937 -j ACCEPT`),
    );
    assert.ok(
      calls.includes(
        `${command} -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
      ),
    );
  }
  assert.ok(calls.includes("iptables -A OUTPUT -d 127.0.0.11 -j DROP"));
  assert.match(
    await readFile(join(dir, "wg0.conf"), "utf8"),
    /ListenPort = 47937/,
  );
  // Old environment variables cannot reopen DNS ingress or outbound exceptions.
  assert.equal(spawnSync('sh',[script],{env:{...env,BUNGEE_WG_PORT:'47937',BUNGEE_DNS_UPSTREAM_IP:'192.168.1.53',BUNGEE_DNS_UPSTREAM_PORT:'5353',BUNGEE_PRIVATE_DNS_HOST:'dns.example.org'}}).status,73);
  const retiredCalls = await readFile(log, "utf8");
  assert.doesNotMatch(retiredCalls,/OUTPUT -d 192\.168\.1\.53.*-j ACCEPT/);
  assert.doesNotMatch(retiredCalls,/REDIRECT|--dport (?:53|5353|8853) -j ACCEPT/);
  const peers = join(dir, "peers/peers.conf");
  await writeFile(
    peers,
    "[Peer]\nPublicKey = legacy-test-key\nAllowedIPs = 10.77.0.2/32\n",
  );
  spawnSync("sh", [script], { env: { ...env, BUNGEE_WG_PORT: "47937" } });
  assert.ok(
    !(await readFile(join(dir, "wg0.conf"), "utf8")).includes("[Peer]"),
    "a persisted legacy file cannot open a PSK-free tunnel during startup",
  );
  await writeFile(
    peers,
    `[Peer]\nPublicKey = test-key\nPresharedKey = ${Buffer.alloc(32, 7).toString("base64")}\nAllowedIPs = 10.77.0.2/32\n`,
  );
  spawnSync("sh", [script], { env: { ...env, BUNGEE_WG_PORT: "47937" } });
  assert.match(
    await readFile(join(dir, "wg0.conf"), "utf8"),
    /PresharedKey = /,
  );
});


test("administrator startup requires explicit subnets and TLS material for remote binds", async t=>{
  const dir=await mkdtemp(join(tmpdir(),"bungee-admin-bind-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const bind of ["0.0.0.0:8080","[::]:8080","203.0.113.10:8080","192.168.1.5:8080","localhost:8080","127.0.0.1:0"]) {
    const child=spawn(resolve("server/target/debug/bungee-server"),[],{env:{...process.env,BUNGEE_STATE_DIR:dir,BUNGEE_ADMIN_BIND:bind,BUNGEE_PUBLIC_ORIGIN:"https://home.example"},stdio:["ignore","ignore","pipe"]});
    let error="";child.stderr.on("data",b=>error+=b);
    const code=await new Promise(r=>child.once("exit",r));
    assert.notEqual(code,0,bind);assert.match(error,/BUNGEE_ADMIN_BIND|BUNGEE_ADMIN_SUBNETS/);
  }
});
