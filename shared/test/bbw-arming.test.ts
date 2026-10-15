/**
 * Unit tests for the BBW arming category gate (Spec §4.12 / Auftrag 3m).
 *
 * Runner: node:test (NOT vitest) — run with `node --import tsx --test`.
 * Pins the pure decision: only a genuine `brew` script arms the app BBW stop;
 * maintenance, unknown and null (uncategorized) must NOT arm — so a flush
 * "overshoot" can never poison residual_lag auto-calibration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveCategory,
  categoryArmsBbw,
  type ScriptCategoryAuto,
} from "../src/bbw-arming.js";

/** Convenience: the full gate as the recorder applies it. */
function arms(categoryAuto: ScriptCategoryAuto): boolean {
  return categoryArmsBbw(effectiveCategory({ categoryAuto }));
}

test("brew script arms BBW", () => {
  assert.equal(arms("brew"), true);
});

test("maintenance script does NOT arm BBW", () => {
  assert.equal(arms("maintenance"), false);
});

test("unknown script does NOT arm BBW", () => {
  assert.equal(arms("unknown"), false);
});

test("uncategorized (null) does NOT arm BBW", () => {
  assert.equal(arms(null), false);
});

test("null/unknown collapse to the same effective category", () => {
  assert.equal(effectiveCategory({ categoryAuto: null }), "unknown");
  assert.equal(effectiveCategory({ categoryAuto: "unknown" }), "unknown");
});

test("override slot wins over auto (reserved for SE-2)", () => {
  // A future manual override pinning 'brew' arms even if auto says maintenance…
  assert.equal(
    categoryArmsBbw(
      effectiveCategory({ categoryAuto: "maintenance", categoryOverride: "brew" }),
    ),
    true,
  );
  // …and pinning 'maintenance' blocks even if auto says brew.
  assert.equal(
    categoryArmsBbw(
      effectiveCategory({ categoryAuto: "brew", categoryOverride: "maintenance" }),
    ),
    false,
  );
});
