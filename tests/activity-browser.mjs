import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import { fixture } from "./support/server.mjs";
import { phone } from "./support/phone.mjs";

const now = () => Math.floor(Date.now() / 1000);
const launch = () => chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const event = (reason, at, detail) => ({ id: randomUUID(), reason, at, recorded_at: now(), ...(detail ? { detail } : {}) });

test("the Activity page browses every entry, explains airplane and location events, and purges on request", async t => {
  const f = await fixture(t), p = await phone(f, { name: "Avery’s Pixel", capabilities: ["locate", "message", "clear_message"] });
  const epoch = (await (await p.request("/v1/sync", { report: {} })).json()).sharing_epoch;
  const base = now();
  // More administrator entries than the old fixed list could show.
  f.sql(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<129)
    INSERT INTO audit(at,action,device_id,detail) SELECT ?1-i*60,'command.queued',?2,'ring' FROM n`, [base - 7200, p.id]);
  const events = [
    event("airplane_mode_on", base - 1800, { source: "live", airplane: true, location_services: true, locked: true, interactive: false, sharing: true, network: "none", fine_location: true, background_location: true }),
    event("location_services_off", base - 1700, { source: "live", airplane: true, location_services: false, locked: true, interactive: false, sharing: true }),
    event("airplane_mode_off", base - 600, { source: "live", airplane: false, location_services: false, locked: false, interactive: true, sharing: true }),
    { id: randomUUID(), reason: "location_services_on", at: null, recorded_at: base, detail: { source: "reconciled", since: base - 4000, location_services: true } },
    event("gps_no_fix", base - 300, { source: "live", failures: 6, minutes: 12, airplane: false, location_services: true }),
    event("airplane_mode_on", base - 3 * 86400, { source: "live", airplane: true }), // delivered long after it happened
    event("user_start", base - 100 * 86400), // old enough for the age purge below
  ];
  assert.equal((await p.request("/v1/sync", { report: { sharing_epoch: epoch, sharing_events: events } })).status, 200);
  const day = 86400;
  assert.equal((await p.request("/v1/telemetry", { battery: 70, charging: false, device_owner: false, capabilities: ["locate", "message", "clear_message"], gps_epoch: p.epoch, location: null,
    locations: [200, 100, 45, 3].map(d => ({ latitude: 38.9, longitude: -77.03, accuracy: 9, observed_at: base - d * day })) })).status, 200);

  const browser = await launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }), [name, value] = f.cookie.split("=");
  await context.addCookies([{ name, value, url: f.origin }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(f.origin);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const feed = page.getByRole("region", { name: "Household activity" });
  await feed.getByText("Airplane mode turned on").first().waitFor();

  // Circumstances, not guesses, and an honest label for time-unknown and backfilled entries.
  await feed.getByText("Phone was locked · screen off · airplane mode on · Bungee sharing was running · no network", { exact: true }).waitFor();
  await feed.getByText(/Found changed after Bungee was not running; exact time unknown/).waitFor();
  await feed.getByText(/Time unknown · detected/).waitFor();
  await feed.getByText("Reported after reconnecting").first().waitFor();
  await feed.getByText("6 attempts in a row without a fix · 12 min without a fix", { exact: true }).waitFor();
  assert.equal(await feed.getByText(/\b(thief|owner|someone)\b/i).count(), 0);

  // Everything is reachable, not just the latest hundred.
  assert.equal(await feed.locator(".activity-list > li").count(), 50);
  for (let i = 0; i < 12 && await feed.getByRole("button", { name: "Load older activity" }).count(); i++) {
    const shown = await feed.locator(".activity-list > li").count();
    await feed.getByRole("button", { name: "Load older activity" }).click();
    await page.waitForFunction(count => document.querySelectorAll(".activity-list > li").length > count, shown);
  }
  assert.ok(await feed.locator(".activity-list > li").count() >= 130 + events.length, "all stored entries are reachable");
  await feed.getByText(/ALL LOADED/).waitFor();
  const ids = await feed.locator(".activity-list > li").evaluateAll(rows => rows.map(r => r.textContent));
  assert.ok(ids.length > 100);

  // Filtering.
  await feed.getByLabel("Show").selectOption("device_state");
  await page.waitForFunction(() => document.querySelectorAll(".activity-list > li").length === 6);
  assert.equal(await feed.locator(".activity-list > li").count(), 6);
  await feed.getByLabel("Show").selectOption("all");
  await page.waitForFunction(() => document.querySelectorAll(".activity-list > li").length === 50);

  // Mobile layout.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1050 });

  // Purging activity older than 90 days removes only the old event; the purge itself is recorded.
  const care = page.getByRole("region", { name: "Log storage and cleanup" });
  await care.getByText("Database on disk").waitFor();
  await care.getByLabel("Activity age to purge").selectOption("90");
  await care.getByLabel("Activity kinds to purge").selectOption("phone");
  await care.getByRole("button", { name: "Purge activity…" }).click();
  await care.getByRole("button", { name: "Cancel" }).click(); // nothing happens until confirmed
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events WHERE reason='user_start'")[0][0], 1);
  await care.getByRole("button", { name: "Purge activity…" }).click();
  await care.getByRole("button", { name: "Confirm purge" }).click();
  await care.getByText("Activity purged: 0 administrator entries and 1 phone events removed.", { exact: true }).waitFor();
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events WHERE reason='user_start'")[0][0], 0);
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events")[0][0], events.length - 1);
  assert.ok(f.sql("SELECT COUNT(*) FROM audit WHERE action='activity.purged'")[0][0] >= 1);

  // Purging saved GPS by age keeps the newest point and does not reset the phone's generation.
  const before = (await (await p.request("/v1/commands", {})).json()).gps_epoch;
  await care.getByLabel("GPS age to purge").selectOption("30");
  await care.getByRole("button", { name: "Purge GPS…" }).click();
  await care.getByRole("button", { name: "Confirm purge" }).click();
  await care.getByText("3 saved GPS points removed. The newest point was kept.", { exact: true }).waitFor();
  assert.deepEqual(f.sql("SELECT observed_at FROM location_history ORDER BY observed_at").map(r => r[0]), [base - 3 * day]);
  assert.equal((await (await p.request("/v1/commands", {})).json()).gps_epoch, before);

  // Automatic cleanup is saved and reported back.
  await care.getByLabel("Automatic GPS cleanup age").selectOption("365");
  await care.getByRole("button", { name: "Save automatic cleanup" }).click();
  await care.getByText("Automatic cleanup saved. It runs every few minutes.", { exact: true }).waitFor();
  assert.equal((await (await f.admin("/api/retention")).json()).gps_days, 365);
  assert.deepEqual(errors, []);
});

test("device care offers a one-tap route back to Location only when Android location services are off", async t => {
  const f = await fixture(t), p = await phone(f, { name: "Avery’s Pixel", capabilities: ["locate", "message", "clear_message"] });
  const at = now();
  const delivery = extra => ({ reported_at: at, queued_fixes: 12, dropped_fixes: 0, pending_receipts: 0, oldest_queued_at: at - 900, gps_access: "background", location_services: true, airplane_mode: false, last_fix_at: at - 60, fix_failures: 0, ...extra });
  const report = d => p.request("/v1/sync", { report: { recovery_consent: true, delivery: d } });
  assert.equal((await report(delivery())).status, 200);
  const browser = await launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }), [name, value] = f.cookie.split("=");
  await context.addCookies([{ name, value, url: f.origin }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(f.origin);
  await page.getByRole("button", { name: "Device care", exact: true }).click();
  await page.getByText("Android location services", { exact: true }).waitFor();
  assert.equal(await page.getByText("Android location services were off at the last report.").count(), 0);

  assert.equal((await report(delivery({ gps_access: "location_services_off", location_services: false, airplane_mode: true, last_fix_at: at - 3000, fix_failures: 6 }))).status, 200);
  await page.getByText("Android location services were off at the last report.").waitFor({ timeout: 15000 });
  await page.getByText("Paused · Android location services are off", { exact: true }).waitFor();
  await page.getByText("6 attempts in a row without a fix", { exact: false }).waitFor();
  await page.getByText(/Android does not let this server, or any app, switch Location on remotely/).waitFor();
  await page.getByRole("button", { name: "Ask the phone to turn Location on" }).click();
  await page.getByText(/Message queued\./).waitFor();
  const offered = (await (await p.request("/v1/commands", {})).json()).commands;
  assert.equal(offered.length, 1);
  assert.equal(offered[0].kind, "message");
  assert.match(offered[0].payload.message, /turn Location on/);
  assert.ok(offered[0].payload.message.length <= 240);

  // Without recovery messages approved on the phone the action is explained instead of failing.
  f.sql("UPDATE devices SET capabilities='[\"locate\"]' WHERE id=?", [p.id]);
  await page.getByText("The phone has not approved recovery messages.").waitFor({ timeout: 15000 });
  assert.equal(await page.getByRole("button", { name: "Ask the phone to turn Location on" }).isDisabled(), true);
  assert.deepEqual(errors, []);
});
