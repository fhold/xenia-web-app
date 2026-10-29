/**
 * Texte aus shared/ auf Englisch (2026-10-22): dieselben Funktionen unter
 * withSharedLang("en"). Die deutschen Ausgaben pruefen die bisherigen Tests
 * unveraendert (Standard "de").
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedLang, withSharedLang } from "../src/shared-lang.js";
import { translateDecent } from "../src/decent-profile.js";
import { stepsToTimeline } from "../src/steps-curve.js";
import { describeCmdLine, scriptToTimeline } from "../src/script-timeline.js";
import { CMD_ARGS, CMD_HELP, SCRIPT_MODEL_HELP } from "../src/script-help.js";
import { parseScript } from "../src/script-parser.js";
import { laufart, projectSteps, decideSave } from "../src/profile-phases.js";
import { validateScript } from "../src/script-validator.js";
import { readProfileFile } from "../src/profile-file.js";
import type { BrewStep } from "../src/types.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "decent");
const file = (name: string) => readFileSync(resolve(dir, name), "utf8");
const en = <T>(fn: () => T): T => withSharedLang("en", fn);

test("withSharedLang: englisch nur innerhalb, danach wieder deutsch", () => {
  assert.equal(sharedLang(), "de");
  assert.equal(en(() => sharedLang()), "en");
  assert.equal(sharedLang(), "de");
});

test("Decent 80's Espresso auf Englisch: Zeilen, Notiz, Begruendung; Kurve wie auf Deutsch", () => {
  const r = en(() => translateDecent(file("80s_espresso.tcl")));
  assert.ok(r.ok);
  assert.deepEqual(r.rows.map((x) => [x.group, x.name, x.decent, x.xenia, x.status]), [
    ["step", "preinfusion start + preinfusion", "Flow 7.5 ml/s until 3.8 bar · at most 8 s", "Preinfusion · full pump ~5.6 ml/s, from 1 bar 2 ml/s · until 3.8 bar · at most 25 s", "changed"],
    ["step", "rise and hold", "Pressure 7.8 bar · 4 s", "Pressure 7.8 bar · Ramp 3 s · 4 s", "changed"],
    ["step", "decline", "Pressure smooth to 5 bar · 50 s", "Pressure smooth to 5 bar · until 36 g", "same"],
    ["profile", "Temperature", "82 → 80 → 72 °C", "80 °C (from “rise and hold”)", "changed"],
    ["profile", "Target", "36 g", "36 g", "same"],
  ]);
  assert.match(r.rows[1]!.why!, /^Ramp 3 s instead of a jump/);
  assert.match(r.profile.notes!, /^From Decent “80's Espresso” \(Decent\)\n\nFor medium to dark roasted beans\./);
  const de = translateDecent(file("80s_espresso.tcl"));
  assert.ok(de.ok);
  assert.deepEqual(r.profile.variants, de.profile.variants, "die Sprache aendert nur Texte, nicht die Kurve");
});

test("Decent auf Englisch: kein deutscher Rest in Zeilen und Hinweisen (alle Fixtures)", () => {
  const german = /[äöüß„]|\b(bis|höchstens|Fluss|Druck|Leistung|Deckel|Rampe|keins?e?|Pumpe|Schritt|Stufe)\b/;
  for (const name of readdirSync(dir)) {
    const r = en(() => translateDecent(file(name)));
    if (!r.ok) {
      assert.doesNotMatch(r.error, german, name);
      continue;
    }
    for (const row of r.rows) {
      for (const t of [row.decent, row.xenia ?? "", row.why ?? ""]) assert.doesNotMatch(t, german, `${name}: ${t}`);
    }
    for (const h of r.hints) for (const t of [h.text, h.why]) assert.doesNotMatch(t, german, `${name}: ${t}`);
  }
  assert.match(en(() => translateDecent("hallo welt") as { error: string }).error, /neither a Decent profile/);
});

test("Kurvenbeschriftungen der App-Stufen auf Englisch, Dezimalpunkt", () => {
  const steps: BrewStep[] = [
    { kind: "preinfusion", gentleness: "normal", exit: { pressureBar: 4, seconds: 25 } },
    { kind: "pressure", targetPressureBar: 9, rampMs: 3000, exit: { seconds: 7 } },
    { kind: "flow", targetFlowGs: 1.5, adoptFlow: true, maxPressureBar: 9.5, exit: { flowGs: 0.85 } },
    { kind: "power", power: 45, exit: { weightG: 2 } },
    { kind: "flow", targetFlowGs: 1.1, exit: {} },
  ];
  const tl = en(() => stepsToTimeline(steps, 27.5));
  assert.deepEqual(tl.phases.map((p) => p.label), ["Preinfusion", "Pressure 9 bar", "Hold flow ≈ 1.5 g/s", "Power 45 %", "Flow 1.1 g/s"]);
  assert.deepEqual(tl.waits.map((w) => w.label), ["until 4 bar", "until F ≤ 0.85 g/s", "until 2 g", "until 27.5 g"]);
  assert.equal(stepsToTimeline(steps, 27.5).phases[2]!.label, "Fluss halten ≈ 1,5 g/s");
});

test("Skriptansicht und Marken auf Englisch", () => {
  const cmd = (s: string) => parseScript(`1;${s};7;`).commands[1]!;
  en(() => {
    assert.deepEqual(describeCmdLine(cmd("4 3800 2000")), { label: "Pump pressure", detail: "3.8 bar in 2 s" });
    assert.deepEqual(describeCmdLine(cmd("3 60 1500")), { label: "Pump power", detail: "60 % in 1.5 s" });
    assert.deepEqual(describeCmdLine(cmd("20 3 500")), { label: "Beep", detail: "3 × 0.5 s" });
    const tl = scriptToTimeline(parseScript("1;13;3 60 2000;12 5000;6;27 36;7;"));
    assert.deepEqual(tl.phases.map((p) => p.label), ["Power → 60 % in 2 s", "Pump off"]);
    assert.deepEqual(tl.waits.map((w) => w.label), ["until 36 g"]);
    assert.deepEqual(tl.markers.map((m) => m.label), ["Start", "Open brew valve", "End"]);
  });
});

test("Skript-Hilfe: Titel, Text und Felder je Sprache; Gruppe und Quelle bleiben feste Schluessel", () => {
  const ids = Object.keys(CMD_HELP).map(Number);
  const deKeys = ids.map((id) => [CMD_HELP[id]!.group, CMD_HELP[id]!.source]);
  assert.equal(CMD_HELP[4]!.title, "Pumpendruck");
  assert.equal(CMD_ARGS[4]![1]!.label, "Übergang");
  en(() => {
    assert.equal(CMD_HELP[4]!.title, "Pump pressure");
    assert.equal(CMD_ARGS[4]![1]!.label, "Ramp");
    assert.equal(SCRIPT_MODEL_HELP[0], "Commands run from top to bottom.");
    assert.deepEqual(ids.map((id) => [CMD_HELP[id]!.group, CMD_HELP[id]!.source]), deKeys);
    // dieselben Grenzen wie die deutsche Hilfe (script-edit.test.ts)
    for (const id of ids) {
      const h = CMD_HELP[id]!;
      assert.ok(h.summary.length > 10 && h.summary.length <= 90, `Cmd ${id}: ${h.summary}`);
      assert.ok(h.details.length <= 1 && h.details.every((d) => d.length <= 60), `Cmd ${id}: ${h.details}`);
      assert.doesNotMatch(`${h.title} ${h.summary} ${h.details.join(" ")}`, /[äöüß„]/, `Cmd ${id}`);
    }
    assert.ok(SCRIPT_MODEL_HELP.length === 3 && SCRIPT_MODEL_HELP.every((l) => l.length <= 90));
  });
  assert.equal(SCRIPT_MODEL_HELP[0], "Befehle laufen von oben nach unten.");
});

test("Laufart-Gruende englisch, enden auf „in stage N“ (das Frontend kuerzt danach)", () => {
  const phases = projectSteps([
    { kind: "preinfusion", gentleness: "normal", exit: { pressureBar: 4 } },
    { kind: "flow", targetFlowGs: 1.5, exit: { flowAboveGs: 2 } },
  ]);
  const la = en(() => laufart(phases));
  assert.deepEqual(la.app, ["preinfusion via the inflow in stage 1", "flow control in stage 2", "flow ≥ as exit in stage 2"]);
  assert.ok(la.app.every((r) => / in stage \d+$/.test(r)));
  const save = en(() => decideSave({ before: { engine: "app", scriptId: null }, after: { engine: "conflict", app: la.app, script: ["x"] },
    curveChanged: true, otherUsers: [], otherSlot: false }));
  assert.deepEqual(save, { kind: "blocked", reasons: [...la.app.map((r) => `app only: ${r}`), "script only: x"] });
});

test("Meldungen beim Pruefen und Lesen auf Englisch", () => {
  const v = en(() => validateScript(parseScript("13;4 9000 0;12 5000;")));
  assert.deepEqual(v.errors.map((e) => e.message), [
    "The script must begin with Cmd 1 (Script start).",
    "The script must end with Cmd 7 (Script end).",
    "No stop mechanism: neither Cmd 17 (Drain & finish) nor a safety timer (Cmd 12 > 20s directly before Cmd 7).",
  ]);
  assert.deepEqual(v.warnings.map((w) => w.message), ["Cmd 4: duration 0 ms is ≤ 0 (implausible)."]);
  assert.deepEqual(en(() => readProfileFile(null)), { ok: false, error: "This is not a profile file of the Xenia app." });
});
