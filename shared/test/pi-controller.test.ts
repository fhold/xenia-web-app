/**
 * Unit tests for the flow-hold PI controller (Consistent-Flow, Phase 1).
 *
 * Runner: node:test (NOT vitest) — run with `node --import tsx --test`.
 * These pin the pure decision logic: proportional/integral response direction,
 * clamping, anti-windup (conditional integration), EMA smoothing, and the
 * bumpless seed() hand-off from the open-loop ramp.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PIController, type PIControllerConfig } from "../src/pi-controller.js";

const CONFIG: PIControllerConfig = {
  kp: 4.0,
  ki: 2.0,
  setpoint: 2.0,
  outMin: 50,
  outMax: 100,
  emaAlpha: 0.3,
};

/** A controller with no EMA smoothing (alpha=1) so measurements pass verbatim. */
function rawController(over: Partial<PIControllerConfig> = {}): PIController {
  return new PIController({ ...CONFIG, emaAlpha: 1, ...over });
}

// ---------------------------------------------------------------------------
// Construction guards
// ---------------------------------------------------------------------------

test("constructor rejects outMin > outMax", () => {
  assert.throws(
    () => new PIController({ ...CONFIG, outMin: 100, outMax: 50 }),
    /outMin/,
  );
});

// ---------------------------------------------------------------------------
// Direction & terms
// ---------------------------------------------------------------------------

test("flow below setpoint raises output (direct-acting)", () => {
  const pi = rawController();
  pi.seed(60);
  // measured 1.0 < setpoint 2.0 → error +1.0 → output above the seed
  const step = pi.update(1.0, 1000);
  assert.equal(step.error, 1.0);
  assert.ok(step.output > 60, `expected >60, got ${step.output}`);
});

test("flow above setpoint lowers output", () => {
  const pi = rawController();
  pi.seed(60);
  const step = pi.update(3.0, 1000);
  assert.equal(step.error, -1.0);
  assert.ok(step.output < 60, `expected <60, got ${step.output}`);
});

test("at setpoint output equals seeded operating point", () => {
  const pi = rawController();
  pi.seed(70);
  const step = pi.update(2.0, 1000);
  assert.equal(step.error, 0);
  assert.equal(step.pTerm, 0);
  // seed set integral so ki·integral == 70 at zero error
  assert.ok(Math.abs(step.output - 70) < 1e-9, `expected ~70, got ${step.output}`);
});

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

test("shift verschiebt den Arbeitspunkt — bei Fehler null folgt der Ausgang, begrenzt wie der Ausgang", () => {
  const c = rawController({ outMin: 15, outMax: 100 });
  c.seed(60);
  c.shift(-5);
  assert.equal(c.update(2.0, 400).output, 55);
  c.shift(-100);
  assert.equal(c.update(2.0, 400).output, 15, "nicht unter die Untergrenze aufziehen");
  c.shift(10);
  assert.equal(c.update(2.0, 400).output, 25, "von der Grenze aus sofort wieder nach oben");
});

test("output clamps to outMax and flags saturation", () => {
  const pi = rawController();
  pi.seed(100);
  const step = pi.update(0.0, 1000); // huge positive error
  assert.equal(step.output, 100);
  assert.equal(step.saturated, true);
});

test("output clamps to outMin and flags saturation", () => {
  const pi = rawController();
  pi.seed(50);
  const step = pi.update(10.0, 1000); // huge negative error
  assert.equal(step.output, 50);
  assert.equal(step.saturated, true);
});

// ---------------------------------------------------------------------------
// Anti-windup (conditional integration)
// ---------------------------------------------------------------------------

test("integral frozen while saturated high and error still positive", () => {
  const pi = rawController();
  pi.seed(100);
  const a = pi.update(0.0, 1000); // saturated at max, error +2 pushes into rail
  const b = pi.update(0.0, 1000);
  // Integral must not grow while pinned at the upper rail against a positive error.
  assert.equal(a.integral, b.integral);
});

test("integral releases as soon as error reverses off the rail", () => {
  const pi = rawController();
  pi.seed(100);
  const pinned = pi.update(0.0, 1000).integral; // wound against upper rail (frozen)
  const released = pi.update(4.0, 1000).integral; // error -2 → not pushing into rail
  assert.ok(released < pinned, `integral should decrease: ${pinned} -> ${released}`);
});

// ---------------------------------------------------------------------------
// EMA smoothing
// ---------------------------------------------------------------------------

test("first measurement after seed is taken verbatim (ema reset)", () => {
  const pi = new PIController({ ...CONFIG, emaAlpha: 0.3 });
  pi.seed(60);
  const step = pi.update(1.0, 1000);
  assert.equal(step.smoothedInput, 1.0);
});

test("ema blends subsequent measurements toward the new value", () => {
  const pi = new PIController({ ...CONFIG, emaAlpha: 0.3 });
  pi.seed(60);
  pi.update(1.0, 1000); // ema = 1.0
  const step = pi.update(2.0, 1000); // 0.3*2 + 0.7*1 = 1.3
  assert.ok(Math.abs(step.smoothedInput - 1.3) < 1e-9, `got ${step.smoothedInput}`);
});

// ---------------------------------------------------------------------------
// Convergence — closed loop against a simple plant
// ---------------------------------------------------------------------------

test("closed loop converges flow toward setpoint", () => {
  const pi = rawController();
  pi.seed(55);
  // Toy plant: flow rises with power. flow = (power - 40) * 0.05 g/s.
  // At setpoint 2.0 g/s the required power is 80%.
  let power = 55;
  let flow = (power - 40) * 0.05;
  for (let i = 0; i < 200; i++) {
    const step = pi.update(flow, 200);
    power = step.output;
    flow = (power - 40) * 0.05;
  }
  assert.ok(Math.abs(flow - 2.0) < 0.05, `flow did not converge: ${flow}`);
});

// ---------------------------------------------------------------------------
// Asymmetric slew limit (anti-gush)
// ---------------------------------------------------------------------------

test("slewUpPerS caps how fast the output may rise", () => {
  const pi = rawController({ slewUpPerS: 5 });
  pi.seed(60);
  // Big positive error would jump the output well past the seed; slew caps it.
  const step = pi.update(0.0, 1000); // 1s → max +5
  assert.equal(step.output, 65);
});

test("slewDownPerS caps how fast the output may fall", () => {
  const pi = rawController({ slewDownPerS: 5 });
  pi.seed(60);
  const step = pi.update(10.0, 1000); // big negative error, 1s → max -5
  assert.equal(step.output, 55);
});

test("slew is asymmetric — falls faster than it rises", () => {
  const up = rawController({ slewUpPerS: 5, slewDownPerS: 40 });
  up.seed(60);
  const rise = up.update(0.0, 1000).output - 60; // capped rise

  const down = rawController({ slewUpPerS: 5, slewDownPerS: 40 });
  down.seed(60);
  const drop = 60 - down.update(10.0, 1000).output; // faster drop

  assert.ok(rise === 5, `rise should be +5, got ${rise}`);
  assert.ok(drop > rise, `drop (${drop}) should exceed rise (${rise})`);
});

test("slew limit scales with dt", () => {
  const pi = rawController({ slewUpPerS: 5 });
  pi.seed(60);
  const step = pi.update(0.0, 500); // 0.5s → max +2.5
  assert.equal(step.output, 62.5);
});

test("integral does not wind up against the slew limit", () => {
  const pi = rawController({ slewUpPerS: 5 });
  pi.seed(60);
  const a = pi.update(0.0, 1000); // slew-limited to 65, error still +2 (into the limit)
  const b = pi.update(0.0, 1000); // slew-limited to 70
  // Frozen while limited and the error pushes further into the slew rail.
  assert.equal(a.integral, b.integral);
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

test("reset clears integral and ema", () => {
  const pi = rawController();
  pi.seed(80);
  pi.update(0.5, 1000);
  pi.reset();
  // After reset the integral is 0, so at zero error the output is just pTerm (0).
  const step = pi.update(2.0, 1000);
  assert.equal(step.integral, 0);
  assert.equal(step.output, CONFIG.outMin); // 0 clamps up to floor
});
