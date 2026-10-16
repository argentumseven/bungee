import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  randomBytes,
  generateKeyPairSync,
  sign,
  createHash,
  randomUUID,
} from "node:crypto";
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
      BUNGEE_WG_ENDPOINT: "203.0.113.10:47937",
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
    const bundle = JSON.parse(
      await page
        .getByRole("textbox", {
          name: "Enrollment bundle",
          includeHidden: true,
        })
        .inputValue(),
    );
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicKey = key.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const proof = sign(
      "sha256",
      Buffer.from(
        `BUNGEE-ENROLL-V1\n${bundle.token}\n${bundle.wireguard.client_public_key}\n${publicKey}`,
      ),
      key.privateKey,
    ).toString("base64");
    const enrolled = await fetch(`http://127.0.0.1:${devicePort}/v1/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: bundle.token,
        public_key: publicKey,
        wg_public_key: bundle.wireguard.client_public_key,
        proof,
        capabilities: [],
      }),
    });
    assert.equal(enrolled.status, 200);
    const time = String(Math.floor(Date.now() / 1000)),
      nonce = randomUUID();
    const body = JSON.stringify({
      battery: 72,
      charging: false,
      device_owner: false,
      capabilities: [],
      location: {
        latitude: 37.78,
        longitude: -122.42,
        accuracy: 12,
        observed_at: Number(time),
      },
    });
    const signature = sign(
      "sha256",
      Buffer.from(
        `BUNGEE-V1\nPOST\n/v1/telemetry\n${time}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`,
      ),
      key.privateKey,
    ).toString("base64");
    const uploaded = await fetch(
      `http://127.0.0.1:${devicePort}/v1/telemetry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bungee-Device": bundle.device_id,
          "X-Bungee-Time": time,
          "X-Bungee-Nonce": nonce,
          "X-Bungee-Signature": signature,
        },
        body,
      },
    );
    assert.equal(uploaded.status, 200);
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
  await t.test(
    "history supports time slices, selecting a point, state logs and private CSV export",
    async () => {
      await page.getByRole("button", { name: "History", exact: true }).click();
      await page
        .getByRole("heading", { name: "Saved history", exact: true })
        .waitFor();
      await page
        .getByRole("img", {
          name: "Saved GPS trail, longitude horizontally and latitude vertically",
        })
        .waitFor();
      await page.getByText(/Selected:.*37.780000, -122.420000/).waitFor();
      await page.screenshot({
        path: "docs/screenshots/history.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.setViewportSize({ width: 1440, height: 1050 });
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export CSV", exact: true })
        .click();
      const file = await download;
      const stream = await file.createReadStream();
      let csv = "";
      for await (const part of stream) csv += part.toString();
      assert.match(
        csv,
        /observed_at_utc,received_at_utc,latitude,longitude,accuracy_m/,
      );
      assert.match(csv, /37.78,-122.42,12/);
      await page.getByLabel("History from").fill("2000-01-01T00:00");
      await page.getByLabel("History to").fill("2000-01-02T00:00");
      await page.getByRole("button", { name: "Look up history" }).click();
      await page.getByText(/No saved records in this time range/).waitFor();
      await page.getByLabel("History to").fill("2099-01-01T00:00");
      await page.getByLabel("History records").selectOption("state");
      await page.getByRole("button", { name: "Look up history" }).click();
      await page.getByRole("cell", { name: "72%", exact: true }).waitFor();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    },
  );
  await t.test(
    "saved location can be erased from settings while the phone stays paired",
    async () => {
      await page
        .getByRole("button", { name: "Erase saved history", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Erase this saved history?" })
        .waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Erase saved history", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Saved history erased" })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Erase saved history", exact: true })
          .count(),
        1,
      );
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page.getByText("Waiting for a location", { exact: true }).waitFor();
      await page.getByRole("button", { name: /Browser test phone/ }).waitFor();
    },
  );
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
