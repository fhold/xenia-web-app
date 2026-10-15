/**
 * BBW residual-lag auto-calibration — the arithmetic, on its own.
 *
 * Port of Beanconqueror's calculateNextResidualLagTime (graphefruit/Beanconqueror,
 * GPL-3.0): turn the weight error into a time correction via the flow at the
 * moment of the stop, smooth it, and quantise.
 *
 * Modified from the original (2026-06 to 2026-08): smoothing factor 0.15 instead
 * of 0.5, the ideal lag is clamped before smoothing, and one shot may move the
 * lag by at most one step (see nextResidualLagS).
 *
 * Split out of ShotRecorder so it can be tested. The recorder still owns the
 * gating (is BBW on, did the stop take effect, are the inputs there).
 */

/** Physically possible lag band. */
export const MIN_LAG_S = 0.1;
export const MAX_LAG_S = 2.0;
/** Quantisation grid — and, since M-5b, the most one shot may move the lag. */
export const LAG_STEP_S = 0.05;
/** EMA factor toward the ideal lag. */
export const LAG_SMOOTHING = 0.15;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface LagCalibrationInput {
  currentLagS: number;
  /** Final weight minus target: positive = overshoot, negative = undershoot. */
  weightErrorG: number;
  /** Flow at the moment the stop was triggered (g/s). */
  flowAtTriggerGs: number;
}

/**
 * The lag to use for the next shot.
 *
 * Two bounds, both learned the hard way on shot 165: a 1.7 g overshoot at a
 * trigger flow of 0.68 g/s asked for a 2.5 s correction — an "ideal" lag of
 * 3.24 s, well past what the machine can physically have. Clamping only the
 * result let that impossible target drag the lag from 0.75 to 1.10 in a single
 * shot, a 47 % move under a smoothing factor chosen to be gentle.
 *
 * So the ideal is clamped into the possible band *before* smoothing, and the
 * move per shot is limited to one step. The smoothing factor now means what its
 * comment always claimed: several shots to shift the lag appreciably, and one
 * bad shot cannot dominate.
 */
export function nextResidualLagS(input: LagCalibrationInput): number {
  const { currentLagS, weightErrorG, flowAtTriggerGs } = input;
  const timeCorrectionS = weightErrorG / flowAtTriggerGs;
  const idealLagS = clamp(currentLagS + timeCorrectionS, MIN_LAG_S, MAX_LAG_S);
  const smoothed = currentLagS * (1 - LAG_SMOOTHING) + idealLagS * LAG_SMOOTHING;
  const rateLimited = clamp(smoothed, currentLagS - LAG_STEP_S, currentLagS + LAG_STEP_S);
  const bounded = clamp(rateLimited, MIN_LAG_S, MAX_LAG_S);
  return parseFloat((Math.round(bounded / LAG_STEP_S) * LAG_STEP_S).toFixed(2));
}
