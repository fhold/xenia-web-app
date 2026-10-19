/**
 * Vereinter Editor, Schnitt 2d: App-Stufen als Kurve wie ein Skript, und Ziehen
 * an genau einer Stufe. Geprueft an den echten App-Profilen vom 2026-10-15.
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPhases, stepsToTimeline, setStepPoint, shiftStepEnd, stepHasPoint, stepHasEnd, RAMP_HINT_FRAC } from "../src/steps-curve.js";
import { powerToBar } from "../src/script-timeline.js";
import type { BrewProfile, BrewStep } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(readFileSync(resolve(__dirname, "fixtures", "real-scripts-profiles-2026-10-15.json"), "utf8")) as {
  profiles: { id: number; name: string; yieldTargetSingleG: number | null; brewSteps: BrewProfile | null }[];
};
const profile = (id: number) => real.profiles.find((p) => p.id === id)!;
const stepsOf = (id: number) => profile(id).brewSteps!.steps;

test("jede App-Stufe wird genau eine Phase, auf der Zeitachse der bisherigen Soll-Kurve", () => {
  for (const p of real.profiles.filter((x) => x.brewSteps)) {
    const steps = p.brewSteps!.steps;
    const tl = stepsToTimeline(steps, p.yieldTargetSingleG);
    const nominal = buildPhases(steps, p.yieldTargetSingleG);
    assert.equal(tl.phases.length, steps.length, p.name);
    tl.phases.forEach((ph, i) => {
      assert.equal(ph.cmdIndex, i);
      assert.equal(ph.tStart, Math.round(nominal[i]!.tStart * 1000), `${p.name} Phase ${i + 1} Start`);
      assert.equal(ph.tEnd, Math.round(nominal[i]!.tEnd * 1000), `${p.name} Phase ${i + 1} Ende`);
    });
    assert.equal(tl.totalMs, tl.phases[tl.phases.length - 1]!.tEnd);
  }
});

test("Adaptive Gagne: Leistung auf der bar-Achse, Fluss rechts, Einstieg nie ab Null", () => {
  const tl = stepsToTimeline(stepsOf(11), 27);
  const [p1, p2, p3] = tl.phases;
  assert.equal(p1!.axis, "bar");
  assert.equal(p1!.targetValue, powerToBar(45));
  assert.equal(p1!.startValue, 0); // Rampe von 0 % — die erste Leistungsstufe
  assert.equal(p2!.axis, "flow");
  assert.equal(p2!.startEstimated, true); // nach Leistung: Ist-Fluss, angedeutet
  assert.equal(p2!.startValue, RAMP_HINT_FRAC * 1.1);
  assert.ok(p2!.startValue > 0);
  assert.equal(p3!.startValue, p3!.targetValue); // ohne Rampe: Sprung
  assert.deepEqual(tl.waits.map((w) => w.label), ["bis 2 g", "bis F ≤ 0,85 g/s", "bis F ≤ 0,65 g/s", "bis 27 g"]);
});

test("Preinfusion: Flaeche ohne Sollwert, endet bei 90 % des folgenden Flusses", () => {
  const tl = stepsToTimeline(stepsOf(16), 24);
  assert.equal(tl.phases[0]!.noTarget, true);
  assert.equal(tl.waits[0]!.label, "bis F ≥ 1,26 g/s");
  assert.equal(tl.phases[1]!.startEstimated, true);
});

test("Pourover: Bloom (Leistung 0) ist eine Pause ohne Ziel-Griff; Rampe einer Druckstufe beginnt beim letzten Druck", () => {
  const steps = stepsOf(14);
  assert.equal(stepHasPoint(steps[0]!), true);
  assert.equal(stepHasPoint(steps[1]!), false);
  const pressure: BrewStep[] = [
    { kind: "pressure", targetPressureBar: 3, exit: { seconds: 10 } },
    { kind: "pressure", targetPressureBar: 9, rampMs: 2000, exit: { seconds: 5 } },
    { kind: "pressure", targetPressureBar: 6, rampMs: 4000, exit: {} },
  ];
  const tl = stepsToTimeline(pressure, 36);
  assert.deepEqual(tl.phases.map((p) => [p.startValue, p.targetValue]), [[3, 3], [3, 9], [9, 6]]);
});

test("Ziehen am Ziel: nur diese Stufe ändert sich, gerastert wie im Skript", () => {
  const steps = stepsOf(11);
  const out = setStepPoint(steps, 2, 1.234, 1730);
  out.forEach((s, i) => { if (i !== 2) assert.equal(s, steps[i], `Stufe ${i} unverändert`); });
  const s2 = out[2]!;
  assert.ok(s2.kind === "flow");
  if (s2.kind === "flow") {
    assert.equal(s2.targetFlowGs, 1.2);
    assert.equal(s2.rampMs, 1500);
  }
  // Rampe 0 entfernt das Feld statt 0 zu speichern
  const flat = setStepPoint(out, 2, 1.2, 100);
  assert.equal("rampMs" in flat[2]!, false);
  // Leistung: Achsenwert ist das bar-Aequivalent
  const p = setStepPoint(steps, 0, powerToBar(60), 3000)[0]!;
  assert.ok(p.kind === "power" && p.power === 60);
  // Pause und Preinfusion haben keinen Ziel-Griff
  assert.equal(setStepPoint(stepsOf(14), 1, 5, 0), stepsOf(14));
});

test("Ziehen am Ende: nur mit Zeit-Ausstieg, nie an der letzten Stufe, mindestens 0,5 s", () => {
  const steps = stepsOf(11);
  assert.equal(stepHasEnd(steps, 1), true);
  assert.equal(stepHasEnd(steps, steps.length - 1), false);
  // Ende per Druck (P ≥ 4 bar): die 15 s sind nur Sicherheitsgrenze, die Kurve zeigt 10 s — kein Griff
  assert.equal(stepHasEnd(steps, 0), false);
  assert.equal(stepHasEnd(stepsOf(16), 0), false);
  // Gewicht oder Zeit (Pourover-Preinfusion): die Zeit bestimmt die Kurve — Griff
  assert.equal(stepHasEnd(stepsOf(14), 0), true);
  const out = shiftStepEnd(steps, 1, 2300);
  assert.equal(out[1]!.exit.seconds, 10.5); // 8 s + 2,3 s → gerastert 10,5
  out.forEach((s, i) => { if (i !== 1) assert.equal(s, steps[i]); });
  assert.equal(shiftStepEnd(steps, 1, -60_000)[1]!.exit.seconds, 0.5);
  assert.equal(shiftStepEnd(steps, steps.length - 1, 5000), steps);
});

test("Druckrampe nach dem Füllen beginnt an dessen Druckgrenze, nicht bei 0 — wie der Treiber", () => {
  const tl = stepsToTimeline([
    { kind: "preinfusion", gentleness: "normal", exit: { pressureBar: 4, seconds: 25 } },
    { kind: "pressure", targetPressureBar: 9, rampMs: 3000, exit: { seconds: 7 } },
    { kind: "flow", targetFlowGs: 1.5, adoptFlow: true, maxPressureBar: 9.5, exit: {} },
  ], 27);
  assert.equal(tl.phases[1]!.startValue, 4);
  assert.equal(tl.phases[1]!.targetValue, 9);
  assert.equal(tl.phases[2]!.label, "Fluss halten ≈ 1,5 g/s");
});
