import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
test("dashboard browser: sign in, enrollment, navigation, and mobile layout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bungee-browser-")),
    port = await freePort(),
    devicePort = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString("base64url");
  await writeFile(join(dir, "admin-password"), password, { mode: 0o600 });
  await mkdir(join(dir, "wireguard"));
  await writeFile(
    join(dir, "wireguard/server-public-key"),
    randomBytes(32).toString("base64"),
  );
  const server = spawn(resolve("server/target/debug/bungee-server"), [], {
    env: {
      ...process.env,
      BUNGEE_STATE_DIR: dir,
      BUNGEE_ADMIN_BIND: `127.0.0.1:${port}`,
      BUNGEE_DEVICE_BIND: `127.0.0.1:${devicePort}`,
      BUNGEE_PUBLIC_ORIGIN: origin,
      BUNGEE_WG_ENDPOINT: "home.example.com:51820",
      BUNGEE_WEB_DIR: resolve("web/dist"),
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGINT");
    await new Promise((r) => server.once("exit", r));
    await rm(dir, { recursive: true, force: true });
  });
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(origin + "/healthz")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    }),
    page = await context.newPage();
  const errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith("data:"))
      external.push(r.url());
  });
  await page.goto(origin);
  await page.getByRole("heading", { name: "Welcome home." }).waitFor();
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({
    path: "docs/screenshots/sign-in.png",
    fullPage: true,
  });
  await page.getByLabel("Server administrator password").fill(password);
  await page.getByRole("button", { name: "Unlock your household" }).click();
  await page
    .getByRole("heading", { name: "A little peace of mind." })
    .waitFor();
  await page
    .getByRole("heading", { name: "It starts with one phone." })
    .waitFor();
  await page.screenshot({
    path: "docs/screenshots/dashboard.png",
    fullPage: true,
  });
  await t.test("an empty dashboard has usable enrollment", async () => {
    await page.getByRole("button", { name: "Add a device" }).click();
    await page
      .getByLabel("Device name", { exact: true })
      .fill("Browser test phone");
    await page
      .getByLabel("Phone’s WireGuard public key", { exact: true })
      .fill(randomBytes(32).toString("base64"));
    await page
      .getByRole("button", { name: "Create one-time enrollment" })
      .click();
    await page
      .getByRole("img", { name: "One-time Bungee enrollment QR code" })
      .waitFor();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: /Browser test phone/ }).waitFor();
  });
  await t.test("activity and settings show real state", async () => {
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await page.getByText("enrollment · created", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("heading", { name: "Device consent & management" })
      .waitFor();
    await page.getByText("Browser test phone", { exact: true }).waitFor();
  });
  await t.test("mobile layout fits a 390-pixel viewport", async () => {
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "docs/screenshots/mobile-dashboard.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
  });
  await t.test(
    "browser reports no runtime errors or third-party requests",
    () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    },
  );
  await t.test(
    "session loss clears the household view on the next refresh",
    async () => {
      await context.clearCookies();
      await page
        .getByRole("heading", { name: "Welcome home." })
        .waitFor({ timeout: 10000 });
      assert.equal(
        await page.getByText("Browser test phone", { exact: true }).count(),
        0,
      );
      await page.getByLabel("Server administrator password").fill(password);
      await page.getByRole("button", { name: "Unlock your household" }).click();
      await page
        .getByRole("heading", { name: "A little peace of mind." })
        .waitFor();
    },
  );
  await t.test("locking the dashboard returns to sign-in", async () => {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.getByRole("button", { name: "Lock dashboard" }).click();
    await page.getByRole("heading", { name: "Welcome home." }).waitFor();
  });
});
