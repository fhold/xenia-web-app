/**
 * Nachlauf: ein Griff an die Tasse wird nicht zum Endgewicht.
 *
 * Anlass Bezug 235 (2026-09-24): im Nachlauf sprang das Gewicht in einem
 * einzigen Messschritt von 25,1 auf 36,4 g. Der Plausibilitaetsfilter liess das
 * durch (er erlaubt +15 g je Schritt, gedacht fuer den laufenden Bezug), die
 * Stabilitaetserkennung nahm 36,4 g als Endgewicht, und die Lag-Kalibrierung
 * wertete 11,4 g "Ueberschuss" als Stopp-Fehler. Neun Bezuege hatten solche
 * Spruenge.
 *
 * Runner: node:test. Kein Geraet: Repo/Settings/Client/Logger sind Attrappen,
 * die Uhr ist gestellt.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ShotRecorder } from "../src/shots/recorder.js";
import type { ArmArgs } from "../src/shots/recorder.js";
import type { LiveFrame } from "../../shared/src/types.js";
import { postBrewDisturbance, POST_BREW_RISE_TOL_G } from "../../shared/src/scale-plausibility.js";

// --- Regel ------------------------------------------------------------------

test("Regel: Tropfen und echter Restfluss sind keine Stoerung", () => {
  for (const step of [0, 0.1, 0.6, 1.2, 2.0]) {
    assert.equal(postBrewDisturbance(25 + step, 25), null, `+${step} g`);
  }
});

test("Regel: Griff an die Tasse und Wegnehmen sind Stoerungen", () => {
  assert.equal(postBrewDisturbance(36.4, 25.1)?.toFixed(1), "11.3");
  assert.equal(postBrewDisturbance(27.5, 25.0)?.toFixed(1), "2.5");
  assert.equal(postBrewDisturbance(0.2, 25.0)?.toFixed(1), "-24.8");
});

test("Regel: ohne Vergleichswert keine Aussage", () => {
  assert.equal(postBrewDisturbance(null, 25), null);
  assert.equal(postBrewDisturbance(30, null), null);
  assert.equal(POST_BREW_RISE_TOL_G, 2.0);
});

// --- Recorder mit gestellter Uhr ---------------------------------------------

let clock = 0;
const realNow = Date.now;
beforeEach(() => { clock = 1_000_000; Date.now = () => clock; });
afterEach(() => { Date.now = realNow; });

interface Finalize { stopMode: string; yieldG: number | null }

function makeRig(opts: { bbw?: boolean } = {}) {
  const finalizes: Finalize[] = [];
  const settingWrites: [string, string][] = [];
  const events: string[] = [];
  let nextId = 500;
  const rows = new Map<number, Record<string, unknown>>();
  const repo = {
    finalizeAllOpen: () => 0,
    createShot: () => { const id = nextId++; rows.set(id, { id, ended_at: null }); return id; },
    appendSample: () => {},
    finalizeShot: (id: number, endedAt: number, stopMode: string, yieldG: number | null) => {
      finalizes.push({ stopMode, yieldG });
      const r = rows.get(id); if (r) { r.ended_at = endedAt; r.stop_mode = stopMode; }
    },
    findById: (id: number) => rows.get(id) ?? null,
    logAutoCalibration: () => {},
    appendStageTransitions: () => {},
    rememberBrewDef: () => "hash",
  };
  const values: Record<string, string> = opts.bbw
    ? { brew_by_weight_active: "true", brew_by_weight_auto_calibrate: "true", brew_by_weight_residual_lag_s: "0.6" }
    : {};
  const settings = {
    get: (k: string) => values[k] ?? null,
    set: (k: string, v: string) => { settingWrites.push([k, v]); values[k] = v; },
  };
  const log = {
    child: () => log,
    info: (o: { event?: string }) => { if (o?.event) events.push(o.event); },
    warn: (o: { event?: string }) => { if (o?.event) events.push(o.event); },
    error: (o: { event?: string }) => { if (o?.event) events.push(o.event); },
  };
  const client = { scriptStop: async () => 200 };
  const recorder = new ShotRecorder(repo as never, settings as never, client as never, log as never);
  return { recorder, finalizes, settingWrites, events };
}

const ARM: ArmArgs = {
  profileId: 1, profileName: "Test", scriptId: 30, shotSize: "single",
  category: "brew", hasPumpAction: true,
  hasCmd27: false, cmd27Value: null, yieldTargetG: 24,
  beanId: null, grinderId: null, grindSetting: null, grinderRpm: null, doseG: null, notes: null,
};

function frame(status: number, weight: number | null, flow = 1.3): LiveFrame {
  return {
    machineStatus: status as never, machineState: status === 3 ? "brewing" : "ready",
    extractionCount: 0, operatingHours: 0, clockSeconds: 0, currentPowerAmps: 0, maxPowerAmps: 0,
    energyTotalKwh: 0, lastExtractionMl: null, brewGroupTempC: 88, brewGroupPwm: 0,
    brewBoilerTempC: 90, brewBoilerPwm: 0, pumpPressureBar: status === 3 ? 6 : 0.1, pumpPwm: 40,
    pumpTargetPwm: 0, flowRateGPerS: status === 3 ? flow : 0, flowMeterVolumeMl: 0,
    steamBoilerPressureBar: 1, steamBoilerStatus: 1 as never, scaleWeightG: weight,
    cpuLoadPercent: 0, timestamp: clock,
  };
}

const tick = (ms = 370) => { clock += ms; };
const flush = () => new Promise((r) => setImmediate(r));

/**
 * Bezug laufen lassen: nach der Start-Grace linear bis `until` g — oder bis die
 * Zielabschaltung ausloest; dann endet das Bruehen wie an der echten Maschine
 * (sonst griffe der Watchdog, und der Nachlauf startete mit einem Abfall).
 * Liefert das Gewicht beim Ende.
 */
async function brewUntil(rig: ReturnType<typeof makeRig>, until: number): Promise<number> {
  rig.recorder.armForExecute(ARM);
  rig.recorder.onFrame(frame(3, 0));
  // 11 s Grace mit wenig Gewicht, dann ~1,3 g/s
  let g = 0;
  for (let t = 0; t < 11_000; t += 370) { tick(); rig.recorder.onFrame(frame(3, g)); }
  while (g < until) {
    tick(); g = Math.min(until, g + 0.48);
    rig.recorder.onFrame(frame(3, g));
    await flush();
    if (rig.events.includes("stop_triggered")) break;
  }
  return g;
}

test("⚠ Kurve von Bezug 235: Endgewicht ist das Gewicht vor dem Griff", async () => {
  const rig = makeRig();
  await brewUntil(rig, 24.8);
  for (const w of [24.9, 25.0, 25.1]) { tick(); rig.recorder.onFrame(frame(4, w)); }
  assert.equal(rig.finalizes.length, 0, "vor dem Sprung noch nicht abgeschlossen");
  tick(); rig.recorder.onFrame(frame(4, 36.4));
  assert.equal(rig.finalizes.length, 1, "der Sprung schliesst sofort ab");
  assert.equal(rig.finalizes[0]!.yieldG, 25.1);
  assert.ok(rig.events.includes("disturbed"));
});

test("Ohne Stoerung unveraendert: Abschluss nach stabiler Sekunde mit dem letzten Gewicht", async () => {
  const rig = makeRig();
  await brewUntil(rig, 24.8);
  for (const w of [24.9, 25.0, 25.1, 25.1, 25.1, 25.1, 25.1]) {
    tick(); rig.recorder.onFrame(frame(4, w));
    if (rig.finalizes.length) break;
  }
  assert.equal(rig.finalizes.length, 1);
  assert.equal(rig.finalizes[0]!.yieldG, 25.1);
  assert.ok(!rig.events.includes("disturbed"));
});

test("Echter Restfluss direkt nach dem Stopp (1,2 g je Schritt) wird nicht abgeschnitten", async () => {
  const rig = makeRig();
  await brewUntil(rig, 24.0);
  for (const w of [25.2, 26.1, 26.5, 26.6, 26.6, 26.6, 26.6, 26.6]) {
    tick(); rig.recorder.onFrame(frame(4, w));
    if (rig.finalizes.length) break;
  }
  assert.equal(rig.finalizes[0]!.yieldG, 26.6);
  assert.ok(!rig.events.includes("disturbed"));
});

test("⚠ Zielabschaltung: ein gestoerter Nachlauf fuettert die Lag-Kalibrierung nicht", async () => {
  const rig = makeRig({ bbw: true });
  const atStop = await brewUntil(rig, 30);        // BBW stoppt vorher (Ziel 24 g)
  assert.ok(rig.events.includes("stop_triggered"), "Zielabschaltung hat ausgeloest");
  for (const w of [atStop + 0.2, atStop + 0.3]) { tick(); rig.recorder.onFrame(frame(4, w)); }
  tick(); rig.recorder.onFrame(frame(4, atStop + 11.6));  // Griff
  await flush();
  assert.equal(rig.finalizes.length, 1);
  assert.ok(rig.events.includes("disturbed"));
  assert.ok(!rig.settingWrites.some(([k]) => k === "brew_by_weight_residual_lag_s"),
    `Lag wurde trotzdem geschrieben: ${JSON.stringify(rig.settingWrites)}`);
});

test("⚠ Filterprofil (Bezug 146): Restfluss im ersten Nachlauf-Schritt bleibt, das Bypass-Wasser nicht", async () => {
  const rig = makeRig();
  rig.recorder.armForExecute(ARM);
  rig.recorder.onFrame(frame(3, 0));
  let g = 0;
  for (let t = 0; t < 11_000; t += 370) { tick(); rig.recorder.onFrame(frame(3, g, 3.6)); }
  while (g < 177.3) { tick(); g = Math.min(177.3, g + 1.3); rig.recorder.onFrame(frame(3, g, 3.6)); }
  // Uebergang +2,2 g (echter Restfluss), dann kleine Schritte wie gemessen
  for (const w of [179.5, 180.7, 181.5, 182.2, 182.9]) { tick(); rig.recorder.onFrame(frame(4, w)); }
  assert.equal(rig.finalizes.length, 0, "Restfluss darf den Nachlauf nicht beenden");
  tick(); rig.recorder.onFrame(frame(4, 194.7));   // Bypass-Wasser
  assert.equal(rig.finalizes.length, 1);
  assert.equal(rig.finalizes[0]!.yieldG, 182.9);
});

test("Die Ausnahme gilt nur fuer den ersten Schritt: ein Sprung im zweiten wird erkannt", async () => {
  const rig = makeRig();
  await brewUntil(rig, 24.8);
  tick(); rig.recorder.onFrame(frame(4, 25.0));
  tick(); rig.recorder.onFrame(frame(4, 27.5));    // +2,5 g im zweiten Schritt
  assert.equal(rig.finalizes.length, 1);
  assert.equal(rig.finalizes[0]!.yieldG, 25.0);
});

test("Gegenprobe: ohne Stoerung kalibriert die Zielabschaltung wie bisher", async () => {
  const rig = makeRig({ bbw: true });
  const atStop = await brewUntil(rig, 30);
  assert.ok(rig.events.includes("stop_triggered"));
  for (const d of [0.3, 0.6, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7]) {
    const w = atStop + d;
    tick(); rig.recorder.onFrame(frame(4, w));
    await flush();
    if (rig.finalizes.length) break;
  }
  assert.equal(rig.finalizes.length, 1);
  assert.ok(rig.settingWrites.some(([k]) => k === "brew_by_weight_residual_lag_s"),
    "ohne Stoerung muss die Kalibrierung laufen — sonst beweist der Test oben nichts. Ereignisse: " + rig.events.join(","));
});
