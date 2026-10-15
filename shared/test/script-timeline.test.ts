/**
 * Unit tests for scriptToTimeline (SE-2b — corrected ramp/wait model).
 *
 * Runner: node:test — run with `node --import tsx --test`.
 * Model (Xenia doc https://www.xenia-espresso.de/support-db-scripte/):
 * pump commands are fire-and-forget (don't advance time); only Cmd 12 + the
 * indeterminate waits (25/27) advance the cursor; a pump command ramps to its
 * target over ramp_dur and the FOLLOWING wait is the phase window.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScript } from "../src/script-parser.js";
import { scriptToTimeline, powerToBar } from "../src/script-timeline.js";

const tl = (s: string) => scriptToTimeline(parseScript(s));

test("powerToBar saturating curve hits the anchors (0→0, 75→9, 100→10)", () => {
  assert.equal(powerToBar(0), 0);
  assert.equal(powerToBar(75), 9);
  assert.equal(powerToBar(100), 10);
  assert.ok(powerToBar(20) > 4.2 && powerToBar(20) < 4.4); // ~4.29
});

test("BINDING — Declining: wait drives the axis (66 s), ramps not steps", () => {
  // 1;13;4 9000 3000;12 6000;3 20 35000;12 60000;17;7;
  const t = tl("1;13;4 9000 3000;12 6000;3 20 35000;12 60000;17;7;");
  // Nominal time = sum of WAITS only (6000 + 60000), not command durations.
  assert.equal(t.totalMs, 66_000);
  assert.equal(t.phases.length, 2);

  // Phase 1 [0–6 s], pressure: ramp 0→9 bar over 3 s, then hold 3 s.
  const p1 = t.phases[0];
  assert.equal(p1.mode, "pressure");
  assert.equal(p1.tStart, 0);
  assert.equal(p1.tEnd, 6_000);
  assert.equal(p1.startValue, 0);
  assert.equal(p1.targetValue, 9);
  assert.equal(p1.endValue, 9);
  assert.equal(p1.rampDurMs, 3_000);
  assert.equal(p1.rampEndT, 3_000);
  assert.equal(p1.truncated, false);
  assert.equal(p1.noWait, false);

  // Phase 2 [6–66 s], power: commanded 20 %, displayed in BAR via powerToBar,
  // and — crucially — it ramps DOWN from the previous 9 bar (continuity, no V).
  const p2 = t.phases[1];
  assert.equal(p2.mode, "power");
  assert.equal(p2.axis, "bar");
  assert.equal(p2.tStart, 6_000);
  assert.equal(p2.tEnd, 66_000);
  assert.equal(p2.rawTarget, 20); // the actual command (for the label)
  assert.equal(p2.startValue, 9); // continues from the 9-bar phase, NOT 0
  assert.ok(p2.targetValue > 4.2 && p2.targetValue < 4.4); // powerToBar(20) ≈ 4.29 bar
  assert.ok(p2.targetValue < p2.startValue); // declining
  assert.equal(p2.rampEndT, 41_000); // 6000 + min(35000, 60000)
});

test("ramp truncated when ramp_dur > window", () => {
  // 5 ml/s ramp over 8 s but only a 4 s wait follows → cut at 4 s, reaches 1.
  const t = tl("1;13;5 2 8000;12 4000;17;7;");
  const p = t.phases[0];
  assert.equal(p.mode, "flow");
  assert.equal(p.truncated, true);
  assert.equal(p.tEnd, 4_000);
  assert.equal(p.targetValue, 2);
  assert.equal(p.endValue, 1); // 0 + (2-0)*(4000/8000)
});

test("clean flow phase (window ≥ ramp): ramp then hold", () => {
  const t = tl("1;13;5 2 8000;12 10000;17;7;");
  const p = t.phases[0];
  assert.equal(p.mode, "flow");
  assert.equal(p.targetValue, 2);
  assert.equal(p.endValue, 2);
  assert.equal(p.rampEndT, 8_000);
  assert.equal(p.tEnd, 10_000);
  assert.equal(p.truncated, false);
});

test("pump command with no following wait → noWait flag (overwritten)", () => {
  // Two pressure commands back-to-back, no wait between → first is window 0.
  const t = tl("1;13;4 6000 2000;4 9000 2000;12 5000;17;7;");
  assert.equal(t.phases[0].noWait, true);
  assert.equal(t.phases[0].tEnd, t.phases[0].tStart);
  assert.equal(t.phases[1].noWait, false);
  // Overridden first stage does not carry value → second starts from 0.
  assert.equal(t.phases[1].startValue, 0);
});

test("Decaf: stages without a Wait are overridden and don't carry value", () => {
  // 4 pressure stages, NO Cmd 12 between → first three are noWait (immediately
  // overridden); only the last (4 bar) runs, and it starts from 0 (the 2.5/6.5/5
  // stages never moved the pump). cmdIndex lets the breakdown flag them.
  const t = tl("1;13;4 2500 13000;4 6500 8000;4 5000 12000;4 4000 30000;12 80000;17;7;");
  assert.equal(t.phases.length, 4);
  assert.deepEqual(t.phases.map((p) => p.noWait), [true, true, true, false]);
  assert.equal(t.phases[3].startValue, 0);
  assert.equal(t.phases[3].targetValue, 4);
  assert.equal(t.phases[3].tEnd, 80_000);
  assert.equal(t.phases[0].cmdIndex, 2);
});

test("pump off (Blooming): drops to 0 and the next ramp restarts from 0", () => {
  const t = tl("1;13;4 6000 3000;12 9000;6;12 30000;4 8000 3000;12 35000;17;7;");
  assert.equal(t.phases.length, 3);
  assert.equal(t.phases[1].label, "Pumpe aus");
  assert.equal(t.phases[1].targetValue, 0);
  assert.equal(t.phases[2].startValue, 0); // restarts from 0 after pump off
  assert.equal(t.phases[2].targetValue, 8);
});

test("Cmd 27 weight wait: indeterminate band, pump value holds through", () => {
  const t = tl("1;12 1000;13;4 2000 10000;27 20;17;7;");
  assert.equal(t.waits.length, 1);
  assert.equal(t.waits[0].kind, "weight");
  assert.equal(t.waits[0].label, "bis 20 g");
  // The pressure phase spans across the indeterminate band, holding its target.
  assert.equal(t.phases[0].mode, "pressure");
  assert.equal(t.phases[0].targetValue, 2);
});

test("Cmd 25 temp + Cmd 31: temp annotation + 'bis X °C' wait + restore marker", () => {
  const t = tl("1;25 93;4 9000 30000;12 30000;31;17;7;");
  assert.equal(t.tempSetpoints.length, 1);
  assert.equal(t.tempSetpoints[0].value, 93);
  assert.equal(t.waits.some((w) => w.kind === "temp" && w.label === "bis 93 °C"), true);
  assert.equal(t.markers.some((m) => m.kind === "restore_temp"), true);
  assert.equal(t.phases[0].mode, "pressure");
  assert.equal(t.phases[0].targetValue, 9);
});

test("limits (Cmd 29/30) are reference values, not phases", () => {
  const t = tl("1;29 9;30 2.5;13;4 6000 20000;12 20000;17;7;");
  assert.equal(t.pressureLimitBar, 9);
  assert.equal(t.flowLimitMlS, 2.5);
  assert.equal(t.phases.length, 1);
});

test("robust: empty / null → empty timeline; unknown cmd → marker", () => {
  assert.equal(scriptToTimeline(null).phases.length, 0);
  assert.equal(scriptToTimeline(parseScript("")).totalMs, 0);
  const u = tl("1;99;7;");
  assert.equal(u.markers.some((m) => m.kind === "unknown" && m.label === "Cmd 99"), true);
});
