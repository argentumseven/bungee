import test from "node:test";
import assert from "node:assert/strict";
import { contextLine, auditTitle, activityQuery, purgeQuery, lateDelivery, formatBytes, phoneKinds, LOCATION_REQUEST_MESSAGE } from "../web/src/activityText.ts";

test("circumstances read as plain language and never invent a cause", () => {
  assert.equal(contextLine({ source: "live", locked: true, interactive: false, airplane: true, sharing: true, network: "none" }), "Phone was locked · screen off · airplane mode on · Bungee sharing was running · no network");
  assert.match(contextLine({ source: "reconciled", since: 5 }), /^Found changed after Bungee was not running; exact time unknown/);
  assert.equal(contextLine({ location_services: false, gps_provider: false }), "Location services off");
  assert.equal(contextLine({ gps_provider: false, location_services: true }), "GPS provider off");
  assert.equal(contextLine({ failures: 6, minutes: 12 }), "6 attempts in a row without a fix · 12 min without a fix");
  assert.equal(contextLine({ suppressed: 4 }), "4 more rapid changes not listed");
  assert.equal(contextLine(null), ""); assert.equal(contextLine(undefined), ""); assert.equal(contextLine({}), "");
  // Nothing in the wording claims to know who acted.
  for (const detail of [{ airplane: true, locked: true }, { location_services: false, interactive: true }]) assert.doesNotMatch(contextLine(detail), /user|owner|someone|thief|person/i);
});

test("every phone event kind and audit action the server sends has a readable title", () => {
  for (const kind of ["started", "stopped", "gps_enabled", "gps_disabled", "error", "locate_started", "locate_finished", "airplane_on", "airplane_off", "location_off", "location_on", "permission_lost", "permission_restored", "gps_gap", "gps_gap_ended"]) assert.ok(phoneKinds[kind], kind);
  assert.equal(auditTitle("activity.purged"), "Activity log purged");
  assert.equal(auditTitle("something.new_action"), "something · new action");
});

test("queries are built from known values only and purge parameters are omitted when not chosen", () => {
  assert.equal(activityQuery({ device: "", group: "all" }, null), "?limit=50&group=all");
  assert.equal(activityQuery({ device: "a b", group: "device_state" }, "10.1.5", 20), "?limit=20&group=device_state&device=a+b&before=10.1.5");
  assert.equal(purgeQuery({}), ""); assert.equal(purgeQuery({ scope: "all" }), "");
  assert.equal(purgeQuery({ device: "p", days: 30, scope: "phone" }), "?device=p&older_than_days=30&scope=phone");
  assert.equal(purgeQuery({ days: 0 }), "");
});

test("backfilled events are labelled, live ones are not", () => {
  assert.equal(lateDelivery(1000, 1010, 1100), false);
  assert.equal(lateDelivery(1000, 1010, 1000 + 3600), true);
  assert.equal(lateDelivery(null, 2000, 2001), false, "an undated event is judged from when it was detected");
  assert.equal(lateDelivery(null, 2000, 2000 + 4000), true);
});

test("sizes and the location request are suitable for display", () => {
  assert.equal(formatBytes(512), "512 B"); assert.equal(formatBytes(2048), "2 KB"); assert.equal(formatBytes(5 * 1048576), "5.0 MB"); assert.equal(formatBytes(3 * 1073741824), "3.0 GB");
  assert.ok(LOCATION_REQUEST_MESSAGE.length <= 240 && LOCATION_REQUEST_MESSAGE.trim().length > 0, "fits the server's recovery-message limit");
  assert.doesNotMatch(LOCATION_REQUEST_MESSAGE, /[\u0000-\u0009\u000b-\u001f]/);
});
