/**
 * BBW arming category gate (Spec §4.12 / Auftrag 3m) — pure decision logic.
 *
 * The app-side brew-by-weight stop must only arm for genuine BREW scripts.
 * Maintenance/flush scripts (and structurally `unknown` ones) must NOT arm —
 * otherwise a flush "overshoot" could poison residual_lag auto-calibration and
 * make the next real brew stop at the wrong weight.
 *
 * `categorizeScript` (shared/src/script-parser.ts) yields:
 *   - "brew"        — has a pump action (Cmd 3/4); a real espresso always does
 *   - "maintenance" — title keyword (spül/back/clean/rinse/…)
 *   - "unknown"     — neither; cannot be a real brew
 *   - null          — not yet categorized → treated as unknown (no arming)
 *
 * NOTE: do NOT use the recorder's `ShotCategory` (brew|maintenance) for this
 * gate — it has already collapsed `unknown`/null to `brew` (scripts.ts). This
 * module works on the RAW categoryAuto so `unknown` stays distinguishable.
 *
 * Pure (no I/O, no clock) → unit-testable in isolation.
 */

/** Raw auto-detected script category (matches XeniaScript.categoryAuto). */
export type ScriptCategoryAuto = "brew" | "maintenance" | "unknown" | null;

/** Resolved category, with `unknown`/null collapsed to a single `"unknown"`. */
export type EffectiveCategory = "brew" | "maintenance" | "unknown";

/**
 * Resolve the effective category used for the arming decision.
 *
 * The `categoryOverride` slot is reserved for a future manual category (SE-2):
 * once that field exists, pass it here and this module needs no change. Today
 * only `categoryAuto` is ever supplied, so the override is always undefined.
 */
export function effectiveCategory(args: {
  categoryAuto: ScriptCategoryAuto;
  categoryOverride?: "brew" | "maintenance" | null;
}): EffectiveCategory {
  return args.categoryOverride ?? args.categoryAuto ?? "unknown";
}

/** True only for genuine brew scripts. `maintenance` and `unknown` → false. */
export function categoryArmsBbw(cat: EffectiveCategory): boolean {
  return cat === "brew";
}
