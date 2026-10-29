/**
 * Issue #1: a script shot whose machine drops off the network.
 *
 * Bug: the recorder followed a shot only through frames. With the machine offline no frame
 * arrived, the shot stayed open and the app sat in brew mode until the machine came back;
 * Stop could not reach the machine either.
 *
 * Fix: after 30 s without the machine (poller 'disconnected') a script shot ends its
 * recording — ended_at = last frame, yield unknown (null, scale_lost) — and a Stop that
 * cannot get through ends it at once. App-driven shots (driveMode) are left to the driver.
 *
 * Runner: node:test. Repo / settings / client / logger mocked, Date.now and timers stubbed.
 */

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ShotRecorder } from "../src/shots/recorder.js";
import type { ArmArgs } from "../src/shots/recorder.js";
import type { LiveFrame } from "../../shared/src/types.js";

let clock = 0;
const realNow = Date.now;
beforeEach(() => {
  clock = 0;
  Date.now = () => clock;
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
  mock.timers.reset();
  Date.now = realNow;
});

interface FinalizeCall { id: number; endedAt: number; stopMode: string; yieldG: number | null; scaleLost: boolean }

function makeRecorder() {
  const finalizeCalls: FinalizeCall[] = [];
  let nextId = 300;
  const rows = new Map<number, Record<string, unknown>>();
  const repo = {
    finalizeAllOpen: () => 0,
    createShot: () => { const id = nextId++; rows.set(id, { id, ended_at: null }); return id; },
    appendSample: () => {},
    finalizeShot: (id: number, endedAt: number, stopMode: string, yieldG: number | null, extra: { scaleLost?: boolean } | undefined) => {
      finalizeCalls.push({ id, endedAt, stopMode, yieldG, scaleLost: extra?.scaleLost ?? false });
      const row = rows.get(id);
      if (row) row.ended_at = endedAt;
    },
    findById: (id: number) => rows.get(id) ?? null,
    logAutoCalibration: () => {},
    appendStageTransitions: () => {},
  };
  const settings = { get: () => null, set: () => {} };
  const log = { child: () => log, info: () => {}, warn: () => {}, error: () => {} };
  const recorder = new ShotRecorder(repo as never, settings as never, {} as never, log as never);
  const ended: number[] = [];
  recorder.on("shotEnded", (shot) => ended.push((shot as { id: number }).id));
  return { recorder, finalizeCalls, ended };
}

const ARM: ArmArgs = {
  profileId: 1, profileName: "Test", scriptId: 7, shotSize: "single", category: "brew",
  hasPumpAction: true, hasCmd27: false, cmd27Value: null, yieldTargetG: null,
  beanId: null, grinderId: null, grindSetting: null, grinderRpm: null, doseG: null, notes: null,
};

function frame(over: Partial<LiveFrame> = {}): LiveFrame {
  return {
    machineStatus: 3, machineState: "brewing", extractionCount: 0, operatingHours: 0, clockSeconds: 0,
    currentPowerAmps: 0, maxPowerAmps: 0, energyTotalKwh: 0, lastExtractionMl: null,
    brewGroupTempC: 93, brewGroupPwm: 0, brewBoilerTempC: 95, brewBoilerPwm: 0,
    pumpPressureBar: 9, pumpPwm: 0, pumpTargetPwm: 0, flowRateGPerS: 2, flowMeterVolumeMl: 0,
    steamBoilerPressureBar: 1, steamBoilerStatus: 1 as never, scaleWeightG: 0, cpuLoadPercent: 0,
    timestamp: clock, ...over,
  };
}

/** A script shot that is recording, last frame at t = 1000 ms. */
function recordingScriptShot() {
  const r = makeRecorder();
  r.recorder.armForExecute(ARM);
  clock = 100;
  r.recorder.onFrame(frame());
  clock = 1000;
  r.recorder.onFrame(frame({ scaleWeightG: 10 }));
  assert.notEqual(r.recorder.activeShotId, null);
  return r;
}

test("Skript-Bezug: 30 s ohne Maschine → Aufzeichnung endet am letzten Frame, Ausbeute unbekannt", () => {
  const { recorder, finalizeCalls, ended } = recordingScriptShot();
  clock = 1400;
  recorder.setMachineOnline(false);
  assert.equal(recorder.isMachineOffline, true);

  mock.timers.tick(29_999);
  assert.equal(finalizeCalls.length, 0, "zu früh beendet");

  mock.timers.tick(1);
  assert.equal(finalizeCalls.length, 1);
  assert.deepEqual(
    { endedAt: finalizeCalls[0]!.endedAt, stopMode: finalizeCalls[0]!.stopMode, yieldG: finalizeCalls[0]!.yieldG, scaleLost: finalizeCalls[0]!.scaleLost },
    { endedAt: 1000, stopMode: "script_end", yieldG: null, scaleLost: true },
  );
  assert.equal(ended.length, 1, "shotEnded muss raus, sonst bleibt die App im Bezugsmodus");
  assert.equal(recorder.activeShotId, null);
});

test("Kurzer Aussetzer: kommt die Maschine vor 30 s zurück, läuft der Bezug weiter", () => {
  const { recorder, finalizeCalls } = recordingScriptShot();
  recorder.setMachineOnline(false);
  mock.timers.tick(10_000);
  recorder.setMachineOnline(true);
  mock.timers.tick(60_000);
  assert.equal(finalizeCalls.length, 0);
  assert.notEqual(recorder.activeShotId, null);
});

test("Stopp, der die Maschine nicht erreicht: Aufzeichnung endet sofort, später nicht noch einmal", () => {
  const { recorder, finalizeCalls } = recordingScriptShot();
  recorder.setMachineOnline(false);
  assert.equal(recorder.endOnConnectionLost("stop"), true);
  assert.equal(finalizeCalls.length, 1);
  mock.timers.tick(60_000);
  assert.equal(finalizeCalls.length, 1);
  assert.equal(recorder.endOnConnectionLost("stop"), false, "nichts mehr zu beenden");
});

test("Schon im Nachlauf: endet normal mit dem Gewicht, das da ist", () => {
  const { recorder, finalizeCalls } = recordingScriptShot();
  clock = 2000;
  recorder.onFrame(frame({ machineStatus: 1, machineState: "ready", scaleWeightG: 18 })); // Nachlauf beginnt
  recorder.setMachineOnline(false);
  mock.timers.tick(30_000);
  assert.equal(finalizeCalls.length, 1);
  assert.notEqual(finalizeCalls[0]!.yieldG, null);
  assert.equal(finalizeCalls[0]!.scaleLost, false);
});

test("App-Bezug (driveMode): kein Ende durch Verbindungsverlust — der Treiber hat den Stopp", () => {
  const { recorder, finalizeCalls } = makeRecorder();
  recorder.armForDrive(ARM);
  clock = 100;
  recorder.onFrame(frame({ machineStatus: 5 }));
  assert.notEqual(recorder.activeShotId, null);
  recorder.setMachineOnline(false);
  mock.timers.tick(60_000);
  assert.equal(finalizeCalls.length, 0);
  assert.equal(recorder.endOnConnectionLost("stop"), false);
});
