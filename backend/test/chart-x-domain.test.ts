/**
 * Zeitachse des Bezugs-Diagramms.
 *
 * Anlass: bei Bezuegen ueber 30 s lief die Preinfusion links aus dem
 * Schiebefenster. Die stauchende Achse (wie bei Decent) fuellt mit dem ganzen
 * Bezug stets die ganze Flaeche.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chartXDomain, GROW_FLOOR_S, LIVE_LAG_S, liveDisplayT, trimToDisplayTime, fixedXTicks, type XDomainArgs,
} from "../../shared/src/chart-x-domain.js";

const base: XDomainArgs = {
  elapsed: 0, mode: "brewing", grow: true,
  windowS: 30, slideStepS: 10, resizeOnEnd: true, overlayEndT: null,
};

test("stauchend: die Kurve reicht immer genau bis zum rechten Rand", () => {
  for (let t = GROW_FLOOR_S; t <= 120; t += 0.37) {
    assert.deepEqual(chartXDomain({ ...base, elapsed: t }), { min: 0, max: t }, `t=${t.toFixed(2)}`);
  }
});

test("stauchend: nur ganz am Anfang greift der Boden", () => {
  assert.deepEqual(chartXDomain({ ...base, elapsed: 0 }), { min: 0, max: GROW_FLOOR_S });
  assert.deepEqual(chartXDomain({ ...base, elapsed: 0.4 }), { min: 0, max: GROW_FLOOR_S });
});

test("stauchend: der Anfang bleibt immer im Bild", () => {
  for (const t of [5, 30, 45, 90]) assert.equal(chartXDomain({ ...base, elapsed: t }).min, 0);
});

test("Schiebefenster unveraendert, wenn der Schalter aus ist", () => {
  const off = { ...base, grow: false };
  assert.deepEqual(chartXDomain({ ...off, elapsed: 12 }), { min: 0, max: 30 });
  assert.deepEqual(chartXDomain({ ...off, elapsed: 30 }), { min: 10, max: 40 });
  assert.deepEqual(chartXDomain({ ...off, elapsed: 39.9 }), { min: 10, max: 40 });
  assert.deepEqual(chartXDomain({ ...off, elapsed: 40 }), { min: 20, max: 50 });
  assert.deepEqual(chartXDomain({ ...off, mode: "idle", elapsed: 55 }), { min: 0, max: 30 });
});

test("nach dem Bezug: ganzer Bezug in beiden Modi, Soll-Ende eingeschlossen", () => {
  for (const grow of [true, false]) {
    assert.deepEqual(chartXDomain({ ...base, grow, mode: "ended", elapsed: 41.3 }), { min: 0, max: 44 });
    assert.deepEqual(
      chartXDomain({ ...base, grow, mode: "ended", elapsed: 41.3, overlayEndT: 60 }),
      { min: 0, max: 62 },
    );
  }
});

test("immer gefuellt: am Ende ganzer Bezug samt Soll-Ende, auch ohne Zoom-Schalter", () => {
  assert.deepEqual(
    chartXDomain({ ...base, grow: true, resizeOnEnd: false, mode: "ended", elapsed: 41.3, overlayEndT: 60 }),
    { min: 0, max: 62 },
  );
});

// --- Live-Kurve und feste Marken ---------------------------------------------

type Row = { t: number; pressure: number | null; weight: number | null };
const rows: Row[] = [
  { t: 0.37, pressure: 1, weight: 0 },
  { t: 0.74, pressure: 2, weight: null },
  { t: 1.11, pressure: 4, weight: 1 },
];
const KEYS = ["pressure", "weight"] as const;

test("Anzeige-Uhr laeuft eine halbe Sekunde hinterher, nie unter null", () => {
  assert.equal(LIVE_LAG_S, 0.5);
  assert.equal(liveDisplayT(10), 9.5);
  assert.equal(liveDisplayT(0.2), 0);
});

test("⚠ Kurvenende wird zwischen den zwei umschliessenden Punkten gezogen", () => {
  const r = trimToDisplayTime(rows, 0.925, KEYS);   // Mitte zwischen 0.74 und 1.11
  assert.equal(r.rows.length, 3);
  assert.equal(r.tipT, 0.925);
  assert.ok(Math.abs(r.rows[2]!.pressure! - 3) < 1e-9);
  assert.equal(r.rows[2]!.weight, null, "fehlt ein Wert auf einer Seite, wird nichts erfunden");
});

test("⚠ kommt der naechste Punkt zu spaet, bleibt die Kurve am letzten stehen — keine Vorausschaetzung", () => {
  const r = trimToDisplayTime(rows, 1.6, KEYS);
  assert.equal(r.rows, rows);
  assert.equal(r.tipT, 1.11);
});

test("vor dem ersten Punkt: noch nichts zu zeichnen", () => {
  assert.deepEqual(trimToDisplayTime(rows, 0.1, KEYS).rows, []);
  assert.deepEqual(trimToDisplayTime([], 3, KEYS), { rows: [], tipT: 0 });
});

test("⚠ stetig: das Kurvenende springt nicht, wenn ein neuer Punkt eintrifft", () => {
  // Uhr bei 0.9 s: Ende liegt zwischen 0.74 und 1.11. Jetzt kommt ein Punkt bei 1.48 dazu.
  const before = trimToDisplayTime(rows, 0.9, KEYS);
  const after = trimToDisplayTime([...rows, { t: 1.48, pressure: 5, weight: 2 }], 0.9, KEYS);
  assert.deepEqual(after.rows, before.rows);
  assert.equal(after.tipT, before.tipT);
});

test("feste Marken: 5 s bis 30 s, dann 10 s, lange Bezuege 30 s", () => {
  assert.deepEqual(fixedXTicks(12.4), [0, 5, 10]);
  assert.deepEqual(fixedXTicks(30), [0, 5, 10, 15, 20, 25, 30]);
  assert.deepEqual(fixedXTicks(44), [0, 10, 20, 30, 40]);
  assert.deepEqual(fixedXTicks(120), [0, 30, 60, 90, 120]);
});

test("feste Marken: dieselbe Breite ergibt dieselben Marken", () => {
  assert.deepEqual(fixedXTicks(21.1), fixedXTicks(24.9));
});
