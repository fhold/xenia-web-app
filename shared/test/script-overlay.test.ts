/**
 * Unit tests for buildScriptOverlay (SO-1) — commanded-vs-actual overlay model.
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScriptOverlay } from "../src/script-overlay.js";

test("null / empty content → no overlay", () => {
  assert.equal(buildScriptOverlay(null, 30_000), null);
  assert.equal(buildScriptOverlay("", 30_000), null);
});

test("deterministic script (no Cmd 27/25): determinismEnd null, fully solid when run to end", () => {
  // 9 bar ramp 3s + hold to 6s; total nominal = 6s.
  const o = buildScriptOverlay("1;13;4 9000 3000;12 6000;17;7;", 6_000)!;
  assert.notEqual(o, null);
  assert.equal(o.determinismEndMs, null);
  assert.equal(o.totalMs, 6_000);
  assert.equal(o.solidUntilMs, 6_000);
  assert.equal(o.barHeld.length, 0); // ran to the end → nothing damped
  assert.equal(o.flowSolid.length, 0); // no flow command
  // Solid bar reaches 9 bar.
  assert.ok(o.barSolid.some((p) => p.v === 9));
});

test("UP-10: deterministic brew stopped early → Soll clipped at the stop, no held tail", () => {
  // Script total 6 s, but the brew stopped at 3 s. determinismEnd is null →
  // solidUntil = stop = 3 s = clipEnd → nothing is drawn past the brew end.
  const o = buildScriptOverlay("1;13;4 9000 3000;12 6000;17;7;", 3_000)!;
  assert.equal(o.solidUntilMs, 3_000);
  assert.equal(o.clipEndMs, 3_000);
  assert.equal(o.barHeld.length, 0); // no Soll past the brew end
  assert.equal(o.barSolid[o.barSolid.length - 1].t, 3_000); // solid ends at the stop
});

test("UP-10: held part is clipped to the brew end when stop is before the script end", () => {
  // determinismEnd 5 s, script total 17 s, but the brew stopped at 10 s →
  // held runs from determinismEnd (5 s) only to the stop (10 s), not to 17 s.
  const o = buildScriptOverlay("1;13;4 2000 10000;12 5000;27 20;17;7;", 10_000)!;
  assert.equal(o.determinismEndMs, 5_000);
  assert.equal(o.clipEndMs, 10_000);
  assert.equal(o.barHeld.length, 2);
  assert.equal(o.barHeld[0].t, 5_000);
  assert.equal(o.barHeld[1].t, 10_000); // clipped at the stop, not 17 s
});

test("Cmd 27 weight target: determinismEnd at the first indeterminate wait", () => {
  // pressure 2 bar (10s ramp) · wait 5s · Cmd 27 "bis 20g".
  const o = buildScriptOverlay("1;13;4 2000 10000;12 5000;27 20;17;7;", 30_000)!;
  assert.equal(o.determinismEndMs, 5_000); // wait fires at t=5s (after the 5s Cmd 12)
  // Stop (30s) is later → solid only until the determinism end.
  assert.equal(o.solidUntilMs, 5_000);
  assert.equal(o.barHeld.length, 2); // damped from 5s to the nominal end
  assert.equal(o.barHeld[0].t, 5_000);
});

test("solidUntil = min(determinismEnd, stop): stop earlier than determinism wins", () => {
  const o = buildScriptOverlay("1;13;4 2000 10000;12 5000;27 20;17;7;", 3_000)!;
  assert.equal(o.determinismEndMs, 5_000);
  assert.equal(o.stopMs, 3_000);
  assert.equal(o.solidUntilMs, 3_000); // stop is earlier
});

test("flow command lands on the flow series", () => {
  const o = buildScriptOverlay("1;13;5 2 8000;12 10000;17;7;", 10_000)!;
  assert.ok(o.flowSolid.length > 0);
  assert.ok(o.flowSolid.some((p) => p.v === 2));
  assert.equal(o.barSolid.length, 0); // no pressure/power command
});
