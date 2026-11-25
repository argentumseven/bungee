import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, pause } from "./support/server.mjs";
import { phone } from "./support/phone.mjs";

const now = () => Math.floor(Date.now() / 1000);
const event = (reason, at = now(), detail) => ({ id: randomUUID(), reason, at, recorded_at: now(), ...(detail ? { detail } : {}) });
const negotiate = async p => (await (await p.request("/v1/sync", { report: {} })).json()).sharing_epoch;
const send = (p, sharing_epoch, sharing_events, extra = {}) => p.request("/v1/sync", { report: { sharing_epoch, sharing_events, ...extra } });
const feed = async (f, query = "") => (await f.admin(`/api/activity${query}`)).json();
const fix = (at, extra = {}) => ({ latitude: 38.9 + (at % 100) / 100000, longitude: -77.03, accuracy: 8, observed_at: at, ...extra });
const upload = (p, locations, gps_epoch = p.epoch) => p.request("/v1/telemetry", { battery: 80, charging: false, capabilities: ["locate"], device_owner: false, gps_epoch, location: null, locations });
// Unauthenticated but same-origin, so the request reaches authentication instead of the browser guard.
const anonymous = (f, path, method, body) => fetch(f.origin + path, { method, headers: { Origin: f.origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const gpsCount = (f, p) => f.sql("SELECT COUNT(*) FROM location_history WHERE device_id=?", [p.id])[0][0];

test("device-state events keep their circumstances and are validated strictly", async t => {
  const f = await fixture(t), p = await phone(f), epoch = await negotiate(p);
  const airplane = event("airplane_mode_on", now() - 60, { source: "live", airplane: true, location_services: true, locked: true, interactive: false, sharing: true, network: "none", fine_location: true, background_location: false });
  const services = event("location_services_off", now() - 30, { source: "live", airplane: true, location_services: false, gps_provider: false, locked: true });
  const unseen = { id: randomUUID(), reason: "location_services_on", at: null, recorded_at: now(), detail: { source: "reconciled", since: now() - 3600, location_services: true } };
  const response = await send(p, epoch, [airplane, services, unseen]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accepted_sharing_events, [airplane.id, services.id, unseen.id]);
  const rows = (await feed(f, "?group=device_state")).events;
  assert.equal(rows.length, 3);
  const byReason = Object.fromEntries(rows.map(e => [e.reason, e]));
  assert.equal(byReason.airplane_mode_on.kind, "airplane_on");
  assert.equal(byReason.airplane_mode_on.detail.locked, true);
  assert.equal(byReason.airplane_mode_on.detail.network, "none");
  assert.equal(byReason.location_services_off.detail.gps_provider, false);
  assert.equal(byReason.location_services_on.at, null, "a change found after the app was not running has no invented time");
  assert.equal(byReason.location_services_on.detail.source, "reconciled");
  // Exact retry is idempotent; a changed body for the same ID is a conflict.
  assert.equal((await send(p, epoch, [airplane])).status, 200);
  assert.equal((await feed(f, "?group=device_state")).events.length, 3);
  assert.equal((await send(p, epoch, [{ ...airplane, detail: { ...airplane.detail, locked: false } }])).status, 409);
  // Nothing outside the fixed vocabulary is accepted: no coordinates, SSIDs or free text.
  for (const detail of [{ ssid: "Home" }, { latitude: 1 }, { network: "ssid:Home" }, { source: "guess" }, { minutes: 6_000_000 }, { suppressed: -1 }, { since: 0 }]) {
    assert.equal((await send(p, epoch, [event("airplane_mode_off", now(), detail)])).status, 400, JSON.stringify(detail));
  }
  assert.equal((await send(p, epoch, [event("user_start", now(), { airplane: true })])).status, 400, "detail belongs only to device-state events");
  assert.equal((await send(p, epoch, [{ id: randomUUID(), reason: "airplane_mode_on", at: null, recorded_at: now() }])).status, 400, "a missing time needs the reconciled marker");
  assert.equal((await send(p, epoch, [{ id: randomUUID(), reason: "user_stop", at: null, recorded_at: now(), detail: { source: "reconciled" } }])).status, 400);
});

test("the activity feed pages through everything, newest first, without duplicates or a fixed 100-entry limit", async t => {
  const f = await fixture(t), p = await phone(f, { name: "Alpha" }), other = await phone(f, { name: "Beta" });
  const epoch = await negotiate(p), base = now() - 5000;
  const records = Array.from({ length: 140 }, (_, i) => event(i % 2 ? "airplane_mode_on" : "airplane_mode_off", base + i));
  for (let i = 0; i < records.length; i += 20) assert.equal((await send(p, epoch, records.slice(i, i + 20))).status, 200);
  // Audit entries in the same time range, including equal timestamps.
  f.sql("INSERT INTO audit(at,action,device_id,detail) VALUES(?,?,?,?)", [base + 10, "test.one", p.id, "first"]);
  for (let i = 0; i < 70; i++) f.sql("INSERT INTO audit(at,action,device_id,detail) VALUES(?,?,?,?)", [base + 20, "test.tie", i % 2 ? p.id : other.id, `tie ${i}`]);
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const page = await feed(f, `?limit=37${cursor ? `&before=${cursor}` : ""}`);
    assert.ok(page.events.length <= 37);
    seen.push(...page.events);
    cursor = page.next_before; pages++;
    assert.ok(pages < 20, "pagination must terminate");
  } while (cursor);
  assert.equal(new Set(seen.map(e => `${e.source}:${e.id}`)).size, seen.length, "no duplicates across pages");
  assert.ok(seen.length >= 140 + 71, `expected the whole log, saw ${seen.length}`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].ts >= seen[i].ts, "newest first");
  assert.equal(seen.filter(e => e.source === "phone").length, 140);
  // Filters.
  assert.ok((await feed(f, "?group=admin&limit=100")).events.every(e => e.source === "server"));
  assert.ok((await feed(f, "?group=phone&limit=100")).events.every(e => e.source === "phone"));
  assert.equal((await feed(f, `?group=device_state&limit=100&device=${other.id}`)).events.length, 0);
  const alpha = await feed(f, `?limit=100&device=${p.id}`);
  assert.ok(alpha.events.every(e => e.device_id === p.id));
  assert.equal((await feed(f, "?group=sharing&limit=100")).events.length, 0, "airplane events are device-state, not sharing start/stop");
  // Bad requests.
  for (const query of ["?limit=0", "?limit=101", "?before=garbage", "?before=1.9.1", "?group=everything", "?device=" + "x".repeat(65)]) assert.equal((await f.admin(`/api/activity${query}`)).status, 400, query);
  assert.equal((await f.admin("/api/activity?device=nope")).status, 404);
  assert.equal((await fetch(f.origin + "/api/activity")).status, 401);
  // The legacy latest-100 endpoint keeps its shape.
  assert.ok(Array.isArray((await (await f.admin("/api/audit")).json()).events));
});

test("purging activity removes what was asked, records the purge and fences old queued events", async t => {
  const f = await fixture(t), p = await phone(f), q = await phone(f, { name: "Second" });
  const epoch = await negotiate(p), otherEpoch = await negotiate(q);
  const old = event("airplane_mode_on", now() - 40 * 86400), recent = event("airplane_mode_off", now() - 3600);
  assert.equal((await send(p, epoch, [old, recent])).status, 200);
  assert.equal((await send(q, otherEpoch, [event("location_services_off")])).status, 200);
  f.sql("INSERT INTO audit(at,action,device_id,detail) VALUES(?,?,?,?)", [now() - 60 * 86400, "ancient.entry", null, "old"]);

  for (const query of ["?older_than_days=0", "?older_than_days=-1", "?older_than_days=3651", "?scope=nothing", "?device=nope"]) {
    assert.notEqual((await f.admin(`/api/activity${query}`, "DELETE")).status, 200, query);
  }
  assert.equal((await anonymous(f, "/api/activity", "DELETE")).status, 401);

  // Age purge: only older rows go and an old event arriving late is acknowledged but not stored.
  const aged = await (await f.admin("/api/activity?older_than_days=30", "DELETE")).json();
  assert.equal(aged.phone_removed, 1);
  assert.ok(aged.server_removed >= 1);
  const afterAge = (await feed(f, "?limit=100")).events;
  assert.ok(afterAge.some(e => e.id === recent.id) && !afterAge.some(e => e.id === old.id) && !afterAge.some(e => e.action === "ancient.entry"));
  assert.ok(afterAge.some(e => e.action === "activity.purged"), "a purge is itself recorded");
  const late = await send(p, epoch, [event("gps_no_fix", now() - 45 * 86400)]);
  assert.equal((await late.json()).accepted_sharing_events.length, 1);
  assert.equal((await feed(f, `?group=device_state&device=${p.id}`)).events.length, 1, "events older than the purge stay gone");
  assert.equal((await send(p, epoch, [event("gps_no_fix", now() - 120)])).status, 200);
  assert.equal((await feed(f, `?group=device_state&device=${p.id}`)).events.length, 2);

  // Scoped, per-phone purge leaves the other phone's activity alone.
  assert.equal((await f.admin(`/api/activity?device=${p.id}&scope=phone`, "DELETE")).status, 200);
  assert.equal((await feed(f, `?group=device_state&device=${p.id}`)).events.length, 0);
  assert.equal((await feed(f, `?group=device_state&device=${q.id}`)).events.length, 1);
  const rotated = await negotiate(p);
  assert.notEqual(rotated, epoch, "a full purge rotates the generation so queued events cannot restore it");
  assert.deepEqual((await (await send(p, epoch, [old])).json()).accepted_sharing_events, []);
  assert.equal((await send(p, rotated, [event("airplane_mode_off")])).status, 200);

  // Purging everything keeps only the record of the purge.
  assert.equal((await f.admin("/api/activity", "DELETE")).status, 200);
  const remaining = (await feed(f, "?limit=100")).events;
  assert.deepEqual(remaining.map(e => e.action), ["activity.purged"]);
  assert.match(remaining[0].detail, /Activity purged \(all, all\)/);
});

test("GPS purge by age keeps the newest point and the phone's offline backlog; a full purge rotates the generation", async t => {
  const f = await fixture(t), p = await phone(f);
  const day = 86400, base = now();
  const points = [base - 200 * day, base - 120 * day, base - 31 * day, base - 29 * day, base - 600].map(at => fix(at));
  assert.equal((await upload(p, points)).status, 200);
  assert.equal(gpsCount(f, p), 5);
  const before = (await (await p.request("/v1/commands", {})).json()).gps_epoch;
  assert.equal((await f.admin(`/api/devices/${p.id}/location?older_than_days=0`, "DELETE")).status, 400);
  assert.equal((await f.admin(`/api/devices/nope/location?older_than_days=30`, "DELETE")).status, 404);
  const result = await (await f.admin(`/api/devices/${p.id}/location?older_than_days=30`, "DELETE")).json();
  assert.equal(result.removed, 3);
  assert.equal(gpsCount(f, p), 2);
  assert.equal((await (await p.request("/v1/commands", {})).json()).gps_epoch, before, "an age purge does not discard the phone's queued fixes");
  // A purge older than the newest point's age still keeps that newest point.
  assert.equal((await f.admin(`/api/devices/${p.id}/location?older_than_days=1`, "DELETE")).status, 200);
  assert.deepEqual(f.sql("SELECT observed_at FROM location_history WHERE device_id=?", [p.id]).map(r => r[0]), [base - 600]);
  assert.ok(JSON.parse(f.sql("SELECT last_location FROM devices WHERE id=?", [p.id])[0][0]).observed_at, "last-known cache stays intact");
  // Backfilled points from an outage still arrive afterwards (the generation is unchanged).
  assert.equal((await upload(p, [fix(base - 3 * 3600), fix(base - 3 * 3600 + 60)])).status, 200);
  assert.equal(gpsCount(f, p), 3);
  // Full purge: the previous behaviour, with a new generation.
  assert.equal((await f.admin(`/api/devices/${p.id}/location`, "DELETE")).status, 200);
  assert.equal(gpsCount(f, p), 0);
  assert.notEqual((await (await p.request("/v1/commands", {})).json()).gps_epoch, before);
  const audit = (await feed(f, "?group=admin&limit=100")).events.map(e => e.action);
  assert.ok(audit.includes("location.purged") && audit.includes("location.erased"));
  assert.doesNotMatch(JSON.stringify(await feed(f, "?limit=100")), /-77\.03/, "coordinates never enter the audit trail");
});

test("retention settings are validated, reported with usage, and applied by maintenance without deleting the newest GPS point", async t => {
  const f = await fixture(t), p = await phone(f);
  const base = now(), day = 86400;
  assert.equal((await upload(p, [200, 100, 20].map(d => fix(base - d * day)))).status, 200);
  f.sql("INSERT INTO audit(at,action,device_id,detail) VALUES(?,?,?,?)", [base - 400 * day, "ancient.audit", null, ""]);
  const initial = await (await f.admin("/api/retention")).json();
  assert.equal(initial.gps_days, 0); assert.equal(initial.activity_days, 0);
  assert.equal(initial.usage.gps_points, 3);
  assert.ok(initial.usage.database_bytes > 0);
  assert.deepEqual(initial.limits, { audit: 20000, events_per_phone: 10000, history_per_phone: 2000000 });
  for (const body of [{ gps_days: 17, activity_days: 0 }, { gps_days: 0 }, { gps_days: 0, activity_days: 0, extra: 1 }, { gps_days: -1, activity_days: 0 }]) {
    assert.equal((await f.admin("/api/retention", "PUT", body)).status === 200, false, JSON.stringify(body));
  }
  assert.equal((await anonymous(f, "/api/retention", "PUT", { gps_days: 0, activity_days: 0 })).status, 401);
  assert.equal((await anonymous(f, `/api/devices/${p.id}/location?older_than_days=30`, "DELETE")).status, 401);
  assert.equal((await f.admin("/api/retention", "PUT", { gps_days: 30, activity_days: 90 })).status, 200);
  assert.equal(gpsCount(f, p), 3, "saving a setting does not delete anything by itself");
  await f.stop(); await f.launch();
  for (let i = 0; i < 80 && gpsCount(f, p) !== 1; i++) await pause(50);
  assert.deepEqual(f.sql("SELECT observed_at FROM location_history WHERE device_id=?", [p.id]).map(r => r[0]), [base - 20 * day]);
  assert.equal(f.sql("SELECT COUNT(*) FROM audit WHERE action='ancient.audit'")[0][0], 0);
  assert.ok(f.sql("SELECT COUNT(*) FROM audit WHERE action='retention.updated'")[0][0] >= 1);
  // Even a very short age leaves the newest point (now 20 days old) in place.
  assert.equal((await f.admin("/api/retention", "PUT", { gps_days: 7, activity_days: 7 })).status, 200);
  await f.stop(); await f.launch(); await pause(400);
  assert.equal(gpsCount(f, p), 1);
  assert.equal((await f.admin("/api/retention", "PUT", { gps_days: 0, activity_days: 0 })).status, 200);
});

test("the log tables trim themselves to bounded sizes without touching other phones or the newest rows", async t => {
  const f = await fixture(t), p = await phone(f), q = await phone(f);
  const base = now();
  f.sql(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<10049)
    INSERT INTO sharing_events(device_id,event_id,reason,at,recorded_at,received_at)
    SELECT ?1,lower(hex(randomblob(16))),'airplane_mode_on',?2+i,?2+i,?3 FROM n`, [p.id, base - 20_000, base]);
  f.sql("INSERT INTO sharing_events(device_id,event_id,reason,at,recorded_at,received_at) VALUES(?,?,?,?,?,?)", [q.id, randomUUID(), "airplane_mode_on", base, base, base]);
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events WHERE device_id=?", [p.id])[0][0], 10_050);
  await f.stop(); await f.launch();
  for (let i = 0; i < 100 && f.sql("SELECT COUNT(*) FROM sharing_events WHERE device_id=?", [p.id])[0][0] > 10_000; i++) await pause(50);
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events WHERE device_id=?", [p.id])[0][0], 10_000);
  assert.equal(f.sql("SELECT MIN(at) FROM sharing_events WHERE device_id=?", [p.id])[0][0], base - 20_000 + 50, "the oldest rows are the ones removed");
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events WHERE device_id=?", [q.id])[0][0], 1);
});

test("delivery reports carry location-services state, and unknown access labels are still rejected", async t => {
  const f = await fixture(t), p = await phone(f);
  const delivery = extra => ({ reported_at: now(), queued_fixes: 3, dropped_fixes: 0, pending_receipts: 0, oldest_queued_at: now() - 600, gps_access: "location_services_off", location_services: false, airplane_mode: true, last_fix_at: now() - 900, fix_failures: 4, ...extra });
  const sync = d => p.request("/v1/sync", { report: { recovery_consent: true, delivery: d } });
  assert.equal((await sync(delivery())).status, 200);
  const saved = (await (await f.admin(`/api/devices/${p.id}/policy`)).json()).report.delivery;
  assert.equal(saved.gps_access, "location_services_off");
  assert.equal(saved.location_services, false); assert.equal(saved.airplane_mode, true); assert.equal(saved.fix_failures, 4);
  assert.equal((await sync(delivery({ gps_access: "unrestricted" }))).status, 400);
  assert.equal((await sync(delivery({ last_fix_at: now() + 100_000 }))).status, 400);
  assert.equal((await sync(delivery({ fix_failures: 2_000_000 }))).status, 400);
  assert.equal((await sync(delivery({ coordinates: [1, 2] }))).status, 400);
});

test("a quick series of catch-up batches records one check-in, not one per batch", async t => {
  const f = await fixture(t), p = await phone(f), base = now();
  const checkins = () => f.sql("SELECT COUNT(*) FROM state_history WHERE device_id=?", [p.id])[0][0];
  const send = (locations, battery = 80) => p.request("/v1/telemetry", { battery, charging: false, capabilities: ["locate"], device_owner: false, gps_epoch: p.epoch, location: null, locations });
  for (let batch = 0; batch < 5; batch++) assert.equal((await send([fix(base - 600 + batch * 60), fix(base - 590 + batch * 60)])).status, 200);
  assert.equal(gpsCount(f, p), 10, "every GPS point still arrives");
  assert.equal(checkins(), 1, "identical back-to-back catch-up readings collapse into one check-in");
  assert.equal((await send([], 80)).status, 200);
  assert.equal(checkins(), 2, "an ordinary check-in is never suppressed");
  assert.equal((await send([fix(base - 5)], 79)).status, 200);
  assert.equal(checkins(), 3, "a changed reading is recorded even during catch-up");
  const state = JSON.parse(f.sql("SELECT telemetry FROM devices WHERE id=?", [p.id])[0][0]);
  assert.equal(state.battery, 79, "the device's latest state is always updated");
});
