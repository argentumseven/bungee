// Isolated Docker-only checks. No provider endpoint or household data is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import https from "node:https";
const prefix = `bungee-network-test-${process.pid}`;
const gateway = `${prefix}-gateway`,
  upstream = `${prefix}-upstream`,
  server = `${prefix}-server`,
  web = `${prefix}-web`;
const image =
  "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const docker = (args, input) =>
  execFileSync("docker", args, {
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
const probe = (ip) =>
  docker([
    "exec",
    gateway,
    "timeout",
    "2",
    "bash",
    "-c",
    'exec 3<>/dev/tcp/"$1"/8088; printf "GET / HTTP/1.0\\r\\n\\r\\n" >&3; head -1 <&3',
    "probe",
    ip,
  ]);
try {
  docker(["network", "create", prefix]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    upstream,
    "--network",
    prefix,
    image,
    "caddy",
    "file-server",
    "--listen",
    ":8088",
    "--root",
    "/tmp",
    "--browse",
  ]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    gateway,
    "--network",
    prefix,
    "-p",
    "127.0.0.1::443",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--read-only",
    "--entrypoint",
    "tail",
    "bungee-gateway:dev",
    "-f",
    "/dev/null",
  ]);
  const upstreamIp = docker([
    "inspect",
    "-f",
    `{{(index .NetworkSettings.Networks "${prefix}").IPAddress}}`,
    upstream,
  ]);
  assert.match(upstreamIp, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(probe(upstreamIp), /200 OK/);
  const firewall = readFileSync("deploy/wireguard/entrypoint.sh", "utf8").split(
    "mkdir -p /private /peers",
  )[0];
  docker(["exec", "-i", "-e", "BUNGEE_WG_PORT=47937", gateway, "sh"], firewall);
  assert.throws(
    () => probe(upstreamIp),
    (e) => e.status === 124,
    "new outbound TCP is dropped after firewall setup",
  );
  assert.throws(
    () =>
      docker([
        "exec",
        gateway,
        "timeout",
        "2",
        "bash",
        "-c",
        "exec 3<>/dev/tcp/127.0.0.11/53",
      ]),
    (e) => e.status === 124,
    "Docker provider DNS is dropped",
  );
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    server,
    "--network",
    `container:${gateway}`,
    "--cap-drop",
    "ALL",
    "--read-only",
    "--tmpfs",
    "/state:uid=10001,gid=10001,mode=0700",
    "--tmpfs",
    "/tmp:size=16m",
    "-e",
    "BUNGEE_PUBLIC_ORIGIN=https://127.0.0.1",
    "bungee-server:dev",
  ]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    web,
    "--network",
    `container:${gateway}`,
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_BIND_SERVICE",
    "--read-only",
    "--tmpfs",
    "/data:mode=0700",
    "--tmpfs",
    "/config:mode=0700",
    "--tmpfs",
    "/tmp:size=16m",
    "-e",
    "BUNGEE_DOMAIN=127.0.0.1",
    "-v",
    `${resolve("deploy/Caddyfile")}:/etc/caddy/Caddyfile:ro`,
    image,
  ]);
  let ca;
  for (let n = 0; n < 50; n++) {
    try {
      ca = docker([
        "exec",
        web,
        "cat",
        "/data/caddy/pki/authorities/local/root.crt",
      ]);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(ca, "local CA is created under outbound-deny policy");
  const port = Number(docker(["port", gateway, "443/tcp"]).split(":").at(-1));
  const result = await new Promise((resolveResult, reject) => {
    const req = https.get(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        ecdhCurve: "X25519MLKEM768",
      },
      (res) => {
        let body = "";
        res.on("data", (b) => (body += b));
        res.on("end", () =>
          resolveResult({ status: res.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "ok");
  console.log(
    "PASS: baseline TCP succeeds; new outbound TCP and Docker DNS are dropped; trusted hybrid HTTPS reaches Rust through the same namespace with all non-gateway capabilities dropped.",
  );
} catch (e) {
  for (const name of [gateway, server, web]) {
    try {
      process.stderr.write(docker(["logs", name]) + "\n");
    } catch {}
  }
  throw e;
} finally {
  for (const name of [web, server, gateway, upstream]) {
    try {
      docker(["rm", "-f", name]);
    } catch {}
  }
  try {
    docker(["network", "rm", prefix]);
  } catch {}
}
