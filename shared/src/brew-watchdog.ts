/**
 * BBW safety watchdog (Spec §4.12 / Auftrag 3m) — pure trigger logic.
 *
 * Background: diagnosis 3k established that the machine ACKs `GET
 * /api/v2/scripts/stop` with HTTP 200 but actuates it intermittently with up to
 * ~12 s delay (firmware actuation, not the app). The normal BBW path therefore
 * believes it stopped (stop_mode='app') while the pump keeps dispensing. The
 * watchdog is the app-side mitigation: while BBW is armed it watches for a stop
 * that did not take effect and RE-FIRES the same stop command (never
 * machineControl / power-off), throttled, until the machine leaves the brew.
 *
 * Two independent triggers (either one fires the watchdog):
 *   1. stop-lag — a BBW stop was sent (bbwStopSentAt set) and the machine is
 *      still brewing (MA_STATUS=3) more than `stopLagMs` later.
 *   2. overshoot — the plausibility-checked weight exceeds target + `overshootG`.
 *      Guarded against the wrap-around scale glitch by using the plausible
 *      weight, NOT the raw frame value.
 *
 * Start-up grace period: the machine tares the scale a moment AFTER the brew
 * starts. Until that tare lands, the scale can still read a residual weight that
 * the overshoot trigger would misread as "too much yield" and fire prematurely
 * (3r-followup bug). The watchdog therefore stays inactive for the first
 * `graceMs` of the brew — a real brew that BBW would stop is never < ~10 s.
 *
 * Deliberately NO absolute time cap: the firmware's ~120 s pump limit is the
 * last-resort ceiling, so the watchdog keeps re-firing rather than giving up.
 *
 * This module is pure (no I/O, no clock) so the trigger logic is unit-testable
 * in isolation; the ShotRecorder owns the side effects (sending the stop,
 * logging, stop_mode) and the per-shot state.
 */

/** Re-fire cadence while the machine is still brewing (ms). */
export const WATCHDOG_REFIRE_INTERVAL_MS = 500;

/** After this long still brewing since the first watchdog fire, escalate the
 *  log level — something is seriously wrong — but keep firing. */
export const WATCHDOG_ESCALATE_AFTER_MS = 5_000;

/** Start-up grace: the watchdog stays inactive for this long after brew start,
 *  so the scale tare (which lands shortly after the brew begins) can settle
 *  before the overshoot trigger reads the weight. A real BBW-stopped brew is
 *  never this short. */
export const WATCHDOG_GRACE_MS = 10_000;

export interface WatchdogConfig {
  /** brew_by_weight_watchdog_enabled (default true). */
  enabled: boolean;
  /** brew_by_weight_watchdog_stop_lag_ms (default 3000). */
  stopLagMs: number;
  /** brew_by_weight_watchdog_overshoot_g (default 7). */
  overshootG: number;
  /** Re-fire throttle; normally WATCHDOG_REFIRE_INTERVAL_MS. */
  refireIntervalMs: number;
  /** Escalation threshold; normally WATCHDOG_ESCALATE_AFTER_MS. */
  escalateAfterMs: number;
  /** Start-up grace period; normally WATCHDOG_GRACE_MS. */
  graceMs: number;
}

/** Per-shot watchdog state owned by the recorder, passed in each evaluation. */
export interface WatchdogState {
  /** Timestamp of the first watchdog fire this shot, or null if not yet fired. */
  firstFiredAt: number | null;
  /** Timestamp of the most recent re-fire, or null if not yet fired. */
  lastRefireAt: number | null;
}

export interface WatchdogFrameInput {
  /** Current time (ms). */
  now: number;
  /** MA_STATUS from the frame (3 = brewing). */
  machineStatus: number;
  /** Whether the BBW controller is armed for this shot (bbwController !== null). */
  bbwArmed: boolean;
  /** When the BBW stop was first sent this shot, or null if not sent. */
  bbwStopSentAt: number | null;
  /** Plausibility-checked weight (NOT the raw frame value), or null. */
  plausibleWeightG: number | null;
  /** Yield target (g) for this shot, or null. */
  yieldTargetG: number | null;
  /** ms since the brew started (now − brew start) — gates the start-up grace. */
  brewElapsedMs: number;
}

export type WatchdogReason = "stop_lag" | "overshoot";

export interface WatchdogDecision {
  /** True if at least one trigger condition is currently met. */
  triggered: boolean;
  /** True if the watchdog should (re-)send the stop now (triggered + throttle ok). */
  shouldFire: boolean;
  /** Which condition(s) are met — for logging. */
  reasons: WatchdogReason[];
  /** ms since the BBW stop was sent (if any) — for logging. */
  sinceStopMs: number | null;
  /** Overshoot in g (weight − target) when the overshoot trigger is met, else null. */
  overshootG: number | null;
  /** True once the watchdog has been firing longer than escalateAfterMs without
   *  the machine leaving the brew — raise the log level (but keep firing). */
  escalate: boolean;
}

const INACTIVE: WatchdogDecision = {
  triggered: false,
  shouldFire: false,
  reasons: [],
  sinceStopMs: null,
  overshootG: null,
  escalate: false,
};

/**
 * Evaluate the watchdog for one frame. Pure — no I/O, no clock; `now` is passed
 * in. Returns whether a trigger is met and whether to (re-)fire the stop now.
 */
export function evaluateWatchdog(
  input: WatchdogFrameInput,
  config: WatchdogConfig,
  state: WatchdogState,
): WatchdogDecision {
  // Armed only while BBW is armed, the watchdog is enabled, and the machine is
  // still brewing. Anything else → inactive (no false fires post-brew).
  if (!config.enabled || !input.bbwArmed || input.machineStatus !== 3) {
    return INACTIVE;
  }

  // Start-up grace: stay inactive until the scale tare has had time to settle,
  // so a not-yet-zeroed residual weight can't trip the overshoot trigger.
  if (input.brewElapsedMs < config.graceMs) {
    return INACTIVE;
  }

  const reasons: WatchdogReason[] = [];

  const sinceStopMs =
    input.bbwStopSentAt !== null ? input.now - input.bbwStopSentAt : null;
  if (sinceStopMs !== null && sinceStopMs > config.stopLagMs) {
    reasons.push("stop_lag");
  }

  let overshootG: number | null = null;
  if (input.plausibleWeightG !== null && input.yieldTargetG !== null) {
    const over = input.plausibleWeightG - input.yieldTargetG;
    if (over > config.overshootG) {
      reasons.push("overshoot");
      overshootG = over;
    }
  }

  if (reasons.length === 0) {
    return { ...INACTIVE, sinceStopMs };
  }

  // Throttle re-fires so we send at most once per refireIntervalMs.
  const shouldFire =
    state.lastRefireAt === null ||
    input.now - state.lastRefireAt >= config.refireIntervalMs;

  // Escalate once the intervention has been ongoing past the threshold.
  const escalate =
    state.firstFiredAt !== null &&
    input.now - state.firstFiredAt > config.escalateAfterMs;

  return { triggered: true, shouldFire, reasons, sinceStopMs, overshootG, escalate };
}
