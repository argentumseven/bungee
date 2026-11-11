import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./support/server.mjs";
import { phone } from "./support/phone.mjs";
const event = (reason, at = Math.floor(Date.now() / 1000)) => ({ id: randomUUID(), reason, at, recorded_at: Math.floor(Date.now() / 1000) });
const negotiate = async p => (await (await p.request("/v1/sync", { report: {} })).json()).sharing_epoch;
const send = (p, sharing_epoch, sharing_events, extra = {}, options) => p.request("/v1/sync", { report: { sharing_epoch, sharing_events, ...extra } }, options);

test("sharing history distinguishes manual, crash, error, system and unknown events with exact retries", async t => {
  const f = await fixture(t), p = await phone(f), epoch = await negotiate(p), path = `/api/devices/${p.id}/sharing-history`;
  assert.match(epoch, /^[a-f0-9]{64}$/);
  const events = [event("user_start"), event("notification_stop"), event("crash"), event("anr"), event("low_memory"), event("unexpected_exit", null)];
  const missingEpoch = await send(p, undefined, events); assert.deepEqual((await missingEpoch.json()).accepted_sharing_events, []);
  for (let i = 0; i < 2; i++) { const r = await send(p, epoch, events); assert.equal(r.status, 200); assert.deepEqual((await r.json()).accepted_sharing_events, events.map(e => e.id)); }
  const rows = (await (await f.admin(path)).json()).events;
  assert.equal(rows.length, events.length);
  assert.deepEqual(Object.fromEntries(rows.map(e => [e.reason, e.category])), { user_start: "manual", notification_stop: "manual", crash: "crash", anr: "error", low_memory: "system", unexpected_exit: "unknown" });
  assert.equal(rows.find(e => e.reason === "unexpected_exit").at, null);
  const report = (await (await f.admin(`/api/devices/${p.id}/policy`)).json()).report;
  assert.equal(JSON.stringify(report).includes(events[0].id), false, "event payloads must have one canonical history store");
  assert.equal((await fetch(f.origin + path)).status, 401);
  assert.equal((await f.admin(path + "?before=-1")).status, 400);
  assert.equal((await send(p, epoch, [{ ...events[2], reason: "user_stop" }])).status, 409);
  assert.equal((await send(p, epoch, [{ ...event("crash"), category: "manual" }])).status, 400);
  assert.equal((await send(p, epoch, [event("user_stop", null)])).status, 400);
  assert.equal((await send(p, epoch, [event("invented")])).status, 400);
  assert.equal((await send(p, epoch, Array.from({ length: 21 }, () => event("user_start")))).status, 400);
  await f.stop(); await f.launch(); assert.equal(await negotiate(p), epoch);
  assert.equal((await (await f.admin(path)).json()).events.length, events.length);
});

test("offline sharing events are paginated, profile-scoped, ordered and fenced against erasure", async t => {
  const f = await fixture(t), main = await phone(f, { profiles: true }), sandbox = await phone(f, { primaryDeviceId: main.id, name: "Sandbox" }), other = await phone(f);
  const epoch = await negotiate(sandbox), path = `/api/devices/${main.id}/sharing-history`;
  const records = Array.from({ length: 43 }, (_, i) => event(i % 2 ? "user_stop" : "automatic_start", Math.floor(Date.now() / 1000) - 86400 + i));
  for (let i = 0; i < records.length; i += 20) assert.equal((await send(sandbox, epoch, records.slice(i, i + 20), { sharing_events_dropped: 2 })).status, 200);
  const first = await (await f.admin(path)).json(); assert.equal(first.events.length, 20); assert.ok(first.next_before); assert.equal(first.dropped, 2);
  assert.ok(first.events.every(e => e.profile_name === "Sandbox" && e.device_id === sandbox.id && e.at < e.received_at));
  const second = await (await f.admin(path + `?before=${first.next_before}`)).json();
  const third = await (await f.admin(path + `?before=${second.next_before}`)).json();
  assert.equal(new Set([...first.events, ...second.events, ...third.events].map(e => e.id)).size, 43);
  assert.deepEqual((await (await f.admin(`/api/devices/${other.id}/sharing-history`)).json()).events, []);
  assert.equal((await f.admin(`/api/devices/${main.id}/location`, "DELETE")).status, 200);
  assert.equal((await (await f.admin(path)).json()).events.length, 20, "GPS-only erasure preserves the sharing timeline");
  assert.equal((await f.admin(`/api/devices/${main.id}/history`, "DELETE")).status, 200);
  assert.deepEqual((await (await f.admin(path)).json()).events, []);
  const stale = await send(sandbox, epoch, records.slice(0, 1)); assert.deepEqual((await stale.json()).accepted_sharing_events, []);
  const newEpoch = await negotiate(sandbox); assert.notEqual(newEpoch, epoch);
  assert.equal((await send(sandbox, newEpoch, [event("user_start")])).status, 200);
  assert.equal((await f.admin(`/api/devices/${main.id}`, "DELETE")).status, 200);
  assert.deepEqual((await (await f.admin(path)).json()).events, []);
});

test("stale runtime reports cannot insert new sharing events", async t => {
  const f = await fixture(t), p = await phone(f, { runtime: true }), epoch = await negotiate(p);
  const one = event("user_start"), late = event("crash");
  assert.equal((await send(p, epoch, [one], { runtime_sequence: 2 }, { raw: true })).status, 200);
  const stale = await send(p, epoch, [late], { runtime_sequence: 1 }, { raw: true });
  const result = await stale.json(); assert.equal(result.report_accepted, false); assert.deepEqual(result.accepted_sharing_events, []);
  const rows = (await (await f.admin(`/api/devices/${p.id}/sharing-history`)).json()).events; assert.deepEqual(rows.map(e => e.id), [one.id]);
});

test("disconnect keeps sharing history and deleting its archive removes it", async t => {
  const f = await fixture(t), p = await phone(f), epoch = await negotiate(p), path = `/api/devices/${p.id}/sharing-history`;
  assert.equal((await send(p, epoch, [event("local_recovery")])).status, 200);
  assert.equal((await f.admin(`/api/devices/${p.id}/disconnect`, "POST", {})).status, 200);
  assert.equal((await (await f.admin(path)).json()).events.length, 1);
  assert.equal((await f.admin(`/api/devices/${p.id}/archive`, "DELETE")).status, 200);
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events")[0][0], 0);
});
