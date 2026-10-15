/**
 * The lag must not be movable by a single shot.
 *
 * Cases come from the live auto_calibration_log, so "unchanged behaviour" means
 * unchanged against shots that actually happened — not against invented numbers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  nextResidualLagS,
  MIN_LAG_S,
  MAX_LAG_S,
  LAG_STEP_S,
} from "../src/bbw-lag-calibration.js";

describe("residual-lag calibration", () => {
  it("shot 165: the outlier that used to jump 0.75 → 1.10 now moves one step", () => {
    // +1.7 g overshoot at 0.68 g/s asked for a 2.49 s correction — an ideal lag
    // of 3.24 s, above the 2.0 s the band even allows.
    const next = nextResidualLagS({
      currentLagS: 0.75,
      weightErrorG: 1.7,
      flowAtTriggerGs: 0.682456435426575,
    });
    assert.equal(next, 0.8);
  });

  it("shots that already moved by one step are decided exactly as before", () => {
    // shot_id, currentLag, weightError, flow, lag that was actually stored
    const unchanged: [number, number, number, number, number][] = [
      [161, 0.9, -0.6, 1.342747210337, 0.85],
      [162, 0.85, -0.6, 1.25229776424614, 0.8],
      [163, 0.8, -0.2, 1.33489160036884, 0.8],
      [164, 0.8, -0.3, 1.59313651940632, 0.75],
      [166, 1.1, -0.6, 2.44582404607404, 1.05],
      [157, 0.95, -0.9, 2.30981383589979, 0.9],
      [151, 1.05, -0.1, 0.691356049010523, 1.05],
      [149, 1.1, -0.1, 0.58, 1.05],
    ];
    for (const [shot, cur, err, flow, expected] of unchanged) {
      const next = nextResidualLagS({
        currentLagS: cur,
        weightErrorG: err,
        flowAtTriggerGs: flow,
      });
      assert.equal(next, expected, `shot ${shot}`);
    }
  });

  it("shots that used to move two steps at once are damped to one", () => {
    // The old code quantised to the 0.05 grid but never limited the move, so
    // even unremarkable shots could shift the lag twice as far as the grid
    // suggests. These two did.
    const damped: [number, number, number, number, number, number][] = [
      // shot, currentLag, weightError, flow, lag stored then, lag now
      [156, 1.05, -0.9, 1.52868768520415, 0.95, 1.0],
      [140, 0.75, -0.3, 0.55, 0.65, 0.7],
    ];
    for (const [shot, cur, err, flow, before, now] of damped) {
      const next = nextResidualLagS({
        currentLagS: cur,
        weightErrorG: err,
        flowAtTriggerGs: flow,
      });
      assert.equal(next, now, `shot ${shot}`);
      assert.equal(Math.abs(before - cur) > LAG_STEP_S + 1e-9, true, `shot ${shot} premise`);
    }
  });

  it("no shot may move the lag by more than one step", () => {
    for (const cur of [0.1, 0.5, 0.75, 1.05, 1.5, 2.0]) {
      for (const err of [-50, -5, -1.7, -0.1, 0, 0.1, 1.7, 5, 50]) {
        for (const flow of [0.1, 0.3, 0.68, 1.35, 5, 11.4]) {
          const next = nextResidualLagS({
            currentLagS: cur,
            weightErrorG: err,
            flowAtTriggerGs: flow,
          });
          const moved = Math.abs(next - cur);
          assert.ok(
            moved <= LAG_STEP_S + 1e-9,
            `lag=${cur} err=${err} flow=${flow} → ${next} (moved ${moved.toFixed(3)})`,
          );
          assert.ok(next >= MIN_LAG_S && next <= MAX_LAG_S, `${next} out of band`);
        }
      }
    }
  });

  it("an absurd correction still points the right way, it just cannot dominate", () => {
    assert.equal(nextResidualLagS({ currentLagS: 1.0, weightErrorG: 20, flowAtTriggerGs: 0.5 }), 1.05);
    assert.equal(nextResidualLagS({ currentLagS: 1.0, weightErrorG: -20, flowAtTriggerGs: 0.5 }), 0.95);
  });

  it("a shot that hit the target leaves the lag alone", () => {
    assert.equal(nextResidualLagS({ currentLagS: 0.85, weightErrorG: 0, flowAtTriggerGs: 1.4 }), 0.85);
  });

  it("stays inside the band at the edges", () => {
    assert.equal(nextResidualLagS({ currentLagS: MIN_LAG_S, weightErrorG: -10, flowAtTriggerGs: 1 }), MIN_LAG_S);
    assert.equal(nextResidualLagS({ currentLagS: MAX_LAG_S, weightErrorG: 10, flowAtTriggerGs: 1 }), MAX_LAG_S);
  });

  it("recovering from a poisoned lag takes a few shots, and it does recover", () => {
    // 1.05 back down toward ~0.75 with a typical undershooting shot.
    let lag = 1.05;
    for (let i = 0; i < 6; i++) {
      lag = nextResidualLagS({ currentLagS: lag, weightErrorG: -0.6, flowAtTriggerGs: 1.35 });
    }
    assert.equal(lag, 0.75);
  });
});
