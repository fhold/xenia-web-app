/**
 * M-5: the profile-temp reset must outlive a restart.
 *
 * The failure it guards against is not a missing prompt. It is that the app
 * moved both boilers to a profile temp and was the only place that knew what
 * they stood at before — so after a restart the machine sits on the wrong
 * temperature with no way back.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROFILE_TEMP_RESET_KEY,
  makeProfileTempResetPersistence,
  reconcileProfileTempReset,
} from "../src/lib/profile-temp-reset-store.js";
import { ProfileTempResetStore } from "../../shared/src/profile-temp-reset.js";
import type { SettingsRepo } from "../src/db/settings-repo.js";
import type { SetpointsFrame } from "../../shared/src/types.js";

function fakeSettings(): SettingsRepo & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (k) => store.get(k),
    getAll: () => new Map(store),
    insertIfAbsent: (k, v) => { if (!store.has(k)) store.set(k, v); },
    set: (k, v) => { store.set(k, v); },
    delete: (k) => { store.delete(k); },
  };
}

function setpoints(bgC: number, bbC: number): SetpointsFrame {
  return { brewGroupTargetC: bgC, brewBoilerTargetC: bbC } as SetpointsFrame;
}

describe("profile-temp reset write-through", () => {
  it("arming stores the pre-set pair", () => {
    const settings = fakeSettings();
    const store = new ProfileTempResetStore(makeProfileTempResetPersistence(settings));
    store.arm(96, 96);
    assert.deepEqual(
      JSON.parse(settings.store.get(PROFILE_TEMP_RESET_KEY)!),
      { bgC: 96, bbC: 96 },
    );
  });

  it("a second set does not overwrite the first (M3) — in the record either", () => {
    const settings = fakeSettings();
    const store = new ProfileTempResetStore(makeProfileTempResetPersistence(settings));
    store.arm(96, 96);
    store.arm(93, 93);
    assert.deepEqual(
      JSON.parse(settings.store.get(PROFILE_TEMP_RESET_KEY)!),
      { bgC: 96, bbC: 96 },
    );
  });

  it("clearing removes the record — a spent reset must not come back", () => {
    const settings = fakeSettings();
    const store = new ProfileTempResetStore(makeProfileTempResetPersistence(settings));
    store.arm(96, 96);
    store.clear();
    assert.equal(settings.store.has(PROFILE_TEMP_RESET_KEY), false);
  });

  it("restore() adopts without writing back", () => {
    const settings = fakeSettings();
    const store = new ProfileTempResetStore(makeProfileTempResetPersistence(settings));
    store.restore({ bgC: 96, bbC: 96 });
    assert.equal(store.isArmed(), true);
    assert.equal(settings.store.size, 0);
  });
});

describe("startup reconciliation", () => {
  it("machine still on the profile temp → the reset stays offered", () => {
    const out = reconcileProfileTempReset(
      JSON.stringify({ bgC: 96, bbC: 96 }),
      setpoints(93, 93),
    );
    assert.equal(out.action, "rearm");
    assert.deepEqual(out.action === "rearm" ? out.prev : null, { bgC: 96, bbC: 96 });
  });

  it("setpoints already back at the remembered pair → record is spent", () => {
    const out = reconcileProfileTempReset(
      JSON.stringify({ bgC: 96, bbC: 96 }),
      setpoints(96, 96),
    );
    assert.deepEqual(out, { action: "drop", reason: "already-restored" });
  });

  it("only one boiler back → still worth restoring", () => {
    const out = reconcileProfileTempReset(
      JSON.stringify({ bgC: 96, bbC: 94 }),
      setpoints(96, 93),
    );
    assert.equal(out.action, "rearm");
  });

  it("no record → nothing to do", () => {
    assert.deepEqual(reconcileProfileTempReset(undefined, setpoints(93, 93)), {
      action: "none",
    });
  });

  it("machine unreachable → keep the record, do not arm and do not delete", () => {
    const out = reconcileProfileTempReset(JSON.stringify({ bgC: 96, bbC: 96 }), null);
    assert.deepEqual(out, { action: "keep", reason: "machine-unreachable" });
  });

  it("unreadable record is dropped, not crashed on", () => {
    for (const raw of ["", "{", "null", "[]", '{"bgC":96}', '{"bgC":"96","bbC":96}']) {
      assert.deepEqual(
        reconcileProfileTempReset(raw, setpoints(93, 93)),
        { action: "drop", reason: "unreadable" },
        `raw=${raw}`,
      );
    }
  });

  it("compares on one decimal — 96.0 and 96.04 are the same setpoint", () => {
    const out = reconcileProfileTempReset(
      JSON.stringify({ bgC: 96, bbC: 96 }),
      setpoints(96.04, 95.96),
    );
    assert.deepEqual(out, { action: "drop", reason: "already-restored" });
  });
});
