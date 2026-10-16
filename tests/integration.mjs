import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  generateKeyPairSync,
  sign,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:net";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

test("live server: household enrollment, device signatures, commands, and revocation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bungee-test-"));
  const port = await freePort(),
    devicePort = await freePort();
  const origin = `http://127.0.0.1:${port}`,
    deviceOrigin = `http://127.0.0.1:${devicePort}`;
  const password = randomBytes(24).toString("base64url");
  await writeFile(join(dir, "admin-password"), password, { mode: 0o600 });
  await mkdir(join(dir, "wireguard"));
  await writeFile(
    join(dir, "wireguard/server-public-key"),
    randomBytes(32).toString("base64"),
  );
  const server = spawn(resolve("server/target/debug/bungee-server"), [], {
    env: {
      ...process.env,
      BUNGEE_STATE_DIR: dir,
      BUNGEE_ADMIN_BIND: `127.0.0.1:${port}`,
      BUNGEE_DEVICE_BIND: `127.0.0.1:${devicePort}`,
      BUNGEE_PUBLIC_ORIGIN: origin,
      BUNGEE_WG_ENDPOINT: "home.example.com:51820",
      BUNGEE_WEB_DIR: resolve("web/dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (b) => (logs += b));
  server.stderr.on("data", (b) => (logs += b));
  t.after(async () => {
    server.kill("SIGINT");
    await new Promise((r) => server.once("exit", r));
    await rm(dir, { recursive: true, force: true });
  });
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(origin + "/healthz")).ok) break;
    } catch {}
    if (server.exitCode !== null) throw Error(logs);
    await pause(50);
  }
  let cookie = "";
  const admin = (path, method = "GET", body, extra = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const sql = (statement, parameters) =>
    execFileSync("python3", [
      "-c",
      "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2],json.loads(sys.argv[3])); c.commit()",
      join(dir, "bungee.sqlite3"),
      statement,
      JSON.stringify(parameters),
    ]);
  await t.test(
    "dashboard is available and hardening headers are present",
    async () => {
      const r = await fetch(origin);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /Bungee/);
      assert.match(
        r.headers.get("content-security-policy"),
        /frame-ancestors 'none'/,
      );
      assert.equal(r.headers.get("cache-control"), "no-store");
    },
  );
  await t.test("anonymous administrators cannot see devices", async () =>
    assert.equal((await admin("/api/devices")).status, 401),
  );
  await t.test(
    "login rejects cross-origin requests and bad passwords",
    async () => {
      assert.equal(
        (
          await admin(
            "/api/session",
            "POST",
            { password },
            { Origin: "https://evil.example" },
          )
        ).status,
        403,
      );
      assert.equal(
        (await admin("/api/session", "POST", { password: "wrong" })).status,
        401,
      );
    },
  );
  await t.test("valid login creates an HttpOnly SameSite session", async () => {
    const r = await admin("/api/session", "POST", { password });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    cookie = r.headers.get("set-cookie").split(";")[0];
  });
  await t.test("device API is separate from dashboard", async () =>
    assert.equal((await admin("/v1/enroll", "POST", {})).status, 405),
  );
  const signing = generateKeyPairSync("ec", { namedCurve: "P-256" }),
    publicKey = signing.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
  const wgPublic = randomBytes(32).toString("base64");
  let bundle, id;
  await t.test("invalid WireGuard keys are rejected", async () =>
    assert.equal(
      (
        await admin("/api/enrollments", "POST", {
          name: "Test Pixel",
          wg_public_key: "bad",
        })
      ).status,
      400,
    ),
  );
  await t.test("one-use invitation provisions only a /32 peer", async () => {
    const r = await admin("/api/enrollments", "POST", {
      name: "Test Pixel",
      wg_public_key: wgPublic,
    });
    assert.equal(r.status, 200);
    bundle = await r.json();
    id = bundle.device_id;
    assert.equal(bundle.wireguard.allowed_ip, "10.77.0.1/32");
    assert.equal(bundle.wireguard.client_public_key, wgPublic);
    assert.match(
      await readFile(join(dir, "wireguard/peers.conf"), "utf8"),
      /AllowedIPs = 10\.77\.0\.2\/32/,
    );
  });
  const pair = () => ({
    token: bundle.token,
    public_key: publicKey,
    wg_public_key: wgPublic,
    proof: sign(
      "sha256",
      Buffer.from(
        `BUNGEE-ENROLL-V1\n${bundle.token}\n${wgPublic}\n${publicKey}`,
      ),
      signing.privateKey,
    ).toString("base64"),
    capabilities: [
      "locate",
      "ring",
      "stop_ringing",
      "message",
      "clear_message",
    ],
  });
  const device = (path, body, headers = {}) =>
    fetch(deviceOrigin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  await t.test("enrollment verifies possession of a signing key", async () => {
    assert.equal(
      (
        await device("/v1/enroll", {
          ...pair(),
          proof: randomBytes(64).toString("base64"),
        })
      ).status,
      401,
    );
    assert.equal((await device("/v1/enroll", pair())).status, 200);
  });
  await t.test("enrollment invitation cannot be reused", async () =>
    assert.equal((await device("/v1/enroll", pair())).status, 401),
  );
  await t.test("expired invitations cannot bind a signing key", async () => {
    const r = await admin("/api/enrollments", "POST", {
      name: "Expired invitation",
      wg_public_key: randomBytes(32).toString("base64"),
    });
    const expired = await r.json();
    sql("UPDATE enrollments SET expires=1 WHERE device_id=?", [
      expired.device_id,
    ]);
    const proof = sign(
      "sha256",
      Buffer.from(
        `BUNGEE-ENROLL-V1\n${expired.token}\n${expired.wireguard.client_public_key}\n${publicKey}`,
      ),
      signing.privateKey,
    ).toString("base64");
    assert.equal(
      (
        await device("/v1/enroll", {
          ...pair(),
          token: expired.token,
          wg_public_key: expired.wireguard.client_public_key,
          proof,
        })
      ).status,
      401,
    );
    await admin(`/api/devices/${expired.device_id}`, "DELETE");
  });
  const auth = (path, text, override = {}) => {
    const time = String(Math.floor(Date.now() / 1000)),
      nonce = randomUUID();
    const h = {
      "X-Bungee-Device": id,
      "X-Bungee-Time": time,
      "X-Bungee-Nonce": nonce,
      ...override,
    };
    h["X-Bungee-Signature"] = sign(
      "sha256",
      Buffer.from(
        `BUNGEE-V1\nPOST\n${path}\n${h["X-Bungee-Time"]}\n${h["X-Bungee-Nonce"]}\n${createHash("sha256").update(text).digest("hex")}`,
      ),
      signing.privateKey,
    ).toString("base64");
    return h;
  };
  const signed = (path, body) => {
    const text = JSON.stringify(body);
    return device(path, text, auth(path, text));
  };
  const telemetry = {
    battery: 76,
    charging: true,
    location: {
      latitude: 37.78,
      longitude: -122.42,
      accuracy: 12,
      observed_at: Math.floor(Date.now() / 1000),
    },
    capabilities: pair().capabilities,
    device_owner: false,
  };
  await t.test("unsigned telemetry is rejected", async () =>
    assert.equal((await device("/v1/telemetry", telemetry)).status, 401),
  );
  await t.test("tampering with a signed body is rejected", async () => {
    const body = JSON.stringify(telemetry),
      h = auth("/v1/telemetry", body);
    assert.equal(
      (await device("/v1/telemetry", { ...telemetry, battery: 2 }, h)).status,
      401,
    );
  });
  await t.test("stale signed requests are rejected", async () => {
    const body = JSON.stringify(telemetry);
    assert.equal(
      (
        await device(
          "/v1/telemetry",
          body,
          auth("/v1/telemetry", body, { "X-Bungee-Time": "1" }),
        )
      ).status,
      401,
    );
  });
  await t.test(
    "a different signing key cannot impersonate an enrolled phone",
    async () => {
      const body = JSON.stringify(telemetry),
        headers = auth("/v1/telemetry", body);
      headers["X-Bungee-Signature"] = sign(
        "sha256",
        Buffer.from("not the enrolled key"),
        generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
      ).toString("base64");
      assert.equal((await device("/v1/telemetry", body, headers)).status, 401);
    },
  );
  await t.test("accepted telemetry appears in the dashboard", async () => {
    assert.equal((await signed("/v1/telemetry", telemetry)).status, 200);
    const data = await (await admin("/api/devices")).json();
    assert.equal(data.devices[0].telemetry.battery, 76);
    assert.equal(data.devices[0].telemetry.location.latitude, 37.78);
    assert.equal(data.devices[0].enrolled, true);
  });
  await t.test("signed request replay is rejected", async () => {
    const body = "{}",
      h = auth("/v1/commands", body);
    assert.equal((await device("/v1/commands", body, h)).status, 200);
    assert.equal((await device("/v1/commands", body, h)).status, 409);
  });
  await t.test("invalid coordinates cannot enter storage", async () =>
    assert.equal(
      (
        await signed("/v1/telemetry", {
          ...telemetry,
          location: { ...telemetry.location, latitude: 100 },
        })
      ).status,
      400,
    ),
  );
  await t.test("remote locking requires a phone-granted capability", async () =>
    assert.equal(
      (await admin(`/api/devices/${id}/commands`, "POST", { kind: "lock" }))
        .status,
      400,
    ),
  );
  let command;
  await t.test("commands are queued, delivered, and acknowledged", async () => {
    const r = await admin(`/api/devices/${id}/commands`, "POST", {
      kind: "ring",
    });
    assert.equal(r.status, 200);
    command = await r.json();
    assert.equal(command.status, "pending");
    const polled = await (await signed("/v1/commands", {})).json();
    assert.equal(polled.commands[0].id, command.id);
    assert.ok(polled.commands[0].expires > Date.now() / 1000);
    const ack = await signed("/v1/ack", {
      id: command.id,
      status: "executed",
      result: "Sound started",
    });
    assert.equal((await ack.json()).accepted, true);
    assert.equal(
      (await (await signed("/v1/commands", {})).json()).commands.length,
      0,
    );
  });
  await t.test(
    "duplicate receipts do not change completed commands",
    async () =>
      assert.equal(
        (
          await (
            await signed("/v1/ack", {
              id: command.id,
              status: "failed",
              result: "duplicate",
            })
          ).json()
        ).accepted,
        false,
      ),
  );
  await t.test("recovery messages have a strict size limit", async () =>
    assert.equal(
      (
        await admin(`/api/devices/${id}/commands`, "POST", {
          kind: "message",
          message: "x".repeat(241),
        })
      ).status,
      400,
    ),
  );
  await t.test(
    "expired commands are not delivered or acknowledged as executed",
    async () => {
      const r = await admin(`/api/devices/${id}/commands`, "POST", {
        kind: "message",
        message: "Test recovery message",
      });
      const expired = await r.json();
      sql("UPDATE commands SET expires=1 WHERE id=?", [expired.id]);
      assert.equal(
        (await (await signed("/v1/commands", {})).json()).commands.length,
        0,
      );
      assert.equal(
        (
          await (
            await signed("/v1/ack", {
              id: expired.id,
              status: "executed",
              result: "too late",
            })
          ).json()
        ).accepted,
        false,
      );
      const data = await (await admin("/api/devices")).json();
      assert.equal(
        data.commands.find((c) => c.id === expired.id).status,
        "expired",
      );
    },
  );
  await t.test("capability withdrawal prevents new commands", async () => {
    assert.equal(
      (await signed("/v1/telemetry", { ...telemetry, capabilities: [] }))
        .status,
      200,
    );
    assert.equal(
      (await admin(`/api/devices/${id}/commands`, "POST", { kind: "ring" }))
        .status,
      400,
    );
  });
  await t.test(
    "revocation erases telemetry and removes tunnel access",
    async () => {
      assert.equal((await admin(`/api/devices/${id}`, "DELETE")).status, 200);
      assert.equal(
        (await readFile(join(dir, "wireguard/peers.conf"), "utf8")).trim(),
        "",
      );
      assert.equal((await signed("/v1/telemetry", telemetry)).status, 401);
      const data = await (await admin("/api/devices")).json();
      assert.equal(data.devices[0].telemetry, null);
      assert.equal(data.devices[0].revoked, true);
    },
  );
  await t.test(
    "audit trail excludes coordinates and enrollment secrets",
    async () => {
      const r = await admin("/api/audit");
      const text = await r.text();
      assert.ok(text.includes("device.enrolled"));
      assert.ok(!text.includes(bundle.token));
      assert.ok(!text.includes("-122.42"));
    },
  );
  await t.test("logout invalidates the administrator session", async () => {
    assert.equal((await admin("/api/session", "DELETE")).status, 204);
    assert.equal((await admin("/api/devices")).status, 401);
  });
});
