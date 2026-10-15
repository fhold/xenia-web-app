/**
 * Stufenleiste der History-Detailansicht (shared/src/stage-strip.ts).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flowStageStrip,
  scriptStageStrip,
  flowPreinfusionEndS,
  firstDropS,
} from "../src/stage-strip.js";
import type { BrewStep, ShotStage } from "../src/types.js";

const stage = (
  stageIndex: number,
  stepKind: ShotStage["stepKind"],
  target: number,
  enteredMs: number,
  exitReason: ShotStage["exitReason"],
): ShotStage => ({
  stageIndex,
  stepKind,
  targetFlowGs: stepKind === "flow" ? target : null,
  targetPressureBar: stepKind === "pressure" ? target : null,
  targetPower: stepKind === "power" ? target : null,
  exitReason,
  enteredMs,
});

// Profil „Decaf Flow (PI)“ wie in Bezug #254.
const DECAF_PI: BrewStep[] = [
  { kind: "power", power: 28, exit: { seconds: 15, weightG: 1 }, rampMs: 3000 },
  { kind: "flow", targetFlowGs: 1, exit: { weightG: 18 }, rampMs: 5000 },
  { kind: "flow", targetFlowGs: 0.7, exit: { weightG: 28 }, rampMs: 3000 },
];
const STAGES_254 = [
  stage(0, "power", 28, -2470, "seconds"),
  stage(1, "flow", 1, 12803, "weightG"),
  stage(2, "flow", 0.7, 37690, null),
];

test("Flow-Bezug: jede Stufe mit Ziel, Zeitspanne und dem Ausstieg, der sie beendet hat", () => {
  const s = flowStageStrip(STAGES_254, DECAF_PI, 51.5, { mode: "flowhold", weightG: 28 })!;
  assert.deepEqual(
    s.segments.map((g) => [g.startS, g.endS, g.what, g.exit]),
    [
      [0, 12.803, { kind: "power", value: 28 }, { kind: "seconds", value: 15 }],
      [12.803, 37.69, { kind: "flow", value: 1 }, { kind: "weight", value: 18 }],
      [37.69, 51.5, { kind: "flow", value: 0.7 }, { kind: "stop", mode: "flowhold", weightG: 28 }],
    ],
  );
  assert.deepEqual(s.segments.map((g) => g.rampS), [3, 5, 3]);
  assert.deepEqual(s.notReached, []);
});

test("Flow-Bezug: die Stufe 0 beginnt vor dem ersten Messpunkt und wird an 0 geklemmt", () => {
  const s = flowStageStrip(STAGES_254, DECAF_PI, 51.5, { mode: "flowhold", weightG: 28 })!;
  assert.equal(s.segments[0].startS, 0);
});

test("Flow-Bezug: Fluss-Ausstieg mit Schwelle, nicht erreichte Stufen in Profil-Reihenfolge", () => {
  // Adaptive Gagne wie #252: endete in der 0,8er-Stufe, die 0,7er kam nicht mehr dran.
  const steps: BrewStep[] = [
    { kind: "power", power: 45, exit: { seconds: 15, pressureBar: 4, weightG: 2 }, rampMs: 3000 },
    { kind: "flow", targetFlowGs: 1.1, exit: { seconds: 8 }, maxPressureBar: 9, rampMs: 4000 },
    { kind: "flow", targetFlowGs: 1, exit: { seconds: 25, flowGs: 0.85 }, maxPressureBar: 9, rampMs: 0 },
    { kind: "flow", targetFlowGs: 0.8, exit: { seconds: 25, flowGs: 0.65 }, maxPressureBar: 9, rampMs: 0 },
    { kind: "flow", targetFlowGs: 0.7, exit: { weightG: 27 }, maxPressureBar: 9, rampMs: 0, name: "  Auslauf " },
  ];
  const stages = [
    stage(0, "power", 45, -2774, "weightG"),
    stage(1, "flow", 1.1, 11071, "seconds"),
    stage(2, "flow", 1, 19327, "flowGs"),
    stage(3, "flow", 0.8, 22292, null),
  ];
  const s = flowStageStrip(stages, steps, 37.3, { mode: "flowhold", weightG: 27 })!;
  assert.deepEqual(s.segments.map((g) => g.exit), [
    { kind: "weight", value: 2 },
    { kind: "seconds", value: 8 },
    { kind: "flowBelow", value: 0.85 },
    { kind: "stop", mode: "flowhold", weightG: 27 },
  ]);
  assert.deepEqual(s.notReached, [{ kind: "flow", value: 0.7 }]);
});

test("Flow-Bezug: Stufenname aus dem Profil wird getrimmt, leerer Name zählt als keiner", () => {
  const steps: BrewStep[] = [
    { kind: "power", power: 100, name: " Füllen ", exit: { seconds: 18 } },
    { kind: "flow", targetFlowGs: 1.4, name: "  ", exit: {} },
  ];
  const s = flowStageStrip(
    [stage(0, "power", 100, 0, "seconds"), stage(1, "flow", 1.4, 18000, null)],
    steps, 40, { mode: "manual", weightG: null },
  )!;
  assert.deepEqual(s.segments.map((g) => g.name), ["Füllen", null]);
});

test("Flow-Bezug ohne Stufen: keine Leiste", () => {
  assert.equal(flowStageStrip([], DECAF_PI, 30, { mode: "flowhold", weightG: 28 }), null);
});

test("Skript-Bezug: Abschnitte nach der Uhr, Pumpenpause als eigener Abschnitt, Stopp im laufenden", () => {
  // „6bar Bloom KN“: 2 bar PI 15 s, 12 s Pumpe aus, dann 6 bar — App-Stopp bei 40 s.
  const s = scriptStageStrip("1;13;4 2000 2000;12 15000;6;12 12000;4 6000 2000;12 60000;7;", 40, { mode: "app", weightG: 24 })!;
  assert.deepEqual(
    s.segments.map((g) => [g.startS, g.endS, g.what, g.rampS, g.exit, g.uncertain]),
    [
      [0, 15, { kind: "pressure", value: 2 }, 2, { kind: "seconds", value: 15 }, false],
      [15, 27, { kind: "pressure", value: 0 }, 0, { kind: "seconds", value: 12 }, false],
      [27, 40, { kind: "pressure", value: 6 }, 2, { kind: "stop", mode: "app", weightG: 24 }, false],
    ],
  );
  assert.deepEqual(s.notReached, []);
});

test("Skript-Bezug: was nach dem Stopp noch im Skript stand, kam nicht mehr dran", () => {
  // „Londinium sanfte Rampe“, früh von Hand gestoppt.
  const s = scriptStageStrip("1;13;4 1100 1000;12 15000;4 9000 2000;12 5000;4 4000 45000;12 60000;17;7;", 18, { mode: "manual", weightG: null })!;
  assert.deepEqual(s.segments.map((g) => [g.startS, g.endS, g.exit]), [
    [0, 15, { kind: "seconds", value: 15 }],
    [15, 18, { kind: "stop", mode: "manual", weightG: null }],
  ]);
  assert.deepEqual(s.notReached, [{ kind: "pressure", value: 4 }]);
});

test("Skript-Bezug: unbestimmtes Warten beendet den Abschnitt, danach ist die Lage nur nominal", () => {
  const s = scriptStageStrip("1;13;4 9000 2000;27 20;4 6000 2000;12 10000;7;", 60, { mode: "script_end", weightG: null })!;
  assert.deepEqual(s.segments[0].exit, { kind: "waitWeight", value: 20 });
  assert.equal(s.segments[0].uncertain, false);
  assert.equal(s.segments[1].uncertain, true);
});

test("Skript ohne Pumpenbefehl: keine Leiste", () => {
  assert.equal(scriptStageStrip("1;13;12 5000;7;", 10, { mode: "script_end", weightG: null }), null);
});

test("Preinfusion eines Flow-Bezugs = erste Stufe; ein Bloom danach zählt nicht mit, ein Fluss-Start hat keine", () => {
  assert.equal(flowPreinfusionEndS(STAGES_254), 12.803);
  // Filter #251: Preinfusion bis 0,5 g, dann 120 s Bloom, dann Fluss.
  const filter = [
    stage(0, "power", 18, -1000, "weightG"),
    stage(1, "power", 0, 21000, "seconds"),
    stage(2, "flow", 2.5, 140900, null),
  ];
  assert.equal(flowPreinfusionEndS(filter), 21);
  assert.equal(flowPreinfusionEndS([stage(0, "flow", 1.4, -2000, "seconds"), stage(1, "flow", 1, 9000, null)]), null);
  assert.equal(flowPreinfusionEndS([stage(0, "power", 45, 0, "seconds")]), null);
});

test("Erster Tropfen: ein einzelner Ausreißer der Waage zählt nicht", () => {
  const s = [
    { t: 16.3, weight: 0.4 }, { t: 16.6, weight: 0 },
    { t: 19.7, weight: 0.1 }, { t: 20.4, weight: 0.5 }, { t: 21.1, weight: 1.2 },
  ];
  assert.equal(firstDropS(s), 20.4);
  assert.equal(firstDropS([{ t: 1, weight: 0 }, { t: 2, weight: null }]), null);
});
