// Docker + Node 24/OpenSSL 3.5: test the actual pinned Caddy image, without trusting a public CA.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import tls from "node:tls";
const name = `bungee-tls-test-${process.pid}`;
const image = "bungee-web:dev";
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
try {
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "BUNGEE_DOMAIN=127.0.0.1",
    "-e",
    "BUNGEE_ADMIN_SUBNETS=127.0.0.1/32 172.16.0.0/12 192.168.0.0/16",
    "-p",
    "127.0.0.1::443",
    "--read-only",
    "--tmpfs",
    "/data:mode=0700",
    "--tmpfs",
    "/config:mode=0700",
    "-v",
    `${resolve("deploy/Caddyfile")}:/etc/caddy/Caddyfile:ro`,
    image,
  ]);
  let ca;
  for (let n = 0; n < 50; n++) {
    try {
      ca = docker([
        "exec",
        name,
        "cat",
        "/data/caddy/pki/authorities/local/root.crt",
      ]);
      assert.match(ca, /BEGIN CERTIFICATE/);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(ca, "local CA was created");
  const port = Number(docker(["port", name, "443/tcp"]).split(":").at(-1));
  const handshake = (
    ecdhCurve,
    minVersion = "TLSv1.3",
    maxVersion = "TLSv1.3",
  ) =>
    new Promise((resolve) => {
      const s = tls.connect(
        {
          host: "127.0.0.1",
          port,
          ca,
          rejectUnauthorized: true,
          minVersion,
          maxVersion,
          ecdhCurve,
        },
        () => {
          const result = {
            authorized: s.authorized,
            protocol: s.getProtocol(),
            group: s.getEphemeralKeyInfo().name,
          };
          s.end();
          resolve(result);
        },
      );
      s.once("error", (e) => resolve({ error: e.code }));
      s.setTimeout(5000, () => {
        s.destroy();
        resolve({ error: "timeout" });
      });
    });
  assert.deepEqual(await handshake("X25519MLKEM768"), {
    authorized: true,
    protocol: "TLSv1.3",
    group: "X25519MLKEM768",
  });
  assert.match((await handshake("X25519")).error, /HANDSHAKE_FAILURE/);
  assert.match(
    (await handshake("X25519", "TLSv1.2", "TLSv1.2")).error,
    /PROTOCOL_VERSION/,
  );
  const config = JSON.parse(
    docker([
      "exec",
      name,
      "caddy",
      "adapt",
      "--config",
      "/etc/caddy/Caddyfile",
    ]),
  );
  assert.ok(
    config.apps.tls.automation.policies.every((p) =>
      p.issuers.every((i) => i.module === "internal"),
    ),
  );
  console.log(
    "PASS: trusted local CA; TLS 1.3 X25519MLKEM768 succeeds; classical-only/TLS 1.2 rejected; no public ACME issuer.",
  );
} finally {
  try {
    docker(["rm", "-f", name]);
  } catch {}
}
