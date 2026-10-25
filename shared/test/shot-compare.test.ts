/**
 * Bezuege vergleichen (shared/src/shot-compare.ts).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { shotMetrics, alignAtFirstDrop, mergeCompare } from "../src/shot-compare.js";
import type { CompareSample, CurvePoint } from "../src/shot-compare.js";

const s = (t: number, weightG: number | null, pressureBar: number | null = 9, phase: CompareSample["phase"] = "extraction"): CompareSample =>
  ({ elapsedMs: t * 1000, weightG, pressureBar, phase });

test("Fluss ab erstem Tropfen: Gewichtszunahme bis Brühende, ohne Anlauf und ohne Nachlauf", () => {
  const m = shotMetrics([
    s(0, 0, 2, "preinfusion"), s(4, 0, 3, "preinfusion"), s(8, 0.2, 5),
    s(10, 0.5), s(12, 2.5), s(20, 16.5), s(30, 36.5),
    s(31, 37.5, 0, "post_brew"), s(40, 39.0, 0, "post_brew"),
  ]);
  assert.equal(m.firstDropS, 10);
  assert.equal(m.brewEndS, 31);
  // (37,5 − 0,5) g ÷ (31 − 10) s
  assert.equal(m.extractionFlowGs!.toFixed(3), (37 / 21).toFixed(3));
});

test("Ø Druck über alle Messpunkte, wie im Bezugs-Detail", () => {
  const m = shotMetrics([s(0, 0, 2), s(1, 0, 4), s(2, 0, null), s(3, 0, 9)]);
  assert.equal(m.avgPressureBar, 5);
});

test("Ohne Nachlauf endet das Brühen am letzten Messpunkt", () => {
  const m = shotMetrics([s(0, 0), s(5, 1), s(6, 3), s(15, 21)]);
  assert.deepEqual([m.firstDropS, m.brewEndS], [5, 15]);
  assert.equal(m.extractionFlowGs, 2);
});

test("Kein Tropfen, kein Gewicht oder zu kurz: kein Fluss", () => {
  assert.equal(shotMetrics([s(0, 0), s(10, 0.1), s(20, 0.2)]).extractionFlowGs, null, "nie ≥ 0,3 g");
  assert.equal(shotMetrics([s(0, null), s(10, null)]).firstDropS, null, "Waage fehlte");
  assert.equal(shotMetrics([s(0, 0), s(8, 0.5), s(9, 1), s(10, 4)]).extractionFlowGs, null, "2 s sind Rauschen");
  assert.deepEqual(shotMetrics([]), { firstDropS: null, brewEndS: null, extractionFlowGs: null, avgPressureBar: null });
});

test("Ausrichten: der frühere Tropfen wandert nach rechts, nie einer nach links", () => {
  assert.deepEqual(alignAtFirstDrop(7.6, 12), { a: 4.4, b: 0 });
  assert.deepEqual(alignAtFirstDrop(12, 7.5), { a: 0, b: 4.5 });
  assert.deepEqual(alignAtFirstDrop(9, 9), { a: 0, b: 0 });
  assert.equal(alignAtFirstDrop(null, 9), null);
  assert.equal(alignAtFirstDrop(9, null), null);
});

const cp = (t: number, pressure: number | null, flow: number | null = null, weight: number | null = null): CurvePoint => ({ t, pressure, flow, weight });

test("Gemeinsames Raster: jeder Zeitpunkt trägt A und B, dazwischen linear", () => {
  const m = mergeCompare([cp(0, 0), cp(1, 4), cp(2, 8)], [cp(0.5, 2), cp(1.5, 6)]);
  assert.deepEqual(m.map((r) => r.t), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(m.map((r) => r.pressure), [0, 2, 4, 6, 8], "A an B-Zeiten interpoliert, eigene Punkte unverändert");
  assert.deepEqual(m.map((r) => r.bPressure), [null, 2, 4, 6, null], "B außerhalb seiner Zeit null");
});

test("Längere Lücken bleiben Lücken, fehlende Werte werden nicht erfunden", () => {
  const m = mergeCompare([cp(0, 1, 1, 0), cp(5, 1, 1, 10)], [cp(1, 3), cp(2, 3)]);
  assert.deepEqual(m.map((r) => r.weight), [0, null, null, 10], "5 s ohne Messpunkt: nicht überbrücken");
  assert.deepEqual(m.map((r) => r.bFlow), [null, null, null, null], "B hatte keinen Fluss");
});

test("Verschobene Bezüge: A beginnt später, B läuft länger", () => {
  const m = mergeCompare([cp(3, 9), cp(4, 9)], [cp(0, 1), cp(1, 2), cp(2, 3), cp(3, 4), cp(4, 5), cp(5, 6)]);
  assert.equal(m.length, 6);
  assert.deepEqual(m.map((r) => r.pressure), [null, null, null, 9, 9, null]);
  assert.deepEqual(m.map((r) => r.bPressure), [1, 2, 3, 4, 5, 6]);
});
