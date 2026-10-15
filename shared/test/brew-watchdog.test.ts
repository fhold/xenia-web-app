/**
 * Unit tests for the BBW safety watchdog trigger logic (Spec §4.12 / Auftrag 3m).
 *
 * Runner: node:test (NOT vitest) — run with `node --import tsx --test`.
 * The real FW actuation outlier cannot be triggered on demand, so these tests
 * pin the pure decision logic: stop-lag threshold, overshoot threshold, re-fire
 * throttling, escalation, and the arming guards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWatchdog,
  WATCHDOG_REFIRE_INTERVAL_MS,
  WATCHDOG_ESCALATE_AFTER_MS,
  WATCHDOG_GRACE_MS,
  type WatchdogConfig,
  type WatchdogFrameInput,
  type WatchdogState,
} from "../src/brew-watchdog.js";

const CONFIG: WatchdogConfig = {
  enabled: true,
  stopLagMs: 3000,
  overshootG: 7,
  refireIntervalMs: WATCHDOG_REFIRE_INTERVAL_MS,
  escalateAfterMs: WATCHDOG_ESCALATE_AFTER_MS,
  graceMs: WATCHDOG_GRACE_MS,
};

const FRESH: WatchdogState = { firstFiredAt: null, lastRefireAt: null };

/** A baseline brewing frame with BBW armed, a stop sent at t=0, no overshoot.
 *  brewElapsedMs defaults past the grace period so trigger tests are unaffected. */
function frame(over: Partial<WatchdogFrameInput> = {}): WatchdogFrameInput {
  return {
    now: 0,
    machineStatus: 3,
    bbwArmed: true,
    bbwStopSentAt: 0,
    plausibleWeightG: 20,
    yieldTargetG: 25,
    brewElapsedMs: 30_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Arming guards
// ---------------------------------------------------------------------------

test("disabled config never fires", () => {
  const d = evaluateWatchdog(
    frame({ now: 10_000 }),
    { ...CONFIG, enabled: false },
    FRESH,
  );
  assert.equal(d.triggered, false);
  assert.equal(d.shouldFire, false);
});

test("not armed never fires (even with a huge lag)", () => {
  const d = evaluateWatchdog(frame({ now: 10_000, bbwArmed: false }), CONFIG, FRESH);
  assert.equal(d.triggered, false);
});

test("machine no longer brewing never fires", () => {
  const d = evaluateWatchdog(frame({ now: 10_000, machineStatus: 4 }), CONFIG, FRESH);
  assert.equal(d.triggered, false);
});

// ---------------------------------------------------------------------------
// Start-up grace period (scale-tare race) — see WATCHDOG_GRACE_MS
// ---------------------------------------------------------------------------

test("within grace: overshoot does NOT fire (un-tared residual weight)", () => {
  // The bug: scale not yet zeroed → residual weight reads as a huge overshoot.
  const d = evaluateWatchdog(
    frame({ brewElapsedMs: WATCHDOG_GRACE_MS - 1, plausibleWeightG: 200, yieldTargetG: 25, bbwStopSentAt: null }),
    CONFIG,
    FRESH,
  );
  assert.equal(d.triggered, false);
  assert.equal(d.shouldFire, false);
});

test("within grace: stop-lag does NOT fire either", () => {
  const d = evaluateWatchdog(
    frame({ brewElapsedMs: 2_000, now: 10_000, bbwStopSentAt: 0 }),
    CONFIG,
    FRESH,
  );
  assert.equal(d.triggered, false);
});

test("at the grace boundary: overshoot fires", () => {
  const d = evaluateWatchdog(
    frame({ brewElapsedMs: WATCHDOG_GRACE_MS, plausibleWeightG: 200, yieldTargetG: 25, bbwStopSentAt: null }),
    CONFIG,
    FRESH,
  );
  assert.equal(d.triggered, true);
  assert.deepEqual(d.reasons, ["overshoot"]);
});

// ---------------------------------------------------------------------------
// Stop-lag trigger
// ---------------------------------------------------------------------------

test("stop-lag below threshold does not fire (normal 985ms-style stop)", () => {
  const d = evaluateWatchdog(frame({ now: 985 }), CONFIG, FRESH);
  assert.equal(d.triggered, false);
  assert.equal(d.sinceStopMs, 985);
});

test("stop-lag exactly at threshold does not fire (strictly greater)", () => {
  const d = evaluateWatchdog(frame({ now: 3000 }), CONFIG, FRESH);
  assert.equal(d.triggered, false);
});

test("stop-lag past threshold fires with reason stop_lag (the #46 case)", () => {
  const d = evaluateWatchdog(frame({ now: 3001 }), CONFIG, FRESH);
  assert.equal(d.triggered, true);
  assert.equal(d.shouldFire, true);
  assert.deepEqual(d.reasons, ["stop_lag"]);
});

test("stop-lag inert when no stop was ever sent", () => {
  const d = evaluateWatchdog(
    frame({ now: 60_000, bbwStopSentAt: null, plausibleWeightG: 20 }),
    CONFIG,
    FRESH,
  );
  assert.equal(d.triggered, false);
  assert.equal(d.sinceStopMs, null);
});

// ---------------------------------------------------------------------------
// Overshoot trigger
// ---------------------------------------------------------------------------

test("overshoot below threshold does not fire", () => {
  // 25 + 7 = 32 bound; 31 is under.
  const d = evaluateWatchdog(
    frame({ now: 500, bbwStopSentAt: null, plausibleWeightG: 31 }),
    CONFIG,
    FRESH,
  );
  assert.equal(d.triggered, false);
});

test("overshoot past threshold fires with reason overshoot", () => {
  // 25 + 7 = 32 bound; 35.2 is the #46 final weight.
  const d = evaluateWatchdog(
    frame({ now: 500, bbwStopSentAt: null, plausibleWeightG: 35.2 }),
    CONFIG,
    FRESH,
  );
  assert.equal(d.triggered, true);
  assert.equal(d.shouldFire, true);
  assert.deepEqual(d.reasons, ["overshoot"]);
  assert.ok(Math.abs((d.overshootG ?? 0) - 10.2) < 1e-9);
});

test("overshoot uses plausible weight only — null weight cannot trigger", () => {
  const d = evaluateWatchdog(
    frame({ now: 500, bbwStopSentAt: null, plausibleWeightG: null }),
    CONFIG,
    FRESH,
  );
  assert.equal(d.triggered, false);
});

test("both triggers can be reported together", () => {
  const d = evaluateWatchdog(
    frame({ now: 4000, bbwStopSentAt: 0, plausibleWeightG: 40 }),
    CONFIG,
    FRESH,
  );
  assert.deepEqual(d.reasons, ["stop_lag", "overshoot"]);
});

// ---------------------------------------------------------------------------
// Re-fire throttle
// ---------------------------------------------------------------------------

test("re-fire throttled within the interval", () => {
  // Triggered, but last re-fire was 200ms ago (< 500ms interval).
  const d = evaluateWatchdog(frame({ now: 3200 }), CONFIG, {
    firstFiredAt: 3001,
    lastRefireAt: 3000,
  });
  assert.equal(d.triggered, true);
  assert.equal(d.shouldFire, false, "should wait out the throttle window");
});

test("re-fire allowed once the interval elapsed", () => {
  const d = evaluateWatchdog(frame({ now: 3600 }), CONFIG, {
    firstFiredAt: 3001,
    lastRefireAt: 3001,
  });
  assert.equal(d.shouldFire, true);
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

test("escalates once firing longer than escalateAfterMs", () => {
  // First fired at 3001; now 8100 → > 5000ms later.
  const d = evaluateWatchdog(frame({ now: 8100 }), CONFIG, {
    firstFiredAt: 3001,
    lastRefireAt: 3001,
  });
  assert.equal(d.escalate, true);
  assert.equal(d.shouldFire, true, "keeps firing while escalated");
});

test("does not escalate before the threshold", () => {
  const d = evaluateWatchdog(frame({ now: 5000 }), CONFIG, {
    firstFiredAt: 3001,
    lastRefireAt: 3001,
  });
  assert.equal(d.escalate, false);
});

test("first fire is never escalated (no firstFiredAt yet)", () => {
  const d = evaluateWatchdog(frame({ now: 60_000 }), CONFIG, FRESH);
  assert.equal(d.triggered, true);
  assert.equal(d.shouldFire, true);
  assert.equal(d.escalate, false);
});
