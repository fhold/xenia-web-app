/**
 * Unit tests for the PT-2 profile-temp pending-reset store.
 *
 * Runner: node:test (NOT vitest) — run with `node --import tsx --test`.
 * Pins the arm-once / never-overwrite (M3) / clear semantics that the two
 * machine endpoints rely on. A profile-temp set writes BOTH boilers (BG + BB),
 * so the store remembers both and the reset restores both. The "manual setpoints
 * path never arms" guarantee lives at the route call sites (only from-profile
 * calls arm()), so the store itself only proves it remembers the FIRST pair and
 * clears cleanly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileTempResetStore } from "../src/profile-temp-reset.js";

test("fresh store is not armed", () => {
  const s = new ProfileTempResetStore();
  assert.equal(s.isArmed(), false);
  assert.equal(s.previous(), null);
});

test("arm remembers the pre-set BG + BB setpoints", () => {
  const s = new ProfileTempResetStore();
  s.arm(92, 90);
  assert.equal(s.isArmed(), true);
  assert.deepEqual(s.previous(), { bgC: 92, bbC: 90 });
});

test("M3: a second arm does NOT overwrite the first remembered pair", () => {
  const s = new ProfileTempResetStore();
  s.arm(92, 90); // first profile set: was at 92/90
  s.arm(96, 96); // second profile set while still armed: stays 92/90
  assert.deepEqual(s.previous(), { bgC: 92, bbC: 90 });
});

test("clear disarms the store (apply:true / dismiss both clear)", () => {
  const s = new ProfileTempResetStore();
  s.arm(92, 90);
  s.clear();
  assert.equal(s.isArmed(), false);
  assert.equal(s.previous(), null);
});

test("re-arm after clear remembers the new pair (not chained)", () => {
  const s = new ProfileTempResetStore();
  s.arm(92, 90);
  s.clear();
  s.arm(100, 100);
  assert.deepEqual(s.previous(), { bgC: 100, bbC: 100 });
});

test("clear with nothing armed is a harmless no-op", () => {
  const s = new ProfileTempResetStore();
  s.clear();
  assert.equal(s.isArmed(), false);
});

test("a remembered setpoint of 0 still counts as armed (not confused with null)", () => {
  const s = new ProfileTempResetStore();
  s.arm(0, 0);
  assert.equal(s.isArmed(), true);
  assert.deepEqual(s.previous(), { bgC: 0, bbC: 0 });
  // a second arm must still not overwrite the remembered pair
  s.arm(96, 96);
  assert.deepEqual(s.previous(), { bgC: 0, bbC: 0 });
});
