/**
 * Review H-3 — an async stop result must not run into a later shot.
 *
 * BBW stop and watchdog fire the machine call fire-and-forget and only write
 * their result flags when the HTTP call comes back. If the machine left brewing
 * meanwhile, finalizeRecording() has already reset those flags — a late result
 * then lands on whatever shot is active *next*, giving it a wrong stop_mode.
 * The manual stop had the mirror-image bug: the mark was set before the request
 * and stayed set when the request failed.
 *
 * Runner: node:test via tsx. No machine, no real I/O — repo, settings, client
 * and logger are mocked and the clock is stubbed.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ShotRecorder } from "../src/shots/recorder.js";
import type { ArmArgs } from "../src/shots/recorder.js";
import type { LiveFrame } from "../../shared/src/types.js";

let clock = 0;
const realNow = Date.now;
beforeEach(() => {
  clock = 0;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});

/** Let pending promise continuations run (the stubbed clock does not advance). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface FinalizeCall {
  id: number;
  stopMode: string;
}

function makeRepo() {
  const finalizeCalls: FinalizeCall[] = [];
  let nextId = 300;
  const rows = new Map<number, Record<string, unknown>>();
  const repo = {
    finalizeAllOpen: () => 0,
    createShot: () => {
      const id = nextId++;
      rows.set(id, { id, ended_at: null });
      return id;
    },
    appendSample: () => {},
    finalizeShot: (id: number, _endedAt: number, stopMode: string) => {
      finalizeCalls.push({ id, stopMode });
    },
    findById: (id: number) => rows.get(id) ?? null,
    logAutoCalibration: () => {},
    appendStageTransitions: () => {},
  };
  return { repo, finalizeCalls };
}

/** BBW armed, watchdog off — the watchdog would fire its own stop and mask the
 *  BBW result this test is about. */
const SETTINGS: Record<string, string> = {
  brew_by_weight_active: "true",
  brew_by_weight_window_ms: "1000",
  brew_by_weight_residual_lag_s: "1.35",
  brew_by_weight_watchdog_enabled: "false",
};
const settings = {
  get: (k: string) => SETTINGS[k] ?? null,
  set: () => {},
};

const noopLog = { child: () => noopLog, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** scriptStop() that stays pending until the test releases it. */
function makeDeferredClient() {
  let release: (() => void) | null = null;
  const client = {
    scriptStop: () =>
      new Promise<number>((resolve) => {
        release = () => resolve(200);
      }),
  };
  return { client, release: () => release?.() };
}

function makeRecorder(client: unknown) {
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
  hasPumpAction: true,
  hasCmd27: false,
  cmd27Value: null,
  yieldTargetG: 36,
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

/** Run a shot until the BBW stop triggers; returns its shot id. */
function brewUntilBbwTrigger(recorder: ShotRecorder): number {
  recorder.armForExecute(ARM);
  clock = 1_000;
  recorder.onFrame(frame({ scaleWeightG: 0 }));
  const shotId = recorder.activeShotId!;

  // Past the 10s start grace, then a steady 2 g/s climb into the target.
  for (let t = 12_000; t <= 30_000; t += 250) {
    clock = t;
    recorder.onFrame(frame({ scaleWeightG: (t - 12_000) / 500 }));
  }
  return shotId;
}

/** Take the machine out of brewing and past post-brew tracking so it finalizes. */
function endShot(recorder: ShotRecorder, at: number): void {
  clock = at;
  recorder.onFrame(frame({ machineStatus: 1, machineState: "idle", scaleWeightG: 36 }));
  clock = at + 6_000; // beyond post_brew_max_duration_ms (5000 default)
  recorder.onFrame(frame({ machineStatus: 1, machineState: "idle", scaleWeightG: 36 }));
}

// ---------------------------------------------------------------------------
// H-3a — a late BBW stop result must not set the next shot's stop_mode
// ---------------------------------------------------------------------------

test("H-3: a BBW stop that returns after finalize does not mark the NEXT shot as 'app'", async () => {
  const { client, release } = makeDeferredClient();
  const { recorder, finalizeCalls } = makeRecorder(client);

  const first = brewUntilBbwTrigger(recorder);
  endShot(recorder, 31_000); // stop call still in flight
  assert.equal(finalizeCalls.length, 1, "first shot must finalize");

  // A second shot starts while the first stop is still unresolved.
  recorder.armForExecute(ARM);
  clock = 60_000;
  recorder.onFrame(frame({ scaleWeightG: 0 }));
  const second = recorder.activeShotId!;
  assert.notEqual(second, first);

  // The machine finally answers the FIRST shot's stop.
  release();
  await flush();

  endShot(recorder, 70_000);
  const secondCall = finalizeCalls.find((c) => c.id === second);
  assert.ok(secondCall, "second shot must finalize");
  assert.notEqual(
    secondCall.stopMode,
    "app",
    "a stop result belonging to the previous shot must not be booked on this one",
  );
});

// ---------------------------------------------------------------------------
// H-3b — the manual-stop mark is bound to its shot
// ---------------------------------------------------------------------------

test("H-3: a failed manual stop is taken back, the shot ends as 'script_end'", () => {
  const { recorder, finalizeCalls } = makeRecorder({});

  recorder.armForExecute({ ...ARM, yieldTargetG: null });
  clock = 1_000;
  recorder.onFrame(frame({ scaleWeightG: 0 }));
  const shotId = recorder.activeShotId!;

  // Route marks, machine refuses the stop → route takes the mark back.
  recorder.markManualStop(shotId);
  recorder.clearManualStop(shotId);

  endShot(recorder, 20_000);
  assert.equal(finalizeCalls[0].stopMode, "script_end");
});

test("H-3: a mark left over from an earlier shot does not make this one 'manual'", () => {
  const { recorder, finalizeCalls } = makeRecorder({});

  recorder.markManualStop(999); // stale mark from a shot that is long gone

  recorder.armForExecute({ ...ARM, yieldTargetG: null });
  clock = 1_000;
  recorder.onFrame(frame({ scaleWeightG: 0 }));

  endShot(recorder, 20_000);
  assert.equal(finalizeCalls[0].stopMode, "script_end");
});

test("H-3: a confirmed manual stop still books 'manual'", () => {
  const { recorder, finalizeCalls } = makeRecorder({});

  recorder.armForExecute({ ...ARM, yieldTargetG: null });
  clock = 1_000;
  recorder.onFrame(frame({ scaleWeightG: 0 }));
  recorder.markManualStop(recorder.activeShotId!);

  endShot(recorder, 20_000);
  assert.equal(finalizeCalls[0].stopMode, "manual");
});

// ---------------------------------------------------------------------------
// The BBW stop has to quote its own acknowledgement
//
// Shots #173/#175 (2026-08-11) kept brewing 4.3 s / 3.9 s after a BBW stop that
// raised no error, so the watchdog re-fired. Whether the machine swallowed the
// first command or our request itself was slow could not be decided: unlike the
// watchdog's stop, the BBW stop logged nothing on success.
// ---------------------------------------------------------------------------

interface LogLine {
  tag?: string;
  event?: string;
  status?: number;
  duration_ms?: number;
  attempt?: number;
}

function makeCapturingLog(): { log: unknown; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const sink = (o: LogLine) => lines.push(o);
  const log: Record<string, unknown> = {
    info: sink,
    warn: sink,
    error: sink,
    debug: sink,
  };
  log["child"] = () => log;
  return { log, lines };
}

function makeRecorderWithLog(client: unknown) {
  const { repo, finalizeCalls } = makeRepo();
  const { log, lines } = makeCapturingLog();
  const recorder = new ShotRecorder(
    repo as never,
    settings as never,
    client as never,
    log as never,
  );
  return { recorder, finalizeCalls, lines };
}

/** Deferred scriptStop() that also records the clock it was called at, so the
 *  expected latency can be derived instead of guessed. */
function makeTimedClient() {
  let release: (() => void) | null = null;
  let calledAt: number | null = null;
  const client = {
    scriptStop: () => {
      calledAt = clock;
      return new Promise<number>((resolve) => {
        release = () => resolve(200);
      });
    },
  };
  return { client, release: () => release?.(), calledAt: () => calledAt };
}

test("BBW stop logs its acknowledgement with status and latency", async () => {
  const { client, release, calledAt } = makeTimedClient();
  const { recorder, lines } = makeRecorderWithLog(client);

  brewUntilBbwTrigger(recorder);
  const sentAt = calledAt();
  assert.ok(sentAt !== null, "the BBW stop must have been sent");

  clock += 1_234; // the machine takes this long to answer
  release();
  await flush();

  const ack = lines.find((l) => l.tag === "bbw" && l.event === "stop_ack");
  assert.ok(ack, "a successful BBW stop must leave an acknowledgement in the log");
  assert.equal(ack.status, 200);
  assert.equal(
    ack.duration_ms,
    clock - sentAt,
    "the latency of our own request must be measurable",
  );
});

test("the acknowledgement is logged even when its result is discarded as stale", async () => {
  const { client, release, calledAt } = makeTimedClient();
  const { recorder, lines } = makeRecorderWithLog(client);

  brewUntilBbwTrigger(recorder);
  const sentAt = calledAt()!;
  endShot(recorder, 31_000); // shot finalizes while the stop is still in flight

  clock += 2_000;
  release();
  await flush();

  const ack = lines.find((l) => l.tag === "bbw" && l.event === "stop_ack");
  assert.ok(ack, "the discarded case is exactly the one worth measuring");
  assert.equal(ack.duration_ms, clock - sentAt);
  assert.ok(
    lines.some((l) => l.event === "stale_stop_discarded"),
    "the result must still be discarded — this change only adds the measurement",
  );
});
