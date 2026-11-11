import test from "node:test";
import assert from "node:assert/strict";
import { recoveryCamera } from "../web/src/recoveryCamera.ts";

const now = 1_000;
const installation = (id, extra = {}) => ({
  id, name: id, enrolled: true, revoked: false, last_contact: now,
  management_report_at: now, capabilities: ["take_picture"],
  management: { foreground_user: true, camera: { armed: true } }, ...extra,
});
const resolve = phone => recoveryCamera(phone, now);

test("main camera uses its profile label when it is the only active installation", () => {
  assert.equal(resolve(installation("phone", { main_profile_name: "Owner" })).target?.name, "Owner");
});
test("phone button routes to the active locally armed companion even when main is unavailable", () => {
  const phone = installation("phone", { capabilities: [], management: { foreground_user: false },
    profiles: [installation("Sandbox")] });
  assert.equal(resolve(phone).target?.id, "Sandbox");
});
test("unarmed active profile never falls back to the inactive main camera", () => {
  const phone = installation("phone", { management: { foreground_user: false }, profiles: [
    installation("Sandbox", { management: { foreground_user: true, camera: { armed: false } } }),
  ] });
  assert.equal(resolve(phone).target, undefined);
  assert.match(resolve(phone).detail, /Sandbox.*Enable theft photos/);
});
test("both foreground claims block automatic routing regardless of readiness or report order", () => {
  const phone = installation("phone", { management_report_at: now - 10, profiles: [
    installation("Sandbox", { capabilities: [] }),
  ] });
  assert.equal(resolve(phone).target, undefined);
  assert.match(resolve(phone).detail, /Profile switch/);
});
test("stale foreground claims cannot receive a picture", () => {
  for (const field of ["last_contact", "management_report_at"]) {
    assert.equal(resolve(installation("phone", { [field]: now - 90 })).target, undefined);
    assert.equal(resolve(installation("phone", { [field]: now + 6 })).target, undefined);
  }
  assert.equal(resolve(installation("phone", { management: {} })).target, undefined);
});
test("a stale main claim does not prevent a fresh active companion", () => {
  assert.equal(resolve(installation("phone", { management_report_at: now - 90,
    profiles: [installation("Sandbox")] })).target?.id, "Sandbox");
});
test("revoked, disconnected and duplicate installations are not camera targets", () => {
  for (const extra of [{ enrolled: false }, { revoked: true }, { binding_released: true }, { duplicate_blocked_at: now }]) {
    const phone = installation("phone", { management: { foreground_user: false }, profiles: [installation("Sandbox", extra)] });
    assert.equal(resolve(phone).target, undefined);
  }
  assert.equal(resolve(installation("phone", { enrolled: false, profiles: [installation("Sandbox")] })).target, undefined);
});
test("both camera readiness and approved command capability are required", () => {
  for (const extra of [{ capabilities: [] }, { management: { foreground_user: true } }]) {
    assert.equal(resolve(installation("phone", extra)).target, undefined);
  }
  assert.equal(resolve(undefined).target, undefined);
});
