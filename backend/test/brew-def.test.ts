/**
 * Guard for the frozen brew definition (brew_def + shot.brew_def_hash).
 *
 * Why this exists: xenia_script.content is overwritten by the next sync, so
 * before this a past shot silently claimed to have run today's script body.
 * The shot now points at the content-addressed copy it actually brewed.
 *
 * Runner: node:test — no DB, no machine. The repo is mocked; only the hash
 * helper is the real thing.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { brewDefHash, canonicalBrewDef } from "../src/db/brew-def.js";
import { ShotRecorder } from "../src/shots/recorder.js";
import type { ArmArgs } from "../src/shots/recorder.js";
import type { LiveFrame, BrewProfile } from "../../shared/src/types.js";

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
// The hash itself
// ---------------------------------------------------------------------------

test("brewDefHash: same kind + content → same hash, different content → different", () => {
  assert.equal(brewDefHash("script", "p 40 6\np 60 20"), brewDefHash("script", "p 40 6\np 60 20"));
  assert.notEqual(brewDefHash("script", "p 40 6"), brewDefHash("script", "p 40 7"));
});

test("brewDefHash: the kind is part of the identity", () => {
  assert.notEqual(brewDefHash("script", "x"), brewDefHash("steps", "x"));
});

// ---------------------------------------------------------------------------
// Canonical form: only what decides the brew
// ---------------------------------------------------------------------------

const PROFILE_16 = {
  version: 1,
  steps: [
    { kind: "power", name: "Füllen", power: 48, rampMs: 6000, exit: { pressureBar: 2, seconds: 12 } },
    { kind: "flow", name: "Konstanter Flow", targetFlowGs: 1.4, maxPressureBar: 9, exit: { weightG: 36 } },
  ],
};
const canon = (o: unknown) => brewDefHash("steps", canonicalBrewDef("steps", JSON.stringify(o)));

test("⚠ kanonisch: eine umbenannte Phase ist dieselbe Profilversion", () => {
  const renamed = structuredClone(PROFILE_16);
  renamed.steps[0]!.name = "Preinfusion";
  assert.equal(canon(renamed), canon(PROFILE_16));
  const unnamed = structuredClone(PROFILE_16) as { steps: Record<string, unknown>[] };
  for (const st of unnamed.steps) delete st.name;
  assert.equal(canon(unnamed), canon(PROFILE_16));
});

test("kanonisch: Schluesselreihenfolge zaehlt nicht", () => {
  const reordered = {
    steps: [
      { exit: { seconds: 12, pressureBar: 2 }, rampMs: 6000, power: 48, kind: "power" },
      { exit: { weightG: 36 }, maxPressureBar: 9, targetFlowGs: 1.4, kind: "flow" },
    ],
    version: 1,
  };
  assert.equal(canon(reordered), canon(PROFILE_16));
});

test("⚠ kanonisch: jeder ausfuehrungsrelevante Wert aendert die Version", () => {
  const variants: ((p: typeof PROFILE_16) => void)[] = [
    (p) => { p.steps[1]!.targetFlowGs = 1.5; },
    (p) => { p.steps[0]!.rampMs = 5000; },
    (p) => { p.steps[0]!.exit.pressureBar = 3; },
    (p) => { p.steps.reverse(); },
  ];
  for (const change of variants) {
    const p = structuredClone(PROFILE_16);
    change(p);
    assert.notEqual(canon(p), canon(PROFILE_16), change.toString());
  }
});

test("kanonisch: ein Skript bleibt Wort fuer Wort, was es ist", () => {
  const script = "1;13;4 2000 2000;12 10000;7;";
  assert.equal(canonicalBrewDef("script", script), script);
});

// ---------------------------------------------------------------------------
// The recorder freezes it at shot creation
// ---------------------------------------------------------------------------

interface RememberCall {
  kind: string;
  content: string;
}

function makeRepo() {
  const remembered: RememberCall[] = [];
  const created: Record<string, unknown>[] = [];
  let nextId = 300;
  const repo = {
    finalizeAllOpen: (_at: number, _mode: string) => 0,
    rememberBrewDef: (kind: string, content: string) => {
      remembered.push({ kind, content });
      return brewDefHash(kind as "script" | "steps", content);
    },
    createShot: (args: Record<string, unknown>) => {
      created.push(args);
      return nextId++;
    },
    appendSample: () => {},
    finalizeShot: () => {},
    findById: () => null,
    logAutoCalibration: () => {},
    appendStageTransitions: () => {},
  };
  return { repo, remembered, created };
}

const noopLog = { child: () => noopLog, info: () => {}, warn: () => {}, error: () => {} };

function makeRecorder() {
  const { repo, remembered, created } = makeRepo();
  const recorder = new ShotRecorder(
    repo as never,
    { get: () => null, set: () => {} } as never,
    {} as never,
    noopLog as never,
  );
  return { recorder, remembered, created };
}

const ARM: ArmArgs = {
  profileId: 1,
  profileName: "Test",
  scriptId: 7,
  shotSize: "double",
  category: "brew",
  hasPumpAction: true,
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

function frame(over: Partial<LiveFrame> = {}): LiveFrame {
  return {
    machineStatus: 3,
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

const STEPS: BrewProfile = {
  steps: [{ targetFlowGs: 1.4, exit: { seconds: 6 } }],
} as unknown as BrewProfile;

test("execute shot: the script body armed with it is frozen on the shot", () => {
  const { recorder, remembered, created } = makeRecorder();

  recorder.armForExecute({ ...ARM, scriptContent: "p 40 6\np 60 20" });
  clock = 100;
  recorder.onFrame(frame());

  assert.deepEqual(remembered, [{ kind: "script", content: "p 40 6\np 60 20" }]);
  assert.equal(created[0].brewDefHash, brewDefHash("script", "p 40 6\np 60 20"));
});

test("drive shot: the step JSON wins over any script content", () => {
  const { recorder, remembered, created } = makeRecorder();

  recorder.armForDrive({ ...ARM, brewSteps: STEPS, scriptContent: "p 40 6" });
  clock = 100;
  recorder.onFrame(frame({ machineStatus: 5, machineState: "brewing" }));

  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].kind, "steps");
  assert.equal(created[0].brewDefHash, brewDefHash("steps", JSON.stringify(STEPS)));
});

test("nothing armed to freeze → no brew_def row, hash stays null", () => {
  const { recorder, remembered, created } = makeRecorder();

  recorder.armForExecute(ARM);
  clock = 100;
  recorder.onFrame(frame());

  assert.equal(remembered.length, 0);
  assert.equal(created[0].brewDefHash, null);
});
