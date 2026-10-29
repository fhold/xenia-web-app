/**
 * Stufen eines App-Bezugs: Zeitachse und Sollkurve, live und aus den gespeicherten
 * Stufen (shared/src/live-stage.ts).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { liveSollCurve, liveStageEntries, recordedStageEntries, setpointAt } from "../src/live-stage.js";
import type { BrewStep, DriveStage, ShotStage } from "../src/types.js";

const T0 = 1_000_000;
const stage = (index: number, kind: DriveStage["kind"], atS: number, setpoint: DriveStage["setpoint"]): DriveStage =>
  ({ index, kind, name: null, tone: false, enteredAt: T0 + atS * 1000, setpoint });

test("Zeitachse: Eintritt relativ zum Bezugsbeginn, Stufe 0 davor zählt als 0", () => {
  const e = liveStageEntries([stage(0, "preinfusion", -1.7, null), stage(1, "pressure", 4, { from: 3.2, to: 7.8, rampMs: 3000, adopted: false })], T0);
  assert.deepEqual(e.map((x) => x.t), [0, 4]);
});

test("Sollkurve: Druck- und Flussstufen bis jetzt, Preinfusion ohne Linie", () => {
  const e = liveStageEntries([
    stage(0, "preinfusion", -1.7, null),
    stage(1, "pressure", 4, { from: 3.2, to: 7.8, rampMs: 3000, adopted: false }),
    stage(2, "flow", 8, { from: 1.5, to: 1.5, rampMs: 0, adopted: true }),
  ], T0);
  const s = liveSollCurve(e, 12);
  // Druck: ab 3,2 bar (Treiber-Messwert beim Eintritt) in 3 s auf 7,8, gehalten bis 8 s
  assert.deepEqual(s.bar, [{ t: 4, v: 3.2 }, { t: 7, v: 7.8 }, { t: 8, v: 7.8 }]);
  assert.deepEqual(s.flow, [{ t: 8, v: 1.5 }, { t: 12, v: 1.5 }]);
});

test("Laufende Rampe endet beim aktuellen Sollwert", () => {
  const sp = { from: 7.8, to: 5, rampMs: 50_000, adopted: false };
  const s = liveSollCurve(liveStageEntries([stage(0, "pressure", 12, sp)], T0), 37);
  assert.equal(s.bar.length, 2);
  assert.ok(Math.abs(s.bar[1]!.v - 6.4) < 1e-9);
  assert.equal(setpointAt(sp, 12, 100), 5);
});

const rec = (stageIndex: number, stepKind: ShotStage["stepKind"], enteredMs: number, target: number | null): ShotStage => ({
  stageIndex, stepKind, enteredMs, exitReason: null,
  targetFlowGs: stepKind === "flow" ? target : null,
  targetPressureBar: stepKind === "pressure" ? target : null,
  targetPower: null,
});
const smp = (t: number, pressure: number | null, flow: number | null = null) => ({ t, pressure, flow });

test("Gespeicherte Stufen: dieselben Einträge und dieselbe Kurve wie live (80's Espresso wie #300)", () => {
  const steps: BrewStep[] = [
    { kind: "preinfusion", name: "preinfusion", gentleness: "normal", exit: { pressureBar: 3.8, seconds: 25 } },
    { kind: "pressure", name: "rise and hold", targetPressureBar: 7.8, rampMs: 3000, exit: { seconds: 4 } },
    { kind: "pressure", name: "decline", targetPressureBar: 5, rampMs: 50_000, exit: {} },
  ] as BrewStep[];
  // Preinfusion als Leistungsstufe gespeichert; Rampenstart = letzter Messpunkt bis zum Eintritt
  const recorded = recordedStageEntries(
    [rec(0, "power", -1872, null), rec(1, "pressure", 8785, 7.8), rec(2, "pressure", 12_908, 5)],
    steps,
    [smp(8.4, 3.2), smp(8.78, 3.8), smp(9.1, 4.2), smp(12.6, 7.8), smp(12.9, 7.6), smp(13.2, 7.4)],
  );
  const live = liveStageEntries([
    stage(0, "preinfusion", -1.872, null),
    stage(1, "pressure", 8.785, { from: 3.8, to: 7.8, rampMs: 3000, adopted: false }),
    stage(2, "pressure", 12.908, { from: 7.6, to: 5, rampMs: 50_000, adopted: false }),
  ], T0);
  assert.deepEqual(recorded.map((e) => [e.kind, e.setpoint]), live.map((e) => [e.kind, e.setpoint]));
  for (const [a, b] of recorded.map((e, i) => [e.t, live[i]!.t])) assert.ok(Math.abs(a! - b!) < 1e-9);
  assert.deepEqual(liveSollCurve(recorded, 19.2).bar.map((p) => p.v), liveSollCurve(live, 19.2).bar.map((p) => p.v));
});

test("Gespeicherte Stufen: übernommener Fluss ohne Rampe, Druckrampe vor dem ersten Messpunkt, fehlender Schnappschuss", () => {
  const gagne: BrewStep[] = [
    { kind: "preinfusion", name: "Füllen", gentleness: "normal", exit: { pressureBar: 4, seconds: 25 } },
    { kind: "pressure", name: "Druckspitze", targetPressureBar: 9, rampMs: 3000, exit: { seconds: 7 } },
    { kind: "flow", name: "Fluss halten", targetFlowGs: 1.5, adoptFlow: true, maxPressureBar: 9.5, exit: {} },
  ] as BrewStep[];
  const e = recordedStageEntries([rec(1, "pressure", 14_243, 9), rec(2, "flow", 21_344, 1.22)], gagne, [smp(14.2, 4.7, 0.1), smp(21.3, 9, 1.3)]);
  assert.deepEqual(e.map((x) => x.setpoint), [{ from: 4.7, to: 9, rampMs: 3000, adopted: false }, { from: 1.22, to: 1.22, rampMs: 0, adopted: true }]);

  // Stufe 0 beginnt vor dem Bezug: Rampe ab dem ersten Messpunkt, auf der Achse ab 0
  const londinium: BrewStep[] = [{ kind: "pressure", name: "Preinfusion 1,1 bar", targetPressureBar: 1.1, rampMs: 1000, exit: { seconds: 15 } }] as BrewStep[];
  const p0 = recordedStageEntries([rec(0, "pressure", -1216, 1.1)], londinium, [smp(0.3, null), smp(0.6, 0.2)]);
  assert.deepEqual(p0, [{ kind: "pressure", t: 0, setpoint: { from: 0.2, to: 1.1, rampMs: 1000, adopted: false } }]);

  // Ohne Schnappschuss: Ziel sofort, Leistungsstufe ohne Linie
  const bare = recordedStageEntries([rec(0, "power", 0, null), rec(1, "flow", 5000, 1.4)], [], [smp(4.9, 2, 0.8)]);
  assert.deepEqual(bare.map((x) => [x.kind, x.setpoint]), [["power", null], ["flow", { from: 1.4, to: 1.4, rampMs: 0, adopted: false }]]);
});
