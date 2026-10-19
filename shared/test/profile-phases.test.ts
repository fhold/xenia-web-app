/**
 * Vereinter Profil-Editor, Schnitt 2a: Phasen-Sicht, Laufart, Umwandeln,
 * Phasen bearbeiten, Speichern-Entscheidung.
 *
 * Geprueft am echten Bestand vom 2026-10-15 (18 Skripte inkl. an der Maschine
 * geloeschter, 16 Profile) — genau das wird spaeter im Editor bearbeitet.
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScript } from "../src/script-parser.js";
import { serializeScript } from "../src/script-serializer.js";
import { scriptToTimeline } from "../src/script-timeline.js";
import { validateScript } from "../src/script-validator.js";
import {
  projectScript, projectSteps, laufart, scriptToSteps, stepsToScript,
  setScriptPhaseValues, setScriptPhaseExit, setScriptPhaseKind, addScriptPhase,
  removeScriptPhase, moveScriptPhase, decideSave, planVariantSave, scriptPhaseInsertIndex, fitPhaseNames, phaseToStep,
} from "../src/profile-phases.js";
import type { VariantSave } from "../src/profile-phases.js";
import type { BrewProfile, BrewStep, ParsedCmd } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(readFileSync(resolve(__dirname, "fixtures", "real-scripts-profiles-2026-10-15.json"), "utf8")) as {
  scripts: { id: number; title: string; content: string }[];
  profiles: { id: number; name: string; scriptIdSingle: number | null; brewSteps: BrewProfile | null }[];
};

const cmds = (s: string) => parseScript(s).commands;
const text = (c: ParsedCmd[]) => serializeScript({ commands: c, unknownCmds: [] });
const script = (id: number) => real.scripts.find((s) => s.id === id)!.content;
/** Was die Kurve ausmacht: Art, Ziel, Rampe, Dauer je Stufe — fuer den Vergleich zweier Skripte. */
const curve = (c: ParsedCmd[]) => scriptToTimeline({ commands: c, unknownCmds: [] }).phases
  .filter((p) => !p.noWait)
  .map((p) => `${p.mode}:${p.targetValue}/${p.rampDurMs}@${p.tStart}-${p.tEnd}`);

// --- Phasen-Sicht -----------------------------------------------------------

test("jeder Befehl gehört genau einmal zu Phase, Marke oder Rahmen — alle 18 Skripte", () => {
  for (const s of real.scripts) {
    const c = cmds(s.content);
    const p = projectScript(c);
    const seen = [
      ...p.phases.flatMap((ph) => [ph.pumpIndex, ph.waitIndex].filter((x): x is number => x !== null)),
      ...p.markers.map((m) => m.index),
      ...p.frame,
    ].sort((a, b) => a - b);
    assert.deepEqual(seen, c.map((_, i) => i), `${s.id} ${s.title}`);
    // Die Bereiche der Phasen liegen lueckenlos hintereinander.
    p.phases.forEach((ph, i) => {
      if (i > 0) assert.equal(ph.range[0], p.phases[i - 1]!.range[1] + 1, `${s.title} Phase ${i + 1}`);
    });
  }
});

test("Londinium Single: drei Druckphasen mit Zeit-Ausstieg, keine Marken", () => {
  const p = projectScript(cmds(script(19)));
  assert.deepEqual(p.phases.map((ph) => [ph.kind, ph.target, ph.rampS, ph.exits]), [
    ["pressure", 1.1, 1, [{ kind: "time", value: 15 }]],
    ["pressure", 9, 2, [{ kind: "time", value: 5 }]],
    ["pressure", 4, 45, [{ kind: "time", value: 60 }]],
  ]);
  assert.deepEqual(p.markers, []);
});

test("80s Decent PI: „bis 3,8 bar, dann 3 s“ ist eine Fortsetzung mit demselben Ziel", () => {
  const p = projectScript(cmds(script(11)));
  const [a, b] = p.phases;
  assert.deepEqual([a!.kind, a!.target, a!.exits], ["pressure", 3.8, [{ kind: "pressureAbove", value: 3.8 }]]);
  assert.deepEqual([b!.pumpIndex, b!.target, b!.rampS, b!.exits], [null, 3.8, 0, [{ kind: "time", value: 3 }]]);
  // Heizleistung 0 % vorn sind Marken vor der ersten Phase.
  assert.deepEqual(p.markers.map((m) => [m.cmd, m.phase]), [[9, -1], [8, -1]]);
});

test("Cleaning: Ventile und Signaltöne bleiben Marken in ihrer Phase", () => {
  const p = projectScript(cmds(script(26)));
  assert.equal(p.phases.filter((ph) => ph.kind === "pause").length, 4);
  const pause = p.phases[1]!;
  const inPause = p.markers.filter((m) => m.phase === 1).map((m) => m.cmd);
  assert.deepEqual([pause.kind, inPause], ["pause", [15, 16]]);
  assert.deepEqual(p.markers.filter((m) => m.cmd === 20).length, 2);
});

test("unveränderte Werte zurückschreiben ist Byte-gleich — alle 18 Skripte", () => {
  for (const s of real.scripts) {
    let c = cmds(s.content);
    projectScript(c).phases.forEach((ph, i) => {
      c = setScriptPhaseValues(c, i, { target: ph.target ?? undefined, rampS: ph.rampS });
      c = setScriptPhaseExit(c, i, ph.exits[0] ?? null);
    });
    assert.equal(text(c), s.content, `${s.id} ${s.title}`);
  }
});

test("Wert ändern und zurücksetzen ist Byte-gleich — die Rundung trifft die Maschinenwerte", () => {
  let checked = 0;
  for (const s of real.scripts) {
    const c0 = cmds(s.content);
    projectScript(c0).phases.forEach((ph, i) => {
      if (ph.pumpIndex !== null && ph.target !== null) {
        let c = setScriptPhaseValues(c0, i, { target: ph.target + 0.5, rampS: ph.rampS + 1 });
        assert.notEqual(text(c), s.content);
        c = setScriptPhaseValues(c, i, { target: ph.target, rampS: ph.rampS });
        assert.equal(text(c), s.content, `${s.title} Phase ${i + 1} Ziel/Rampe`);
        checked++;
      }
      const e = ph.exits[0];
      if (e) {
        let c = setScriptPhaseExit(c0, i, { ...e, value: e.value + 1 });
        c = setScriptPhaseExit(c, i, e);
        assert.equal(text(c), s.content, `${s.title} Phase ${i + 1} Ausstieg`);
      }
    });
  }
  assert.equal(checked, 38); // alle Druck- und Leistungsphasen der 18 Skripte
});

// --- Laufart ----------------------------------------------------------------

test("Laufart: alle 16 Profile laufen so, wie sie heute laufen", () => {
  for (const p of real.profiles) {
    const got = p.brewSteps
      ? laufart(projectSteps(p.brewSteps.steps)).engine
      : (() => { const pr = projectScript(cmds(script(p.scriptIdSingle!))); return laufart(pr.phases, pr.markers).engine; })();
    assert.equal(got, p.brewSteps ? "app" : "script", `${p.id} ${p.name}`);
  }
});

test("Laufart nennt den Grund — und „Geht so nicht“, wenn beides nötig ist", () => {
  const pr = projectScript(cmds(script(10))); // 80s Decent: Heizleistung 0 %
  const flow = { ...pr.phases[0]!, kind: "flow" as const };
  const la = laufart([flow, ...pr.phases.slice(1)], pr.markers);
  assert.equal(la.engine, "conflict");
  assert.ok(la.app.includes("Flussregelung in Phase 1"));
  assert.ok(la.script.some((r) => r.includes("Heizleistung")));
});

// --- Umwandeln --------------------------------------------------------------

test("Skript → Stufen → Skript ergibt dieselbe Kurve, wo es keine Marken gibt", () => {
  let checked = 0;
  for (const s of real.scripts) {
    const steps = scriptToSteps(cmds(s.content));
    if (!steps.ok) continue;
    const back = stepsToScript(steps.value);
    assert.ok(back.ok, s.title);
    if (!back.ok) continue;
    assert.deepEqual(curve(back.value), curve(cmds(s.content)), `${s.id} ${s.title}`);
    assert.ok(validateScript({ commands: back.value, unknownCmds: [] }).ok, `${s.title} gültig`);
    checked++;
  }
  assert.ok(checked >= 10, `nur ${checked} Skripte umwandelbar`);
});

test("Skripte mit Befehlen ohne Phase lassen sich nicht in die App umwandeln", () => {
  for (const id of [10, 12, 15, 26]) { // 80s Decent, 80s, Spülen, Cleaning
    const r = scriptToSteps(cmds(script(id)));
    assert.equal(r.ok, false, String(id));
    if (!r.ok) assert.ok(r.reasons.length > 0);
  }
});

test("App-Profile mit Fluss oder Preinfusion lassen sich nicht als Skript schreiben", () => {
  for (const p of real.profiles.filter((x) => x.brewSteps)) {
    const r = stepsToScript(p.brewSteps!.steps);
    assert.equal(r.ok, false, p.name);
  }
});

test("Stufen → Skript: Gewicht wird Cmd 27 mit Tara-Warten, die letzte Phase bekommt die Notbremse", () => {
  const steps: BrewStep[] = [
    { kind: "pressure", targetPressureBar: 3.8, rampMs: 2000, exit: { weightG: 2 } },
    { kind: "pressure", targetPressureBar: 9, exit: { seconds: 8 } },
    { kind: "power", power: 70, rampMs: 30000, exit: { weightG: 36 } },
  ];
  const r = stepsToScript(steps);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(text(r.value), "1;12 1000;13;4 3800 2000;27 2;4 9000 0;12 8000;3 70 30000;12 60000;17;7;");
  assert.ok(validateScript({ commands: r.value, unknownCmds: [] }).ok);
});

// --- Phasen bearbeiten --------------------------------------------------------

test("Ziel und Rampe ändern nur den Pumpenbefehl der Phase", () => {
  const c = setScriptPhaseValues(cmds(script(19)), 1, { target: 8.5, rampS: 3 });
  assert.equal(text(c), "1;13;4 1100 1000;12 15000;4 8500 3000;12 5000;4 4000 45000;12 60000;17;7;");
});

test("Ziel davor ändern: die Fortsetzung hält wie im Skript das neue Ziel, nur ein Befehl ändert sich", () => {
  const c = setScriptPhaseValues(cmds(script(11)), 0, { target: 4.3 });
  assert.equal(text(c), "1;9 0;8 0;13;4 4300 2000;26 3800;12 3000;4 7800 3000;12 5000;4 5000 40000;12 45000;17;7;");
  assert.equal(projectScript(c).phases[1]!.target, 4.3);
});

test("Fortsetzung ändern: bekommt erst einen eigenen Pumpenbefehl, die Phase davor bleibt", () => {
  const c = setScriptPhaseValues(cmds(script(11)), 1, { target: 5 });
  assert.equal(text(c), "1;9 0;8 0;13;4 3800 2000;26 3800;4 5000 0;12 3000;4 7800 3000;12 5000;4 5000 40000;12 45000;17;7;");
});

test("Ausstieg wechseln: Zeit → Gewicht ersetzt genau das Warten", () => {
  const c = setScriptPhaseExit(cmds(script(19)), 0, { kind: "weight", value: 2 });
  assert.equal(text(c), "1;13;4 1100 1000;27 2;4 9000 2000;12 5000;4 4000 45000;12 60000;17;7;");
});

test("Art wechseln: Druck → Pause tauscht nur den Pumpenbefehl", () => {
  const c = setScriptPhaseKind(cmds(script(19)), 1, "pause");
  assert.equal(text(c), "1;13;4 1100 1000;12 15000;6;12 5000;4 4000 45000;12 60000;17;7;");
});

test("Phase hinzufügen: Pumpenbefehl mit eigenem Warten hinter der gewählten Phase", () => {
  const c = addScriptPhase(cmds(script(19)), 0);
  assert.equal(text(c), "1;13;4 1100 1000;12 15000;4 6000 0;12 5000;4 9000 2000;12 5000;4 4000 45000;12 60000;17;7;");
});

test("Phase entfernen: Pumpenbefehl und Warten weg, die Fortsetzung behält ihr Ziel", () => {
  const c = removeScriptPhase(cmds(script(11)), 0);
  assert.equal(text(c), "1;9 0;8 0;13;4 3800 0;12 3000;4 7800 3000;12 5000;4 5000 40000;12 45000;17;7;");
});

test("Phase verschieben: Marken wandern mit, Fortsetzungen behalten ihr Ziel", () => {
  // Cleaning: Druckstoss und Pause (mit Ablassventil auf/zu) tauschen
  const cl = moveScriptPhase(cmds(script(26)), 0, 1);
  assert.ok(text(cl).startsWith("1;13;6;15;12 20000;16;4 9000 1000;12 20000;4 9000 1000;12 15000;"));
  // 80s Decent PI: die Fortsetzung „3 s halten“ nach vorn — Ziel 3,8 bar bleibt bei ihr
  const pi = moveScriptPhase(cmds(script(11)), 1, -1);
  const p = projectScript(pi).phases;
  assert.deepEqual(p.slice(0, 2).map((x) => [x.target, x.exits[0]]), [
    [3.8, { kind: "time", value: 3 }],
    [3.8, { kind: "pressureAbove", value: 3.8 }],
  ]);
});

// --- Speichern ----------------------------------------------------------------

const script3 = laufart([]); // Skript, keine Gruende
const appOnly = { engine: "app" as const, app: ["Flussregelung in Phase 1"], script: [] };

test("Speichern: App-Profil bleibt App, wird nur bei geänderter Kurve zum Skript", () => {
  const base = { otherUsers: [], otherSlot: false };
  assert.deepEqual(decideSave({ ...base, before: { engine: "app", scriptId: null }, after: appOnly, curveChanged: true }), { kind: "profileOnly" });
  assert.deepEqual(decideSave({ ...base, before: { engine: "app", scriptId: null }, after: script3, curveChanged: false }), { kind: "profileOnly" });
  assert.deepEqual(decideSave({ ...base, before: { engine: "app", scriptId: null }, after: script3, curveChanged: true }), { kind: "newScript" });
});

test("Speichern: Skript bleibt Skript — unverändert, nur hier, geteilt, mit der anderen Variante", () => {
  const b = { engine: "script" as const, scriptId: 19 };
  assert.deepEqual(decideSave({ before: b, after: script3, curveChanged: false, otherUsers: [], otherSlot: false }), { kind: "profileOnly" });
  assert.deepEqual(decideSave({ before: b, after: script3, curveChanged: true, otherUsers: [], otherSlot: false }),
    { kind: "overwrite", scriptId: 19, otherUsers: [], otherSlot: false });
  assert.deepEqual(decideSave({ before: b, after: script3, curveChanged: true, otherUsers: ["Londinium (Kopie)"], otherSlot: false }),
    { kind: "overwrite", scriptId: 19, otherUsers: ["Londinium (Kopie)"], otherSlot: false });
  assert.deepEqual(decideSave({ before: b, after: script3, curveChanged: true, otherUsers: [], otherSlot: true }),
    { kind: "overwrite", scriptId: 19, otherUsers: [], otherSlot: true });
  assert.deepEqual(decideSave({ before: b, after: script3, curveChanged: true, otherUsers: [], otherSlot: true, split: true }), { kind: "newScript" });
});

test("Speichern: Skript wird App — Frage nach dem Skript nur, wenn es sonst niemand braucht", () => {
  const b = { engine: "script" as const, scriptId: 19 };
  assert.deepEqual(decideSave({ before: b, after: appOnly, curveChanged: true, otherUsers: [], otherSlot: false }),
    { kind: "toApp", scriptId: 19, stillUsed: false });
  assert.deepEqual(decideSave({ before: b, after: appOnly, curveChanged: true, otherUsers: ["X"], otherSlot: false }),
    { kind: "toApp", scriptId: 19, stillUsed: true });
});

test("Speichern: „Geht so nicht“ sperrt und nennt beide Seiten", () => {
  const r = decideSave({
    before: { engine: "script", scriptId: 10 },
    after: { engine: "conflict", app: ["Flussregelung in Phase 1"], script: ["Befehl „Heizleistung Brühkessel“"] },
    curveChanged: true, otherUsers: [], otherSlot: false,
  });
  assert.equal(r.kind, "blocked");
  if (r.kind === "blocked") assert.equal(r.reasons.length, 2);
});

// --- Speichern: das ganze Profil ---------------------------------------------

const stepsOf = (id: number): BrewStep[] => {
  const r = scriptToSteps(cmds(script(id)));
  assert.ok(r.ok);
  return r.ok ? r.value : [];
};
/** Skript-Variante, wie geladen bzw. bearbeitet. */
const onScript = (id: number, now: ParsedCmd[] = cmds(script(id))): VariantSave => ({
  start: { cmds: cmds(script(id)), steps: null },
  now: { cmds: now, steps: null, scriptId: id, baseContent: script(id) },
  otherUsers: [], otherSlot: false,
});
/** Skript-Variante, im Editor in App-Stufen umgewandelt. */
const converted = (id: number, steps: BrewStep[] = stepsOf(id)): VariantSave => ({
  start: { cmds: cmds(script(id)), steps: null },
  now: { cmds: null, steps, scriptId: id, baseContent: script(id) },
  otherUsers: [], otherSlot: false,
});
const onApp = (start: BrewStep[], now: BrewStep[] = start): VariantSave => ({
  start: { cmds: null, steps: start },
  now: { cmds: null, steps: now, scriptId: null, baseContent: null },
  otherUsers: [], otherSlot: false,
});
const pressureOnly: BrewStep[] = [
  { kind: "pressure", targetPressureBar: 3, rampMs: 1000, exit: { seconds: 10 } },
  { kind: "pressure", targetPressureBar: 9, exit: { seconds: 60 } },
];
const gagne = real.profiles.find((p) => p.id === 11)!.brewSteps!.steps;

const plan = (v: VariantSave) => {
  const r = planVariantSave(v);
  return [r.engine, r.case];
};

test("Speichern je Variante: braucht eine die App, läuft nur sie in der App — die andere bleibt Skript und wird nicht neu geschrieben", () => {
  // Londinium: Einzel Phase 1 auf Fluss, Doppel nur mit umgewandelt (Kurve wie vorher)
  const flow1: BrewStep[] = [{ kind: "flow", targetFlowGs: 1.4, rampMs: 1000, exit: { seconds: 15 } }, ...stepsOf(19).slice(1)];
  assert.deepEqual(plan(converted(19, flow1)), ["app", { kind: "toApp", scriptId: 19, stillUsed: false }]);
  assert.deepEqual(plan(converted(28)), ["script", { kind: "profileOnly" }]);
});

test("Speichern je Variante: in die App umgewandelt und zurück — gleiche Kurve schreibt nichts, geänderte überschreibt", () => {
  assert.deepEqual(plan(converted(19)), ["script", { kind: "profileOnly" }]);
  const st = stepsOf(19);
  const nineToEight = st.map((x, i) => (i === 1 && x.kind === "pressure" ? { ...x, targetPressureBar: 8 } : x));
  assert.deepEqual(plan(converted(19, nineToEight)), ["script", { kind: "overwrite", scriptId: 19, otherUsers: [], otherSlot: false }]);
});

test("Speichern je Variante: eine App-Kurve wird zum Skript, wenn sie geändert ist und ins Skript passt — unverändert bleibt sie App", () => {
  assert.deepEqual(plan(onApp(gagne, pressureOnly)), ["script", { kind: "newScript" }]);
  assert.deepEqual(plan(onApp(gagne)), ["app", { kind: "profileOnly" }]);
  assert.deepEqual(plan(onApp(pressureOnly)), ["app", { kind: "profileOnly" }]);
});

test("Speichern je Variante: vorhandenes Skript gewählt — die Variante zeigt darauf, geschrieben wird nichts", () => {
  const picked: VariantSave = { ...onApp(gagne), now: { cmds: cmds(script(30)), steps: null, scriptId: 30, baseContent: script(30) } };
  assert.deepEqual(plan(picked), ["script", { kind: "profileOnly" }]);
});

test("Speichern je Variante: abgespaltene eigene Kurve — vom Skript wird sie neues Skript, eine unveränderte App-Kopie bleibt App", () => {
  const ownCopy: VariantSave = { ...onScript(19), now: { cmds: cmds(script(19)), steps: null, scriptId: null, baseContent: null } };
  assert.deepEqual(plan(ownCopy), ["script", { kind: "newScript" }]);
  // Kopie einer umgewandelten, unveraenderten Kurve: kein Skript, auf das sie zeigen koennte → App
  const convertedCopy: VariantSave = { ...converted(30), now: { ...converted(30).now, scriptId: null, baseContent: null } };
  assert.deepEqual(plan(convertedCopy), ["app", { kind: "profileOnly" }]);
});

test("Speichern je Variante: „wie Variante X“ — Überschreiben gilt für alle, in die App fahren sie mit", () => {
  const edited = setScriptPhaseValues(cmds(script(30)), 0, { target: 2.5 });
  assert.deepEqual(plan({ ...onScript(30, edited), otherSlot: true }), ["script", { kind: "overwrite", scriptId: 30, otherUsers: [], otherSlot: true }]);
  const flow1: BrewStep[] = [{ kind: "flow", targetFlowGs: 1.4, exit: { seconds: 10 } }, ...stepsOf(30).slice(1)];
  assert.deepEqual(plan({ ...converted(30, flow1), otherSlot: true }), ["app", { kind: "toApp", scriptId: 30, stillUsed: false }]);
});

test("Phasennamen im Skript: Einfügen landet hinter Phase und Fortsetzung, Namen passen sich der Phasenzahl an", () => {
  // Skript 11 „bis 3,8 bar, dann 3 s“: Phase 2 ist die Fortsetzung von Phase 1
  const c = cmds(script(11));
  const before = projectScript(c).phases.length;
  const at = scriptPhaseInsertIndex(c, 0);
  const after = projectScript(addScriptPhase(c, 0)).phases;
  assert.equal(after.length, before + 1);
  assert.ok(at >= 1 && at <= before);
  assert.deepEqual(fitPhaseNames(["Füllen"], 3), ["Füllen", null, null]);
  assert.deepEqual(fitPhaseNames(["a", "b", "c"], 2), ["a", "b"]);
});

test("Umbenennen einer umgewandelten Kurve schreibt das Skript nicht neu — Namen stehen neben dem Skript", () => {
  const named = stepsOf(19).map((st, i) => (i === 0 ? { ...st, name: "Füllen" } : st));
  assert.deepEqual(plan(converted(19, named)), ["script", { kind: "profileOnly" }]);
});

test("Fluss übernehmen (Gagne) übersteht Phasen ↔ Stufen und die Prüfung; nur true/false", async () => {
  const { validateBrewSteps } = await import("../src/brew-steps.js");
  const steps: BrewStep[] = [
    { kind: "preinfusion", gentleness: "normal", exit: { pressureBar: 4, seconds: 25 } },
    { kind: "pressure", targetPressureBar: 9, rampMs: 3000, exit: { seconds: 7 } },
    { kind: "flow", targetFlowGs: 1.5, adoptFlow: true, maxPressureBar: 9.5, exit: { weightG: 27 } },
  ];
  const phases = projectSteps(steps);
  assert.equal(phases[2]!.adoptFlow, true);
  assert.equal(phases[1]!.adoptFlow, undefined, "nur die Flussstufe trägt das Feld");
  assert.deepEqual(phases.map(phaseToStep), steps);
  assert.deepEqual(validateBrewSteps(steps), { ok: true });
  // In der ersten Stufe gibt es noch keinen Fluss — erlaubt, der Treiber nimmt dann den erwarteten Wert.
  assert.deepEqual(validateBrewSteps([{ kind: "flow", targetFlowGs: 1, adoptFlow: true, exit: {} }]), { ok: true });
  const bad = validateBrewSteps([{ kind: "flow", targetFlowGs: 1, adoptFlow: "ja" as never, exit: {} }]);
  assert.equal(bad.ok, false);
});
