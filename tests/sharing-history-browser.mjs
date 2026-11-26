import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import { fixture } from "./support/server.mjs";
import { phone } from "./support/phone.mjs";

test("sharing timeline separates manual actions from crashes/errors and retains unknown stop times", async t => {
  const f = await fixture(t), p = await phone(f), now = Math.floor(Date.now() / 1000);
  const epoch = (await (await p.request("/v1/sync", { report: {} })).json()).sharing_epoch;
  const events = ["user_start", "notification_stop", "crash", "consent_storage_error", "unexpected_exit"].map(reason => ({ id: randomUUID(), reason, at: reason === "unexpected_exit" ? null : now - 3600, recorded_at: now }));
  assert.equal((await p.request("/v1/sync", { report: { sharing_epoch: epoch, sharing_events: events } })).status, 200);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: "UTC" }), [name, value] = f.cookie.split("=");
  await context.addCookies([{ name, value, url: f.origin }]);
  const page = await context.newPage(), errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(f.origin);
  await page.getByRole("button", { name: "Tracking", exact: true }).click();
  await page.getByRole("button", { name: "Sharing history", exact: true }).click();
  const timeline = page.getByRole("region", { name: "Sharing start and stop history" });
  await timeline.getByText("Android reported an app crash", { exact: true }).waitFor();
  assert.equal(await timeline.locator(".sharing-event-manual").count(), 2);
  assert.equal(await timeline.locator(".sharing-event-crash").count(), 1);
  assert.equal(await timeline.locator(".sharing-event-error").count(), 1);
  await timeline.getByText(/Stop time unknown · detected on phone/).waitFor();
  assert.equal(await timeline.locator(".sharing-event-crash").getByText("Manual", { exact: true }).count(), 0);
  await timeline.getByLabel("From (local time)").fill(new Date((now - 300) * 1000).toISOString().slice(0, 16));
  await timeline.getByRole("button", { name: "Apply filter", exact: true }).click();
  await timeline.getByText(/Stop time unknown · detected on phone/).waitFor();
  assert.equal(await timeline.locator(".sharing-event").count(), 1);
  await timeline.getByRole("button", { name: "Clear filter", exact: true }).click();
  await timeline.getByText("Android reported an app crash", { exact: true }).waitFor();
  await timeline.screenshot({ path: "docs/screenshots/sharing-history.png" });
  f.sql("UPDATE devices SET last_contact=? WHERE id=?", [now - 86400, p.id]);
  await timeline.getByRole("button", { name: "Refresh sharing history", exact: true }).click();
  assert.equal(f.sql("SELECT COUNT(*) FROM sharing_events WHERE device_id=?", [p.id])[0][0], 5, "loss of contact must not invent a manual stop");
  await page.setViewportSize({ width: 390, height: 844 });
  await timeline.screenshot({ path: "docs/screenshots/mobile-sharing-history.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test("manual Locate stays available with passive GPS off and leaves that setting unchanged", async t => {
  const f = await fixture(t), p = await phone(f), now = Math.floor(Date.now() / 1000);
  assert.equal((await p.request("/v1/telemetry", { battery: 70, charging: false, device_owner: false, capabilities: ["locate"] })).status, 200);
  assert.equal((await p.request("/v1/sync", { report: { recovery_consent: true, delivery: { reported_at: now, gps_access: "disabled" } } })).status, 200);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  t.after(() => browser.close());
  const context = await browser.newContext(), [name, value] = f.cookie.split("=");
  await context.addCookies([{ name, value, url: f.origin }]); const page = await context.newPage();
  await page.goto(f.origin); await page.getByRole("button", { name: /^Devices/ }).click();
  await page.getByRole("button", { name: /Refresh location/ }).click();
  const offered = (await (await p.request("/v1/commands", {})).json()).commands;
  assert.equal(offered[0].kind, "locate");
  assert.equal((await (await p.request("/v1/command-check", { id: offered[0].id })).json()).allowed, true);
  const response = await p.request("/v1/telemetry", { battery: 70, charging: false, device_owner: false, capabilities: ["locate"], gps_epoch: p.epoch, locate_command: offered[0].id, location: { latitude: 33, longitude: -80, accuracy: 10, observed_at: now, source: "homing", samples: 1 } });
  assert.equal(response.status, 200); assert.equal((await response.json()).gps_accepted, true);
  const policy = await (await f.admin(`/api/devices/${p.id}/policy`)).json();
  assert.equal(policy.report.delivery.gps_access, "disabled");
  assert.equal(policy.policy.lost_mode, false);
});


test("diagnostics reports return to their own panel and activity filters use event time", async t => {
  const f = await fixture(t), p = await phone(f, { capabilities: ["diagnostics"] });
  const now = Math.floor(Date.now() / 1000);
  f.sql("INSERT INTO audit(at,action,device_id,detail) VALUES(?,?,?,?)", [now - 3600, "fixture.previous", p.id, "Earlier activity fixture"]);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
  const [name, value] = f.cookie.split("=");
  await context.addCookies([{ name, value, url: f.origin }]);
  const page = await context.newPage();
  await page.goto(f.origin);
  await page.getByRole("button", { name: /^Devices/ }).click();
  await page.getByRole("button", { name: /Check phone diagnostics/ }).click();
  const report = page.getByRole("region", { name: "Phone diagnostics" });
  await report.getByText(/Waiting for .+ to connect and run the checks/).waitFor();
  const poll = (await (await p.request("/v1/commands", {})).json()).commands;
  assert.equal(poll.length, 1);
  assert.equal(poll[0].kind, "diagnostics");
  const receipt = {
    id: poll[0].id, status: "executed", result: "Phone diagnostics completed",
    attempted_at: Math.floor(Date.now() / 1000),
    diagnostic_checks: [{ label: "Android location services", status: "attention", detail: "Location is disabled in Android Settings." }],
  };
  assert.equal((await p.request("/v1/ack", { ...receipt, diagnostic_checks: [] })).status, 400);
  assert.equal((await p.request("/v1/ack", receipt)).status, 200);
  const retry = await (await p.request("/v1/ack", receipt)).json();
  assert.equal(retry.receipt_status, "already_terminal");
  await report.getByText("Location is disabled in Android Settings.", { exact: true }).waitFor();
  await report.getByText("1 check needs attention", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByText(/Earlier activity fixture/).waitFor();
  await page.getByLabel("From (local time)").fill(new Date((now - 300) * 1000).toISOString().slice(0, 16));
  await page.getByRole("button", { name: "Apply filter", exact: true }).click();
  await page.getByText("Command receipt received", { exact: true }).waitFor();
  assert.equal(await page.getByText(/Earlier activity fixture/).count(), 0);
});
