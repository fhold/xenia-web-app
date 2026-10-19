/**
 * BBW arming gate (Spec §4.12 / Auftrag 3m) — pure decision logic.
 *
 * The app-side brew-by-weight stop must only arm for genuine BREW runs.
 * Maintenance/flush runs must NOT arm — otherwise a flush "overshoot" could
 * poison residual_lag auto-calibration and make the next real brew stop at the
 * wrong weight.
 *
 * Seit Schnitt 3 sagt das Profil, ob es ein Bezug ist (`profile.kind`); das
 * Skript traegt nur noch bei, ob es die Pumpe ansteuert (`profileArmsBbw`).
 * Die Skript-Kategorie (`categorizeScript`, shared/src/script-parser.ts) bleibt
 * fuer den Abgleich und um die Art eines uebernommenen Skripts vorzuschlagen:
 *   - "brew"        — has a pump action (Cmd 3/4); a real espresso always does
 *   - "maintenance" — title keyword (spül/back/clean/rinse/…)
 *   - "unknown"     — neither; cannot be a real brew
 *   - null          — not yet categorized → treated as unknown
 *
 * Pure (no I/O, no clock) → unit-testable in isolation.
 */

/** Raw auto-detected script category (matches XeniaScript.categoryAuto). */
export type ScriptCategoryAuto = "brew" | "maintenance" | "unknown" | null;

/** Resolved category, with `unknown`/null collapsed to a single `"unknown"`. */
export type EffectiveCategory = "brew" | "maintenance" | "unknown";

/**
 * Die Kategorie eines Skripts: Uebersteuerung vor Automatik. Schlaegt die Art
 * vor, wenn ein Skript als Profil uebernommen wird (und fuellte `profile.kind`
 * bei der Umstellung) — ueber BBW entscheidet sie nicht mehr.
 */
export function effectiveCategory(args: {
  categoryAuto: ScriptCategoryAuto;
  categoryOverride?: "brew" | "maintenance" | null;
}): EffectiveCategory {
  return args.categoryOverride ?? args.categoryAuto ?? "unknown";
}

/**
 * Schnitt 3: die Art kommt vom Profil, nicht mehr vom Skript. BBW darf nur
 * fuer einen Bezug scharf schalten, dessen Skript die Pumpe ansteuert
 * (Cmd 3/4) — Wartung nie, und ein Skript ohne Pumpe auch dann nicht, wenn das
 * Profil Bezug sagt: ein solcher Lauf darf das Nachlauf-Lernen nicht verfaelschen.
 */
export function profileArmsBbw(args: { kind: "brew" | "maintenance" | "test"; hasPumpAction: boolean }): boolean {
  // Ein Messlauf stoppt wie ein Bezug am Zielgewicht; ob er das Nachlauf-Lernen
  // fuettert, entscheidet der Recorder (nie).
  return args.kind !== "maintenance" && args.hasPumpAction;
}
