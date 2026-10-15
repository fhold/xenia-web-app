/**
 * Guard for the mid-brew scale dropout detector (shared/src/scale-stall.ts).
 *
 * The reference case is shot #158 (02.08.): the BOOKOO stopped reporting at
 * 15.5 s — weight stuck at 13.0 g, rate exactly 0.0 — while pressure and pump
 * kept working. The counter-cases matter just as much: blooms and pressure
 * ramps also show a flat weight and must never be mistaken for a dropout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trackScaleStall,
  initialScaleStallState,
  SCALE_STALL_MS,
  type ScaleStallState,
} from "../src/scale-stall.js";

/** Feed n frames 400 ms apart, starting at t0. */
function feed(
  state: ScaleStallState,
  t0: number,
  n: number,
  frame: { weightG: number | null; flowGs: number | null; pumpPwm: number | null; pressureBar: number | null },
): { state: ScaleStallState; endedAt: number } {
  let s = state;
  let now = t0;
  for (let i = 0; i < n; i++) {
    s = trackScaleStall({ now, ...frame }, s);
    now += 400;
  }
  return { state: s, endedAt: now - 400 };
}

test("a healthy extraction never looks like a dropout", () => {
  let s = initialScaleStallState();
  let w = 3.3;
  for (let now = 9000; now < 30000; now += 400) {
    s = trackScaleStall({ now, weightG: w, flowGs: 1.8, pumpPwm: 52, pressureBar: 6.5 }, s);
    w += 0.7;
  }
  assert.equal(s.everStalled, false);
});

test("shot #158: weight and rate die together while the pump pushes", () => {
  const frame = { weightG: 13.0, flowGs: 0, pumpPwm: 60, pressureBar: 8.3 };

  // Just under the dwell time — not yet confirmed.
  const short = feed(initialScaleStallState(), 15807, 7, frame); // 2.4 s
  assert.equal(short.state.stalled, false, "confirmed too early");

  const long = feed(initialScaleStallState(), 15807, 9, frame); // 3.2 s
  assert.equal(long.state.stalled, true, "dropout not detected");
  assert.equal(long.state.everStalled, true);
  assert.equal(long.state.frozenAtG, 13.0);
  assert.ok(long.endedAt - 15807 >= SCALE_STALL_MS);
});

test("a bloom with the pump off is not a dropout", () => {
  const { state } = feed(initialScaleStallState(), 20000, 40, {
    weightG: 15.5,
    flowGs: 0,
    pumpPwm: 0,
    pressureBar: 0,
  });
  assert.equal(state.everStalled, false);
});

test("a pressure ramp before the first drop is not a dropout", () => {
  // Pump at 100 %, pressure climbing, weight flat — but the scale still reports
  // rate noise, which is what separates it from a dead scale (#174).
  let s = initialScaleStallState();
  let now = 15484;
  for (const rate of [0.02, 0.03, 0.01, 0.01, 0.02, 0.01, 0.02, 0.03, 0.01, 0.02]) {
    s = trackScaleStall({ now, weightG: 5.9, flowGs: rate, pumpPwm: 100, pressureBar: 4.1 }, s);
    now += 400;
  }
  assert.equal(s.everStalled, false);
});

test("the scale coming back clears the stall but not the record of it", () => {
  const dropout = feed(initialScaleStallState(), 15807, 12, {
    weightG: 13.0,
    flowGs: 0,
    pumpPwm: 60,
    pressureBar: 8.3,
  });
  assert.equal(dropout.state.stalled, true);

  const back = trackScaleStall(
    { now: 21000, weightG: 27.4, flowGs: 1.6, pumpPwm: 55, pressureBar: 8.0 },
    dropout.state,
  );
  assert.equal(back.stalled, false, "stall should clear once the scale reports again");
  assert.equal(back.everStalled, true, "the dropout must stay on the record");
});
