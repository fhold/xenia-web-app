/**
 * Phasen-Sicht fuer den vereinten Profil-Editor (Schnitt 2a).
 *
 * Ein Profil laeuft entweder als Maschinen-Skript oder in der App (Stufen,
 * BrewStep). Der Editor zeigt beides gleich: als Folge von Phasen mit Art,
 * Ziel, Rampe, Begrenzung und Ausstiegen.
 *
 * ⚠ Bei Skript-Profilen bleibt die Befehlsliste die eine Datenquelle. Die
 * Phasen sind eine Projektion darauf — Pumpenbefehl plus das Warten, das ihn
 * beendet —, und jede Aenderung geht an genau die betroffenen Befehle. Was
 * niemand anfasst, bleibt Byte fuer Byte gleich; es gibt keine zweite
 * Darstellung, die beim Zurueckschreiben etwas verlieren koennte. Befehle
 * ohne Phase (Ventile, Signalton, Heizleistung …) bleiben als Marken an ihrer
 * Stelle und wandern mit ihrer Phase, wenn die verschoben wird.
 *
 * Warten nach Warten im selben Abschnitt („bis 3,8 bar, dann 3 s“) ist eine
 * weitere Phase mit demselben Ziel — eine Fortsetzung ohne eigenen
 * Pumpenbefehl. Sie folgt dem Pumpenbefehl ihres Abschnitts wie im Skript:
 * wird das Ziel davor geaendert, haelt sie das neue. Einen eigenen
 * Pumpenbefehl (gleiches Ziel, keine Rampe) bekommt sie erst, wenn sie selbst
 * geaendert wird oder wenn Entfernen/Verschieben sie von ihrem Abschnitt
 * trennen wuerde.
 */

import type { BrewStep, ParsedCmd, PreinfusionGentleness, StepExit } from "./types.js";
import { CMD_HELP } from "./script-help.js";
import { makeCmd, setArg, insertCmd, removeCmd, insertWithWait } from "./script-edit.js";
import { serializeScript } from "./script-serializer.js";

// ---------------------------------------------------------------------------
// Modell
// ---------------------------------------------------------------------------

export type PhaseKind = "pressure" | "flow" | "power" | "pause" | "preinfusion";
export type ExitKind = "weight" | "pressureAbove" | "pressureBelow" | "flowBelow" | "time" | "tempAbove";
/** Werte in Anzeige-Einheiten: g, bar, g/s, s, °C. */
export interface PhaseExit { kind: ExitKind; value: number }

export interface Phase {
  kind: PhaseKind;
  /** bar (Druck) · g/s bzw. ml/s (Fluss) · % (Leistung) — null bei Pause und Preinfusion. */
  target: number | null;
  /** Rampe in s, 0 = sofort. */
  rampS: number;
  maxPressureBar: number | null;
  maxFlowGs: number | null;
  /** Nur Preinfusion. */
  gentleness: PreinfusionGentleness | null;
  /** Nur Fluss: das Ziel beim Eintritt vom Puck uebernehmen (FlowStep.adoptFlow);
   *  `target` ist dann der erwartete Wert. */
  adoptFlow?: boolean;
  /** Freier Name; null = automatisch. Skript-Phasen haben (noch) keinen. */
  name: string | null;
  /** Oder-verknuepft: die erste erfuellte Bedingung beendet die Phase. */
  exits: PhaseExit[];
}

/** Eine Phase eines Skripts, mit den Befehlen, die sie ausmachen. */
export interface ScriptPhaseView extends Phase {
  /** Pumpenbefehl; null = Fortsetzung (weiteres Warten im selben Abschnitt). */
  pumpIndex: number | null;
  /** Das Warten, das sie beendet; null = keins (Pumpenbefehl laeuft nie). */
  waitIndex: number | null;
  /** Alle Befehle der Phase, einschliesslich ihrer Marken: [erster, letzter]. */
  range: [number, number];
}

/** Ein Befehl ohne Phase; `phase` = die Phase, in der er steht (-1 = davor). */
export interface ScriptMarker { index: number; cmd: number; label: string; phase: number }

export interface ScriptProjection {
  phases: ScriptPhaseView[];
  markers: ScriptMarker[];
  /** Rahmen, den jedes Skript hat und die App selbst erledigt: Start, Tara-Warten,
   *  Bezugsventil auf, Entleeren & Beenden, Ende. */
  frame: number[];
}

/** Pumpenbefehle wie in script-edit.ts (2 „Pumpe an“ ist hier nie gelaufen → Marke). */
const PUMP = new Set([3, 4, 5, 6]);
const WAIT = new Set([12, 25, 26, 27]);
const label = (cmd: number) => CMD_HELP[cmd]?.title ?? `Befehl ${cmd}`;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const r1 = (v: number) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Skript → Phasen
// ---------------------------------------------------------------------------

function pumpValues(c: ParsedCmd): Pick<Phase, "kind" | "target" | "rampS"> {
  const ramp = num(c.args[1]) / 1000;
  switch (c.cmd) {
    case 4: return { kind: "pressure", target: num(c.args[0]) / 1000, rampS: ramp };
    case 3: return { kind: "power", target: num(c.args[0]), rampS: ramp };
    case 5: return { kind: "flow", target: num(c.args[0]), rampS: ramp };
    default: return { kind: "pause", target: null, rampS: 0 };
  }
}

function waitExit(c: ParsedCmd): PhaseExit {
  switch (c.cmd) {
    case 27: return { kind: "weight", value: num(c.args[0]) };
    case 26: return { kind: "pressureAbove", value: num(c.args[0]) / 1000 };
    case 25: return { kind: "tempAbove", value: num(c.args[0]) };
    default: return { kind: "time", value: num(c.args[0]) / 1000 };
  }
}

export function projectScript(cmds: ParsedCmd[]): ScriptProjection {
  const n = cmds.length;
  const pumps: number[] = [];
  cmds.forEach((c, i) => { if (PUMP.has(c.cmd)) pumps.push(i); });
  // Ende: ab dem ersten „Entleeren & Beenden“ bzw. „Ende“ hinter dem letzten Pumpenbefehl.
  let tail = n;
  for (let i = (pumps[pumps.length - 1] ?? -1) + 1; i < n; i++) {
    if (cmds[i]!.cmd === 17 || cmds[i]!.cmd === 7) { tail = i; break; }
  }
  const head = pumps[0] ?? tail;

  const phases: ScriptPhaseView[] = [];
  const markerIdx: number[] = [];
  const frame: number[] = [];

  // Kopf: Start, Tara-Warten und Bezugsventil sind Rahmen, alles andere Marke.
  let valveSeen = false;
  for (let i = 0; i < head; i++) {
    const id = cmds[i]!.cmd;
    if ((id === 1 && i === 0) || id === 12 || (id === 13 && !valveSeen)) {
      if (id === 13) valveSeen = true;
      frame.push(i);
    } else markerIdx.push(i);
  }

  // Abschnitte: Pumpenbefehl bis vor den naechsten (bzw. das Ende).
  pumps.forEach((s, k) => {
    const e = (pumps[k + 1] ?? tail) - 1;
    const vals = pumpValues(cmds[s]!);
    let start = s;
    let pumpIndex: number | null = s;
    let any = false;
    for (let j = s + 1; j <= e; j++) {
      if (WAIT.has(cmds[j]!.cmd)) {
        phases.push(phaseOf(vals, pumpIndex, j, [start, j], cmds[j]!));
        start = j + 1;
        pumpIndex = null;
        any = true;
      } else markerIdx.push(j);
    }
    if (!any) phases.push(phaseOf(vals, s, null, [s, e], null));
    else if (start <= e) phases[phases.length - 1]!.range[1] = e; // Marken hinter dem letzten Warten
  });

  // Schluss: Entleeren & Beenden und Ende sind Rahmen, Signaltoene usw. Marken.
  for (let i = tail; i < n; i++) {
    const id = cmds[i]!.cmd;
    if (id === 17 || (id === 7 && i === n - 1)) frame.push(i);
    else markerIdx.push(i);
  }

  const markers = markerIdx.map((i) => {
    let phase = -1;
    phases.forEach((p, pi) => { if (i >= p.range[0]) phase = pi; });
    return { index: i, cmd: cmds[i]!.cmd, label: label(cmds[i]!.cmd), phase };
  });
  return { phases, markers, frame };
}

function phaseOf(
  vals: Pick<Phase, "kind" | "target" | "rampS">,
  pumpIndex: number | null,
  waitIndex: number | null,
  range: [number, number],
  wait: ParsedCmd | null,
): ScriptPhaseView {
  return {
    kind: vals.kind,
    target: vals.target,
    rampS: pumpIndex === null ? 0 : vals.rampS,
    maxPressureBar: null,
    maxFlowGs: null,
    gentleness: null,
    name: null,
    exits: wait ? [waitExit(wait)] : [],
    pumpIndex,
    waitIndex,
    range,
  };
}

// ---------------------------------------------------------------------------
// Stufen → Phasen
// ---------------------------------------------------------------------------

function exitsOf(e: StepExit): PhaseExit[] {
  const out: PhaseExit[] = [];
  if (e.weightG != null) out.push({ kind: "weight", value: e.weightG });
  if (e.pressureBar != null) out.push({ kind: "pressureAbove", value: e.pressureBar });
  if (e.pressureBelowBar != null) out.push({ kind: "pressureBelow", value: e.pressureBelowBar });
  if (e.flowGs != null) out.push({ kind: "flowBelow", value: e.flowGs });
  if (e.seconds != null) out.push({ kind: "time", value: e.seconds });
  return out;
}

export function projectSteps(steps: BrewStep[]): Phase[] {
  return steps.map((s): Phase => {
    const base = {
      rampS: (s.rampMs ?? 0) / 1000, maxPressureBar: null, maxFlowGs: null, gentleness: null,
      name: s.name?.trim() ? s.name.trim() : null, exits: exitsOf(s.exit),
    };
    switch (s.kind) {
      case "flow": return { ...base, kind: "flow", target: s.targetFlowGs, maxPressureBar: s.maxPressureBar ?? null,
        ...(s.adoptFlow ? { adoptFlow: true } : {}) };
      case "pressure": return { ...base, kind: "pressure", target: s.targetPressureBar, maxFlowGs: s.maxFlowGs ?? null };
      case "preinfusion": return { ...base, kind: "preinfusion", target: null, rampS: 0, gentleness: s.gentleness ?? "normal" };
      case "power": {
        const limits = { maxPressureBar: s.maxPressureBar ?? null, maxFlowGs: s.maxFlowGs ?? null };
        // Leistung 0 ohne Begrenzung ist eine Pause (Pumpe aus) — wie Cmd 6 im Skript.
        return s.power === 0 && limits.maxPressureBar === null && limits.maxFlowGs === null
          ? { ...base, kind: "pause", target: null, rampS: 0 }
          : { ...base, ...limits, kind: "power", target: s.power };
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Laufart
// ---------------------------------------------------------------------------

export type Engine = "script" | "app";

export interface Laufart {
  engine: Engine | "conflict";
  /** Was nur die App kann. */
  app: string[];
  /** Was nur das Skript kann. */
  script: string[];
}

/**
 * Skript, wann immer die Phasen es erlauben. Das Skript kann je Phase Druck,
 * Leistung oder Pause und genau ein Warten (Zeit, Gewicht, Druck ≥, °C);
 * Befehle ohne Phase gibt es nur im Skript. Fluss (Cmd 5) und Begrenzungen
 * (Cmd 29/30) sind im Skript nie gelaufen und zaehlen deshalb als App.
 */
export function laufart(phases: Phase[], markers: Pick<ScriptMarker, "label">[] = []): Laufart {
  const app: string[] = [];
  const script: string[] = [];
  phases.forEach((p, i) => {
    const n = `Phase ${i + 1}`;
    if (p.kind === "flow") app.push(`Flussregelung in ${n}`);
    if (p.kind === "preinfusion") app.push(`Preinfusion über den Zulauf in ${n}`);
    if (p.maxPressureBar !== null || p.maxFlowGs !== null) app.push(`Begrenzung in ${n}`);
    if (p.kind !== "preinfusion" && p.exits.length > 1) app.push(`mehrere Ausstiege in ${n}`);
    for (const e of p.exits) {
      if (e.kind === "pressureBelow") app.push(`Druck ≤ als Ausstieg in ${n}`);
      if (e.kind === "flowBelow") app.push(`Fluss ≤ als Ausstieg in ${n}`);
      if (e.kind === "tempAbove") script.push(`Warten bis °C in ${n}`);
    }
  });
  for (const m of markers) script.push(`Befehl „${m.label}“`);
  return { engine: app.length && script.length ? "conflict" : app.length ? "app" : "script", app, script };
}

// ---------------------------------------------------------------------------
// Umwandeln
// ---------------------------------------------------------------------------

type Converted<T> = { ok: true; value: T } | { ok: false; reasons: string[] };

function exitOf(exits: PhaseExit[]): StepExit {
  const e: StepExit = {};
  for (const x of exits) {
    if (x.kind === "weight") e.weightG = x.value;
    if (x.kind === "pressureAbove") e.pressureBar = x.value;
    if (x.kind === "pressureBelow") e.pressureBelowBar = x.value;
    if (x.kind === "flowBelow") e.flowGs = x.value;
    if (x.kind === "time") e.seconds = x.value;
  }
  return e;
}

/** Eine Phase als App-Stufe. Preinfusion und Fluss sind nur in der App moeglich. */
export function phaseToStep(p: Phase): BrewStep {
  const exit = exitOf(p.exits);
  const named = p.name ? { name: p.name } : {};
  const ramp = p.rampS > 0 ? { rampMs: Math.round(p.rampS * 1000) } : {};
  switch (p.kind) {
    case "flow":
      return { kind: "flow", ...named, targetFlowGs: p.target ?? 0, ...ramp, exit,
        ...(p.maxPressureBar !== null ? { maxPressureBar: p.maxPressureBar } : {}),
        ...(p.adoptFlow ? { adoptFlow: true } : {}) };
    case "pressure":
      return { kind: "pressure", ...named, targetPressureBar: p.target ?? 0, ...ramp, exit,
        ...(p.maxFlowGs !== null ? { maxFlowGs: p.maxFlowGs } : {}) };
    case "preinfusion":
      return { kind: "preinfusion", ...named, gentleness: p.gentleness ?? "normal", exit };
    case "pause":
      return { kind: "power", ...named, power: 0, exit };
    case "power":
      return { kind: "power", ...named, power: p.target ?? 0, ...ramp, exit,
        ...(p.maxPressureBar !== null ? { maxPressureBar: p.maxPressureBar } : {}),
        ...(p.maxFlowGs !== null ? { maxFlowGs: p.maxFlowGs } : {}) };
  }
}

/** Skript → App-Stufen, wenn eine Aenderung die App braucht. Marken sperren. */
export function scriptToSteps(cmds: ParsedCmd[]): Converted<BrewStep[]> {
  const proj = projectScript(cmds);
  const reasons = laufart(proj.phases, proj.markers).script;
  proj.phases.forEach((p, i) => {
    if (p.waitIndex === null) reasons.push(`Phase ${i + 1} hat kein Warten (läuft nie)`);
  });
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, value: proj.phases.map(phaseToStep) };
}

/** Rahmen-Notbremse fuer eine letzte Phase ohne Ausstieg (wie die Londinium-Skripte). */
export const SAFETY_WAIT_MS = 60_000;

function pumpCmd(p: Phase): ParsedCmd {
  const ramp = Math.round(p.rampS * 10) * 100;
  if (p.kind === "pressure") return makeCmd(4, [Math.round((p.target ?? 0) * 10) * 100, ramp]);
  if (p.kind === "power") return makeCmd(3, [Math.round(p.target ?? 0), ramp]);
  return makeCmd(6);
}

function waitCmd(e: PhaseExit): ParsedCmd {
  if (e.kind === "weight") return makeCmd(27, [e.value]);
  if (e.kind === "pressureAbove") return makeCmd(26, [Math.round(e.value * 10) * 100]);
  if (e.kind === "tempAbove") return makeCmd(25, [e.value]);
  return makeCmd(12, [Math.round(e.value * 10) * 100]);
}

/**
 * App-Stufen → neues Skript, wenn ein App-Profil skriptfaehig wird. Rahmen wie
 * die vorhandenen Skripte: Start, Bezugsventil, je Phase Pumpenbefehl + Warten,
 * Entleeren & Beenden, Ende. Ein Gewichts-Ausstieg (Cmd 27) bekommt das
 * Tara-Warten von ~1 s davor (Xenia-Support).
 *
 * Die letzte Phase behaelt die Bedeutung aus der App: dort stoppt der Yield
 * (App, nach Gewicht), ihre Ausstiege wertet der Antrieb nie aus. Im Skript
 * bekommt sie deshalb die Notbremse — ausser sie hat eine eigene Zeit, die
 * bleibt (Skript → Stufen → Skript aendert so nichts).
 */
export function stepsToScript(steps: BrewStep[]): Converted<ParsedCmd[]> {
  const phases = projectSteps(steps);
  const reasons = [...laufart(phases).app];
  if (phases.length === 0) reasons.push("keine Phase");
  if (reasons.length > 0) return { ok: false, reasons };
  const last = phases.length - 1;
  const out: ParsedCmd[] = [makeCmd(1)];
  if (phases.some((p, i) => i < last && p.exits.some((e) => e.kind === "weight"))) out.push(makeCmd(12, [1000]));
  out.push(makeCmd(13));
  phases.forEach((p, i) => {
    out.push(pumpCmd(p));
    const e = p.exits[0];
    if (i < last) { if (e) out.push(waitCmd(e)); }
    else out.push(e?.kind === "time" ? waitCmd(e) : makeCmd(12, [SAFETY_WAIT_MS]));
  });
  out.push(makeCmd(17), makeCmd(7));
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Skript-Phasen bearbeiten — immer nur die betroffenen Befehle
// ---------------------------------------------------------------------------

/**
 * Fortsetzungen eigene Pumpenbefehle geben (gleiches Ziel, keine Rampe), von
 * hinten nach vorn, damit die Indizes der uebrigen stimmen.
 */
function materialize(cmds: ParsedCmd[], phaseIndexes: number[]): ParsedCmd[] {
  const proj = projectScript(cmds);
  const todo = [...new Set(phaseIndexes)]
    .filter((i) => proj.phases[i] && proj.phases[i]!.pumpIndex === null)
    .sort((a, b) => b - a);
  let out = cmds;
  for (const i of todo) {
    const p = proj.phases[i]!;
    out = insertCmd(out, p.range[0], pumpCmd({ ...p, rampS: 0 }));
  }
  return out;
}

/** Die Fortsetzungen, die zu Phase `i` gehoeren (gleicher Abschnitt, danach). */
function continuationsAfter(proj: ScriptProjection, i: number): number[] {
  const out: number[] = [];
  for (let k = i + 1; k < proj.phases.length && proj.phases[k]!.pumpIndex === null; k++) out.push(k);
  return out;
}

/** Ziel und Rampe einer Skript-Phase in ihren eigenen Einheiten. Unveraendert → dieselbe Liste. */
export function setScriptPhaseValues(cmds: ParsedCmd[], i: number, v: { target?: number; rampS?: number }): ParsedCmd[] {
  const p0 = projectScript(cmds).phases[i];
  if (!p0 || p0.kind === "pause") return cmds;
  const sameTarget = v.target === undefined || v.target === p0.target;
  const sameRamp = v.rampS === undefined || v.rampS === p0.rampS;
  if (sameTarget && sameRamp) return cmds;
  let out = materialize(cmds, [i]);
  const p = projectScript(out).phases[i]!;
  const at = p.pumpIndex!;
  if (v.target !== undefined) {
    const raw = p.kind === "pressure" ? Math.round(v.target * 10) * 100
      : p.kind === "power" ? Math.round(v.target) : r1(v.target);
    out = setArg(out, at, 0, raw);
  }
  if (v.rampS !== undefined) out = setArg(out, at, 1, Math.max(0, Math.round(v.rampS * 10) * 100));
  return out;
}

/** Den Ausstieg einer Skript-Phase setzen — genau einer, oder keiner (null). */
export function setScriptPhaseExit(cmds: ParsedCmd[], i: number, exit: PhaseExit | null): ParsedCmd[] {
  const p = projectScript(cmds).phases[i];
  if (!p) return cmds;
  if (exit === null) return p.waitIndex === null ? cmds : removeCmd(cmds, p.waitIndex);
  if (exit.kind === "pressureBelow" || exit.kind === "flowBelow") return cmds; // nur App
  const next = waitCmd(exit);
  if (p.waitIndex === null) return insertCmd(cmds, p.range[1] + 1, next);
  const cur = cmds[p.waitIndex]!;
  if (cur.cmd === next.cmd && num(cur.args[0]) === num(next.args[0])) return cmds;
  return cmds.map((c, k) => (k === p.waitIndex ? next : c));
}

/** Art einer Skript-Phase wechseln (Druck, Leistung, Pause) mit ueblichen Startwerten. */
export function setScriptPhaseKind(cmds: ParsedCmd[], i: number, kind: "pressure" | "power" | "pause"): ParsedCmd[] {
  const p0 = projectScript(cmds).phases[i];
  if (!p0 || p0.kind === kind) return cmds;
  const out = materialize(cmds, [i]);
  const p = projectScript(out).phases[i]!;
  const ramp = Math.round(p.rampS * 10) * 100;
  const next = kind === "pressure" ? makeCmd(4, [9000, ramp]) : kind === "power" ? makeCmd(3, [60, ramp]) : makeCmd(6);
  return out.map((c, k) => (k === p.pumpIndex ? next : c));
}

/** Neue Druckphase hinter Phase `after` (-1 = als erste), mit Warten (siehe insertWithWait). */
export function addScriptPhase(cmds: ParsedCmd[], after: number): ParsedCmd[] {
  const proj = projectScript(cmds);
  // Hinter die Phase samt ihren Fortsetzungen, sonst landet die neue mitten in deren Abschnitt.
  const last = after < 0 ? null : proj.phases[Math.max(after, ...continuationsAfter(proj, after))];
  // Ohne Vorgaenger: vor die erste Phase, in einem Skript ohne Phasen vor „Entleeren & Beenden“/„Ende“.
  const tailStart = proj.frame.find((f) => cmds[f]!.cmd === 17 || cmds[f]!.cmd === 7) ?? cmds.length - 1;
  const at = last ? last.range[1] + 1 : (proj.phases[0]?.range[0] ?? tailStart);
  return insertWithWait(cmds, at, makeCmd(4, [6000, 0])).cmds;
}

/** Phase entfernen: ihr Pumpenbefehl und ihr Warten. Marken bleiben, Fortsetzungen behalten ihr Ziel. */
/** Index, an dem `addScriptPhase(cmds, after)` die neue Phase einfuegt — hinter Phase und Fortsetzungen. */
export function scriptPhaseInsertIndex(cmds: ParsedCmd[], after: number): number {
  const proj = projectScript(cmds);
  if (after < 0 || !proj.phases[after]) return 0;
  return Math.max(after, ...continuationsAfter(proj, after)) + 1;
}

/**
 * Phasennamen einer Skript-Kurve: die Maschine kennt keine, sie stehen je
 * Phasen-Index in der Variante. Einfuegen, Loeschen und Verschieben fuehren sie
 * mit; freies Bearbeiten der Befehle zaehlt nur nach Position — hier auf die
 * Phasenzahl gebracht.
 */
export function fitPhaseNames(names: readonly (string | null)[], count: number): (string | null)[] {
  return Array.from({ length: count }, (_, i) => names[i] ?? null);
}

export function removeScriptPhase(cmds: ParsedCmd[], i: number): ParsedCmd[] {
  const out = materialize(cmds, continuationsAfter(projectScript(cmds), i));
  const p = projectScript(out).phases[i];
  if (!p) return cmds;
  const drop = [p.waitIndex, p.pumpIndex].filter((x): x is number => x !== null).sort((a, b) => b - a);
  return drop.reduce((acc, k) => removeCmd(acc, k), out);
}

/** Phase samt ihren Marken mit der Nachbarphase tauschen (dir -1 = nach vorn, +1 = nach hinten). */
export function moveScriptPhase(cmds: ParsedCmd[], i: number, dir: -1 | 1): ParsedCmd[] {
  const j = i + dir;
  const proj0 = projectScript(cmds);
  if (!proj0.phases[i] || !proj0.phases[j]) return cmds;
  // Beide Phasen und alles, was an ihnen haengt, bekommen eigene Pumpenbefehle.
  const out = materialize(cmds, [i, j, ...continuationsAfter(proj0, i), ...continuationsAfter(proj0, j)]);
  const proj = projectScript(out);
  const [a, b] = dir === 1 ? [proj.phases[i]!, proj.phases[j]!] : [proj.phases[j]!, proj.phases[i]!];
  const A = out.slice(a.range[0], a.range[1] + 1);
  const B = out.slice(b.range[0], b.range[1] + 1);
  return [...out.slice(0, a.range[0]), ...B, ...out.slice(a.range[1] + 1, b.range[0]), ...A, ...out.slice(b.range[1] + 1)];
}

// ---------------------------------------------------------------------------
// Speichern — welcher Fall liegt vor?
// ---------------------------------------------------------------------------

export type SaveCase =
  /** Laufart „Geht so nicht“ — nichts speichern. */
  | { kind: "blocked"; reasons: string[] }
  /** Nur das Profil (App-Profil, oder Skript-Inhalt unveraendert). */
  | { kind: "profileOnly" }
  /** Skript bleibt Skript und hat sich geaendert: ueberschreiben oder als neues anlegen.
   *  `otherUsers` = andere Profile mit demselben Skript; `otherSlot` = andere
   *  Varianten dieses Profils fahren es mit („wie Variante X“). */
  | { kind: "overwrite"; scriptId: number; otherUsers: string[]; otherSlot: boolean }
  /** Neues Skript anlegen (App-Profil wird skriptfaehig, oder eigene Kurve abgespalten). */
  | { kind: "newScript" }
  /** Skript-Profil laeuft kuenftig in der App; braucht das Skript sonst niemand → fragen, ob loeschen. */
  | { kind: "toApp"; scriptId: number; stillUsed: boolean };

export function decideSave(a: {
  before: { engine: Engine; scriptId: number | null };
  after: Laufart;
  /** Hat sich die Kurve geaendert (Skript-Inhalt bzw. Stufen)? */
  curveChanged: boolean;
  otherUsers: string[];
  otherSlot: boolean;
  /** Die Variante nutzte das Skript der anderen und hat jetzt eine eigene Kurve. */
  split?: boolean;
}): SaveCase {
  if (a.after.engine === "conflict") {
    return { kind: "blocked", reasons: [...a.after.app.map((r) => `nur App: ${r}`), ...a.after.script.map((r) => `nur Skript: ${r}`)] };
  }
  if (a.before.engine === "app") {
    // Bestehende App-Profile wechseln nie von selbst — nur, wenn die Kurve geaendert wurde.
    return a.after.engine === "script" && a.curveChanged ? { kind: "newScript" } : { kind: "profileOnly" };
  }
  if (a.after.engine === "app") {
    return { kind: "toApp", scriptId: a.before.scriptId!, stillUsed: a.otherUsers.length > 0 || a.otherSlot };
  }
  if (!a.curveChanged) return { kind: "profileOnly" };
  if (a.split) return { kind: "newScript" };
  return { kind: "overwrite", scriptId: a.before.scriptId!, otherUsers: a.otherUsers, otherSlot: a.otherSlot };
}

/** Die Kurve einer Variante beim Speichern: wie sie beim Oeffnen lief und wie sie jetzt ist. */
export interface VariantSave {
  /** Beim Oeffnen (abgespaltene Kurve: die, von der sie kopiert ist). */
  start: { cmds: ParsedCmd[] | null; steps: BrewStep[] | null };
  /** Jetzt; `scriptId`/`baseContent` = das Skript, auf das sie zeigt, so wie es geladen wurde. */
  now: { cmds: ParsedCmd[] | null; steps: BrewStep[] | null; scriptId: number | null; baseContent: string | null };
  otherUsers: string[];
  /** Andere Varianten fahren diese Kurve mit („wie Variante X“). */
  otherSlot: boolean;
}

export interface VariantSavePlan {
  /** So laeuft die Kurve nach dem Speichern. */
  engine: Engine;
  case: SaveCase;
  laufart: Laufart;
}

/**
 * Die Kurve ohne Befehlsbezug — erkennt eine umgewandelte, sonst unveraenderte
 * Variante. Ohne Phasennamen: die stehen neben dem Skript (Variante), ein
 * Umbenennen schreibt kein Skript neu.
 */
function curveKey(phases: Phase[]): string {
  return JSON.stringify(phases.map((p) => [p.kind, p.target, p.rampS, p.maxPressureBar, p.maxFlowGs, p.gentleness, p.exits,
    ...(p.adoptFlow ? ["adopt"] : [])]));
}

/**
 * Speichern je Kurve — jede Variante laeuft fuer sich (Schnitt 3c). Braucht
 * die Kurve die App, laeuft sie in der App; sonst im Skript, wenn sie eins hat,
 * eins war oder geaendert wurde. Eine unveraenderte App-Kurve bleibt App, auch
 * wenn sie ins Skript passte. Eine in die App umgewandelte Kurve, die wieder
 * die alte ist, behaelt ihr Skript Byte fuer Byte.
 */
export function planVariantSave(v: VariantSave): VariantSavePlan {
  let la: Laufart;
  let changed: boolean;
  if (v.now.cmds) {
    const pr = projectScript(v.now.cmds);
    la = laufart(pr.phases, pr.markers);
    changed = v.now.baseContent === null || serializeScript({ commands: v.now.cmds, unknownCmds: [] }) !== v.now.baseContent;
  } else {
    const ps = projectSteps(v.now.steps ?? []);
    la = laufart(ps);
    changed = v.start.cmds
      ? curveKey(ps) !== curveKey(projectScript(v.start.cmds).phases)
      : JSON.stringify(v.now.steps) !== JSON.stringify(v.start.steps);
  }
  const onScript = v.now.scriptId !== null;
  // „War ein Skript“ zaehlt nur, solange sie noch darauf zeigt — eine abgespaltene
  // Kopie ohne eigenes Skript bleibt unveraendert in der App.
  const engine: Engine = la.engine === "app" ? "app"
    : v.now.cmds !== null || (v.start.cmds !== null && onScript) || changed ? "script" : "app";
  return {
    engine,
    laufart: la,
    case: decideSave({
      // Zeigt die Kurve auf ein Skript, ist das der Stand an der Maschine.
      before: { engine: onScript ? "script" : "app", scriptId: v.now.scriptId },
      after: la.engine === "conflict" ? la : { ...la, engine },
      curveChanged: changed,
      otherUsers: v.otherUsers,
      // In der App fahren die anderen Varianten mit — das Skript braucht dann keine mehr.
      otherSlot: v.otherSlot && engine === "script",
    }),
  };
}
