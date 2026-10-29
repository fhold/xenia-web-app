/**
 * Brew-step validation — one rule for the profile API and for the drive.
 *
 * The driver checked a step sequence only when the drive was already starting;
 * the profile API stored whatever JSON arrived. A malformed step therefore
 * surfaced at the machine instead of in the editor. Both paths validate here.
 */

import type { BrewProfile, BrewStep, FlowControllerKind, StepExit } from "./types.js";
import { L } from "./shared-lang.js";

export type StepsCheck = { ok: true } | { ok: false; error: string };

const OK: StepsCheck = { ok: true };
const EXIT_KEYS = ["seconds", "weightG", "pressureBar", "pressureBelowBar", "flowGs", "flowAboveGs"] as const;
const CONTROLLERS: FlowControllerKind[] = ["adaptive", "pi"];

function isPositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function checkExit(exit: StepExit | undefined, i: number): StepsCheck {
  if (exit === undefined) return OK;
  for (const key of EXIT_KEYS) {
    const v = exit[key];
    if (v !== undefined && !isPositive(v)) {
      return { ok: false, error: L(`Stufe ${i + 1}: Ausstieg ${key} muss eine positive Zahl sein`, `Step ${i}: exit.${key} must be a positive number`) };
    }
  }
  return OK;
}

/** True when at least one exit condition can ever fire. */
export function hasExit(exit: StepExit | undefined): boolean {
  return exit !== undefined && EXIT_KEYS.some((k) => exit[k] !== undefined);
}

/**
 * Endet der Bezug ohne Ziel von selbst? Dann braucht die letzte Stufe einen
 * Ausstieg (Zeit, Gewicht, Druck, Fluss) — sie beendet ihn wie bei der Decent
 * ein Profil ohne Zielgewicht. Mit Ziel stoppt weiter die Waage.
 */
export function endsWithoutYield(steps: BrewStep[] | null | undefined): boolean {
  return !!steps && steps.length > 0 && hasExit(steps[steps.length - 1]!.exit);
}

function checkOptionalCap(v: unknown, i: number, field: string): StepsCheck {
  if (v === undefined) return OK;
  if (!isPositive(v)) return { ok: false, error: L(`Stufe ${i + 1}: ${field} muss eine positive Zahl sein`, `Step ${i}: ${field} must be a positive number`) };
  return OK;
}

function checkStep(s: BrewStep, i: number): StepsCheck {
  if (s === null || typeof s !== "object") {
    return { ok: false, error: L(`Stufe ${i + 1} muss ein Objekt sein`, `Step ${i} must be an object`) };
  }
  if (s.name !== undefined && typeof s.name !== "string") {
    return { ok: false, error: L(`Stufe ${i + 1}: Name muss Text sein`, `Step ${i}: name must be a string`) };
  }
  if (s.tone !== undefined && typeof s.tone !== "boolean") {
    return { ok: false, error: L(`Stufe ${i + 1}: Ton muss true oder false sein`, `Step ${i}: tone must be true or false`) };
  }
  // A ramp of 0 ms is the documented "jump straight to target" case.
  if (s.rampMs !== undefined && !(typeof s.rampMs === "number" && Number.isFinite(s.rampMs) && s.rampMs >= 0)) {
    return { ok: false, error: L(`Stufe ${i + 1}: Rampe (rampMs) muss eine Zahl ≥ 0 sein`, `Step ${i}: rampMs must be a number >= 0`) };
  }

  switch (s.kind) {
    case "flow": {
      if (!isPositive(s.targetFlowGs)) {
        return { ok: false, error: L("Jede Flussstufe braucht ein positives Flussziel (targetFlowGs)", "Each flow step needs a positive targetFlowGs") };
      }
      if (s.controller !== undefined && !CONTROLLERS.includes(s.controller)) {
        return { ok: false, error: L(`Stufe ${i + 1}: Regler muss 'adaptive' oder 'pi' sein`, `Step ${i}: controller must be 'adaptive' or 'pi'`) };
      }
      if (s.adoptFlow !== undefined && typeof s.adoptFlow !== "boolean") {
        return { ok: false, error: L(`Stufe ${i + 1}: adoptFlow muss true oder false sein`, `Step ${i}: adoptFlow must be true or false`) };
      }
      const cap = checkOptionalCap(s.maxPressureBar, i, "maxPressureBar");
      if (!cap.ok) return cap;
      break;
    }
    case "pressure": {
      if (s.adoptPressure !== undefined && typeof s.adoptPressure !== "boolean") {
        return { ok: false, error: L(`Stufe ${i + 1}: adoptPressure muss true oder false sein`, `Step ${i}: adoptPressure must be true or false`) };
      }
      if (!isPositive(s.targetPressureBar)) {
        return { ok: false, error: L("Jede Druckstufe braucht ein positives Druckziel (targetPressureBar)", "Each pressure step needs a positive targetPressureBar") };
      }
      const cap = checkOptionalCap(s.maxFlowGs, i, "maxFlowGs");
      if (!cap.ok) return cap;
      break;
    }
    case "power": {
      // A power step is open-loop: its value is written to the pump as-is, so
      // the 0..100 % range of PU_SET_LEVEL_PW_CONTROL is the bound.
      if (!Number.isFinite(s.power) || s.power < 0 || s.power > 100) {
        return { ok: false, error: L("Jede Leistungsstufe braucht eine Leistung zwischen 0 und 100", "Each power step needs a power between 0 and 100") };
      }
      const pCap = checkOptionalCap(s.maxPressureBar, i, "maxPressureBar");
      if (!pCap.ok) return pCap;
      const fCap = checkOptionalCap(s.maxFlowGs, i, "maxFlowGs");
      if (!fCap.ok) return fCap;
      break;
    }
    case "preinfusion": {
      if (s.gentleness !== undefined && !["gentle", "normal", "brisk", "none"].includes(s.gentleness)) {
        return { ok: false, error: L(`Stufe ${i + 1}: Sanftheit muss gentle, normal, brisk oder none sein`, `Step ${i}: gentleness must be gentle, normal, brisk or none`) };
      }
      if (s.fill !== undefined && !["normal", "fast"].includes(s.fill)) {
        return { ok: false, error: L(`Stufe ${i + 1}: Füllen muss normal oder fast sein`, `Step ${i}: fill must be normal or fast`) };
      }
      break;
    }
    default:
      return { ok: false, error: L(`Unbekannte Stufenart '${(s as { kind: string }).kind}'`, `Unknown step kind '${(s as { kind: string }).kind}'`) };
  }

  return checkExit(s.exit, i);
}

/** Validate a step sequence. An empty sequence is legal — the driver then runs
 *  its flat-flow default. */
export function validateBrewSteps(steps: BrewStep[]): StepsCheck {
  for (let i = 0; i < steps.length; i++) {
    const step = checkStep(steps[i], i);
    if (!step.ok) return step;
    // Every step but the last must advance on a condition; the last is
    // weight-stopped by BBW at the yield target.
    if (i < steps.length - 1 && !hasExit(steps[i]?.exit)) {
      return {
        ok: false,
        error: L(`Stufe ${i + 1} braucht einen Ausstieg (Zeit, Gewicht, Druck ≥, Druck ≤, Fluss ≤ oder Fluss ≥)`, `Step ${i} needs an exit (seconds / weightG / pressureBar / pressureBelowBar / flowGs / flowAboveGs)`),
      };
    }
  }
  return OK;
}

/** Validate the persisted wrapper (profile.brew_steps JSON) and its steps. */
export function validateBrewProfile(raw: unknown): StepsCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: L("muss ein Objekt { version: 1, steps: [...] } sein", "must be an object { version: 1, steps: [...] }") };
  }
  const bp = raw as Partial<BrewProfile>;
  if (bp.version !== 1) return { ok: false, error: L("version muss 1 sein", "version must be 1") };
  if (!Array.isArray(bp.steps)) return { ok: false, error: L("steps muss eine Liste sein", "steps must be an array") };
  return validateBrewSteps(bp.steps);
}
