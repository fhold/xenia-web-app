/**
 * Xenia script validator — codifies the safety/validity rules a script must
 * satisfy before the app would ever write it back via `/api/v2/scripts/create`.
 *
 * Pure function. Nothing calls it at runtime yet (resting code, SE-1 discovery);
 * it exists so a future editor can gate writes. No runtime imports — the type
 * import is erased, the stop-mechanism detection is inlined deliberately to keep
 * this module standalone (mirrors detectSafetyTimer() in script-parser.ts).
 *
 * Rule sources: Handoff §2.8 (Cmd dictionary), §2.10 (Bookoo tara bug + Xenia support's
 * "wait 1s" recommendation, Cmd 27 needs an attached Bookoo scale, safety-timer
 * pattern for scripts that omit Cmd 17). Thresholds are documented in
 * docs/script-editor-discovery.md §5.
 *
 * Errors  -> would block a write (script is invalid or unsafe).
 * Warnings-> allowed, but flagged for the user to confirm.
 */

import type { ParsedScript } from "./types.js";

/** A stable English code plus a German (UI-facing) message. */
export interface ScriptIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ScriptIssue[];
  warnings: ScriptIssue[];
}

// ---------------------------------------------------------------------------
// Thresholds (see discovery report §5 for the rationale behind each value)
// ---------------------------------------------------------------------------

/** A Cmd 12 longer than this directly before Cmd 7 counts as a safety timer.
 *  Matches detectSafetyTimer() in script-parser.ts. */
const SAFETY_TIMER_MIN_MS = 20_000;
/** Xenia support's "wait ~1s" tara command (Cmd 12) accepted window. §2.10. */
const TARA_WAIT_MIN_MS = 500;
const TARA_WAIT_MAX_MS = 1_500;
/** Pump/boiler power percentage bounds (Cmd 3 / 8 / 9). */
const PERCENT_MIN = 0;
const PERCENT_MAX = 100;
/** Pump pressure ceiling in mbar (Cmd 4) — 12 bar. */
const PRESSURE_MAX_MBAR = 12_000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateScript(parsed: ParsedScript): ValidationResult {
  const errors: ScriptIssue[] = [];
  const warnings: ScriptIssue[] = [];
  const cmds = parsed?.commands ?? [];

  // --- Empty: nothing else is meaningful ---
  if (cmds.length === 0) {
    errors.push({
      code: "EMPTY_SCRIPT",
      message: "Das Skript ist leer.",
    });
    return { ok: false, errors, warnings };
  }

  // --- E1: must start with Cmd 1 ---
  if (cmds[0].cmd !== 1) {
    errors.push({
      code: "MISSING_SCRIPT_START",
      message: "Skript muss mit Cmd 1 (Script start) beginnen.",
    });
  }

  // --- E2: must end with Cmd 7 ---
  if (cmds[cmds.length - 1].cmd !== 7) {
    errors.push({
      code: "MISSING_SCRIPT_END",
      message: "Skript muss mit Cmd 7 (Script end) enden.",
    });
  }

  // --- E3: no unknown command IDs ---
  if (parsed.unknownCmds && parsed.unknownCmds.length > 0) {
    errors.push({
      code: "UNKNOWN_CMD",
      message: `Unbekannte Befehls-ID(s): ${parsed.unknownCmds.join(", ")}.`,
    });
  }

  // --- E4: a stop mechanism is mandatory ---
  // Either Cmd 17 (Entleeren & Beenden) OR a safety timer (long Cmd 12 directly
  // before Cmd 7). BBW scripts deliberately omit Cmd 17 → the safety timer is
  // then the only guard against an open-ended brew (§2.10 / S5).
  const hasCmd17 = cmds.some((c) => c.cmd === 17);
  const safety = detectSafetyTimerInline(cmds);
  if (!hasCmd17 && !(safety?.hasSafetyTimer === true)) {
    errors.push({
      code: "NO_STOP_MECHANISM",
      message:
        "Kein Stop-Mechanismus: weder Cmd 17 (Entleeren & Beenden) noch ein " +
        `Safety-Timer (Cmd 12 > ${SAFETY_TIMER_MIN_MS / 1000}s direkt vor Cmd 7).`,
    });
  }

  // --- W1: Cmd 27 without a leading ~1s tara wait (Bookoo init bug, §2.10) ---
  const hasCmd27 = cmds.some((c) => c.cmd === 27);
  if (hasCmd27) {
    const firstEffective = cmds.find((c) => c.cmd !== 1);
    const isTaraWait =
      firstEffective !== undefined &&
      firstEffective.cmd === 12 &&
      typeof firstEffective.args[0] === "number" &&
      firstEffective.args[0] >= TARA_WAIT_MIN_MS &&
      firstEffective.args[0] <= TARA_WAIT_MAX_MS;
    if (!isTaraWait) {
      warnings.push({
        code: "CMD27_NO_TARA_WAIT",
        message:
          "Skript nutzt Cmd 27, aber der erste Wirk-Befehl ist kein " +
          "wait ~1s (Cmd 12, ~1000ms). Ohne Tara-Wait kann der Bezug bei " +
          "Bookoo-Waage sofort abbrechen (Empfehlung Xenia-Support, §2.10).",
      });
    }

    // --- W3: Cmd 27 only acts with an attached Bookoo scale (informational) ---
    warnings.push({
      code: "CMD27_NEEDS_BOOKOO",
      message:
        "Cmd 27 (Zielgewicht) wirkt nur mit angeschlossener Bookoo-Waage, " +
        "nicht mit der integrierten Waage (§2.10). Im Skript nicht prüfbar.",
    });
  }

  // --- W2: per-command argument plausibility ---
  for (const c of cmds) {
    const a0 = toNum(c.args[0]);
    const a1 = toNum(c.args[1]);
    switch (c.cmd) {
      case 3: // Pump power %: [power%, duration_ms]
        if (a0 !== null && (a0 < PERCENT_MIN || a0 > PERCENT_MAX)) {
          warnings.push(rangeIssue("PUMP_POWER_RANGE", "Cmd 3 Pumpenleistung", a0, "0–100 %"));
        }
        if (a1 !== null && a1 <= 0) warnings.push(durationIssue("Cmd 3", a1));
        break;
      case 4: // Pump pressure: [pressure_mbar, duration_ms]
        if (a0 !== null && (a0 < 0 || a0 > PRESSURE_MAX_MBAR)) {
          warnings.push(rangeIssue("PRESSURE_RANGE", "Cmd 4 Pumpendruck", a0, `0–${PRESSURE_MAX_MBAR} mbar`));
        }
        if (a1 !== null && a1 <= 0) warnings.push(durationIssue("Cmd 4", a1));
        break;
      case 26: // Wait for pressure: [pressure_mbar]
        if (a0 !== null && (a0 < 0 || a0 > PRESSURE_MAX_MBAR)) {
          warnings.push(rangeIssue("PRESSURE_RANGE", "Cmd 26 Warten bis Druck", a0, `0–${PRESSURE_MAX_MBAR} mbar`));
        }
        break;
      case 5: // Scale flow rate: [rate, duration_ms]
        if (a1 !== null && a1 <= 0) warnings.push(durationIssue("Cmd 5", a1));
        break;
      case 8: // Brew boiler power %
      case 9: // Brew group power %
        if (a0 !== null && (a0 < PERCENT_MIN || a0 > PERCENT_MAX)) {
          warnings.push(rangeIssue("BOILER_POWER_RANGE", `Cmd ${c.cmd} Leistung`, a0, "0–100 %"));
        }
        break;
      case 12: // Wait: [duration_ms]
        if (a0 !== null && a0 <= 0) warnings.push(durationIssue("Cmd 12", a0));
        break;
      default:
        break;
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inlined copy of detectSafetyTimer() (script-parser.ts) so the validator has
 *  no runtime dependency. Cmd 12 > SAFETY_TIMER_MIN_MS directly before Cmd 7. */
function detectSafetyTimerInline(
  cmds: ParsedScript["commands"],
): { hasSafetyTimer: boolean; durationMs: number } | null {
  if (cmds.length < 2) return null;
  const last = cmds[cmds.length - 1];
  const beforeLast = cmds[cmds.length - 2];
  if (last.cmd === 7 && beforeLast.cmd === 12 && beforeLast.args.length > 0) {
    const dur = toNum(beforeLast.args[0]) ?? 0;
    return { hasSafetyTimer: dur > SAFETY_TIMER_MIN_MS, durationMs: dur };
  }
  return null;
}

function toNum(v: number | string | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

function rangeIssue(code: string, label: string, value: number, range: string): ScriptIssue {
  return { code, message: `${label} = ${value} außerhalb des Plausibilitätsbereichs (${range}).` };
}

function durationIssue(label: string, value: number): ScriptIssue {
  return {
    code: "DURATION_NONPOSITIVE",
    message: `${label}: Dauer ${value} ms ist ≤ 0 (unplausibel).`,
  };
}
