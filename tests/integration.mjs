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
import { request as httpRequest } from "node:http";
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
  const launch = () => {
    const instance = spawn(resolve("server/target/debug/bungee-server"), [], {
      env: {
        ...process.env,
        BUNGEE_STATE_DIR: dir,
        BUNGEE_ADMIN_BIND: `127.0.0.1:${port}`,
        BUNGEE_DEVICE_BIND: `127.0.0.1:${devicePort}`,
        BUNGEE_PUBLIC_ORIGIN: origin,
        BUNGEE_WG_ENDPOINT: "203.0.113.10:47937",
        BUNGEE_WEB_DIR: resolve("web/dist"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    instance.stdout.on("data", (b) => (logs += b));
    instance.stderr.on("data", (b) => (logs += b));
    return instance;
  };
  let logs = "";
  let server = launch();
  const stop = async () => {
    if (server.exitCode !== null) return;
    const done = new Promise((r) => server.once("exit", r));
    server.kill("SIGINT");
    await done;
  };
  const waitForServer = async () => {
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(origin + "/healthz")).ok) return;
      } catch {}
      if (server.exitCode !== null) throw Error(logs);
      await pause(50);
    }
    throw Error("Server did not become ready");
  };
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  await waitForServer();
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
    assert.equal(bundle.version, 2);
    assert.equal(bundle.wireguard.endpoint, "203.0.113.10:47937");
    assert.equal(
      Buffer.from(bundle.wireguard.preshared_key, "base64").length,
      32,
    );
    assert.ok(
      !(await (await admin("/api/devices")).text()).includes(
        bundle.wireguard.preshared_key,
      ),
    );
    assert.ok(
      !(await (await admin("/api/audit")).text()).includes(
        bundle.wireguard.preshared_key,
      ),
    );
    assert.match(
      await readFile(join(dir, "wireguard/peers.conf"), "utf8"),
      new RegExp(
        `PresharedKey = ${bundle.wireguard.preshared_key.replace(/[+]/g, "\\+")}`,
      ),
    );
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
    assert.notEqual(
      expired.wireguard.preshared_key,
      bundle.wireguard.preshared_key,
    );
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
  const cachedFix = {
    ...telemetry.location,
    observed_at: Math.floor(Date.now() / 1000) - 90 * 86400,
  };
  const history = (query = "", deviceId = id) =>
    admin(
      `/api/devices/${deviceId}/history?from=0&to=${Math.floor(Date.now() / 1000) + 120}${query}`,
    );
  await t.test(
    "history is private and validates bounded range queries",
    async () => {
      assert.equal(
        (
          await admin(
            `/api/devices/${id}/history?from=0&to=1`,
            "GET",
            undefined,
            { Cookie: "" },
          )
        ).status,
        401,
      );
      for (const q of [
        "from=2&to=1",
        "from=-1&to=1",
        "from=0&to=1&limit=1001",
        "from=0&to=1&limit=0",
        "from=0&to=1&kind=sql",
        "from=0&to=1&before=-1",
      ]) {
        assert.equal(
          (await admin(`/api/devices/${id}/history?${q}`)).status,
          400,
        );
      }
      assert.equal((await history("", randomUUID())).status, 404);
    },
  );
  await t.test(
    "a valid cached fix is accepted even after a long outage",
    async () => {
      assert.equal(
        (await signed("/v1/telemetry", { ...telemetry, location: cachedFix }))
          .status,
        200,
      );
      const data = await (await admin("/api/devices")).json();
      assert.deepEqual(data.devices[0].telemetry.location, cachedFix);
      const saved = await (await history()).json();
      assert.equal(saved.records.length, 1);
      assert.equal(saved.records[0].observed_at, cachedFix.observed_at);
    },
  );
  await t.test(
    "an offline location survives reads, cleanup, and a server restart",
    async () => {
      sql("UPDATE devices SET last_seen=? WHERE id=?", [
        cachedFix.observed_at,
        id,
      ]);
      let data = await (await admin("/api/devices")).json();
      assert.deepEqual(data.devices[0].telemetry.location, cachedFix);
      const replay = auth("/v1/commands", "{}");
      assert.equal((await device("/v1/commands", "{}", replay)).status, 200);
      await stop();
      server = launch();
      await waitForServer();
      assert.equal((await admin("/api/devices")).status, 401);
      const login = await admin("/api/session", "POST", { password });
      assert.equal(login.status, 200);
      cookie = login.headers.get("set-cookie").split(";")[0];
      data = await (await admin("/api/devices")).json();
      assert.equal(data.devices[0].last_seen, cachedFix.observed_at);
      assert.deepEqual(data.devices[0].telemetry.location, cachedFix);
      assert.equal((await device("/v1/commands", "{}", replay)).status, 409);
      assert.equal(
        (await (await history()).json()).records[0].observed_at,
        cachedFix.observed_at,
      );
    },
  );
  await t.test("accepted telemetry appears in the dashboard", async () => {
    assert.equal((await signed("/v1/telemetry", telemetry)).status, 200);
    const data = await (await admin("/api/devices")).json();
    assert.equal(data.devices[0].telemetry.battery, 76);
    assert.equal(data.devices[0].telemetry.location.latitude, 37.78);
    assert.equal(data.devices[0].enrolled, true);
  });
  await t.test(
    "a check-in without a GPS fix refreshes battery without erasing location",
    async () => {
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            battery: 64,
            location: null,
          })
        ).status,
        200,
      );
      const data = await (await admin("/api/devices")).json();
      assert.equal(data.devices[0].telemetry.battery, 64);
      assert.ok(data.devices[0].last_seen > cachedFix.observed_at);
      assert.deepEqual(data.devices[0].telemetry.location, telemetry.location);
    },
  );
  await t.test(
    "older and duplicate fixes cannot move the last-known location backward",
    async () => {
      for (const observed_at of [
        cachedFix.observed_at,
        telemetry.location.observed_at,
      ]) {
        assert.equal(
          (
            await signed("/v1/telemetry", {
              ...telemetry,
              location: { ...telemetry.location, latitude: 42, observed_at },
            })
          ).status,
          200,
        );
        const data = await (await admin("/api/devices")).json();
        assert.deepEqual(
          data.devices[0].telemetry.location,
          telemetry.location,
        );
      }
    },
  );
  await t.test("signed request replay is rejected", async () => {
    const body = "{}",
      h = auth("/v1/commands", body);
    assert.equal((await device("/v1/commands", body, h)).status, 200);
    assert.equal((await device("/v1/commands", body, h)).status, 409);
  });
  await t.test(
    "GPS history backfills, deduplicates and paginates by observation time",
    async () => {
      const base = telemetry.location.observed_at - 3600;
      const locations = [0, 20, 10].map((offset) => ({
        ...telemetry.location,
        latitude: 37.8 + offset / 1000,
        observed_at: base + offset,
      }));
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            location: null,
            locations,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            location: null,
            locations,
          })
        ).status,
        200,
      );
      const path = `/api/devices/${id}/history?from=${base}&to=${base + 20}&limit=2`;
      const first = await (await admin(path)).json();
      assert.deepEqual(
        first.records.map((p) => p.observed_at),
        [base + 20, base + 10],
      );
      assert.equal(first.next_before, base + 10);
      const second = await (
        await admin(path + `&before=${first.next_before}`)
      ).json();
      assert.deepEqual(
        second.records.map((p) => p.observed_at),
        [base],
      );
      assert.equal(second.next_before, null);
      assert.ok(first.records.every((p) => p.received_at > p.observed_at));
      assert.deepEqual(
        (await (await admin("/api/devices")).json()).devices[0].telemetry
          .location,
        telemetry.location,
      );
      const states = await (await history("&kind=state&limit=1")).json();
      assert.equal(states.records[0].battery, 76);
      assert.ok(states.next_before);
    },
  );
  await t.test(
    "an invalid queued fix rejects the whole batch and oversized batches are refused",
    async () => {
      const before = (await (await history()).json()).records.length;
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            locations: [
              telemetry.location,
              { ...telemetry.location, longitude: 181 },
            ],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            locations: Array(101).fill(telemetry.location),
          })
        ).status,
        400,
      );
      assert.equal((await (await history()).json()).records.length, before);
    },
  );
  await t.test(
    "recurrence queries sample full saved history and retain pagination boundaries",
    async () => {
      const base = telemetry.location.observed_at - 3600;
      const path = `/api/devices/${id}/history?from=${base}&to=${base + 1200}&every=300&limit=1`;
      let data = await (await admin(path)).json();
      assert.ok(Array.isArray(data.records), JSON.stringify(data));
      assert.equal(data.records.length, 1);
      assert.equal(data.records[0].observed_at, base + 20);
      const day = new Date(base * 1000).toISOString().slice(0, 10);
      const time = new Date(base * 1000).toISOString().slice(11, 16);
      data = await (
        await admin(
          `/api/devices/${id}/history?from=${Date.parse(day + "T00:00:00Z") / 1000}&to=${Date.parse(day + "T23:59:59Z") / 1000}&daily=${time}&timezone=UTC&tolerance=120`,
        )
      ).json();
      assert.equal(data.records.length, 1);
      const full = await (await history()).json();
      assert.ok(full.records.length > data.records.length);
      for (const extra of [
        "every=0",
        "every=86401",
        "daily=24:99&timezone=UTC",
        "daily=09:00&timezone=Bad/Zone",
        "daily=09:00&timezone=UTC&every=300",
        "daily=09:00&timezone=UTC&tolerance=7201",
      ]) {
        assert.equal(
          (
            await admin(
              `/api/devices/${id}/history?from=${base}&to=${base + 1200}&${extra}`,
            )
          ).status,
          400,
        );
      }
    },
  );
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
    "DDIL pairing confirmation requires the already-bound key and never reopens the invitation",
    async () => {
      assert.equal((await device("/v1/enroll", pair())).status, 401);
      const confirmation = await signed("/v1/sync", { report: {} });
      assert.equal(confirmation.status, 200);
      const state = await confirmation.json();
      assert.equal(typeof state.revision, "number");
      assert.ok(state.policy);
      assert.equal((await device("/v1/sync", { report: {} })).status, 401);
      assert.equal((await device("/v1/enroll", pair())).status, 401);
    },
  );
  await t.test(
    "DDIL redelivery and late receipt reconcile an earlier attempt without extending execution expiry",
    async () => {
      const queued = await (
        await admin(`/api/devices/${id}/commands`, "POST", { kind: "ring" })
      ).json();
      const beforeContact = (
        await (await admin("/api/devices")).json()
      ).devices.find((d) => d.id === id).last_seen;
      const first = await (await signed("/v1/commands", {})).json();
      const contact = (await (await admin("/api/devices")).json()).devices.find(
        (d) => d.id === id,
      );
      assert.ok(contact.last_contact >= Math.floor(Date.now() / 1000) - 2);
      assert.equal(contact.last_seen, beforeContact);
      const repeated = await (await signed("/v1/commands", {})).json();
      assert.equal(first.commands[0].id, queued.id);
      assert.equal(repeated.commands[0].id, queued.id);
      const time = Math.floor(Date.now() / 1000);
      sql("UPDATE commands SET created=?,expires=? WHERE id=?", [
        time - 100,
        time - 1,
        queued.id,
      ]);
      assert.equal(
        (await (await signed("/v1/commands", {})).json()).commands.length,
        0,
      );
      const uncertain = (
        await (await admin("/api/devices")).json()
      ).commands.find((c) => c.id === queued.id);
      assert.equal(uncertain.status, "expired");
      assert.equal(uncertain.delivery_uncertain, true);
      const late = await (
        await signed("/v1/ack", {
          id: queued.id,
          status: "executed",
          result: "Sound started before loss",
          attempted_at: time - 10,
        })
      ).json();
      assert.equal(late.accepted, true);
      assert.equal(late.settled, true);
      assert.equal(late.receipt_status, "recorded");
      const confirmed = (
        await (await admin("/api/devices")).json()
      ).commands.find((c) => c.id === queued.id);
      assert.equal(confirmed.status, "executed");
      assert.equal(confirmed.delivery_uncertain, false);
      assert.ok(confirmed.receipt_received_at > confirmed.expires);
      assert.equal(
        (
          await (
            await signed("/v1/ack", {
              id: queued.id,
              status: "failed",
              result: "duplicate",
              attempted_at: time - 10,
            })
          ).json()
        ).accepted,
        false,
      );
    },
  );
  await t.test(
    "DDIL cannot acknowledge an undelivered or post-expiry attempt",
    async () => {
      const queued = await (
        await admin(`/api/devices/${id}/commands`, "POST", { kind: "ring" })
      ).json();
      const time = Math.floor(Date.now() / 1000);
      assert.equal(
        (
          await (
            await signed("/v1/ack", {
              id: queued.id,
              status: "executed",
              result: "not delivered",
              attempted_at: time,
            })
          ).json()
        ).accepted,
        false,
      );
      await signed("/v1/commands", {});
      sql("UPDATE commands SET created=?,expires=? WHERE id=?", [
        time - 100,
        time - 1,
        queued.id,
      ]);
      assert.equal(
        (
          await (
            await signed("/v1/ack", {
              id: queued.id,
              status: "executed",
              result: "post deadline",
              attempted_at: time,
            })
          ).json()
        ).accepted,
        false,
      );
      assert.equal(
        (
          await signed("/v1/ack", {
            id: queued.id,
            status: "executed",
            result: "future claim",
            attempted_at: time + 1000,
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "DDIL queue reports are optional, bounded and explicitly dated",
    async () => {
      const report = {
        delivery: {
          reported_at: Math.floor(Date.now() / 1000),
          queued_fixes: 120,
          dropped_fixes: 3,
          oldest_queued_at: 1000,
          pending_receipts: 2,
          gps_access: "needs_foreground_start",
        },
      };
      assert.equal((await signed("/v1/sync", { report })).status, 200);
      const saved = await (await admin(`/api/devices/${id}/policy`)).json();
      assert.equal(saved.report.delivery.queued_fixes, 120);
      assert.equal(saved.report.delivery.gps_access, "needs_foreground_start");
      for (const value of [
        { queued_fixes: 10081 },
        { pending_receipts: 101 },
        { dropped_fixes: 9007199254740992 },
        { reported_at: 0 },
        { gps_access: "unrestricted" },
      ])
        assert.equal(
          (
            await signed("/v1/sync", {
              report: { delivery: { ...report.delivery, ...value } },
            })
          ).status,
          400,
        );
    },
  );
  await t.test("receipt replay after restoring pre-poll state stays unresolved until the server records a matching outcome", async () => {
    const queued = await (await admin(`/api/devices/${id}/commands`, "POST", {kind:"ring"})).json();
    await signed("/v1/commands", {});
    const receipt = {id:queued.id,status:"executed",result:"Sound started",attempted_at:Math.floor(Date.now()/1000)};
    // Simulate restoring the command row from a snapshot taken before the poll.
    sql("UPDATE commands SET status='pending' WHERE id=?", [queued.id]);
    const unresolved = await (await signed("/v1/ack", receipt)).json();
    assert.equal(unresolved.receipt_status, "not_offered"); assert.equal(unresolved.settled,false);
    await signed("/v1/commands", {});
    const recorded = await (await signed("/v1/ack", receipt)).json();
    assert.equal(recorded.receipt_status,"recorded"); assert.equal(recorded.accepted,true);
    const repeated = await (await signed("/v1/ack", receipt)).json();
    assert.equal(repeated.receipt_status,"already_terminal"); assert.equal(repeated.settled,true);
    const conflict = await (await signed("/v1/ack", {...receipt,status:"failed",result:"Conflicting old state"})).json();
    assert.equal(conflict.receipt_status,"conflicting_terminal"); assert.equal(conflict.settled,false);
    sql("DELETE FROM commands WHERE id=?", [queued.id]);
    const missing = await (await signed("/v1/ack", receipt)).json();
    assert.equal(missing.receipt_status,"unknown_command"); assert.equal(missing.settled,false);
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
  await t.test(
    "reboot is refused even for a legacy capable phone, and old queued reboots cannot be delivered",
    async () => {
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            capabilities: [...telemetry.capabilities, "reboot"],
          })
        ).status,
        200,
      );
      for (const supplied of [undefined, "wrong", password]) {
        const response = await admin(`/api/devices/${id}/commands`, "POST", {
          kind: "reboot",
          password: supplied,
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /reversibility/);
      }
      const commandId = randomUUID(),
        time = Math.floor(Date.now() / 1000);
      sql(
        "INSERT INTO commands(id,device_id,kind,payload,created,expires,status) VALUES(?,?,?,?,?,?,?)",
        [commandId, id, "reboot", "{}", time, time + 300, "pending"],
      );
      const polled = await (await signed("/v1/commands", {})).json();
      assert.ok(!polled.commands.some((c) => c.id === commandId));
      const saved = await (await admin("/api/devices")).json();
      assert.equal(
        saved.commands.find((c) => c.id === commandId).status,
        "rejected",
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
    "erasing a saved location requires administrator authentication and same-origin intent",
    async () => {
      assert.equal(
        (
          await admin(`/api/devices/${id}/location`, "DELETE", undefined, {
            Cookie: "",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await admin(`/api/devices/${id}/location`, "DELETE", undefined, {
            Origin: "https://evil.example",
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "an owner can erase the saved fix without unpairing or erasing battery state",
    async () => {
      assert.equal(
        (await admin(`/api/devices/${id}/location`, "DELETE")).status,
        200,
      );
      const data = await (await admin("/api/devices")).json();
      assert.equal(data.devices[0].telemetry.location, null);
      assert.equal(data.devices[0].telemetry.battery, telemetry.battery);
      assert.equal(data.devices[0].enrolled, true);
      assert.equal(data.devices[0].revoked, false);
      assert.deepEqual((await (await history()).json()).records, []);
    },
  );
  await t.test(
    "a cached old fix cannot restore an explicitly erased location",
    async () => {
      assert.equal((await signed("/v1/telemetry", telemetry)).status, 200);
      const data = await (await admin("/api/devices")).json();
      assert.equal(data.devices[0].telemetry.location, null);
      assert.deepEqual((await (await history()).json()).records, []);
    },
  );
  await t.test(
    "a genuinely newer fix can be saved after explicit erasure",
    async () => {
      await pause(1100);
      const newer = {
        ...telemetry.location,
        latitude: 37.79,
        observed_at: Math.floor(Date.now() / 1000),
      };
      assert.equal(
        (await signed("/v1/telemetry", { ...telemetry, location: newer }))
          .status,
        200,
      );
      const data = await (await admin("/api/devices")).json();
      assert.deepEqual(data.devices[0].telemetry.location, newer);
    },
  );
  await t.test(
    "full history erasure requires authorization and preserves the pairing",
    async () => {
      const path = `/api/devices/${id}/history`;
      assert.equal(
        (await admin(path, "DELETE", undefined, { Cookie: "" })).status,
        401,
      );
      assert.equal(
        (
          await admin(path, "DELETE", undefined, {
            Origin: "https://evil.example",
          })
        ).status,
        403,
      );
      assert.equal((await admin(path, "DELETE")).status, 200);
      assert.deepEqual((await (await history()).json()).records, []);
      assert.deepEqual(
        (await (await history("&kind=state")).json()).records,
        [],
      );
      assert.equal(
        (await (await admin("/api/devices")).json()).devices[0].enrolled,
        true,
      );
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            location: null,
            locations: [cachedFix, telemetry.location],
          })
        ).status,
        200,
      );
      assert.deepEqual((await (await history()).json()).records, []);
      await pause(1100);
      assert.equal(
        (
          await signed("/v1/telemetry", {
            ...telemetry,
            location: {
              ...telemetry.location,
              observed_at: Math.floor(Date.now() / 1000),
            },
          })
        ).status,
        200,
      );
      assert.equal((await (await history()).json()).records.length, 1);
    },
  );
  await t.test("4096 fabricated device IDs cannot exhaust administrator or another peer's budgets", async () => {
    const flood = (n) => new Promise((resolve, reject) => {
      const req = httpRequest(`${deviceOrigin}/v1/commands`, {
        method: "POST", localAddress: "127.0.0.2", agent: false,
        headers: {"Content-Type":"application/json", "X-Bungee-Device": `fabricated-${n}`, "X-Bungee-Time": `${Math.floor(Date.now()/1000)}`, "X-Bungee-Nonce": randomBytes(18).toString("base64url"), "X-Bungee-Signature":"AA==", "X-Bungee-Admin-IP":"127.0.0.1", "X-Forwarded-For":"127.0.0.1"},
      }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end("{}");
    });
    for (let base=0; base<4096; base+=32) {
      const statuses = await Promise.all(Array.from({length:32}, (_,i) => flood(base+i)));
      assert.ok(statuses.every(status => status === 401 || status === 429));
    }
    assert.equal((await signed("/v1/commands", {})).status, 200);
    assert.equal((await signed("/v1/telemetry", telemetry)).status, 200);
    assert.equal((await admin("/api/devices")).status, 200);
    assert.equal((await admin("/api/session", "POST", {password})).status, 200);
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
      assert.deepEqual((await (await history()).json()).records, []);
      assert.deepEqual(
        (await (await history("&kind=state")).json()).records,
        [],
      );
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
      assert.ok(!text.includes(bundle.wireguard.preshared_key));
      assert.ok(
        !(await (await admin("/api/devices")).text()).includes(
          bundle.wireguard.preshared_key,
        ),
      );
      assert.ok(!logs.includes(bundle.wireguard.preshared_key));
    },
  );
  await t.test("logout invalidates the administrator session", async () => {
    assert.equal((await admin("/api/session", "DELETE")).status, 204);
    assert.equal((await admin("/api/devices")).status, 401);
  });
});
