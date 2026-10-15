/**
 * Skript-Editor — reine Bearbeitungs-Operationen auf der Befehlsliste.
 *
 * Alles hier ist unveraenderlich (neue Liste statt Mutation), damit der Editor
 * Rueckgaengig ueber eine einfache Liste von Staenden bekommt.
 *
 * Zwei Arten zu bearbeiten, beide landen in denselben Befehlen:
 *
 *   Liste  — Befehl einfuegen, loeschen, verschieben, ein Argument setzen.
 *   Kurve  — an der Soll-Kurve ziehen. Das Modell dahinter ist das von
 *            scriptToTimeline: ein Pumpenbefehl (3/4/5) setzt ein Ziel und
 *            kehrt sofort zurueck, die Rampe laeuft parallel zu den folgenden
 *            Wartezeiten, die Stufe endet, wenn der naechste Pumpenbefehl feuert.
 *            Daraus folgen genau drei Griffe:
 *              - Zielwert  → Argument 0 des Pumpenbefehls
 *              - Rampe     → Argument 1 des Pumpenbefehls (Uebergangszeit)
 *              - Stufenende → die LETZTE Wartezeit (Cmd 12) vor dem naechsten
 *                Pumpenbefehl bzw. vor dem Skriptende. Die letzte, weil davor
 *                liegende Wartezeiten meist etwas anderes takten (z. B. die
 *                Tara-Pause) und die Stufe als Ganzes laenger werden soll.
 *
 * Start (Cmd 1) und Ende (Cmd 7) sind fest: der Validator verlangt sie am
 * Rand, der Editor zeigt und verschiebt nur, was dazwischen steht.
 */

import type { ParsedCmd } from "./types.js";
import { parseScript } from "./script-parser.js";
import { powerToBar } from "./script-timeline.js";

/** Pumpenbefehle, die eine Stufe beginnen (6 = Pumpe aus, Ziel 0). */
const PUMP_CMDS = new Set([3, 4, 5, 6]);

/** Rasterung beim Ziehen und in den Feldern. */
export const TIME_STEP_MS = 100;
export const DRAG_TIME_STEP_MS = 500;
export const PRESSURE_STEP_BAR = 0.1;
export const FLOW_STEP_MLS = 0.1;
/** Kuerzeste Wartezeit, auf die ein Stufenende gezogen werden kann. */
export const MIN_WAIT_MS = 500;
/** Obergrenzen wie im Validator (Druck 12 bar) bzw. physikalisch sinnvoll. */
export const MAX_PRESSURE_BAR = 12;
export const MAX_FLOW_MLS = 10;

/** Einen Befehl mit Bedeutung und Argument-Namen bauen, wie der Parser es tut. */
export function makeCmd(cmd: number, args: number[] = []): ParsedCmd {
  return parseScript(`${[cmd, ...args].join(" ")};`).commands[0]!;
}

/** Standard-Argumente fuer einen neu eingefuegten Befehl. */
export function defaultArgs(cmd: number): number[] {
  switch (cmd) {
    case 3: return [60, 2000];
    case 4: return [6000, 2000];
    case 5: return [2, 2000];
    case 8: case 9: return [100];
    case 12: return [5000];
    case 20: return [1, 1000];
    case 25: return [93];
    case 27: return [36];
    case 29: return [9];
    case 30: return [3];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

/** Erster und letzter bearbeitbarer Index (ohne Start/Ende am Rand). */
export function editableRange(cmds: ParsedCmd[]): { first: number; last: number } {
  const first = cmds[0]?.cmd === 1 ? 1 : 0;
  const last = cmds.length > 0 && cmds[cmds.length - 1]!.cmd === 7 ? cmds.length - 2 : cmds.length - 1;
  return { first, last };
}

function clampIndex(cmds: ParsedCmd[], i: number, forInsert: boolean): number {
  const { first, last } = editableRange(cmds);
  return Math.max(first, Math.min(forInsert ? last + 1 : last, i));
}

/** Befehl von `from` nach `to` verschieben (Start/Ende bleiben am Rand). */
export function moveCmd(cmds: ParsedCmd[], from: number, to: number): ParsedCmd[] {
  const { first, last } = editableRange(cmds);
  if (from < first || from > last) return cmds;
  const target = clampIndex(cmds, to, false);
  if (target === from) return cmds;
  const next = [...cmds];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item!);
  return next;
}

/** Befehl an Position `at` einfuegen (vor dem Ende, nie vor dem Start). */
export function insertCmd(cmds: ParsedCmd[], at: number, cmd: ParsedCmd): ParsedCmd[] {
  const i = clampIndex(cmds, at, true);
  return [...cmds.slice(0, i), cmd, ...cmds.slice(i)];
}

/** Befehl an `at` entfernen — Start und Ende nicht. */
export function removeCmd(cmds: ParsedCmd[], at: number): ParsedCmd[] {
  const { first, last } = editableRange(cmds);
  if (at < first || at > last) return cmds;
  return [...cmds.slice(0, at), ...cmds.slice(at + 1)];
}

/** Ein Argument setzen; der Rest des Befehls bleibt. */
export function setArg(cmds: ParsedCmd[], at: number, argIndex: number, value: number): ParsedCmd[] {
  const c = cmds[at];
  if (!c) return cmds;
  const args = [...c.args];
  while (args.length <= argIndex) args.push(0);
  args[argIndex] = value;
  return cmds.map((x, i) => (i === at ? { ...c, args } : x));
}

// ---------------------------------------------------------------------------
// Kurve
// ---------------------------------------------------------------------------

const round = (v: number, step: number) => Math.round(v / step) * step;
const clean = (v: number) => Number(v.toFixed(3));

/**
 * Umkehrung von powerToBar (bar = 15·p/(p+50)) → p = 50·bar/(15−bar).
 * Nur fuer die Darstellung von Leistungsbefehlen auf der bar-Achse — dieselbe
 * angenommene Kurve, nicht gemessen.
 */
export function barToPower(bar: number): number {
  const b = Math.max(0, Math.min(powerToBar(100), bar));
  return Math.max(0, Math.min(100, Math.round((50 * b) / (15 - b))));
}

/**
 * Zielwert einer Stufe setzen, in der Einheit ihrer Achse (bar bzw. ml/s).
 * Cmd 4 → mbar (auf 0,1 bar gerastert), Cmd 3 → % ueber die bar-Kurve,
 * Cmd 5 → ml/s. Cmd 6 hat kein Ziel.
 */
export function setPhaseTarget(cmds: ParsedCmd[], at: number, axisValue: number): ParsedCmd[] {
  const c = cmds[at];
  if (!c) return cmds;
  if (c.cmd === 4) {
    const bar = Math.max(0, Math.min(MAX_PRESSURE_BAR, round(axisValue, PRESSURE_STEP_BAR)));
    return setArg(cmds, at, 0, Math.round(bar * 1000));
  }
  if (c.cmd === 3) return setArg(cmds, at, 0, barToPower(axisValue));
  if (c.cmd === 5) {
    return setArg(cmds, at, 0, clean(Math.max(0, Math.min(MAX_FLOW_MLS, round(axisValue, FLOW_STEP_MLS)))));
  }
  return cmds;
}

/** Uebergangszeit (Rampe) eines Pumpenbefehls setzen, gerastert, nie negativ. */
export function setPhaseRamp(cmds: ParsedCmd[], at: number, rampMs: number, step = TIME_STEP_MS): ParsedCmd[] {
  const c = cmds[at];
  if (!c || !(c.cmd === 3 || c.cmd === 4 || c.cmd === 5)) return cmds;
  return setArg(cmds, at, 1, Math.max(0, round(rampMs, step)));
}

/**
 * Die Wartezeit, deren Laenge das Ende der Stufe ab `at` bestimmt: die letzte
 * Cmd-12 zwischen diesem Pumpenbefehl und dem naechsten (bzw. dem Skriptende).
 * -1, wenn keine da ist — dann endet die Stufe sofort oder nur ueber eine
 * unbestimmte Wartezeit (Cmd 25/27), und es gibt nichts zu ziehen.
 */
export function phaseWaitIndex(cmds: ParsedCmd[], at: number): number {
  let found = -1;
  for (let i = at + 1; i < cmds.length; i++) {
    const id = cmds[i]!.cmd;
    if (PUMP_CMDS.has(id)) break;
    if (id === 12) found = i;
  }
  return found;
}

/**
 * Stufenende verschieben: die bestimmende Wartezeit waechst oder schrumpft um
 * genau `deltaMs` (gerastert), aber nie unter MIN_WAIT_MS. Ohne passende
 * Wartezeit bleibt alles, wie es ist.
 */
export function shiftPhaseEnd(cmds: ParsedCmd[], at: number, deltaMs: number, step = TIME_STEP_MS): ParsedCmd[] {
  const w = phaseWaitIndex(cmds, at);
  if (w < 0) return cmds;
  const current = Number(cmds[w]!.args[0] ?? 0);
  const next = Math.max(MIN_WAIT_MS, round(current + deltaMs, step));
  return next === current ? cmds : setArg(cmds, w, 0, next);
}

// ---------------------------------------------------------------------------
// Einfuegen mit Warten
// ---------------------------------------------------------------------------

/** Befehle, die die Uhr weiterdrehen (fest oder unbestimmt). */
const WAIT_CMDS = new Set([12, 25, 27]);

/** Vorgabe-Wartezeit fuer einen neuen Pumpenbefehl: er soll sein Ziel erreichen. */
export const MIN_STAGE_MS = 5000;
export const BLOOM_PAUSE_MS = 10_000;
/** Notbremse: ein Warten ueber dieser Laenge direkt vor dem Ende (wie im Validator). */
const SAFETY_TIMER_MS = 20_000;

/** Wohin ein Befehl ohne Auswahl kommt: ans Ende, aber vor „Entleeren & Beenden“. */
export function defaultInsertIndex(cmds: ParsedCmd[]): number {
  const { last } = editableRange(cmds);
  return cmds[last]?.cmd === 17 ? last : last + 1;
}

/** Kommt zwischen `from` (einschliesslich) und dem naechsten Pumpenbefehl bzw. dem Ende ein Warten? */
function waitBeforeNextPump(cmds: ParsedCmd[], from: number): { wait: boolean; pumpFollows: boolean } {
  for (let i = from; i < cmds.length; i++) {
    const id = cmds[i]!.cmd;
    if (WAIT_CMDS.has(id)) return { wait: true, pumpFollows: false };
    if (PUMP_CMDS.has(id)) return { wait: false, pumpFollows: true };
  }
  return { wait: false, pumpFollows: false };
}

/**
 * Befehl einfuegen — und bei Pumpenbefehlen dafuer sorgen, dass sie laufen.
 *
 * Ein Pumpenbefehl ohne Warten danach wird vom naechsten sofort ueberschrieben.
 * Deshalb, nur fuer 3/4/5/6:
 *   1. Liegt die Einfuegestelle mitten in einer Stufe — hinter einem
 *      Pumpenbefehl, aber vor dessen Warten —, nahme der neue Befehl dem alten
 *      das Warten weg. Er kommt dann hinter das Warten dieser Stufe, als neue
 *      Stufe danach.
 *   2. Folgt ihm bis zum naechsten Pumpenbefehl kein Warten, kommt eines mit:
 *      Uebergangszeit, mindestens MIN_STAGE_MS; bei „Pumpe aus“ eine
 *      Bloom-Pause. „Pumpe aus“ ohne Pumpenbefehl danach braucht keins.
 *   3. Landet die neue Stufe hinter der Notbremse eines Skripts ohne
 *      „Entleeren & Beenden“, bekommt ihr Warten deren Laenge — sonst fehlte
 *      der Stopp-Mechanismus, und das Skript waere ungueltig.
 * Alle anderen Befehle werden eingefuegt, wie sie sind.
 *
 * Liefert die neue Liste und den Platz des eingefuegten Befehls (zum Markieren).
 */
export function insertWithWait(cmds: ParsedCmd[], at: number, cmd: ParsedCmd): { cmds: ParsedCmd[]; index: number } {
  let i = clampIndex(cmds, at, true);
  if (!PUMP_CMDS.has(cmd.cmd)) return { cmds: insertCmd(cmds, i, cmd), index: i };

  // 1. Nicht in eine Stufe hinein, deren Warten noch folgt.
  let prevPump = -1;
  for (let k = i - 1; k >= 0; k--) {
    const id = cmds[k]!.cmd;
    if (WAIT_CMDS.has(id)) break;
    if (PUMP_CMDS.has(id)) { prevPump = k; break; }
  }
  if (prevPump >= 0) {
    // letztes Warten jeder Art (auch „bis Gewicht“/„bis °C“) dieser Stufe
    let w = -1;
    for (let k = prevPump + 1; k < cmds.length && !PUMP_CMDS.has(cmds[k]!.cmd); k++) {
      if (WAIT_CMDS.has(cmds[k]!.cmd)) w = k;
    }
    if (w >= i) i = w + 1;
  }

  let next = insertCmd(cmds, i, cmd);
  // 3. Hinter der Notbremse eines Skripts ohne „Entleeren & Beenden“ (Stopp
  //    nach Gewicht): die neue letzte Stufe uebernimmt deren Laenge, sonst
  //    fehlte am Ende der Stopp-Mechanismus.
  const beforeEnd = next[i + 1]?.cmd === 7;
  const prev = next[i - 1];
  const safetyMs = beforeEnd && !next.some((c) => c.cmd === 17) && prev?.cmd === 12
    && Number(prev.args[0]) > SAFETY_TIMER_MS ? Number(prev.args[0]) : null;
  // 2. Eigenes Warten, wenn keins folgt.
  const after = waitBeforeNextPump(next, i + 1);
  const needsWait = !after.wait && (cmd.cmd !== 6 || after.pumpFollows || safetyMs !== null);
  if (needsWait) {
    const ms = safetyMs ?? (cmd.cmd === 6 ? BLOOM_PAUSE_MS : Math.max(MIN_STAGE_MS, Number(cmd.args[1] ?? 0)));
    next = insertCmd(next, i + 1, makeCmd(12, [ms]));
  }
  return { cmds: next, index: i };
}
