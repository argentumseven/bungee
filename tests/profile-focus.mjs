import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/server.mjs";
import { phone } from "./support/phone.mjs";

// How the server decides which Android profile is active, scenario by scenario. The phone supplies a claim
// (foreground_user plus the time its profile last became foreground); the server never guesses between two.
const caps = ["locate", "message", "clear_message", "stop_all", "take_picture"];
async function household(t) {
  const f = await fixture(t), main = await phone(f, { profiles: true, name: "Owner phone", capabilities: caps });
  const sandbox = await phone(f, { primaryDeviceId: main.id, name: "Sandbox", capabilities: ["message", "clear_message", "stop_all"] });
  const work = await phone(f, { primaryDeviceId: main.id, name: "Work", capabilities: ["message", "clear_message", "stop_all"] });
  const sync = async (p, report, expected = 200) => {
    const response = await p.request("/v1/sync", { report: { recovery_consent: true, ...report } });
    assert.equal(response.status, expected, `sync ${JSON.stringify(report)}`);
    return response;
  };
  const focus = async () => (await (await f.admin("/api/devices")).json()).devices[0].focus;
  return { f, main, sandbox, work, sync, focus };
}
const T = Date.now() - 600_000; // a phone-clock millisecond ten minutes ago

test("without focus timestamps (older apps) one foreground claim is active, two are a switch, none is unknown", async t => {
  const { main, sandbox, sync, focus } = await household(t);
  assert.deepEqual(await focus(), { state: "unknown" });
  assert.equal((await sync(main, { foreground_user: true })).status, 200);
  assert.equal((await sync(sandbox, { foreground_user: false })).status, 200);
  assert.deepEqual(await focus(), { state: "active", id: main.id, since_ms: null });
  assert.equal((await sync(sandbox, { foreground_user: true })).status, 200);
  assert.deepEqual(await focus(), { state: "switching" }, "two unqualified claims are never resolved by guessing");
  assert.equal((await sync(main, { foreground_user: false })).status, 200);
  assert.equal((await sync(sandbox, { foreground_user: false })).status, 200);
  assert.deepEqual(await focus(), { state: "unknown" });
});

test("with focus timestamps the newest transition wins and an older positive report cannot come back", async t => {
  const { main, sandbox, work, sync, focus } = await household(t);
  await sync(main, { foreground_user: true, foreground_since_ms: T, app_version_code: 40 });
  assert.deepEqual(await focus(), { state: "active", id: main.id, since_ms: T });
  // The user switches to Sandbox. Main never managed to report that it left, so its positive claim is stale.
  await sync(sandbox, { foreground_user: true, foreground_since_ms: T + 5000, app_version_code: 40 });
  assert.deepEqual(await focus(), { state: "active", id: sandbox.id, since_ms: T + 5000 });
  // Work becomes active, then leaves. Sandbox and Main still hold older positive reports.
  await sync(work, { foreground_user: true, foreground_since_ms: T + 9000, app_version_code: 40 });
  await sync(work, { foreground_user: false, app_version_code: 40 });
  assert.deepEqual(await focus(), { state: "unknown" }, "the newest transition's owner left; nothing older is promoted");
});

test("an identical timestamp from two profiles is a switch in progress, and a stale report is unknown", async t => {
  const { f, main, sandbox, sync, focus } = await household(t);
  await sync(main, { foreground_user: true, foreground_since_ms: T, app_version_code: 40 });
  await sync(sandbox, { foreground_user: true, foreground_since_ms: T, app_version_code: 40 });
  assert.deepEqual(await focus(), { state: "switching" });
  await sync(sandbox, { foreground_user: true, foreground_since_ms: T + 1, app_version_code: 40 });
  assert.equal((await focus()).id, sandbox.id);
  f.sql("UPDATE devices SET management_report_at=management_report_at-200 WHERE id=?", [sandbox.id]);
  assert.deepEqual(await focus(), { state: "unknown" }, "a claim older than 90 seconds is not trusted");
});

test("a background report without a timestamp keeps the last claim in the database", async t => {
  const { f, sandbox, sync } = await household(t);
  await sync(sandbox, { foreground_user: true, foreground_since_ms: T, app_version_code: 40 });
  await sync(sandbox, { foreground_user: false, app_version_code: 40 });
  const report = JSON.parse(f.sql("SELECT management_report FROM devices WHERE id=?", [sandbox.id])[0][0]);
  assert.equal(report.foreground_user, false);
  assert.equal(report.foreground_since_ms, T);
});

test("impossible focus claims are rejected", async t => {
  const { main, sync } = await household(t);
  await sync(main, { foreground_since_ms: T, app_version_code: 40 }, 400);
  await sync(main, { foreground_user: true, foreground_since_ms: 0, app_version_code: 40 }, 400);
  await sync(main, { foreground_user: true, foreground_since_ms: (Math.floor(Date.now() / 1000) + 3600) * 1000, app_version_code: 40 }, 400);
  await sync(main, { foreground_user: true, foreground_since_ms: T, app_version_code: 0 }, 400);
});

test("commands aimed at the active profile refuse to guess and carry a foreground requirement when they can", async t => {
  const { f, main, sandbox, work, sync } = await household(t);
  const send = profile => f.admin(`/api/devices/${main.id}/commands`, "POST", { kind: "message", message: "Please call the household.", profile });
  assert.equal((await send("active")).status, 409, "no profile has reported foreground");
  await sync(sandbox, { foreground_user: true, foreground_since_ms: T, app_version_code: 40 });
  const sent = await send("active");
  assert.equal(sent.status, 200);
  const offered = (await (await sandbox.request("/v1/commands", {})).json()).commands;
  assert.equal(offered.length, 1);
  assert.equal(offered[0].payload.require_foreground, true, "the phone rechecks that this profile is still foreground before acting");
  assert.deepEqual((await (await work.request("/v1/commands", {})).json()).commands, []);
  await sync(work, { foreground_user: true, foreground_since_ms: T, app_version_code: 40 });
  assert.equal((await send("active")).status, 409, "two profiles claiming the same moment is a switch in progress");
  // An explicit choice never depends on focus.
  assert.equal((await send(work.id)).status, 200);
  assert.equal((await send("not-a-profile")).status, 404);
});
