/**
 * Unit tests for computeEffectiveAgeDays (§3.4b) — Alter minus Frostdauer.
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEffectiveAgeDays } from "../src/coffee.js";

const NOW = Date.parse("2026-07-30T12:00:00Z");

test("no roast date -> null", () => {
  assert.equal(computeEffectiveAgeDays(null, null, null, NOW), null);
  assert.equal(computeEffectiveAgeDays("nonsense", null, null, NOW), null);
});

test("never frozen -> raw days since roast", () => {
  assert.equal(computeEffectiveAgeDays("2026-07-06", null, null, NOW), 24);
});

test("still frozen -> age stops at the freeze day", () => {
  // 06.07. -> 17.07. sind 11 Tage; danach zaehlt nichts mehr.
  assert.equal(computeEffectiveAgeDays("2026-07-06", "2026-07-17", null, NOW), 11);
});

test("thawed -> frost span is excluded, clock runs again", () => {
  // 11 Tage bis zum Einfrieren + 5 Tage seit dem Auftauen am 25.07.
  assert.equal(computeEffectiveAgeDays("2026-07-06", "2026-07-17", "2026-07-25", NOW), 16);
});

test("stale thawDate before frozenDate counts as still frozen (bean 12)", () => {
  // Das Modell haelt nur ein Frozen/Thaw-Paar: nach thawed(09.07.) -> frozen(17.07.)
  // bleibt ein thaw_date aus dem Vorzyklus stehen. Ohne Sonderfall wuerde die
  // negative Frostdauer auf 0 geklemmt und die 24 Rohtage angezeigt.
  assert.equal(computeEffectiveAgeDays("2026-07-06", "2026-07-17", "2026-07-09", NOW), 11);
});

test("unparseable thawDate falls back to still frozen", () => {
  assert.equal(computeEffectiveAgeDays("2026-07-06", "2026-07-17", "kaputt", NOW), 11);
});

test("frozen date in the future does not inflate the age", () => {
  assert.equal(computeEffectiveAgeDays("2026-07-06", "2026-08-10", null, NOW), 24);
});

test("frozen on the roast day -> age never leaves 0", () => {
  assert.equal(computeEffectiveAgeDays("2026-07-06", "2026-07-06", null, NOW), 0);
});
