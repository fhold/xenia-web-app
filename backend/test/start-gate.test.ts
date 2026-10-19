/**
 * Review H-1 + H-2 guards.
 *
 * H-1: a start is allowed only when a FRESH frame shows the machine idle. The
 *      old guard coupled recorder state AND MA=3, so a brew this process never
 *      started (restart, machine-side start, lost recorder state) let a second
 *      start through to the machine.
 * H-2: a start that fails AFTER arming must disarm again, but only its own arm.
 *
 * Runner: node:test via tsx. No machine, no real I/O.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkMachineReadyToStart, frameForStartGate } from "../src/lib/start-gate.js";
import { ShotRecorder } from "../src/shots/recorder.js";
import type { ArmArgs } from "../src/shots/recorder.js";
import type { LiveFrame, MachineStatus } from "../../shared/src/types.js";

let clock = 0;
const realNow = Date.now;
beforeEach(() => {
  clock = 0;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});

function frame(machineStatus: MachineStatus): LiveFrame {
  return { machineStatus, timestamp: clock } as LiveFrame;
}

// ---------------------------------------------------------------------------
// H-1 — machine state is the authority, unknown state is fail-closed
// ---------------------------------------------------------------------------

test("H-1: idle machine (MA=1 on, MA=2 eco) may start", () => {
  assert.equal(checkMachineReadyToStart(frame(1)).ok, true);
  assert.equal(checkMachineReadyToStart(frame(2)).ok, true);
});

test("H-1: busy machine (MA=3 brewing, 4 draining, 5 paddle) is refused", () => {
  for (const status of [3, 4, 5] as MachineStatus[]) {
    const gate = checkMachineReadyToStart(frame(status));
    assert.equal(gate.ok, false, `MA=${status} must not start`);
  }
});

test("H-1: machine off (MA=0) is refused", () => {
  assert.equal(checkMachineReadyToStart(frame(0)).ok, false);
});

test("H-1: no frame is fail-closed, not fail-open", () => {
  const gate = checkMachineReadyToStart(null);
  assert.equal(gate.ok, false);
});

// ---------------------------------------------------------------------------
// H-2 — disarm on a failed start, and only the caller's own arm
// ---------------------------------------------------------------------------

const noopLog = { child: () => noopLog, info: () => {}, warn: () => {}, error: () => {} };

const ARM: ArmArgs = {
  profileId: 1,
  profileName: "Test",
  scriptId: 7,
  shotSize: "single",
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

function makeRecorder(): ShotRecorder {
  const repo = {
    finalizeAllOpen: () => 0,
    createShot: () => 1,
    appendSample: () => {},
    finalizeShot: () => {},
    findById: () => null,
    logAutoCalibration: () => {},
    appendStageTransitions: () => {},
  };
  const settings = { get: () => null, set: () => {} };
  return new ShotRecorder(repo as never, settings as never, {} as never, noopLog as never);
}

test("H-2: disarmIfCurrent drops the arm of a failed start", () => {
  const recorder = makeRecorder();
  const token = recorder.armForExecute(ARM);
  assert.equal(recorder.disarmIfCurrent(token), true);
  // Armed state gone → an MA=3 frame must not start a recording.
  clock = 100;
  recorder.onFrame(frame(3));
  assert.equal(recorder.activeShotId, null);
});

test("H-2: a late disarm must not drop a newer arm", () => {
  const recorder = makeRecorder();
  const stale = recorder.armForExecute(ARM);
  const fresh = recorder.armForExecute({ ...ARM, scriptId: 8 });

  assert.equal(recorder.disarmIfCurrent(stale), false, "stale token must not disarm");

  // The newer arm is still live → MA=3 starts recording for script 8.
  clock = 100;
  recorder.onFrame(frame(3));
  assert.notEqual(recorder.activeShotId, null);
  assert.equal(recorder.disarmIfCurrent(fresh), false, "already consumed by recording");
});

// ---------------------------------------------------------------------------
// A stale cache is not an answer — it is a reason to ask.
//
// Real incident (2026-08-08, log tag "reject"): two starts from the tablet were
// refused with "Maschinenzustand unbekannt", 0.5 s and 0.2 s after an isolated
// /overview timeout. The machine reconnected 2 s later each time and the same
// start succeeded from the phone. The gate never asked it.
// ---------------------------------------------------------------------------

test("a fresh cached frame decides on its own — the machine is not asked", async () => {
  let asked = 0;
  const out = await frameForStartGate(frame(1), async () => {
    asked++;
    return frame(3);
  });
  assert.equal(out?.machineStatus, 1);
  assert.equal(asked, 0, "no request may go out while the cache is fresh");
});

test("the incident: stale cache in the shadow of a timeout still starts", async () => {
  const out = await frameForStartGate(null, async () => frame(1));
  assert.equal(out?.machineStatus, 1, "the machine answered — the start must proceed");
});

test("a single timeout is retried, not taken as an answer", async () => {
  let calls = 0;
  const out = await frameForStartGate(null, async () => {
    calls++;
    if (calls === 1) throw new Error("Request timed out after 1500ms: GET /api/v2/overview");
    return frame(2);
  });
  assert.equal(out?.machineStatus, 2);
  assert.equal(calls, 2);
});

test("a machine that truly does not answer stays fail-closed", async () => {
  let calls = 0;
  const out = await frameForStartGate(null, async () => {
    calls++;
    throw new Error("Request timed out after 1500ms: GET /api/v2/overview");
  });
  assert.equal(out, null);
  assert.equal(calls, 2, "bounded — a start must not hang forever");
  assert.equal(checkMachineReadyToStart(out).ok, false);
});

test("asking the machine does not weaken the gate: a brewing answer still refuses", async () => {
  const out = await frameForStartGate(null, async () => frame(3));
  const gate = checkMachineReadyToStart(out);
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? gate.error : "", /im Betrieb/);
});
