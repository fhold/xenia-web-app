/**
 * Mid-brew scale dropout — detection only, no stop.
 *
 * Observed once, shot #158 (02.08.): at 15.5 s the BOOKOO stopped reporting in
 * a single frame — the weight froze at 13.0 g and the scale rate went to
 * exactly 0.0, while pressure and pump kept reporting normally. Nothing caught
 * it: plausibleScaleWeight carries the last value forward indefinitely, and the
 * watchdog's triggers (stop lag, overshoot) both need a moving weight. The shot
 * recorded 13.0 g yield for a cup that really held ~28 g.
 *
 * The signature is the two scale channels dying together while the machine is
 * demonstrably pushing water: weight bit-identical AND rate exactly 0.0 AND
 * pump on AND pressure up. Over all 175 recorded shots that combination occurs
 * only in #158 — blooms and pressure ramps (#150/#153/#174) drop out either
 * because the pump is off or because the rate still carries sensor noise.
 *
 * Pure (no I/O, no clock) so the trigger logic is unit-testable; the recorder
 * owns the per-shot state and the side effects (log, yield, flag).
 */

/** How long the signature must hold before the scale counts as lost. */
export const SCALE_STALL_MS = 3_000;

/** Below this the machine isn't pushing water, so a flat weight proves nothing. */
export const STALL_MIN_PRESSURE_BAR = 2;

export interface ScaleStallInput {
  now: number;
  /** Raw frame weight (g), NOT the carried-forward plausible value. */
  weightG: number | null;
  /** Scale rate (g/s) from the frame. */
  flowGs: number | null;
  /** Pump power (%) from the frame. */
  pumpPwm: number | null;
  pressureBar: number | null;
}

export interface ScaleStallState {
  /** The value the scale keeps repeating, or null when the signature is absent. */
  frozenAtG: number | null;
  /** When the current run of repeats began. */
  since: number | null;
  /** True while the run has lasted long enough to count as a dropout. */
  stalled: boolean;
  /** Sticky: the scale dropped out at least once this shot. */
  everStalled: boolean;
}

export function initialScaleStallState(): ScaleStallState {
  return { frozenAtG: null, since: null, stalled: false, everStalled: false };
}

/** Advance the detector by one frame. Returns the next state. */
export function trackScaleStall(
  input: ScaleStallInput,
  state: ScaleStallState,
): ScaleStallState {
  const { now, weightG, flowGs, pumpPwm, pressureBar } = input;

  const signature =
    weightG !== null &&
    flowGs === 0 &&
    pumpPwm !== null &&
    pumpPwm > 0 &&
    pressureBar !== null &&
    pressureBar > STALL_MIN_PRESSURE_BAR;

  if (!signature || (state.frozenAtG !== null && weightG !== state.frozenAtG)) {
    return { ...state, frozenAtG: signature ? weightG : null, since: signature ? now : null, stalled: false };
  }

  const since = state.since ?? now;
  const stalled = now - since >= SCALE_STALL_MS;
  return {
    frozenAtG: weightG,
    since,
    stalled,
    everStalled: state.everStalled || stalled,
  };
}
