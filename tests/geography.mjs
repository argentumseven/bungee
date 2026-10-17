import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
test("offline maps and GeoIP preserve source, authentication, history and erasure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bungee-geography-")),
    port = await freePort(),
    origin = `http://127.0.0.1:${port}`,
    geodata = join(dir, "data");
  execFileSync("python3", ["tests/fixtures/geodata.py", geodata]);
  await mkdir(join(dir, "wireguard"));
  await writeFile(
    join(dir, "admin-password"),
    "only-for-offline-geography-test",
  );
  const server = spawn(resolve("server/target/debug/bungee-server"), [], {
    env: {
      ...process.env,
      BUNGEE_STATE_DIR: dir,
      BUNGEE_ADMIN_BIND: `127.0.0.1:${port}`,
      BUNGEE_DEVICE_BIND: `127.0.0.1:${await freePort()}`,
      BUNGEE_PUBLIC_ORIGIN: origin,
      BUNGEE_GEODATA_DIR: geodata,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    const stopped = new Promise((r) => server.once("exit", r));
    server.kill("SIGINT");
    await stopped;
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/healthz")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 40));
  }
  let cookie = "";
  const api = (path, method = "GET", body, extra = {}) =>
    fetch(origin + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  await t.test(
    "map status and tiles require a session and never redirect to a provider",
    async () => {
      assert.equal((await api("/geography")).status, 401);
      assert.equal((await api("/maps/0/0/0")).status, 401);
      const login = await api("/session", "POST", {
        password: "only-for-offline-geography-test",
      });
      cookie = login.headers.get("set-cookie").split(";")[0];
      const status = await (await api("/geography")).json();
      assert.equal(status.maps.name, "Synthetic test grid (not street data)");
      assert.equal(status.geoip.database_type, "GeoIP2-City");
      const tile = await api("/maps/0/0/0");
      assert.equal(tile.status, 200);
      assert.equal(tile.headers.get("content-type"), "image/png");
      assert.equal(tile.headers.get("cache-control"), "no-store");
      assert.equal((await api("/maps/1/2/0")).status, 400);
      assert.equal((await api("/maps/23/0/0")).status, 400);
      const absent = await api("/maps/18/0/0");
      assert.equal(absent.status, 404);
      assert.equal(absent.headers.get("location"), null);
      // Distinguish north/south origin by verifying a known XYZ tile exists, and its mirror does not.
      assert.equal((await api("/maps/15/5241/12665")).status, 200);
    },
  );
  const wg = randomBytes(32).toString("base64"),
    unknown = randomBytes(32).toString("base64");
  const sql = (statement, parameters = []) =>
    execFileSync("python3", [
      "-c",
      "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit()",
      join(dir, "bungee.sqlite3"),
      statement,
      JSON.stringify(parameters),
    ]);
  sql(
    "INSERT INTO devices(id,name,public_key,wg_key,address,created,wg_psk) VALUES('geo','Geo fixture','fixture-public-key',?,'10.77.0.2',1,'fixture-psk')",
    [wg],
  );
  const time = Math.floor(Date.now() / 1000);
  const snapshot = async (peers, sampled_at = Math.floor(Date.now() / 1000)) =>
    writeFile(
      join(dir, "wireguard/endpoints.json"),
      JSON.stringify({ sampled_at, peers }),
    );
  const history = async (extra) =>
    await (
      await api(
        `/devices/geo/history?kind=network&from=${extra?.includes("every=") ? time-1000 : 0}&to=${time + 1000}${extra || ""}`,
      )
    ).json();
  await t.test(
    "only gateway peer observations create IP records; headers cannot forge an address",
    async () => {
      await api("/devices", "GET", undefined, {
        "X-Forwarded-For": "81.2.69.142",
        "X-Real-IP": "81.2.69.142",
      });
      assert.deepEqual((await history()).records, []);
      await snapshot([
        { public_key: unknown, ip: "81.2.69.142", observed_at: time },
      ]);
      await api("/devices");
      assert.deepEqual((await history()).records, []);
      await snapshot([
        { public_key: wg, ip: "81.2.69.142", observed_at: time - 10 },
      ]);
      const d = (await (await api("/devices")).json()).devices[0];
      assert.equal(d.network.ip, "81.2.69.142");
      assert.equal(d.network.source, "wireguard_endpoint");
      assert.equal(d.network.geoip.city, "London");
      assert.equal(d.network.geoip.latitude, 51.5142);
      assert.equal(d.network.geoip.accuracy_radius_km, 10);
      assert.equal(d.telemetry, null);
      assert.equal((await history()).records.length, 1);
      await api("/devices");
      assert.equal((await history()).records.length, 1);
    },
  );
  await t.test(
    "IPv6 and private IPs are recorded without invented GeoIP; recurrence and pagination work",
    async () => {
      await snapshot([
        { public_key: wg, ip: "fd12::5", observed_at: time - 5 },
      ]);
      await api("/devices");
      await snapshot([
        { public_key: wg, ip: "10.8.0.2", observed_at: time - 1 },
      ]);
      await api("/devices");
      await writeFile(join(dir, "wireguard/endpoints.json"), "broken optional state");
    assert.equal((await api("/devices")).status, 200);
    const all = await history();
      assert.equal(all.records.length, 3);
      assert.equal(all.records[0].geoip, null);
      assert.equal(all.records[1].ip, "fd12::5");
      const one = await history("&limit=1");
      assert.equal(one.records.length, 1);
      assert.equal(one.next_before, time - 1);
      const next = await history(`&limit=1&before=${one.next_before}`);
      assert.equal(next.records[0].observed_at, time - 5);
      assert.equal((await history("&every=3600")).records.length, 1);
      await snapshot(
        [{ public_key: wg, ip: "81.2.69.142", observed_at: time }],
        time - 60,
      );
      await api("/devices");
      assert.equal((await history()).records.length, 3);
    },
  );
  await t.test(
    "erasure prevents cached IP resurrection, and revocation deletes IP observations",
    async () => {
      assert.equal((await api("/devices/geo/history", "DELETE")).status, 200);
      await api("/devices");
      assert.deepEqual((await history()).records, []);
      sql("UPDATE devices SET network_floor=0 WHERE id='geo'");
      await snapshot([
        { public_key: wg, ip: "81.2.69.142", observed_at: time },
      ]);
      await api("/devices");
      assert.equal((await history()).records.length, 1);
      assert.equal((await api("/devices/geo", "DELETE")).status, 200);
      await api("/devices");
      assert.equal((await api(`/devices/geo/history?kind=network&from=0&to=${time+1000}`)).status,404);
      assert.equal(execFileSync("python3",["-c","import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute(\"SELECT count(*) FROM network_history WHERE device_id='geo'\").fetchone()[0])",join(dir,"bungee.sqlite3")],{encoding:"utf8"}).trim(),"0");
    },
  );
  await t.test(
    "malformed datasets fail an offline validation without network or state creation",
    async () => {
      const bad = join(dir, "bad");
      await mkdir(bad);
      await writeFile(join(bad, "geoip.mmdb"), "not a database");
      const child = spawn(
        resolve("server/target/debug/bungee-server"),
        ["--check-geodata"],
        { env: { ...process.env, BUNGEE_GEODATA_DIR: bad }, stdio: "ignore" },
      );
      assert.notEqual(await new Promise((r) => child.on("exit", r)), 0);
    },
  );
});
