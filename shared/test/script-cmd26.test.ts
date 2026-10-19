/**
 * Befehl 26 „Warten bis Druck“ (offizieller Skript-Editor der Maschine, FW 4.255)
 * und die übrigen dort gelisteten Befehle 32–34. Vorher kannte der Parser sie
 * nicht — die Prüfung meldete „Unbekannte Befehls-ID“ als Fehler, ein Skript mit
 * 26 ließ sich in der App nicht speichern.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScript } from "../src/script-parser.js";
import { validateScript } from "../src/script-validator.js";
import { scriptToTimeline } from "../src/script-timeline.js";
import { scriptStageStrip } from "../src/stage-strip.js";
import { describeCmdLine } from "../src/script-timeline.js";
import { insertWithWait, makeCmd } from "../src/script-edit.js";

// 80s Decent mit Preinfusion bis 3,8 bar statt nach Uhr.
const DECENT_26 = "1;9 0;8 0;13;4 3800 2000;26 3800;4 7800 3000;12 5000;4 5000 40000;12 45000;17;7;";

test("26, 32, 33, 34 sind bekannt; das Skript besteht die Prüfung", () => {
  const p = parseScript(DECENT_26);
  assert.deepEqual(p.unknownCmds, []);
  for (const s of ["1;26 3800;7;", "1;32 5;7;", "1;33 7;7;", "1;34;7;"]) {
    assert.deepEqual(parseScript(s).unknownCmds, [], s);
  }
  const v = validateScript(p);
  assert.equal(v.errors.some((e) => e.code === "UNKNOWN_CMD"), false);
  assert.equal(v.ok, true);
});

test("26 ist eine unbestimmte Wartezeit: Band „bis 3,8 bar“, die Stufe davor läuft", () => {
  const tl = scriptToTimeline(parseScript(DECENT_26));
  assert.equal(tl.waits.length, 1);
  assert.equal(tl.waits[0].kind, "pressure");
  assert.equal(tl.waits[0].value, 3.8);
  assert.equal(tl.waits[0].label, "bis 3,8 bar");
  // Der 3,8-bar-Befehl wird nicht sofort überschrieben — 26 hält die Abarbeitung an.
  const first = tl.phases.find((ph) => ph.rawTarget === 3.8)!;
  assert.equal(first.noWait, false);
  assert.equal(tl.markers.some((m) => m.label === "Cmd 26"), false);
});

test("Stufenleiste: die Preinfusion endet bei 3,8 bar, danach ist die Lage nur nominal", () => {
  const strip = scriptStageStrip(DECENT_26, 60, { mode: "app", weightG: 20 })!;
  assert.deepEqual(strip.segments[0].exit, { kind: "waitPressure", value: 3.8 });
  assert.equal(strip.segments[0].uncertain, false);
  assert.equal(strip.segments[1].uncertain, true);
});

test("Befehlsliste: Name und Wert wie im Editor", () => {
  const c = parseScript("1;26 3800;7;").commands[1];
  assert.deepEqual(describeCmdLine(c), { label: "Warten bis Druck", detail: "3,8 bar" });
});

test("Editor: ein Pumpenbefehl vor einer 26 bekommt kein zusätzliches Warten", () => {
  const cmds = parseScript("1;13;26 3800;17;7;").commands;
  const r = insertWithWait(cmds, 2, makeCmd(4, [3800, 2000]));
  assert.deepEqual(r.cmds.map((c) => c.cmd), [1, 13, 4, 26, 17, 7]);
});
