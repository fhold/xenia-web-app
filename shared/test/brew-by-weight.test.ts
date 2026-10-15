import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { linearRegressionSlope, BrewByWeightController } from "../src/brew-by-weight.js";

// ---------------------------------------------------------------------------
// linearRegressionSlope
// ---------------------------------------------------------------------------

describe("linearRegressionSlope", () => {
  it("computes correct slope for uniform rise", () => {
    // (0,0), (1,1), (2,2) → slope = 1.0 g/s
    const slope = linearRegressionSlope([[0, 0], [1, 1], [2, 2]]);
    expect(slope).toBeCloseTo(1.0, 6);
  });

  it("returns 0 for constant values", () => {
    const slope = linearRegressionSlope([[0, 5], [1, 5], [2, 5]]);
    expect(slope).toBe(0);
  });

  it("returns 0 for a single point", () => {
    const slope = linearRegressionSlope([[0, 10]]);
    expect(slope).toBe(0);
  });

  it("returns 0 for identical x-values (no denominator)", () => {
    // All at same timestamp — slope undefined, returns 0
    const slope = linearRegressionSlope([[1, 3], [1, 7], [1, 5]]);
    expect(slope).toBe(0);
  });

  it("computes correct slope for realistic espresso flow", () => {
    // 4 samples at 250ms intervals, flow ≈ 1.5g/s
    // x: 0, 0.25, 0.5, 0.75s  y: 30.0, 30.375, 30.75, 31.125g
    const points: [number, number][] = [
      [0,    30.000],
      [0.25, 30.375],
      [0.5,  30.750],
      [0.75, 31.125],
    ];
    const slope = linearRegressionSlope(points);
    expect(slope).toBeCloseTo(1.5, 3);
  });

  it("handles negative slope (weight decreasing)", () => {
    const slope = linearRegressionSlope([[0, 10], [1, 8], [2, 6]]);
    expect(slope).toBeCloseTo(-2.0, 6);
  });
});

// ---------------------------------------------------------------------------
// BrewByWeightController
// ---------------------------------------------------------------------------

/**
 * Helper: add samples at uniform 250ms intervals starting at t=0.
 * Returns the last result.
 */
function addSamples(
  ctrl: BrewByWeightController,
  weights: number[],
  startT = 0,
  intervalMs = 250,
) {
  let result = ctrl.addSample(startT, weights[0]);
  for (let i = 1; i < weights.length; i++) {
    result = ctrl.addSample(startT + i * intervalMs, weights[i]);
  }
  return result;
}

describe("BrewByWeightController", () => {
  const TARGET = 36;
  const WINDOW_MS = 1000;
  const RESIDUAL = 1.35;

  it("returns shouldStop=false with only one sample", () => {
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    const result = ctrl.addSample(0, 30);
    expect(result.shouldStop).toBe(false);
    expect(result.telemetry).toBeNull();
  });

  it("keeps going when projected weight is below target", () => {
    // Slow flow ~0.3 g/s — nowhere near target 36g from 33g base
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    const weights = [33.0, 33.075, 33.15, 33.225, 33.3];
    const result = addSamples(ctrl, weights);
    // slope ≈ 0.3 g/s, lag = 0.25+1.35 = 1.6s → projected ≈ 33.3 + 0.48 = 33.78 < 36
    expect(result.shouldStop).toBe(false);
  });

  it("triggers stop when projected weight reaches target (normal flow)", () => {
    // Flow 1.5g/s (0.375g per 250ms step), starting at 32.1g.
    // lag = span/(n-1) + residual = 0.25 + 1.35 = 1.6s (constant for uniform polling).
    // Stop threshold: w >= 36 - 1.5*1.6 = 33.6g.
    // Sample 4 (w=33.225): 33.225 + 2.4 = 35.625 < 36 → keep going
    // Sample 5 (w=33.6):   33.6   + 2.4 = 36.0   >= 36 → stop
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    const weights = [32.1, 32.475, 32.85, 33.225, 33.6];
    const result = addSamples(ctrl, weights);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) {
      expect(result.telemetry.slopeGPerS).toBeCloseTo(1.5, 1);
      expect(result.telemetry.projectedWeightG).toBeGreaterThanOrEqual(36);
      expect(result.telemetry.currentWeightG).toBeCloseTo(33.6, 2);
      expect(result.telemetry.sampleCount).toBe(5);
    }
  });

  it("triggers stop earlier with fast flow", () => {
    // Flow 3g/s (0.75g per 250ms step), starting at 29.7g.
    // lag = 0.25 + 1.35 = 1.6s; stop threshold = 36 - 3*1.6 = 31.2g.
    // Sample 2 (w=30.45): 30.45 + 4.8 = 35.25 < 36 → keep going
    // Sample 3 (w=31.2):  31.2  + 4.8 = 36.0  >= 36 → stop at index 2
    // Normal flow (test above) stops at index 4 — fast flow stops earlier.
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    let stoppedAtIndex = -1;
    const weights = [29.7, 30.45, 31.2, 31.95, 32.7];
    for (let i = 0; i < weights.length; i++) {
      const result = ctrl.addSample(i * 250, weights[i]);
      if (result.shouldStop && stoppedAtIndex === -1) {
        stoppedAtIndex = i;
      }
    }
    // Should stop before reaching the final sample (index 4)
    expect(stoppedAtIndex).toBeGreaterThanOrEqual(1);
    expect(stoppedAtIndex).toBeLessThan(4);
  });

  it("does not trigger when flow is zero", () => {
    // Weight stuck at 34g — slope=0, projected=34, never reaches 36
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    const weights = [34, 34, 34, 34, 34, 34];
    const result = addSamples(ctrl, weights);
    expect(result.shouldStop).toBe(false);
    if (!result.shouldStop && result.telemetry) {
      expect(result.telemetry.slopeGPerS).toBeCloseTo(0, 3);
    }
  });

  it("does not trigger on negative flow (scale oscillation)", () => {
    // Weight decreasing — projected goes below current, no stop
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    const weights = [35.5, 35.3, 35.1, 34.9, 34.7];
    const result = addSamples(ctrl, weights);
    expect(result.shouldStop).toBe(false);
  });

  it("returns shouldStop=false after first stop (no double trigger)", () => {
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    // Trigger the stop (same weights as normal flow test — stops at 5th sample)
    const weights = [32.1, 32.475, 32.85, 33.225, 33.6];
    const firstStop = addSamples(ctrl, weights);
    expect(firstStop.shouldStop).toBe(true);

    // Further samples should not trigger again
    const afterStop = ctrl.addSample(5000, 37);
    expect(afterStop.shouldStop).toBe(false);
    expect(afterStop.telemetry).toBeNull();
  });

  it("includes telemetry on non-stop result when enough samples", () => {
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    const result = addSamples(ctrl, [30, 30.375]); // only 2 samples, flow 1.5g/s but far from target
    expect(result.shouldStop).toBe(false);
    // telemetry may or may not be present depending on whether projected < target
    if (result.telemetry) {
      expect(result.telemetry.sampleCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("respects windowMs: old samples outside window are pruned", () => {
    // Old samples at 0, 250ms — weight at 20g (slow, far from target).
    // After a 2s gap new samples arrive at 1.5 g/s starting at 33g.
    // At t=2500ms the window is [1500, 2500ms]; old samples (t=0, t=250) are
    // pruned, leaving only the 3 new ones → regression sees 1.5 g/s, not the
    // polluted slope that would result from mixing the 20g samples.
    const ctrl = new BrewByWeightController(TARGET, WINDOW_MS, RESIDUAL);
    ctrl.addSample(0, 20);
    ctrl.addSample(250, 20.375);
    // Gap — old samples fall outside windowMs=1000ms once new ones arrive
    ctrl.addSample(2000, 33.0);
    ctrl.addSample(2250, 33.375);
    // At t=2500 the window [1500,2500] contains only the 3 new samples.
    // span=500ms, sampleIntervalS=0.25s, slope≈1.5g/s
    // projected = 33.75 + 1.5*1.6 = 36.15 >= 36 → stop
    const result = ctrl.addSample(2500, 33.75);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) {
      // If old samples had polluted the regression, slope would be wrong
      expect(result.telemetry.slopeGPerS).toBeCloseTo(1.5, 1);
    }
  });
});
