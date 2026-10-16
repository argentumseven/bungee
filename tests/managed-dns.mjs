import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  sign,
  createHash,
} from "node:crypto";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function question(name, type = 1, id = 123) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const parts = name
    .split(".")
    .flatMap((s) => [Buffer.from([s.length]), Buffer.from(s)]);
  return Buffer.concat([
    header,
    ...parts,
    Buffer.from([0, type >> 8, type & 255, 0, 1]),
  ]);
}
function qname(data) {
  let pos = 12,
    parts = [];
  while (data[pos]) {
    const len = data[pos++];
    parts.push(data.subarray(pos, pos + len).toString());
    pos += len;
  }
  return parts.join(".");
}
function response(data, tcp) {
  const name = qname(data),
    header = Buffer.from(data.subarray(0, 12));
  header.writeUInt16BE(
    name.startsWith("missing")
      ? 0x8183
      : name.startsWith("truncated") && !tcp
        ? 0x8380
        : 0x8180,
    2,
  );
  if (name.startsWith("wrong"))
    header.writeUInt16BE((header.readUInt16BE(0) + 1) % 65536, 0);
  return Buffer.concat([header, data.subarray(12)]);
}

test("managed DNS: authenticated policy, UDP/TCP forwarding, summaries and revocation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bungee-dns-"));
  const adminPort = await port(),
    devicePort = await port(),
    dnsPort = await port(),
    upstreamPort = await port();
  const origin = `http://127.0.0.1:${adminPort}`,
    deviceOrigin = `http://127.0.0.1:${devicePort}`;
  const password = randomBytes(24).toString("base64url");
  await writeFile(join(dir, "admin-password"), password, { mode: 0o600 });
  const seen = [],
    held = [];
  const udp = dgram.createSocket("udp4");
  udp.on("message", (data, peer) => {
    seen.push({ name: qname(data), tcp: false });
    if (qname(data).startsWith("held")) {
      held.push({ data, peer });
      return;
    }
    udp.send(response(data, false), peer.port, peer.address);
  });
  await new Promise((r) => udp.bind(upstreamPort, "127.0.0.1", r));
  const tcp = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 2 || buffer.length < buffer.readUInt16BE(0) + 2)
        return;
      const q = buffer.subarray(2, 2 + buffer.readUInt16BE(0));
      seen.push({ name: qname(q), tcp: true });
      const answer = response(q, true),
        size = Buffer.alloc(2);
      size.writeUInt16BE(answer.length);
      socket.end(Buffer.concat([size, answer]));
    });
  });
  await new Promise((r) => tcp.listen(upstreamPort, "127.0.0.1", r));
  let logs = "",
    server;
  const launch = () => {
    server = spawn(resolve("server/target/debug/bungee-server"), [], {
      env: {
        ...process.env,
        BUNGEE_STATE_DIR: dir,
        BUNGEE_ADMIN_BIND: `127.0.0.1:${adminPort}`,
        BUNGEE_DEVICE_BIND: `127.0.0.1:${devicePort}`,
        BUNGEE_PUBLIC_ORIGIN: origin,
        BUNGEE_WG_ENDPOINT: "203.0.113.10:47937",
        BUNGEE_WEB_DIR: resolve("web/dist"),
        BUNGEE_DNS_UPSTREAM_IP: "127.0.0.1",
        BUNGEE_DNS_UPSTREAM_PORT: String(upstreamPort),
        BUNGEE_DNS_BIND: `127.0.0.1:${dnsPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (b) => (logs += b));
    server.stderr.on("data", (b) => (logs += b));
  };
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const done = new Promise((r) => server.once("exit", r));
    server.kill("SIGINT");
    await done;
  };
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/healthz")).ok) return;
      } catch {}
      if (server.exitCode !== null) throw Error(logs);
      await pause(50);
    }
    throw Error("startup timeout");
  };
  t.after(async () => {
    await stop();
    udp.close();
    await new Promise((r) => tcp.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  launch();
  await ready();
  let cookie = "";
  const admin = (path, method = "GET", body, headers = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async () => {
    const r = await admin("/api/session", "POST", { password });
    assert.equal(r.status, 200);
    cookie = r.headers.get("set-cookie").split(";")[0];
  };
  await login();
  const sql = (query, args = []) =>
    execFileSync("python3", [
      "-c",
      "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit()",
      join(dir, "bungee.sqlite3"),
      query,
      JSON.stringify(args),
    ]);
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" }),
    publicKey = keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
  const id = randomUUID(),
    other = randomUUID();
  for (const [device, address] of [
    [id, "127.0.0.2"],
    [other, "127.0.0.3"],
  ])
    sql(
      "INSERT INTO devices(id,name,wg_key,address,created,public_key,wg_psk) VALUES(?,?,?,?,?,?,?)",
      [
        device,
        "DNS test phone",
        randomBytes(32).toString("base64"),
        address,
        Math.floor(Date.now() / 1000),
        publicKey,
        randomBytes(32).toString("base64"),
      ],
    );
  const report = {
    owner: true,
    consent: true,
    recovery_consent: true,
    revision: 0,
    dns_active: false,
    always_on: false,
    secure_lock: true,
    screen_locked: false,
    unlock_monitoring: true,
    android_version: "16",
    security_patch: "2026-10-01",
  };
  const signed = (device, body) => {
    const path = "/v1/sync",
      text = JSON.stringify(body),
      time = String(Math.floor(Date.now() / 1000)),
      nonce = randomUUID();
    const signature = sign(
      "sha256",
      Buffer.from(
        `BUNGEE-V1\nPOST\n${path}\n${time}\n${nonce}\n${createHash("sha256").update(text).digest("hex")}`,
      ),
      keys.privateKey,
    ).toString("base64");
    return fetch(deviceOrigin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bungee-Device": device,
        "X-Bungee-Time": time,
        "X-Bungee-Nonce": nonce,
        "X-Bungee-Signature": signature,
      },
      body: text,
    });
  };
  const policyPath = `/api/devices/${id}/policy`,
    dnsPath = `/api/devices/${id}/dns?from=${Math.floor(Date.now() / 1000) - 86400}&to=${Math.floor(Date.now() / 1000) + 120}`;
  const policy = {
    managed_dns: true,
    always_on: true,
    lost_mode: true,
    recovery_message: "Call the household",
    blocked_apps: ["org.mozilla.firefox"],
  };
  function query(name, type = 1, source = "127.0.0.2", packet) {
    return new Promise((resolveQuery, reject) => {
      const socket = dgram.createSocket("udp4");
      let timer;
      const done = (value) => {
        clearTimeout(timer);
        socket.close();
        resolveQuery(value);
      };
      socket.once("error", reject);
      socket.once("message", (data) => done(data));
      socket.bind(0, source, () => {
        timer = setTimeout(() => done(null), 350);
        socket.send(packet || question(name, type), dnsPort, "127.0.0.1");
      });
    });
  }
  async function tcpQuery(name) {
    return new Promise((resolveQuery, reject) => {
      const s = net.connect(
        { host: "127.0.0.1", port: dnsPort, localAddress: "127.0.0.2" },
        () => {
          const q = question(name),
            size = Buffer.alloc(2);
          size.writeUInt16BE(q.length);
          s.write(Buffer.concat([size, q]));
        },
      );
      let data = Buffer.alloc(0);
      s.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.length >= 2 && data.length >= data.readUInt16BE(0) + 2) {
          s.destroy();
          resolveQuery(data.subarray(2));
        }
      });
      s.on("error", reject);
      s.setTimeout(2000, () => {
        s.destroy();
        reject(Error("TCP DNS timeout"));
      });
    });
  }
  await t.test(
    "policy and summary endpoints require administration and same-origin intent",
    async () => {
      assert.equal(
        (await admin(policyPath, "GET", undefined, { Cookie: "" })).status,
        401,
      );
      assert.equal(
        (await admin(dnsPath, "GET", undefined, { Cookie: "" })).status,
        401,
      );
      assert.equal(
        (
          await admin(
            policyPath,
            "POST",
            { expected_revision: 0, policy },
            { Origin: "https://evil.example" },
          )
        ).status,
        403,
      );
      assert.equal(
        (await admin(policyPath, "POST", { expected_revision: 0, policy }))
          .status,
        400,
      );
    },
  );
  await t.test(
    "persistent controls are refused regardless of owner consent; old policy is projected to reversible recovery",
    async () => {
      assert.equal((await signed(id, { report })).status, 200);
      for (const field of [
        "managed_dns",
        "always_on",
        "auto_resume",
        "protect_settings",
        "prevent_uninstall",
        "require_strong_lock",
      ]) {
        const unsafe = {
          [field]: true,
          ...(field === "managed_dns" ? { always_on: true } : {}),
        };
        const response = await admin(policyPath, "POST", {
          expected_revision: 0,
          policy: unsafe,
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /reversibility/);
      }
      assert.equal(
        (
          await admin(policyPath, "POST", {
            expected_revision: 0,
            policy: { blocked_apps: ["org.mozilla.firefox"] },
          })
        ).status,
        400,
      );
      const saved = await admin(policyPath, "POST", {
        expected_revision: 0,
        policy: { lost_mode: true, recovery_message: "Call the household" },
      });
      assert.equal(saved.status, 200);
      assert.equal(
        (await admin(policyPath, "POST", { expected_revision: 0, policy: {} }))
          .status,
        409,
      );
      // Explicit legacy fixture, not an enrollment path: keep testing old resolver isolation/erasure.
      execFileSync("python3", [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE device_policies SET policy=? WHERE device_id=?',(sys.argv[3],sys.argv[2])); c.commit()",
        join(dir, "bungee.sqlite3"),
        id,
        JSON.stringify(policy),
      ]);
      const desired = await (await signed(id, { report })).json();
      assert.equal(desired.policy.managed_dns, false);
      assert.equal(desired.policy.always_on, false);
      assert.deepEqual(desired.policy.blocked_apps, []);
      assert.equal(desired.policy.lost_mode, true);
      const shown = await (await admin(policyPath)).json();
      assert.equal(shown.legacy_policy_present, true);
      assert.equal(shown.persistent_controls_enabled, false);
    },
  );
  await t.test(
    "DNS stays closed until the matching phone applies and reports its policy",
    async () => {
      assert.equal(await query("not-ready.example.com"), null);
      assert.equal(
        (
          await signed(id, {
            report: {
              ...report,
              revision: 1,
              dns_active: true,
              always_on: true,
            },
          })
        ).status,
        200,
      );
      assert.equal(await query("unknown.example.com", 1, "127.0.0.9"), null);
      assert.equal(await query("other.example.com", 1, "127.0.0.3"), null);
    },
  );
  await t.test(
    "UDP answers retain the client ID and combine bundled questions / random subdomains",
    async () => {
      const replies = await Promise.all([
        query("random-a.metrics.example.com", 1),
        query("random-b.metrics.example.com", 28),
        query("random-c.metrics.example.com", 65),
      ]);
      for (const reply of replies) {
        assert.ok(reply);
        assert.equal(reply.readUInt16BE(0), 123);
        assert.equal(reply[3] & 15, 0);
      }
      const data = await (await admin(dnsPath)).json();
      assert.equal(data.records.length, 1);
      assert.equal(data.records[0].domain, "example.com");
      assert.equal(data.queries, 3);
      assert.ok(data.activities < 3);
      assert.deepEqual(data.records[0].types, {
        A: 1,
        AAAA: 1,
        HTTPS: 1,
        other: 0,
      });
      assert.ok(!JSON.stringify(data).includes("random-a"));
      const otherDns = await (await admin(dnsPath.replace(id, other))).json();
      assert.equal(otherDns.queries, 0);
    },
  );
  await t.test(
    "TCP DNS, UDP truncation fallback and invalid upstream IDs are handled",
    async () => {
      assert.equal((await tcpQuery("tcp.example.net")).readUInt16BE(0), 123);
      assert.ok(await query("truncated.example.net"));
      assert.ok(seen.some((q) => q.name === "truncated.example.net" && q.tcp));
      assert.equal((await query("wrong.example.net"))[3] & 15, 2);
      assert.equal((await query("missing.example.net"))[3] & 15, 3);
    },
  );
  await t.test(
    "transfer / ANY / multiple-question requests are not forwarded",
    async () => {
      const before = seen.length;
      for (const type of [252, 251, 255])
        assert.equal((await query("deny.example.com", type))[3] & 15, 5);
      const packet = question("multi.example.com");
      packet.writeUInt16BE(2, 4);
      assert.equal(await query("", 1, "127.0.0.2", packet), null); // malformed count is rejected by the DNS parser
      assert.equal(seen.length, before);
    },
  );
  await t.test(
    "known OS checks collapse without retaining their random identifiers",
    async () => {
      await query("nonce123-dnsotls-ds.dnscheck.grapheneos.org");
      await query("nonce456-dnsotls-ds.dnscheck.grapheneos.org", 28);
      const data = await (await admin(dnsPath)).json();
      assert.ok(
        data.records.some(
          (r) => r.domain === "[system DNS checks]" && r.queries === 2,
        ),
      );
      assert.ok(!JSON.stringify(data).includes("nonce"));
    },
  );
  await t.test(
    "persistent lost-mode intent and DNS summaries survive a server restart",
    async () => {
      const before = await (await admin(dnsPath)).json();
      await stop();
      launch();
      await ready();
      await login();
      const desired = await (
        await signed(id, {
          report: { ...report, revision: 1, dns_active: true, always_on: true },
        })
      ).json();
      assert.equal(desired.policy.lost_mode, true);
      assert.equal(desired.policy.recovery_message, "Call the household");
      assert.equal(
        (await (await admin(dnsPath)).json()).queries,
        before.queries,
      );
      assert.ok(await query("after-restart.example.com"));
    },
  );
  await t.test("local consent withdrawal stops DNS immediately", async () => {
    assert.equal(
      (
        await signed(id, {
          report: {
            ...report,
            revision: 1,
            consent: false,
            dns_active: true,
            always_on: true,
          },
        })
      ).status,
      200,
    );
    assert.equal(await query("withdrawn.example.com"), null);
    await signed(id, {
      report: { ...report, revision: 1, dns_active: true, always_on: true },
    });
  });
  await t.test(
    "DNS summaries can be erased without affecting location or enrollment",
    async () => {
      assert.equal(
        (
          await admin(`/api/devices/${id}/dns`, "DELETE", undefined, {
            Cookie: "",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await admin(`/api/devices/${id}/dns`, "DELETE", undefined, {
            Origin: "https://evil.example",
          })
        ).status,
        403,
      );
      assert.equal(
        (await admin(`/api/devices/${id}/dns`, "DELETE")).status,
        200,
      );
      assert.equal((await (await admin(dnsPath)).json()).queries, 0);
      assert.equal((await (await admin(policyPath)).json()).report.owner, true);
    },
  );
  await t.test(
    "revocation blocks an in-flight DNS answer and erases policy and summaries",
    async () => {
      const pending = query("held.example.com");
      for (let i = 0; i < 20 && !held.length; i++) await pause(10);
      assert.ok(held.length);
      assert.equal((await admin(`/api/devices/${id}`, "DELETE")).status, 200);
      for (const item of held)
        udp.send(response(item.data, false), item.peer.port, item.peer.address);
      assert.equal(await pending, null);
      assert.equal((await (await admin(dnsPath)).json()).queries, 0);
      assert.equal((await admin(policyPath)).status, 404);
      assert.ok(!logs.includes("random-a.metrics"));
      assert.ok(!logs.includes("nonce123"));
    },
  );
});
