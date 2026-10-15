/**
 * Skript-Editor: Bearbeitungs-Operationen. Geprueft an Flavios echten
 * Skripten, weil genau die bearbeitet werden. Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScript } from "../src/script-parser.js";
import { serializeScript } from "../src/script-serializer.js";
import { scriptToTimeline, powerToBar } from "../src/script-timeline.js";
import { validateScript } from "../src/script-validator.js";
import {
  makeCmd, moveCmd, insertCmd, removeCmd, setArg, editableRange,
  setPhaseTarget, setPhaseRamp, phaseWaitIndex, shiftPhaseEnd, barToPower, MIN_WAIT_MS,
} from "../src/script-edit.js";

const LONDINIUM = "1;13;4 1100 1000;12 15000;4 9000 2000;12 5000;4 4000 45000;12 60000;17;7;";
const BLOOM_KN = "1;13;4 2000 2000;12 10000;6;12 12000;4 6000 2000;12 60000;7;";
const DECLINING = "1;13;4 9000 3000;12 6000;3 20 35000;12 60000;17;7;";
const BEFEHLTEST = "1;12 1000;13;4 2000 10000;27 20;17;7;";

const cmds = (s: string) => parseScript(s).commands;
const text = (c: ReturnType<typeof cmds>) => serializeScript({ commands: c, unknownCmds: [] });

// --- Liste ------------------------------------------------------------------

test("makeCmd baut einen Befehl wie der Parser", () => {
  assert.deepEqual(makeCmd(4, [6000, 2000]), cmds("4 6000 2000;")[0]);
  assert.equal(makeCmd(12, [5000]).meaning, "Warten");
});

test("bearbeitbar ist alles zwischen Start und Ende", () => {
  assert.deepEqual(editableRange(cmds(LONDINIUM)), { first: 1, last: 8 });
});

test("verschieben: Ventil hinter die erste Wartezeit", () => {
  const c = moveCmd(cmds(LONDINIUM), 1, 3);
  assert.equal(text(c), "1;4 1100 1000;12 15000;13;4 9000 2000;12 5000;4 4000 45000;12 60000;17;7;");
});

test("⚠ verschieben: Start und Ende bleiben am Rand, egal wohin gezogen wird", () => {
  const c = cmds(LONDINIUM);
  assert.equal(moveCmd(c, 0, 4), c, "Start laesst sich nicht greifen");
  assert.equal(moveCmd(c, 9, 2), c, "Ende laesst sich nicht greifen");
  assert.equal(text(moveCmd(c, 2, 0)).slice(0, 4), "1;4 ", "vor den Start gezogen landet direkt dahinter");
  assert.ok(text(moveCmd(c, 2, 99)).endsWith("17;4 1100 1000;7;"), "hinter das Ende gezogen landet davor");
});

test("einfuegen und loeschen", () => {
  let c = insertCmd(cmds(BLOOM_KN), 99, makeCmd(20, [1, 1000]));
  assert.ok(text(c).endsWith("12 60000;20 1 1000;7;"));
  c = removeCmd(c, c.length - 2);
  assert.equal(text(c), BLOOM_KN);
  assert.equal(removeCmd(c, 0), c, "Start bleibt");
  assert.equal(removeCmd(c, c.length - 1), c, "Ende bleibt");
});

test("Argument setzen laesst den Rest stehen", () => {
  assert.equal(text(setArg(cmds(LONDINIUM), 3, 0, 20000)).split(";")[3], "12 20000");
});

// --- Kurve: Zielwert und Rampe ------------------------------------------------

test("Zielwert Druck: bar auf 0,1 gerastert, in mbar gespeichert", () => {
  const c = setPhaseTarget(cmds(LONDINIUM), 4, 8.64);
  assert.equal(c[4]!.args[0], 8600);
  assert.equal(setPhaseTarget(cmds(LONDINIUM), 4, 15)[4]!.args[0], 12000, "nie ueber 12 bar");
  assert.equal(setPhaseTarget(cmds(LONDINIUM), 4, -2)[4]!.args[0], 0);
});

test("Zielwert Leistung: ueber dieselbe bar-Kurve wie die Anzeige", () => {
  for (const p of [20, 50, 75, 100]) assert.equal(barToPower(powerToBar(p)), p, `${p} %`);
  const c = setPhaseTarget(cmds(DECLINING), 4, powerToBar(30));
  assert.equal(c[4]!.args[0], 30);
});

test("Pumpe aus hat kein Ziel", () => {
  const c = cmds(BLOOM_KN);
  assert.equal(setPhaseTarget(c, 4, 3), c);
  assert.equal(setPhaseRamp(c, 4, 3000), c);
});

test("Rampe: gerastert, nie negativ", () => {
  assert.equal(setPhaseRamp(cmds(LONDINIUM), 4, 3240)[4]!.args[1], 3200);
  assert.equal(setPhaseRamp(cmds(LONDINIUM), 4, 3240, 500)[4]!.args[1], 3000);
  assert.equal(setPhaseRamp(cmds(LONDINIUM), 4, -800)[4]!.args[1], 0);
});

// --- Kurve: Stufenende --------------------------------------------------------

test("Stufenende gehoert der letzten Wartezeit vor dem naechsten Pumpenbefehl", () => {
  assert.equal(phaseWaitIndex(cmds(LONDINIUM), 2), 3);
  assert.equal(phaseWaitIndex(cmds(LONDINIUM), 6), 7, "letzte Stufe: die Wartezeit vor 17/7");
  assert.equal(phaseWaitIndex(cmds(BEFEHLTEST), 3), -1, "nur Cmd 27 → nichts zu ziehen");
});

test("⚠ Stufenende ziehen verlaengert die Stufe um genau das Stueck — die Kurve folgt", () => {
  const before = scriptToTimeline(parseScript(LONDINIUM));
  const c = shiftPhaseEnd(cmds(LONDINIUM), 2, 5000);
  const after = scriptToTimeline({ commands: c, unknownCmds: [] });
  assert.equal(after.phases[0]!.tEnd, before.phases[0]!.tEnd + 5000);
  assert.equal(after.phases[1]!.tStart, before.phases[1]!.tStart + 5000, "die folgenden Stufen ruecken nach");
  assert.equal(after.totalMs, before.totalMs + 5000);
});

test("Stufenende: nie unter die Mindest-Wartezeit, ohne Wartezeit keine Aenderung", () => {
  assert.equal(shiftPhaseEnd(cmds(LONDINIUM), 2, -60000)[3]!.args[0], MIN_WAIT_MS);
  const c = cmds(BEFEHLTEST);
  assert.equal(shiftPhaseEnd(c, 3, 3000), c);
});

test("Bloom: das Ende der Pause (Pumpe aus) laesst sich ziehen", () => {
  const c = shiftPhaseEnd(cmds(BLOOM_KN), 4, 3000);
  assert.equal(text(c), "1;13;4 2000 2000;12 10000;6;12 15000;4 6000 2000;12 60000;7;");
});

test("⚠ keine Operation macht aus einem gueltigen Skript ein ungueltiges", () => {
  for (const s of [LONDINIUM, BLOOM_KN, DECLINING]) {
    const base = cmds(s);
    const variants = [
      setPhaseTarget(base, 2, 7.3), setPhaseRamp(base, 2, 9000), shiftPhaseEnd(base, 2, -99999),
      moveCmd(base, 1, 0), moveCmd(base, base.length - 2, 99), removeCmd(base, 0), removeCmd(base, base.length - 1),
    ];
    for (const v of variants) {
      const r = validateScript({ commands: v, unknownCmds: [] });
      assert.ok(r.ok, `${s} → ${text(v)}: ${r.errors.map((e) => e.code)}`);
    }
  }
});

// --- Hilfe und Felder ---------------------------------------------------------

import { CMD_HELP, CMD_ARGS, INSERTABLE_CMDS } from "../src/script-help.js";

const KNOWN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 20, 25, 27, 28, 29, 30, 31];

test("jeder Befehl hat eine Hilfe mit Quelle", () => {
  for (const id of KNOWN) {
    const h = CMD_HELP[id];
    assert.ok(h, `Cmd ${id} ohne Hilfe`);
    assert.ok(h.summary.length > 10, `Cmd ${id}: Zusammenfassung fehlt`);
    assert.ok(["gemessen", "xenia", "nicht erprobt"].includes(h.source));
    assert.notEqual(makeCmd(id).meaning, "UNKNOWN", `Cmd ${id} kennt der Parser nicht`);
  }
});

test("⚠ die Eingabefelder passen zu den Argumenten des Befehls", () => {
  for (const id of KNOWN) {
    assert.equal((CMD_ARGS[id] ?? []).length, makeCmd(id).argLabels.length, `Cmd ${id}`);
  }
});

test("Start und Ende sind nicht einfuegbar, alles andere schon", () => {
  assert.ok(!INSERTABLE_CMDS.includes(1) && !INSERTABLE_CMDS.includes(7));
  assert.deepEqual([...INSERTABLE_CMDS].sort((a, b) => a - b), KNOWN.filter((id) => id !== 1 && id !== 7));
});

// --- Einfuegen mit Warten -----------------------------------------------------

import { insertWithWait, defaultInsertIndex } from "../src/script-edit.js";

/** Pumpenbefehle, die nie laufen — ohne „Pumpe aus“ ganz am Ende (das beendet ohnehin nur). */
const runsNever = (c: ReturnType<typeof cmds>) => {
  const tl = scriptToTimeline({ commands: c, unknownCmds: [] });
  return tl.phases.filter((p) => p.noWait && !(c[p.cmdIndex]!.cmd === 6 && p.tStart === tl.totalMs)).length;
};

test("ohne Auswahl: vor „Entleeren & Beenden“, nicht dahinter", () => {
  assert.equal(defaultInsertIndex(cmds(LONDINIUM)), 8, "vor der 17");
  assert.equal(defaultInsertIndex(cmds(BLOOM_KN)), 8, "ohne 17: vor dem Ende");
});

test("⚠ neuer Druckbefehl am Ende bekommt sein Warten mit", () => {
  const r = insertWithWait(cmds(LONDINIUM), 8, makeCmd(4, [6000, 2000]));
  assert.ok(text(r.cmds).endsWith("12 60000;4 6000 2000;12 5000;17;7;"), text(r.cmds));
  assert.equal(r.index, 8);
  assert.equal(runsNever(r.cmds), 0);
});

test("Wartezeit = Uebergang, wenn der laenger als 5 s ist", () => {
  const r = insertWithWait(cmds(LONDINIUM), 8, makeCmd(4, [6000, 8000]));
  assert.ok(text(r.cmds).includes("4 6000 8000;12 8000;"));
});

test("⚠ hinter einem Pumpenbefehl eingefuegt: kommt hinter dessen Warten, nimmt es ihm nicht weg", () => {
  // Auswahl „Druck 1,1 bar“ (Index 2), „danach einfuegen“ → Index 3 laege vor seinem Warten.
  const r = insertWithWait(cmds(LONDINIUM), 3, makeCmd(4, [3000, 2000]));
  assert.ok(text(r.cmds).startsWith("1;13;4 1100 1000;12 15000;4 3000 2000;12 5000;4 9000 2000;"), text(r.cmds));
  assert.equal(r.index, 4);
  assert.equal(runsNever(r.cmds), 0);
});

test("steht schon ein Warten dahinter, kommt kein zweites", () => {
  // vor „Warten 15 s“ einer Stufe, deren Pumpenbefehl weiter vorn liegt: Einfuegen nach dem Ventil in BEFEHLTEST
  const r = insertWithWait(cmds("1;13;12 3000;4 9000 2000;12 30000;7;"), 2, makeCmd(4, [1000, 1000]));
  assert.equal(text(r.cmds), "1;13;4 1000 1000;12 3000;4 9000 2000;12 30000;7;");
});

test("Pumpe aus: Bloom-Pause, wenn danach noch gepumpt wird — vor dem Ende nicht", () => {
  const mid = insertWithWait(cmds("1;13;4 2000 2000;12 10000;4 6000 2000;12 60000;7;"), 4, makeCmd(6));
  assert.equal(text(mid.cmds), "1;13;4 2000 2000;12 10000;6;12 10000;4 6000 2000;12 60000;7;");
  const end = insertWithWait(cmds(LONDINIUM), 8, makeCmd(6));
  assert.ok(text(end.cmds).endsWith("12 60000;6;17;7;"), text(end.cmds));
});

test("⚠ Gewichtsstopp-Skript: eine neue letzte Stufe uebernimmt die Notbremse", () => {
  const r = insertWithWait(cmds(BLOOM_KN), defaultInsertIndex(cmds(BLOOM_KN)), makeCmd(4, [5000, 3000]));
  assert.ok(text(r.cmds).endsWith("4 6000 2000;12 60000;4 5000 3000;12 60000;7;"), text(r.cmds));
  assert.ok(validateScript({ commands: r.cmds, unknownCmds: [] }).ok);
});

test("andere Befehle kommen ohne Warten und an genau die Stelle", () => {
  const r = insertWithWait(cmds(LONDINIUM), 3, makeCmd(20, [1, 1000]));
  assert.equal(r.index, 3);
  assert.equal(text(r.cmds).split(";")[3], "20 1 1000");
});

test("⚠ Einfuegen eines Pumpenbefehls erzeugt an keiner Stelle einen, der nie laeuft", () => {
  for (const s of [LONDINIUM, BLOOM_KN, DECLINING, BEFEHLTEST]) {
    const base = cmds(s);
    const { first, last } = editableRange(base);
    for (let at = first; at <= last + 1; at++) {
      for (const c of [makeCmd(4, [5000, 3000]), makeCmd(3, [60, 2000]), makeCmd(6)]) {
        const r = insertWithWait(base, at, c);
        assert.ok(runsNever(r.cmds) <= runsNever(base), `${s} @${at} Cmd ${c.cmd}: ${text(r.cmds)}`);
        assert.ok(validateScript({ commands: r.cmds, unknownCmds: [] }).ok);
      }
    }
  }
});
