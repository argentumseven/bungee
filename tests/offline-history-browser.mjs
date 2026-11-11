import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { fixture } from "./support/server.mjs";
import { phone } from "./support/phone.mjs";

async function dashboard(t, f, time = Date.now()) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const [name, value] = f.cookie.split("=");
  await context.addCookies([{ name, value, url: f.origin }]);
  const page = await context.newPage();
  await page.clock.install({ time });
  await page.goto(f.origin);
  await page.getByRole("button", { name: "Tracking", exact: true }).click();
  await page.getByRole("button", { name: "GPS history", exact: true }).click();
  return page;
}
const report = (p, locations) => p.request("/v1/telemetry", { battery: 60, charging: false, device_owner: false, capabilities: ["locate"], gps_epoch: p.epoch, locations });
const point = (at, latitude = 33) => ({ observed_at: at, latitude, longitude: -80, accuracy: 10 });

test("an offline phone's saved history remains visible beyond the last 24 hours", async t => {
  const f = await fixture(t), p = await phone(f), now = Math.floor(Date.now() / 1000);
  assert.equal((await report(p, [point(now - 7 * 86400, 32.99), point(now - 3 * 86400), point(now - 3 * 86400 + 60, 33.001)])).status, 200);
  f.sql("UPDATE devices SET last_contact=?,last_seen=? WHERE id=?", [now - 3 * 86400, now - 3 * 86400, p.id]);
  const page = await dashboard(t, f);
  await page.getByRole("table").waitFor({ timeout: 5000 });
  assert.equal(await page.locator(".history-table tbody tr").count(), 2);
  await page.clock.fastForward(26 * 3600 * 1000);
  await page.getByRole("img", { name: "OpenStreetMap GPS history" }).waitFor();
  assert.equal(await page.locator(".history-table tbody tr").count(), 2);
  await page.getByRole("button", { name: "Show all saved history", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".history-table tbody tr").length === 3);
  assert.equal(f.sql("SELECT COUNT(*) FROM location_history WHERE device_id=?", [p.id])[0][0], 3);
});

test("history retains loaded fixes on refresh failure and shows reconnect backfill without reopening", async t => {
  const f = await fixture(t), p = await phone(f), now = Math.floor(Date.now() / 1000);
  assert.equal((await report(p, [point(now - 10800)])).status, 200);
  const page = await dashboard(t, f, (now - 7200) * 1000);
  await page.getByRole("table").waitFor();
  await page.route("**/api/devices/*/history?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "History temporarily unavailable" }) }));
  const failed = page.waitForResponse(response => response.url().includes("/history?") && response.status() === 503, { timeout: 5000 });
  await page.clock.fastForward(15000);
  await failed;
  assert.equal(await page.locator(".history-table tbody tr").count(), 1);
  await page.unroute("**/api/devices/*/history?*");
  assert.equal((await report(p, [point(now - 60, 33.002)])).status, 200);
  const refreshed = page.waitForResponse(response => response.url().includes("/history?") && response.status() === 200);
  await page.clock.fastForward(7200 * 1000);
  await refreshed;
  await page.waitForFunction(() => document.querySelectorAll(".history-table tbody tr").length === 2);
  assert.equal((await f.admin(`/api/devices/${p.id}/history`, "DELETE")).status, 200);
  const erased = page.waitForResponse(response => response.url().includes("/history?") && response.status() === 200);
  await page.clock.fastForward(15000);
  await erased;
  await page.getByText(/No saved records in this time range/).waitFor();
  assert.equal(await page.locator(".history-table tbody tr").count(), 0);
});

test("paging and custom time ranges remain stable until latest history is requested", async t => {
  const f = await fixture(t), p = await phone(f), now = Math.floor(Date.now() / 1000);
  const points = Array.from({ length: 205 }, (_, i) => point(now - 60 - i * 60, 33 + i * 0.00001));
  for (let i = 0; i < points.length; i += 100) assert.equal((await report(p, points.slice(i, i + 100))).status, 200);
  const page = await dashboard(t, f);
  await page.waitForFunction(() => document.querySelectorAll(".history-table tbody tr").length === 200);
  await page.getByRole("button", { name: "Load older records", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".history-table tbody tr").length === 205);
  await page.clock.fastForward(60000);
  assert.equal(await page.locator(".history-table tbody tr").count(), 205);
  const localTime = seconds => { const date = new Date(seconds * 1000); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  await page.getByLabel("History from", { exact: true }).fill(localTime(now + 3600));
  await page.getByLabel("History to", { exact: true }).fill(localTime(now + 7200));
  await page.getByRole("button", { name: "Look up history", exact: true }).click();
  await page.getByText(/No saved records in this time range/).waitFor();
  let requests = 0;
  page.on("request", request => { if (request.url().includes("/history?")) requests++; });
  await page.clock.fastForward(60000);
  assert.equal(requests, 0, "custom lookups must keep their chosen time range");
  await page.getByRole("button", { name: "Show all saved history", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".history-table tbody tr").length === 200);
  const refreshed = page.waitForResponse(response => response.url().includes("/history?") && response.status() === 200);
  await page.clock.fastForward(15000);
  await refreshed;
  assert.equal(f.sql("SELECT COUNT(*) FROM location_history WHERE device_id=?", [p.id])[0][0], 205);
});
