/**
 * Dry-run guard for the driveMode finalize fix (recorder.ts line ~439).
 *
 * Bug: ENDING_STATUSES = {1, 4}. A flow-hold watchdog/max-brew hard stop is
 * machine/control action 0 → the machine lands in MA=0 (OFF), which is NOT in
 * ENDING_STATUSES. The recorder therefore sat in "wait and see" and never
 * finalized the shot (ended_at stayed NULL → dashboard showed it running).
 *
 * Fix: in driveMode, treat MA=0 as an ending status so post-brew tracking runs
 * and the shot finalizes with the driver's stop_mode ('flowhold_watchdog').
 *
 * Runner: node:test — `node --import tsx --test`. No machine, no real I/O:
 * ShotRepo / SettingsRepo / XeniaClient / Logger are mocked, clock is stubbed.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ShotRecorder } from "../src/shots/recorder.js";
import type { ArmArgs } from "../src/shots/recorder.js";
import type { LiveFrame } from "../../shared/src/types.js";

// ---------------------------------------------------------------------------
// Controllable clock
// ---------------------------------------------------------------------------

let clock = 0;
const realNow = Date.now;
beforeEach(() => {
  clock = 0;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const stageWrites: { enteredMs: number }[] = [];
const sampleWrites: { elapsedMs: number; weightG: number | null }[] = [];

interface FinalizeCall {
  id: number;
  endedAt: number;
  stopMode: string;
  yieldG: number | null;
  scaleLost: boolean;
}

function makeRepo() {
  const finalizeCalls: FinalizeCall[] = [];
  let nextId = 200;
  const rows = new Map<number, Record<string, unknown>>();
  const repo = {
    finalizeAllOpen: (_at: number, _mode: string) => 0,
    createShot: (_args: Record<string, unknown>) => {
      const id = nextId++;
      rows.set(id, { id, ended_at: null });
      return id;
    },
    appendSample: (_id: number, s: unknown) => {
      sampleWrites.push(s as { elapsedMs: number; weightG: number | null });
    },
    finalizeShot: (
      id: number,
      endedAt: number,
      stopMode: string,
      yieldG: number | null,
      extra: { scaleLost?: boolean } | undefined,
    ) => {
      finalizeCalls.push({ id, endedAt, stopMode, yieldG, scaleLost: extra?.scaleLost ?? false });
      const row = rows.get(id);
      if (row) {
        row.ended_at = endedAt;
        row.stop_mode = stopMode;
      }
    },
    findById: (id: number) => rows.get(id) ?? null,
    logAutoCalibration: (_row: unknown) => {},
    appendStageTransitions: (_id: number, stages: unknown[]) => {
      stageWrites.push(...(stages as { enteredMs: number }[]));
    },
  };
  return { repo, finalizeCalls };
}

const settings = { get: (_k: string) => null, set: (_k: string, _v: string) => {} };

const noopLog = {
  child: () => noopLog,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const client = {};

function makeRecorder() {
  stageWrites.length = 0;
  sampleWrites.length = 0;
  const { repo, finalizeCalls } = makeRepo();
  const recorder = new ShotRecorder(
    repo as never,
    settings as never,
    client as never,
    noopLog as never,
  );
  return { recorder, finalizeCalls };
}

const ARM: ArmArgs = {
  profileId: 1,
  profileName: "Test",
  scriptId: 7,
  shotSize: "double",
  category: "brew",
  categoryAuto: "brew",
  categoryOverride: null,
  hasCmd27: false,
  cmd27Value: null,
  yieldTargetG: null,
  beanId: null,
  grinderId: null,
  grindSetting: null,
  grinderRpm: null,
  doseG: null,
  notes: null,
};

/** A paddle-mode (MA=5) frame with the given scale weight. */
function frame(over: Partial<LiveFrame> = {}): LiveFrame {
  return {
    machineStatus: 5,
    machineState: "brewing",
    extractionCount: 0,
    operatingHours: 0,
    clockSeconds: 0,
    currentPowerAmps: 0,
    maxPowerAmps: 0,
    energyTotalKwh: 0,
    lastExtractionMl: null,
    brewGroupTempC: 93,
    brewGroupPwm: 0,
    brewBoilerTempC: 95,
    brewBoilerPwm: 0,
    pumpPressureBar: 9,
    pumpPwm: 0,
    pumpTargetPwm: 0,
    flowRateGPerS: 2.0,
    flowMeterVolumeMl: 0,
    steamBoilerPressureBar: 1,
    steamBoilerStatus: 1 as never,
    scaleWeightG: 0,
    cpuLoadPercent: 0,
    timestamp: clock,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The guard: driveMode hard stop → MA=0 must finalize
// ---------------------------------------------------------------------------

test("driveMode: a hard stop landing at MA=0 finalizes the shot", () => {
  const { recorder, finalizeCalls } = makeRecorder();

  recorder.armForDrive(ARM);
  clock = 100;
  recorder.onFrame(frame({ scaleWeightG: 0 })); // MA=5 → start recording

  clock = 1000;
  recorder.onFrame(frame({ scaleWeightG: 20 })); // brewing sample

  // Watchdog hard stop: driver picked the mode, machine dropped to MA=0.
  recorder.setDriveStopMode("flowhold_watchdog");

  // First MA=0 frame → enter post-brew tracking (not yet finalized).
  clock = 1100;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: 20 }));
  assert.equal(finalizeCalls.length, 0, "should not finalize on the first post-brew frame");

  // Stable weight past the post-brew window (default 1000ms) → finalize.
  clock = 2300;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: 20 }));

  assert.equal(finalizeCalls.length, 1, "shot never finalized after MA=0 hard stop");
  assert.equal(finalizeCalls[0].stopMode, "flowhold_watchdog");
  assert.ok(finalizeCalls[0].endedAt > 0);
});

test("driveMode: MA=0 is NOT an ending status outside driveMode (regression guard)", () => {
  const { recorder, finalizeCalls } = makeRecorder();

  // Normal script arm (driveMode = false), recording starts at MA=3.
  recorder.armForExecute(ARM);
  clock = 100;
  recorder.onFrame({ ...frame(), machineStatus: 3, machineState: "brewing" });

  clock = 1000;
  recorder.onFrame({ ...frame(), machineStatus: 3, scaleWeightG: 20 });

  // A spurious MA=0 during a script shot must NOT finalize (wait-and-see).
  clock = 3000;
  recorder.onFrame({ ...frame(), machineStatus: 0, machineState: "off", scaleWeightG: 20 });

  assert.equal(finalizeCalls.length, 0, "MA=0 must not finalize a non-drive script shot");
});

// ---------------------------------------------------------------------------
// Stage times: the driver reports wall-clock, the DB stores the sample axis
// ---------------------------------------------------------------------------

test("driveMode: stage entry times are rebased onto shot.startedAt", () => {
  const { recorder } = makeRecorder();

  // Driver starts at t=0 and immediately records stage 0; the machine only
  // reports brewing 1500 ms later, which is when the shot row starts.
  clock = 0;
  recorder.armForDrive(ARM);
  recorder.setDriveStages([
    {
      stageIndex: 0,
      stepKind: "flow",
      targetFlowGs: 1.4,
      targetPressureBar: null,
      targetPower: null,
      exitReason: null,
      enteredAt: 0,
    },
  ]);

  clock = 1500;
  recorder.onFrame(frame({ scaleWeightG: 0 })); // MA=5 → shot.startedAt = 1500

  recorder.setDriveStages([
    {
      stageIndex: 0,
      stepKind: "flow",
      targetFlowGs: 1.4,
      targetPressureBar: null,
      targetPower: null,
      exitReason: "seconds",
      enteredAt: 0,
    },
    {
      stageIndex: 1,
      stepKind: "flow",
      targetFlowGs: 2.0,
      targetPressureBar: null,
      targetPower: null,
      exitReason: null,
      enteredAt: 8000,
    },
  ]);

  recorder.setDriveStopMode("app");
  clock = 20000;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: 36 }));
  clock = 21500;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: 36 }));

  assert.equal(stageWrites.length, 2, "stages were not persisted");
  // Stage 0 ran before recording began → negative on the sample axis.
  assert.equal(stageWrites[0].enteredMs, -1500);
  // Stage 1 at wall-clock 8000 is 6.5 s into the samples, not 8.0 s.
  assert.equal(stageWrites[1].enteredMs, 6500);
});

// ---------------------------------------------------------------------------
// Mid-brew scale dropout: report it, don't stop the brew
// ---------------------------------------------------------------------------

test("a scale that dies mid-brew nulls the yield and flags the shot", () => {
  const { recorder, finalizeCalls } = makeRecorder();

  recorder.armForDrive(ARM);
  clock = 100;
  recorder.onFrame(frame({ scaleWeightG: 0, pumpPwm: 40, pumpPressureBar: 3 }));

  // Healthy extraction up to 13 g.
  let w = 1;
  for (clock = 1000; clock < 15000; clock += 400) {
    recorder.onFrame(frame({ scaleWeightG: w, flowRateGPerS: 1.8, pumpPwm: 55, pumpPressureBar: 7 }));
    w += 0.4;
  }
  const lastGood = w;

  // The scale goes silent: weight frozen, rate exactly 0, pump still pushing.
  for (; clock < 22000; clock += 400) {
    recorder.onFrame(
      frame({ scaleWeightG: lastGood, flowRateGPerS: 0, pumpPwm: 60, pumpPressureBar: 8.3 }),
    );
  }

  recorder.setDriveStopMode("flowhold");
  clock = 23000;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: lastGood }));
  clock = 24500;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: lastGood }));

  assert.equal(finalizeCalls.length, 1, "the brew must still finalize normally");
  assert.equal(finalizeCalls[0].stopMode, "flowhold", "the dropout must not change the stop");
  assert.equal(finalizeCalls[0].yieldG, null, "a stale weight must not be recorded as yield");
  assert.equal(finalizeCalls[0].scaleLost, true);
});

test("a normal brew is not flagged as a dropout", () => {
  const { recorder, finalizeCalls } = makeRecorder();

  recorder.armForDrive(ARM);
  clock = 100;
  recorder.onFrame(frame({ scaleWeightG: 0, pumpPwm: 40, pumpPressureBar: 3 }));

  let w = 1;
  for (clock = 1000; clock < 25000; clock += 400) {
    recorder.onFrame(frame({ scaleWeightG: w, flowRateGPerS: 1.8, pumpPwm: 55, pumpPressureBar: 7 }));
    w += 0.4;
  }

  recorder.setDriveStopMode("flowhold");
  clock = 26000;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: w }));
  clock = 27500;
  recorder.onFrame(frame({ machineStatus: 0, machineState: "off", scaleWeightG: w }));

  assert.equal(finalizeCalls[0].scaleLost, false);
  assert.ok((finalizeCalls[0].yieldG ?? 0) > 20, "a healthy brew must keep its yield");
});

// ---------------------------------------------------------------------------
// #177: the scale comes back — its reading must be believed, not latched out
// ---------------------------------------------------------------------------

test("a returning scale rebases the plausibility filter instead of latching", () => {
  const { recorder } = makeRecorder();

  recorder.armForDrive(ARM);
  clock = 100;
  recorder.onFrame(frame({ scaleWeightG: 0, flowRateGPerS: 0, pumpPwm: 45, pumpPressureBar: 8 }));

  // Mute from the start: weight pinned at 0 while the pump pushes (#177).
  for (clock = 500; clock < 18000; clock += 400) {
    recorder.onFrame(frame({ scaleWeightG: 0, flowRateGPerS: 0, pumpPwm: 45, pumpPressureBar: 8 }));
  }

  // It returns with 19 g in the cup — far past the 15 g jump tolerance, and
  // long past the start grace, so the old filter carried the 0 forward forever.
  clock = 22000;
  recorder.onFrame(frame({ scaleWeightG: 19, flowRateGPerS: 1.1, pumpPwm: 45, pumpPressureBar: 7 }));

  assert.equal(sampleWrites.at(-1)?.weightG, 19, "the returning reading was rejected");

  // And it keeps tracking from there rather than re-rejecting every frame.
  clock = 22400;
  recorder.onFrame(frame({ scaleWeightG: 20.1, flowRateGPerS: 1.1, pumpPwm: 45, pumpPressureBar: 7 }));
  assert.equal(sampleWrites.at(-1)?.weightG, 20.1);
});
