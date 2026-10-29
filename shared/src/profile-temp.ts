/**
 * Per-profile target brew temperature (PT-1, Spec §3.4 / §5.8.5).
 *
 * A profile may carry an optional absolute brew setpoint (°C). `null` means
 * "no target" → today's behaviour (Stage 1 does NOT touch the machine; setting
 * the setpoint, the readiness traffic-light and the post-brew reset are Stage 2).
 *
 * This is the single source of truth for the accepted value set. It mirrors the
 * double yield-override validation in routes/scripts.ts
 *   (`typeof === "number" && Number.isFinite(x) && in range`)
 * and is reused by BOTH the backend profile routes and the frontend
 * ProfileEditor so front- and backend accept exactly the same values.
 */

import { L } from "./shared-lang.js";

/** Inclusive plausibility range — guards against typos like 960 instead of 96. */
export const TARGET_TEMP_MIN_C = 70;
export const TARGET_TEMP_MAX_C = 110;

export type TargetTempParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * Validate / normalize a profile target brew temperature.
 *
 * - `null` / `undefined`           → `null` (no target — today's behaviour)
 * - finite number within range     → that number
 * - non-numeric / NaN / out of range → `ok: false` (caller returns HTTP 400 /
 *   blocks save; a persistent profile field is never silently nulled)
 */
export function parseTargetTempC(value: unknown): TargetTempParse {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: L("Zieltemperatur muss eine Zahl oder leer sein", "targetTempC must be a finite number or null") };
  }
  if (value < TARGET_TEMP_MIN_C || value > TARGET_TEMP_MAX_C) {
    return {
      ok: false,
      error: L(`Zieltemperatur muss zwischen ${TARGET_TEMP_MIN_C} und ${TARGET_TEMP_MAX_C} °C liegen`, `targetTempC must be between ${TARGET_TEMP_MIN_C} and ${TARGET_TEMP_MAX_C} °C`),
    };
  }
  return { ok: true, value };
}
