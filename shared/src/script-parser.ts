/**
 * Xenia script parser — shared between backend (sync) and future frontends.
 *
 * A Xenia script is a semicolon-separated string of tokens.
 * Each token is: <cmd_id> [arg1] [arg2] ...
 * Example: "1;13;4 9000 3000;12 60000;17;7;"
 *
 * Reference: Handoff 2.8 (Cmd Dictionary).
 */

import type { ParsedCmd, ParsedScript } from "./types.js";

// ---------------------------------------------------------------------------
// Cmd dictionary (Handoff 2.8 — all 22 commands)
// ---------------------------------------------------------------------------

interface CmdEntry {
  de: string;
  en: string;
  args: string[];
}

const CMD_DICTIONARY: Record<number, CmdEntry> = {
  1:  { de: "Script start",                    en: "Script start",           args: [] },
  2:  { de: "Pumpe an",                         en: "Pump on",                args: [] },
  3:  { de: "Leistung Pumpe %",                en: "Pump power %",           args: ["power%", "duration_ms"] },
  4:  { de: "Pumpendruck bar",                 en: "Pump pressure bar",      args: ["pressure_mbar", "duration_ms"] },
  5:  { de: "Waage, Flussrate",                en: "Scale flow rate",        args: ["rate_ml/s", "duration_ms"] },
  6:  { de: "Pumpe aus",                        en: "Pump off",               args: [] },
  7:  { de: "Script end",                       en: "Script end",             args: [] },
  8:  { de: "Leistung Brühboiler %",           en: "Brew boiler power %",    args: ["percent"] },
  9:  { de: "Leistung Brühgruppe %",           en: "Brew group power %",     args: ["percent"] },
  12: { de: "Warten",                           en: "Wait",                   args: ["duration_ms"] },
  13: { de: "Bezugsventil öffnen",             en: "Open brew valve",        args: [] },
  14: { de: "Bezugsventil schließen",          en: "Close brew valve",       args: [] },
  15: { de: "Ablassventil öffnen",             en: "Open drain valve",       args: [] },
  16: { de: "Ablassventil schließen",          en: "Close drain valve",      args: [] },
  17: { de: "Entleeren & Beenden",             en: "Drain and finish",       args: [] },
  20: { de: "Signalton",                        en: "Signal tone",            args: ["count", "duration_ms"] },
  25: { de: "Warten Solltemperatur °C",        en: "Wait for target temp",   args: ["temp_C"] },
  27: { de: "Waage, Gewicht",                  en: "Scale weight target",    args: ["grams"] },
  28: { de: "Eco-Modus aktivieren",            en: "Activate ECO",           args: [] },
  29: { de: "Brühdruckbegrenzung",             en: "Brew pressure limit",    args: ["bar"] },
  30: { de: "Begrenzung Flussrate",            en: "Flow rate limit",        args: ["ml/s"] },
  31: { de: "Solltemperatur wiederherstellen", en: "Restore target temp",    args: [] },
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a semicolon-separated Xenia script string.
 * Never throws — unknown Cmd IDs are collected in unknownCmds.
 */
export function parseScript(content: string): ParsedScript {
  if (!content || typeof content !== "string") {
    return { commands: [], unknownCmds: [], error: "Empty or non-string content" };
  }

  const tokens = content.split(";").map((t) => t.trim()).filter(Boolean);
  const commands: ParsedCmd[] = [];
  const unknownSet = new Set<number>();

  for (const token of tokens) {
    const parts = token.split(/\s+/).map((p) => p.trim()).filter(Boolean);
    const cmd = parseInt(parts[0], 10);
    const args: (number | string)[] = parts.slice(1).map((a) => {
      const n = Number(a);
      return Number.isNaN(n) ? a : n;
    });
    const entry = CMD_DICTIONARY[cmd];
    if (!entry) {
      unknownSet.add(cmd);
      commands.push({ cmd, args, meaning: "UNKNOWN", argLabels: [] });
    } else {
      commands.push({ cmd, args, meaning: entry.de, argLabels: entry.args });
    }
  }

  return { commands, unknownCmds: [...unknownSet] };
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

const MAINTENANCE_KEYWORDS = [
  "spül", "spul", "rückspül", "rueckspül", "back", "clean", "rinse",
];

/**
 * Auto-detect script category from title keywords + command content.
 * Title match takes priority — a script named "Spülen" is maintenance
 * even if it contains pump commands.
 */
export function categorizeScript(
  title: string,
  parsed: ParsedScript,
): "brew" | "maintenance" | "unknown" {
  const lower = (title ?? "").toLowerCase();
  if (MAINTENANCE_KEYWORDS.some((kw) => lower.includes(kw))) return "maintenance";
  const hasPumpAction = parsed.commands.some((c) => c.cmd === 3 || c.cmd === 4);
  if (hasPumpAction) return "brew";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all Cmd 27 (weight target) values in order of appearance.
 * Multiple Cmd 27s can occur (e.g. pre-infusion target + final target).
 */
export function extractWeightTargets(parsed: ParsedScript): number[] {
  return parsed.commands
    .filter((c) => c.cmd === 27 && c.args.length > 0)
    .map((c) => c.args[0] as number);
}

/**
 * Detect the safety-timer pattern: Cmd 12 (wait) directly before Cmd 7 (end).
 * A duration >20 000 ms is flagged as an intentional safety timer.
 * Returns null if the pattern isn't present.
 */
export function detectSafetyTimer(
  parsed: ParsedScript,
): { hasSafetyTimer: boolean; durationMs: number } | null {
  const cmds = parsed.commands;
  if (cmds.length < 2) return null;
  const last = cmds[cmds.length - 1];
  const beforeLast = cmds[cmds.length - 2];
  if (last.cmd === 7 && beforeLast.cmd === 12 && beforeLast.args.length > 0) {
    const dur = beforeLast.args[0] as number;
    return { hasSafetyTimer: dur > 20_000, durationMs: dur };
  }
  return null;
}

/** True if the script contains at least one Cmd 27 (weight-based stop). */
export function hasCmd27(parsed: ParsedScript): boolean {
  return parsed.commands.some((c) => c.cmd === 27);
}
