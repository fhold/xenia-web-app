/**
 * scriptToTimeline — pure transform from a ParsedScript into a render-ready
 * timeline model (SE-2 / corrected in SE-2b).
 *
 * Correct Xenia execution model (source: https://www.xenia-espresso.de/support-db-scripte/):
 *
 *  - The command processor is FIRE-AND-FORGET: a pump/boiler command (Cmd 3/4/5)
 *    is handed to the system and the processor immediately moves on. Only a
 *    WAIT command (Cmd 12) — and the indeterminate waits Cmd 25 ("bis °C") /
 *    Cmd 26 ("bis bar") / Cmd 27 ("bis g") — pause the processor and thus
 *    advance the time cursor.
 *  - A pump command RAMPS its mode's value from the current value to the target
 *    over `ramp_dur`, starting when it fires; afterwards it HOLDS the target.
 *    The ramp runs in PARALLEL to the following wait.
 *  - The window of a phase = time until the NEXT pump command fires = the sum of
 *    the waits in between. Ramp spans min(ramp_dur, window); the remainder of the
 *    window holds the target. If ramp_dur > window the ramp is TRUNCATED at the
 *    window (the next command fires before the ramp finishes). If NO wait follows
 *    (window 0) the command is immediately overwritten → flagged `noWait`.
 *  - Pressure / flow / power are SEPARATE control modes (% is not 1:1 to bar) →
 *    the curve is ONE mode-segmented line; the frontend normalizes per mode.
 *  - Cmd 25 sets a target-temp annotation AND is an indeterminate wait; Cmd 31
 *    restores it (base unknown → marker). Cmd 29/30 are limit reference lines.
 *
 * Never throws — empty/error input yields an empty timeline; unknown Cmd IDs
 * become neutral markers.
 */

import type { ParsedScript, ParsedCmd } from "./types.js";
import { CMD_ARGS, CMD_HELP } from "./script-help.js";

/** Nominal width (ms) used for an indeterminate wait (Cmd 25/26/27). The band is
 *  shaded + labelled by the frontend; the width is NOT to scale. */
export const INDETERMINATE_WAIT_MS = 12_000;

/**
 * Pump power (%) → equivalent pressure (bar), for displaying pressure-mode
 * (Cmd 4) and power-mode (Cmd 3) commands on ONE continuous bar curve.
 *
 * ASSUMED saturating curve (not measured — shot_sample never logged pump power):
 * a hyperbolic fit pinned to Flavio's anchors 75 % ≈ 9 bar and 100 % ≈ 10 bar
 * (the OPV/expansion valve caps real pressure ~10 bar, so it is NOT linear to
 * 12 bar). bar = 15·p / (p + 50): 0→0, 20→4.3, 50→7.5, 75→9, 100→10. Refine
 * later from logged pump power if/when that is recorded.
 */
export function powerToBar(percent: number): number {
  const p = Math.max(0, Math.min(100, percent));
  return (15 * p) / (p + 50);
}

export type PumpMode = "pressure" | "flow" | "power";
export type PumpUnit = "bar" | "ml/s" | "%";
/** Which chart axis a phase plots on: pressure & power share "bar"; flow is ml/s. */
export type PhaseAxis = "bar" | "flow";

export interface ScriptPhase {
  mode: PumpMode;
  /** Index of the source command in parsed.commands (for breakdown cross-ref). */
  cmdIndex: number;
  /** Command unit (for the label/tooltip): 'bar' | '%' | 'ml/s'. */
  unit: PumpUnit;
  /** Chart axis this phase plots on: pressure & power → 'bar', flow → 'flow'. */
  axis: PhaseAxis;
  /** Nominal start/end (ms). tEnd === tStart when noWait. */
  tStart: number;
  tEnd: number;
  /** End of the ramp (tStart + min(rampDurMs, window)); equals tStart for instant. */
  rampEndT: number;
  /** Values IN THE AXIS UNIT (bar for pressure/power, ml/s for flow): where the
   *  ramp starts, its target, and where it actually ends (partial if truncated).
   *  Power is already converted to its bar-equivalent via powerToBar() so the
   *  pressure+power line is continuous across mode switches. */
  startValue: number;
  targetValue: number;
  endValue: number;
  /** The COMMANDED value in its raw unit (for the label/tooltip): bar / % / ml/s. */
  rawTarget: number;
  rampDurMs: number;
  /** ramp_dur > window: the ramp never reached the target before the next command. */
  truncated: boolean;
  /** No wait followed → window 0 → the command is immediately overwritten. */
  noWait: boolean;
  /** Plain-text label, e.g. "→ 9 bar in 3 s" / "Leistung → 20 % in 35 s". */
  label: string;
  /** Nur App-Stufen (steps-curve.ts): der Rampenstart ist der Ist-Fluss, hier nur angedeutet. */
  startEstimated?: boolean;
  /** Nur App-Stufen: Preinfusion ohne festen Sollwert — Flaeche ohne Linie. */
  noTarget?: boolean;
}

export type WaitKind = "weight" | "temp" | "pressure";
export interface WaitSegment {
  kind: WaitKind;
  value: number;
  label: string;
  tStart: number;
  tEnd: number;
}

export type MarkerKind =
  | "start" | "end" | "drain" | "valve_open" | "valve_close"
  | "drain_valve_open" | "drain_valve_close" | "pump_on" | "tone"
  | "restore_temp" | "unknown";
export interface TimelineMarker {
  t: number;
  kind: MarkerKind;
  label: string;
}

export interface TempSetpoint {
  t: number;
  value: number; // °C
}

export interface ScriptTimeline {
  /** Mode-segmented phases (ramp + hold) in nominal-time order. */
  phases: ScriptPhase[];
  /** Indeterminate-wait bands (Cmd 25/26/27). */
  waits: WaitSegment[];
  /** Target-temp annotations (Cmd 25). */
  tempSetpoints: TempSetpoint[];
  /** Cmd 29 brew-pressure limit (bar) / Cmd 30 flow limit (ml/s), reference lines. */
  pressureLimitBar: number | null;
  flowLimitMlS: number | null;
  /** Structure event markers. */
  markers: TimelineMarker[];
  /** Total nominal duration (ms) — x-axis extent. */
  totalMs: number;
}

function num(x: number | string | undefined): number {
  if (typeof x === "number") return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Dezimalkomma wie im Skript-Editor und in der Befehlsliste.
function fmtS(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1).replace(".", ",");
}
function fmtV(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(".", ",");
}

const EMPTY: ScriptTimeline = {
  phases: [],
  waits: [],
  tempSetpoints: [],
  pressureLimitBar: null,
  flowLimitMlS: null,
  markers: [],
  totalMs: 0,
};

export function scriptToTimeline(parsed: ParsedScript | null | undefined): ScriptTimeline {
  if (!parsed || !parsed.commands || parsed.commands.length === 0) {
    return { ...EMPTY };
  }
  const cmds = parsed.commands;

  // ---- Pass 1: nominal time cursor. Only waits (12) + indeterminate (25/26/27)
  //      advance T. Pump/boiler/structure commands are fire-and-forget. ----
  const tAt: number[] = new Array(cmds.length);
  const waits: WaitSegment[] = [];
  const tempSetpoints: TempSetpoint[] = [];
  let T = 0;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    tAt[i] = T;
    if (c.cmd === 12) {
      T += num(c.args[0]);
    } else if (c.cmd === 25) {
      const temp = num(c.args[0]);
      tempSetpoints.push({ t: T, value: temp });
      const tStart = T;
      T += INDETERMINATE_WAIT_MS;
      waits.push({ kind: "temp", value: temp, label: `bis ${fmtV(temp)} °C`, tStart, tEnd: T });
    } else if (c.cmd === 26) {
      const bar = num(c.args[0]) / 1000;
      const tStart = T;
      T += INDETERMINATE_WAIT_MS;
      waits.push({ kind: "pressure", value: bar, label: `bis ${fmtV(bar)} bar`, tStart, tEnd: T });
    } else if (c.cmd === 27) {
      const g = num(c.args[0]);
      const tStart = T;
      T += INDETERMINATE_WAIT_MS;
      waits.push({ kind: "weight", value: g, label: `bis ${fmtV(g)} g`, tStart, tEnd: T });
    }
  }
  const totalMs = T;

  // ---- Pass 2: build phases from pump-like commands (3/4/5 ramp; 6 → 0). ----
  const pumpIdx: number[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const id = cmds[i].cmd;
    if (id === 3 || id === 4 || id === 5 || id === 6) pumpIdx.push(i);
  }

  const phases: ScriptPhase[] = [];
  // The pump has ONE physical state. Pressure (Cmd 4) and power (Cmd 3) are two
  // ways to command it, linked by powerToBar() → both tracked in BAR on a shared
  // axis so the line is continuous across a pressure↔power switch (no V-shape).
  // Flow (Cmd 5) is a separate physical quantity on its own ml/s axis.
  let currentBar = 0;
  let currentFlow = 0;
  let activeMode: PumpMode = "pressure";

  for (let k = 0; k < pumpIdx.length; k++) {
    const i = pumpIdx[k];
    const c = cmds[i];
    const ts = tAt[i];
    const nextTs = k + 1 < pumpIdx.length ? tAt[pumpIdx[k + 1]] : totalMs;
    const window = Math.max(0, nextTs - ts);

    let mode: PumpMode;
    let unit: PumpUnit;
    let axis: PhaseAxis;
    let rawTarget: number; // commanded value in its raw unit (bar / % / ml/s)
    let target: number; // target in the AXIS unit (bar or ml/s)
    let rampDur: number;
    if (c.cmd === 6) {
      // Pump off — drop the bar axis to 0 (and kill any flow).
      mode = activeMode === "flow" ? "flow" : "pressure";
      unit = mode === "flow" ? "ml/s" : "bar";
      axis = mode === "flow" ? "flow" : "bar";
      rawTarget = 0;
      target = 0;
      rampDur = 0;
    } else if (c.cmd === 5) {
      mode = "flow"; unit = "ml/s"; axis = "flow";
      rawTarget = num(c.args[0]); target = rawTarget; rampDur = num(c.args[1]);
    } else if (c.cmd === 3) {
      mode = "power"; unit = "%"; axis = "bar";
      rawTarget = num(c.args[0]); target = powerToBar(rawTarget); rampDur = num(c.args[1]);
    } else {
      // Cmd 4 — pressure (mbar → bar)
      mode = "pressure"; unit = "bar"; axis = "bar";
      rawTarget = num(c.args[0]) / 1000; target = rawTarget; rampDur = num(c.args[1]);
    }

    const startValue = axis === "flow" ? currentFlow : currentBar;
    const noWait = window === 0;
    const rampEff = Math.min(rampDur, window);
    const rampEndT = ts + rampEff;
    const truncated = !noWait && rampDur > window;
    const endValue =
      noWait || window >= rampDur || rampDur === 0
        ? target
        : startValue + (target - startValue) * (window / rampDur);

    const label =
      c.cmd === 6
        ? "Pumpe aus"
        : c.cmd === 3
          ? rampDur > 0 ? `Leistung → ${fmtV(rawTarget)} % in ${fmtS(rampDur)} s` : `Leistung ${fmtV(rawTarget)} %`
          : rampDur > 0 ? `→ ${fmtV(rawTarget)} ${unit} in ${fmtS(rampDur)} s` : `${fmtV(rawTarget)} ${unit}`;

    phases.push({
      mode, cmdIndex: i, unit, axis,
      tStart: ts,
      tEnd: ts + window,
      rampEndT,
      startValue,
      targetValue: target,
      endValue,
      rawTarget,
      rampDurMs: rampDur,
      truncated,
      noWait,
      label,
    });

    // A noWait command is immediately overridden by the next one (Xenia doc):
    // the pump never reaches its target, so it does NOT carry a new state — the
    // next effective phase ramps from the last EFFECTIVE value (e.g. Decaf's
    // 2.5/6.5/5 bar stages never run → the 4-bar phase still starts from 0).
    if (!noWait) {
      if (axis === "flow") currentFlow = endValue;
      else { currentBar = endValue; if (c.cmd === 6) currentFlow = 0; }
      activeMode = mode;
    }
  }

  // ---- Structure markers + limits. ----
  const markers: TimelineMarker[] = [];
  let pressureLimitBar: number | null = null;
  let flowLimitMlS: number | null = null;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    const t = tAt[i];
    switch (c.cmd) {
      case 1:  markers.push({ t, kind: "start", label: "Start" }); break;
      case 2:  markers.push({ t, kind: "pump_on", label: "Pumpe an" }); break;
      case 7:  markers.push({ t, kind: "end", label: "Ende" }); break;
      case 13: markers.push({ t, kind: "valve_open", label: "Bezugsventil auf" }); break;
      case 14: markers.push({ t, kind: "valve_close", label: "Bezugsventil zu" }); break;
      case 15: markers.push({ t, kind: "drain_valve_open", label: "Ablassventil auf" }); break;
      case 16: markers.push({ t, kind: "drain_valve_close", label: "Ablassventil zu" }); break;
      case 17: markers.push({ t, kind: "drain", label: "Entleeren & Beenden" }); break;
      case 20: markers.push({ t, kind: "tone", label: "Signalton" }); break;
      case 31: markers.push({ t, kind: "restore_temp", label: "Soll-Temp wiederherstellen" }); break;
      case 29: pressureLimitBar = num(c.args[0]); break;
      case 30: flowLimitMlS = num(c.args[0]); break;
      default:
        if (![3, 4, 5, 6, 12, 25, 26, 27].includes(c.cmd)) {
          markers.push({ t, kind: "unknown", label: `Cmd ${c.cmd}` });
        }
        break;
    }
  }

  return { phases, waits, tempSetpoints, pressureLimitBar, flowLimitMlS, markers, totalMs };
}

/** Zahl wie im Skript-Editor: hoechstens drei Nachkommastellen, Dezimalkomma. */
function fmtDe(v: number): string {
  return String(Number(v.toFixed(3))).replace(".", ",");
}

/**
 * Zeile der Skriptansicht fuer einen Befehl. Name und Werte kommen aus
 * derselben Quelle wie der Skript-Editor (script-help: Titel und Felder), damit
 * beide nie auseinanderlaufen. Pumpenbefehle rampenbewusst ("3,8 bar in 2 s"),
 * Signalton als "3 × 0,5 s", sonst die Werte mit Einheit.
 */
export function describeCmdLine(c: ParsedCmd): { label: string; detail: string } {
  const help = CMD_HELP[c.cmd];
  const fields = CMD_ARGS[c.cmd] ?? [];
  const label = help?.title ?? (c.meaning === "UNKNOWN" ? `Cmd ${c.cmd}` : c.meaning);
  if (fields.length === 0) return { label, detail: help ? "" : c.args.join(" ") };
  const v = fields.map((f, i) => fmtDe(num(c.args[i]) / f.scale));
  const withUnit = (i: number) => `${v[i]} ${fields[i].unit}`;
  let detail: string;
  if (fields[1]?.label === "Übergang") detail = `${withUnit(0)} in ${v[1]} s`;
  else if (c.cmd === 20) detail = `${v[0]} × ${withUnit(1)}`;
  else detail = fields.map((_, i) => withUnit(i)).join(" · ");
  return { label, detail };
}
