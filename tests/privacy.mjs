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
      .replaceAll("/run/wg0.conf", join(dir, "wg0.conf")),
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TEST_FIREWALL_LOG: log,
  };
  for (const port of ["", "51820", "0", "65536", "123;bad", "-2"]) {
    const rejected = spawnSync("sh", [script], {
      env: { ...env, BUNGEE_WG_PORT: port },
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Choose a custom UDP port|Invalid UDP port/);
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
  for (const upstream of [
    "8.8.8.8",
    "1.1.1.1",
    "127.0.0.11",
    "10.77.0.2",
    "resolver.example",
  ]) {
    const rejected = spawnSync("sh", [script], {
      env: {
        ...env,
        BUNGEE_WG_PORT: "47937",
        BUNGEE_DNS_UPSTREAM_IP: upstream,
      },
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 73, upstream);
    assert.notEqual(rejected.status, 0, upstream);
  }
  assert.equal(
    spawnSync("sh", [script], {
      env: {
        ...env,
        BUNGEE_WG_PORT: "47937",
        BUNGEE_DNS_UPSTREAM_IP: "192.168.1.53",
        BUNGEE_DNS_UPSTREAM_PORT: "5353",
      },
    }).status,
    73,
  );
  const dnsCalls = await readFile(log, "utf8");
  assert.match(
    dnsCalls,
    /OUTPUT -d 192\.168\.1\.53 -p udp --dport 5353 -j ACCEPT/,
  );
  assert.match(
    dnsCalls,
    /PREROUTING -i wg0 -p udp --dport 53 -j REDIRECT --to-ports 5353/,
  );
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
