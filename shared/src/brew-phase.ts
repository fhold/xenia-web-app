/**
 * Brew sub-phase classification — pure, shared by the live recorder and the
 * historical backfill so both tag samples identically.
 *
 * A brewing sample is 'preinfusion' until extraction has started, then
 * 'extraction'. Extraction begins at the FIRST of:
 *   - pressure reaching EXTRACTION_PRESSURE_BAR — normal espresso profiles ramp
 *     to ~9 bar; pre-infusion is the low-pressure saturation before that, OR
 *   - real output appearing on the scale (EXTRACTION_MIN_OUTPUT_G) — low-pressure
 *     profiles (e.g. Decaf, which tops out ~4 bar and never reaches 5) extract
 *     without ever crossing the pressure threshold, so the scale tells us.
 *
 * The latch is monotonic: once extraction has started it never reverts to
 * pre-infusion (declining-pressure profiles drop below the threshold mid-shot).
 * Nulls count as "not yet". `weightG` is the cumulative output (tared scale);
 * for a properly tared brew it starts ~0 and rises with extraction.
 */

/** Pressure (bar) at/above which a normal profile is considered extracting. */
export const EXTRACTION_PRESSURE_BAR = 5;

/** Cumulative scale output (g) that marks real extraction on low-pressure
 *  profiles that never reach EXTRACTION_PRESSURE_BAR. */
export const EXTRACTION_MIN_OUTPUT_G = 1;

/**
 * Monotonic latch: returns whether extraction has started, given the previous
 * latch state and the current sample's pressure + cumulative weight.
 */
export function extractionStarted(
  prev: boolean,
  pressureBar: number | null,
  weightG: number | null,
): boolean {
  if (prev) return true;
  if (pressureBar !== null && pressureBar >= EXTRACTION_PRESSURE_BAR) return true;
  if (weightG !== null && weightG >= EXTRACTION_MIN_OUTPUT_G) return true;
  return false;
}

export type BrewSubPhase = "preinfusion" | "extraction";

/** Convenience: map the latch state to the phase label. */
export function brewSubPhase(started: boolean): BrewSubPhase {
  return started ? "extraction" : "preinfusion";
}
