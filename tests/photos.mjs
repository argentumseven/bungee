import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { fixture, pause } from "./support/server.mjs";
import { phone } from "./support/phone.mjs";

test("armed recovery photos: private storage, bounded input and erasure generations", async t => {
  const f = await fixture(t), p = await phone(f), second = await phone(f);
  const jpeg = await readFile("tests/fixtures/recovery-test.jpg"), path = `/api/devices/${p.id}/photos`;
  let epoch = (await (await p.request("/v1/commands", {})).json()).photo_epoch;
  assert.match(epoch, /^[a-f0-9]{64}$|^[A-Za-z0-9_-]{43}$/);
  const photo = (extra = {}) => ({ id: randomUUID(), captured_at: Math.floor(Date.now() / 1000), failed_attempts: 3, reason: "failed_unlock", jpeg: jpeg.toString("base64"), ...extra });
  const body = (recovery_photo, generation = epoch) => ({ battery: 72, charging: false, device_owner: false, capabilities: ["locate"], photo_epoch: generation, recovery_photo });
  const upload = data => p.request("/v1/telemetry", data);
  const erase = async () => { assert.equal((await f.admin(path, "DELETE")).status, 200); epoch = (await (await p.request("/v1/commands", {})).json()).photo_epoch; };
  const empty = async () => assert.deepEqual((await (await f.admin(path)).json()).photos, []);
  let saved;
  await t.test("signed upload is idempotent and image bytes require the correct authenticated device route", async () => {
    saved = photo(); const data = body(saved);
    for (let i = 0; i < 2; i++) { const r = await upload(data); assert.equal(r.status, 200); assert.equal((await r.json()).accepted_photo, saved.id); }
    const rows = (await (await f.admin(path)).json()).photos; assert.equal(rows.length, 1); assert.equal(rows[0].id, saved.id); assert.equal(rows[0].jpeg, undefined);
    const image = await f.admin(`${path}/${saved.id}`); assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/jpeg"); assert.equal(image.headers.get("cache-control"), "no-store"); assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    assert.equal((await fetch(f.origin + path)).status, 401); assert.equal((await fetch(`${f.origin}${path}/${saved.id}`)).status, 401);
    assert.equal((await f.admin(`/api/devices/${second.id}/photos/${saved.id}`)).status, 404);
    assert.equal((await f.admin(path, "DELETE", undefined, { Origin: "https://example.invalid" })).status, 403);
    const device = (await (await f.admin("/api/devices")).json()).devices.find(d => d.id === p.id);
    assert.equal(device.telemetry.recovery_photo, undefined); assert.equal(device.telemetry.photo_epoch, undefined);
    assert.equal((await upload(body({ ...saved, failed_attempts: 4 }))).status, 409);
  });
  await t.test("invalid content, EXIF, excessive sizes and misleading reasons are refused", async () => {
    const exif = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 225, 0, 8, 69, 120, 105, 102, 0, 0]), jpeg.subarray(2)]);
    const lateExif = Buffer.concat([jpeg.subarray(0, -2), Buffer.from([255, 225, 0, 8, 69, 120, 105, 102, 0, 0]), jpeg.subarray(-2)]);
    const oversize = Buffer.from(jpeg), frame = oversize.indexOf(Buffer.from([255, 192])); assert.ok(frame > 0); oversize.writeUInt16BE(32767, frame + 7);
    for (const change of [{ jpeg: Buffer.from('<svg onload="alert(1)"></svg>').toString("base64") }, { jpeg: exif.toString("base64") }, { jpeg: lateExif.toString("base64") }, { jpeg: oversize.toString("base64") }, { jpeg: "A".repeat(16_385) }, { jpeg: "???" }, { failed_attempts: 2 }, { reason: "local_test" }, { captured_at: Math.floor(Date.now()/1000)+121 }, { reason: "remote_camera" }]) {
      assert.equal((await upload(body(photo(change)))).status, 400);
    }
    assert.equal((await upload(body(photo({ jpeg: "A".repeat(40_000) })))).status, 413);
    const noEpoch = body(photo()); delete noEpoch.photo_epoch; assert.equal((await upload(noEpoch)).status, 409);
    assert.equal((await upload(body(photo({ reason: "local_test", failed_attempts: 0 })))).status, 200);
    assert.equal((await f.admin(`/api/devices/${p.id}/commands`, "POST", { kind: "camera" })).status, 400);
  });
  await t.test("six-per-hour admission does not block ordinary telemetry", async () => {
    for (let i = 0; i < 4; i++) assert.equal((await upload(body(photo()))).status, 200);
    assert.equal((await upload(body(photo()))).status, 429);
    assert.equal((await upload(body(saved))).status, 200, "exact retry remains acknowledgeable at quota");
    const ordinary = body(undefined); delete ordinary.recovery_photo;
    assert.equal((await upload(ordinary)).status, 200);
  });
  await t.test("erasure rejects a slow pre-erasure upload and invalidates earlier photo URLs", async () => {
    const oldEpoch = epoch, prepared = p.prepare("/v1/telemetry", body(photo())); let request;
    const completed = new Promise((resolve, reject) => {
      request = httpRequest(f.deviceOrigin + "/v1/telemetry", { method: "POST", headers: { ...prepared.headers, "Content-Length": Buffer.byteLength(prepared.text) } }, r => {
        let data = ""; r.setEncoding("utf8"); r.on("data", b => data += b); r.on("end", () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
      }); request.on("error", reject); request.write(prepared.text.slice(0, -1));
    });
    await pause(20); await erase(); request.end(prepared.text.slice(-1));
    const result = await completed; assert.equal(result.status, 200); assert.equal(result.body.accepted_photo, null); assert.notEqual(epoch, oldEpoch); await empty();
    assert.equal((await f.admin(`${path}/${saved.id}`)).status, 404);
    const late = await upload(body(photo(), oldEpoch)); assert.equal((await late.json()).accepted_photo, null); await empty();
    assert.equal((await upload(body(photo()))).status, 200);
  });
  await t.test("concurrent upload and erasure leave no old-generation image", async () => {
    for (let i = 0; i < 5; i++) {
      const prepared = body(photo());
      const [uploaded] = await Promise.all([upload(prepared), erase()]);
      assert.equal(uploaded.status, 200); await uploaded.json(); await empty();
    }
  });
  await t.test("pagination is bounded and history erasure and revocation also remove photos", async () => {
    assert.equal((await upload(body(photo()))).status, 200);
    for (let i = 0; i < 22; i++) f.sql("INSERT INTO recovery_photos(device_id,photo_id,captured_at,received_at,failed_attempts,reason,jpeg) VALUES(?,?,?,?,?,?,?)", [p.id, randomUUID(), 100+i, 100+i, 3, "failed_unlock", "fixture-not-served"]);
    const first = await (await f.admin(path)).json(); assert.equal(first.photos.length, 20); assert.ok(first.next_before);
    const rest = await (await f.admin(`${path}?before=${first.next_before}`)).json(); assert.equal(rest.photos.length, 3); assert.equal(rest.next_before, null);
    assert.equal(new Set([...first.photos, ...rest.photos].map(p => p.id)).size, 23);
    assert.equal((await f.admin(`${path}?before=-1`)).status, 400);
    const previous = epoch; assert.equal((await f.admin(`/api/devices/${p.id}/history`, "DELETE")).status, 200); await empty();
    epoch = (await (await p.request("/v1/commands", {})).json()).photo_epoch; assert.notEqual(epoch, previous);
    assert.equal((await upload(body(photo()))).status, 200);
    const retained = epoch; await f.stop(); await f.launch(); epoch = (await (await p.request("/v1/commands", {})).json()).photo_epoch; assert.equal(epoch, retained);
    assert.equal((await f.admin(`/api/devices/${p.id}`, "DELETE")).status, 200);
    assert.equal((await f.admin(path)).status, 404); assert.equal(f.sql("SELECT COUNT(*) FROM recovery_photos WHERE device_id=?", [p.id])[0][0], 0);
    assert.equal((await upload(body(photo()))).status, 401);
  });
});
