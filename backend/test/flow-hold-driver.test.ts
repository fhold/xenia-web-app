/**
 * State-machine dry-run for the FlowHoldDriver (Consistent-Flow, Phase 1).
 *
 * Runner: node:test — run with `node --import tsx --test`.
 * No machine, no real I/O: the XeniaClient / ShotRecorder / SettingsRepo /
 * Logger are mocked and the clock is stubbed, so the full lifecycle
 * (idle→hold→stopping→done) and both safety paths (max-brew ceiling,
 * watchdog stop-lag) are exercised against mocked telemetry.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FlowHoldDriver } from "../src/xenia/flow-hold-driver.js";
import type { BrewStep, LiveFrame } from "../../shared/src/types.js";

/** Was der Treiber dem Recorder ueber die Stufen meldet. */
type StageLike = { stageIndex: number; exitReason: string | null };

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

interface ClientCall {
  method: string;
  arg?: unknown;
}

function makeClient(
  opts: { failFirstWrite?: boolean; sbStatus?: number; maStatus?: number } = {},
) {
  const calls: ClientCall[] = [];
  let wrote = false;
  const client = {
    async paddlePumppower(level: number) {
      calls.push({ method: "paddlePumppower", arg: level });
      if (opts.failFirstWrite && !wrote) {
        wrote = true;
        throw new Error("network");
      }
      wrote = true;
    },
    async paddleStop() {
      calls.push({ method: "paddleStop" });
      return 200;
    },
    async machineControl(action: string) {
      calls.push({ method: "machineControl", arg: action });
    },
    async overview() {
      calls.push({ method: "overview" });
      return { SB_STATUS: opts.sbStatus ?? 1, MA_STATUS: opts.maStatus ?? 1 };
    },
  };
  return { client, calls };
}

/** A client whose pump writes block until the gate is opened — used to hold a
 *  loop write "in flight" so the K-2 stop-serialization can be observed. */
function makeGatedDriver(opts: { maStatus?: number; log?: unknown } = {}) {
  const calls: ClientCall[] = [];
  const pending: Array<() => void> = [];
  let blocking = false;
  const client = {
    async paddlePumppower(level: number) {
      calls.push({ method: "paddlePumppower", arg: level });
      if (blocking) await new Promise<void>((r) => pending.push(r));
    },
    async paddleStop() {
      calls.push({ method: "paddleStop" });
      return 200;
    },
    async machineControl(action: string) {
      calls.push({ method: "machineControl", arg: action });
    },
    async overview() {
      calls.push({ method: "overview" });
      return { SB_STATUS: 1, MA_STATUS: opts.maStatus ?? 1 };
    },
  };
  const { recorder, state } = makeRecorder();
  const driver = new FlowHoldDriver(
    client as never,
    recorder as never,
    settings as never,
    (opts.log ?? noopLog) as never,
  );
  const gate = {
    hold: () => {
      blocking = true;
    },
    open: () => {
      blocking = false;
      pending.splice(0).forEach((r) => r());
    },
  };
  return { driver, calls, state, gate };
}

function makeRecorder() {
  const state = { armed: false, stopMode: null as string | null, stages: [] as StageLike[] };
  const recorder = {
    armForDrive() {
      state.armed = true;
    },
    setDriveStopMode(mode: string) {
      state.stopMode = mode;
    },
    setDriveStages(stages: unknown[]) { state.stages = stages as StageLike[]; },
  };
  return { recorder, state };
}

const settings = { get: (_k: string) => null };

const noopLog = {
  child: () => noopLog,
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeDriver(clientOpts?: {
  failFirstWrite?: boolean;
  sbStatus?: number;
  maStatus?: number;
}) {
  const { client, calls } = makeClient(clientOpts);
  const { recorder, state } = makeRecorder();
  const driver = new FlowHoldDriver(
    client as never,
    recorder as never,
    settings as never,
    noopLog as never,
  );
  return { driver, calls, state };
}

const ARM = {
  profileId: 1,
  profileName: "Test",
  scriptId: 7,
  shotSize: "double" as const,
  beanId: null,
  grinderId: null,
  grindSetting: null,
  grinderRpm: null,
  doseG: null,
  notes: null,
};

/** A brewing (MA=5) frame with the given scale weight and flow. */
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

test("start arms the recorder and sends the step-0 seed power", async () => {
  const { driver, calls, state } = makeDriver();
  clock = 0;
  const cfg = await driver.start(undefined, 36, ARM, frame({ scaleWeightG: 0 }));

  assert.equal(state.armed, true);
  assert.equal(driver.isActive(), true);
  // No ramp phase: start enters step 0 directly. With no steps the default is a
  // flow step, so the first (forced) pump write is the controller seed power.
  assert.deepEqual(calls[0], { method: "paddlePumppower", arg: cfg.rampStartPower });
});

test("start refuses a cold brew boiler when a warm-up floor is set", async () => {
  const { driver } = makeDriver();
  await assert.rejects(
    () =>
      driver.start(
        { warmupMinBrewBoilerC: 90 },
        36,
        ARM,
        frame({ brewBoilerTempC: 80 }),
      ),
    /too cold/,
  );
  assert.equal(driver.isActive(), false);
});

test("start refuses an un-tared scale (residual weight) before a drive", async () => {
  const { driver } = makeDriver();
  // Scale carries a residual (drive mode has no machine tare) → refuse to start
  // rather than feed the flow loop / BBW a false weight (root cause of #117).
  await assert.rejects(
    () => driver.start(undefined, 36, ARM, frame({ scaleWeightG: 32.8 })),
    /nicht genullt/,
  );
  assert.equal(driver.isActive(), false);
});

test("start aborts cleanly if the first pump write fails", async () => {
  const { driver, calls, state } = makeDriver({ failFirstWrite: true });
  await assert.rejects(() => driver.start(undefined, 36, ARM, frame()), /network/);
  await flush();
  assert.equal(driver.isActive(), false);
  // safeStop was attempted and the shot is flagged as a watchdog stop.
  assert.ok(calls.some((c) => c.method === "paddleStop"));
  assert.equal(state.stopMode, "flowhold_watchdog");
});

// ---------------------------------------------------------------------------
// Full happy path: hold → normal stop → done
// ---------------------------------------------------------------------------

test("the drive holds from step 0, then a BBW projection stops normally", async () => {
  const { driver, calls, state } = makeDriver();
  clock = 0;
  await driver.start(undefined, 10, ARM, frame());

  // First drip is just a normal hold tick (no ramp phase to hand off from).
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 }));

  // The BBW normal stop is suppressed during the 10s start grace (script
  // parity, recorder.ts) so an un-tared residual can't fire an early stop
  // (#117). Climb the weight ~2 g/s across the grace boundary: no stop inside
  // grace, then the projection fires once BBW is fed post-grace.
  let stopped = false;
  for (let t = 750; t <= 9750 && !stopped; t += 250) {
    clock = t;
    const w = 1.5 + ((t - 500) / 1000) * 0.9;
    driver.onFrame(frame({ scaleWeightG: w, flowRateGPerS: 2.0 }));
    if (state.stopMode !== null) stopped = true;
  }
  assert.equal(state.stopMode, null, "normal stop must be suppressed during grace");

  for (let t = 10000; t <= 12000 && !stopped; t += 250) {
    clock = t;
    const w = 1.5 + ((t - 500) / 1000) * 0.9;
    driver.onFrame(frame({ scaleWeightG: w, flowRateGPerS: 2.0 }));
    if (state.stopMode !== null) stopped = true;
  }
  await flush();

  assert.equal(stopped, true, "normal stop never triggered");
  assert.equal(state.stopMode, "flowhold");

  // Normal exit order (Block-1): paddleStop BEFORE pumppower=0.
  const idxStop = calls.findIndex((c) => c.method === "paddleStop");
  const idxZero = calls.findIndex(
    (c) => c.method === "paddlePumppower" && c.arg === 0,
  );
  assert.ok(idxStop >= 0 && idxZero >= 0, "exit calls missing");
  assert.ok(idxStop < idxZero, "paddleStop must precede pumppower=0");
  // Normal exit forces MA 5→1 (idle) after pumppower=0 so the exit registers.
  const idxIdle = calls.findIndex(
    (c) => c.method === "machineControl" && c.arg === "1",
  );
  assert.ok(idxIdle >= 0, "normal exit must send machine/control action 1 (idle)");
  assert.ok(idxZero < idxIdle, "pumppower=0 must precede the idle command");
  // No hard stop on the normal path.
  assert.ok(!calls.some((c) => c.method === "machineControl" && c.arg === "0"));

  // Machine leaves paddle mode → drive is done.
  clock = 12500;
  driver.onFrame(frame({ machineStatus: 1, machineState: "idle" }));
  assert.equal(driver.isActive(), false);
});

// ---------------------------------------------------------------------------
// Safety: last-resort max-brew ceiling
// ---------------------------------------------------------------------------

test("a dead scale trips the max-brew ceiling into a hard stop", async () => {
  const { driver, calls, state } = makeDriver();
  clock = 0;
  await driver.start({ maxBrewMs: 2000 }, 36, ARM, frame());

  // Weight/flow never advance; past the ceiling the driver hard-stops.
  clock = 2500;
  driver.onFrame(frame({ scaleWeightG: 0, flowRateGPerS: 0 }));
  await flush();

  assert.ok(calls.some((c) => c.method === "machineControl" && c.arg === "0"));
  assert.equal(state.stopMode, "flowhold_watchdog");
  assert.equal(driver.isActive(), false);
});

test("a bloom (pump at 0) does not consume the pump-runtime ceiling", async () => {
  const { driver, state } = makeDriver();
  clock = 0;
  // Step 0 blooms with the pump off for 30 s — three times the ceiling in wall-
  // clock terms. The machine caps continuous pump RUN, so this must not stop.
  const steps: BrewStep[] = [
    { kind: "power", power: 0, exit: { seconds: 30 } },
    { kind: "flow", targetFlowGs: 2.0, exit: { weightG: 36 } },
  ];
  await driver.start({ maxBrewMs: 10_000, steps }, 36, ARM, frame());

  for (let t = 500; t <= 29_500; t += 500) {
    clock = t;
    driver.onFrame(frame({ scaleWeightG: 0, flowRateGPerS: 0 }));
    await flush();
  }
  assert.equal(state.stopMode, null, "pump-off time must not trip the ceiling");
  assert.equal(driver.isActive(), true);

  // Past the bloom the pump runs again — now the ceiling counts and fires.
  for (let t = 30_000; t <= 45_000; t += 500) {
    clock = t;
    driver.onFrame(frame({ scaleWeightG: 0, flowRateGPerS: 0 }));
    await flush();
  }
  assert.equal(state.stopMode, "flowhold_watchdog");
});

// ---------------------------------------------------------------------------
// Power-step limiters
// ---------------------------------------------------------------------------

/** Pump powers commanded so far, in order. */
function sentPowers(calls: ClientCall[]): number[] {
  return calls.filter((c) => c.method === "paddlePumppower").map((c) => c.arg as number);
}

test("a power step bleeds its power down while the pressure cap is exceeded", async () => {
  const { driver, calls } = makeDriver();
  clock = 0;
  const steps: BrewStep[] = [
    { kind: "power", power: 80, maxPressureBar: 3, exit: { seconds: 60 } },
    { kind: "flow", targetFlowGs: 2.0, exit: { weightG: 36 } },
  ];
  await driver.start({ steps }, 36, ARM, frame({ pumpPressureBar: 0 }));

  for (let t = 500; t <= 6_000; t += 500) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: 9, scaleWeightG: 0, flowRateGPerS: 0 }));
    await flush();
  }
  const last = sentPowers(calls).pop()!;
  assert.ok(last < 80, `over-cap pressure must bleed the power down, got ${last}`);

  // Back under the cap the step returns to its nominal power.
  clock = 6_500;
  driver.onFrame(frame({ pumpPressureBar: 1, scaleWeightG: 0, flowRateGPerS: 0 }));
  await flush();
  assert.equal(sentPowers(calls).pop(), 80);
});

test("a power step bleeds its power down while the flow cap is exceeded", async () => {
  const { driver, calls } = makeDriver();
  clock = 0;
  const steps: BrewStep[] = [
    { kind: "power", power: 80, maxFlowGs: 2, exit: { seconds: 60 } },
    { kind: "flow", targetFlowGs: 2.0, exit: { weightG: 36 } },
  ];
  await driver.start({ steps }, 36, ARM, frame({ flowRateGPerS: 0 }));

  for (let t = 500; t <= 6_000; t += 500) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: 0, scaleWeightG: 0, flowRateGPerS: 5 }));
    await flush();
  }
  const last = sentPowers(calls).pop()!;
  assert.ok(last < 80, `over-cap flow must bleed the power down, got ${last}`);
});

test("an uncapped power step holds its power regardless of pressure and flow", async () => {
  const { driver, calls } = makeDriver();
  clock = 0;
  const steps: BrewStep[] = [
    { kind: "power", power: 80, exit: { seconds: 60 } },
    { kind: "flow", targetFlowGs: 2.0, exit: { weightG: 36 } },
  ];
  await driver.start({ steps }, 36, ARM, frame());

  for (let t = 500; t <= 6_000; t += 500) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: 12, scaleWeightG: 0, flowRateGPerS: 9 }));
    await flush();
  }
  assert.deepEqual(new Set(sentPowers(calls)), new Set([80]));
});

// ---------------------------------------------------------------------------
// Safety: watchdog stop-lag escalates a stuck normal exit to a hard stop
// ---------------------------------------------------------------------------

test("a normal exit that does not take effect escalates via the watchdog", async () => {
  const { driver, calls, state } = makeDriver();
  clock = 0;
  await driver.start(undefined, 10, ARM, frame());

  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 }));
  // Trigger the normal stop — only fires past the 10s start grace (script parity).
  for (let t = 750; t <= 12000 && state.stopMode === null; t += 250) {
    clock = t;
    const w = 1.5 + ((t - 500) / 1000) * 0.9;
    driver.onFrame(frame({ scaleWeightG: w }));
  }
  await flush();
  assert.equal(state.stopMode, "flowhold");

  // The machine stays stuck in paddle mode (MA=5) well past grace + stop-lag.
  clock = 13000;
  driver.onFrame(frame({ machineStatus: 5, scaleWeightG: 20 }));
  await flush();

  assert.ok(
    calls.some((c) => c.method === "machineControl" && c.arg === "0"),
    "watchdog did not hard-stop the stuck exit",
  );
  assert.equal(state.stopMode, "flowhold_watchdog");
  assert.equal(driver.isActive(), false);
});

// ---------------------------------------------------------------------------
// Manual abort
// ---------------------------------------------------------------------------

test("requestStop during hold triggers the normal exit", async () => {
  const { driver, calls, state } = makeDriver();
  clock = 0;
  await driver.start(undefined, 36, ARM, frame());
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 })); // → hold

  driver.requestStop();
  await flush();

  // 'manual', not 'flowhold': a stop by hand must stay distinguishable from the
  // BBW stop at the yield target, otherwise the history can no longer tell
  // whether a profile actually reached its target.
  assert.equal(state.stopMode, "manual");
  assert.ok(calls.some((c) => c.method === "paddleStop"));
});

test("SB_STATUS=2 after exit sends steam-off (action 3) once", async () => {
  const { driver, calls } = makeDriver({ sbStatus: 2 });
  clock = 0;
  await driver.start(undefined, 36, ARM, frame());
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 }));
  driver.requestStop();
  await flush();

  assert.ok(calls.some((c) => c.method === "machineControl" && c.arg === "3"));
});

// ---------------------------------------------------------------------------
// Post-exit SB watch — delayed steam re-activation (Block-1 bug)
// ---------------------------------------------------------------------------

test("delayed steam re-activation during the SB watch sends steam-off (action 3)", async () => {
  const { driver, calls } = makeDriver(); // sbStatus defaults to 1 (immediate cleanup no-op)
  clock = 0;
  await driver.start(undefined, 36, ARM, frame());
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 })); // → hold
  driver.requestStop();
  await flush();

  // Machine leaves paddle mode → enter the SB watch. Steam still off.
  clock = 1000;
  driver.onFrame(frame({ machineStatus: 1, machineState: "idle", steamBoilerStatus: 1 as never }));
  assert.equal(driver.isActive(), false);
  const before = calls.filter((c) => c.method === "machineControl" && c.arg === "3").length;

  // ~14 s later the MA 5→1 transition flips steam back on.
  clock = 15000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 2 as never }));
  await flush();
  const after = calls.filter((c) => c.method === "machineControl" && c.arg === "3").length;
  assert.ok(after > before, "delayed steam-off (action 3) was not sent");
});

test("SB watch closes without a steam-off when steam stays off", async () => {
  const { driver, calls } = makeDriver();
  clock = 0;
  await driver.start(undefined, 36, ARM, frame());
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 }));
  driver.requestStop();
  await flush();

  clock = 1000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 1 as never })); // enter SB watch

  // A frame past the watch window with steam still off closes it, no action 3.
  clock = 31000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 1 as never }));
  assert.equal(driver.isActive(), false);
  assert.ok(!calls.some((c) => c.method === "machineControl" && c.arg === "3"));
});

// ---------------------------------------------------------------------------
// Dampf: nach dem Bezug der Zustand von vorher, nicht pauschal aus
// ---------------------------------------------------------------------------

const steamCmds = (calls: ClientCall[]) =>
  calls.filter((c) => c.method === "machineControl" && (c.arg === "3" || c.arg === "4")).map((c) => c.arg);

test("⚠ Dampf war vor dem Bezug an: er bleibt an — kein Ausschalten, auch nicht im Nachgang", async () => {
  const { driver, calls } = makeDriver({ sbStatus: 2 });
  clock = 0;
  await driver.start(undefined, 36, ARM, frame({ steamBoilerStatus: 2 as never }));
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5, steamBoilerStatus: 2 as never }));
  driver.requestStop();
  await flush();
  clock = 1000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 2 as never })); // SB-Beobachtung
  clock = 15000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 2 as never }));
  await flush();
  assert.deepEqual(steamCmds(calls), []);
});

test("Dampf war an und ist nach dem Bezug aus: er wird wieder eingeschaltet", async () => {
  const { driver, calls } = makeDriver({ sbStatus: 1 });
  clock = 0;
  await driver.start(undefined, 36, ARM, frame({ steamBoilerStatus: 2 as never }));
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5, steamBoilerStatus: 2 as never }));
  driver.requestStop();
  await flush();
  assert.deepEqual(steamCmds(calls), ["4"]);
});

test("Dampf war aus: der Firmware-Fehler wird wie bisher abgefangen", async () => {
  const { driver, calls } = makeDriver({ sbStatus: 2 });
  clock = 0;
  await driver.start(undefined, 36, ARM, frame({ steamBoilerStatus: 1 as never }));
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 }));
  driver.requestStop();
  await flush();
  assert.deepEqual(steamCmds(calls), ["3"]);
});

test("⚠ nach einem Notstopp wird nie Dampf eingeschaltet — die Maschine ist bewusst aus", async () => {
  const { driver, calls } = makeDriver({ sbStatus: 1, maStatus: 0 });
  clock = 0;
  await driver.start({ maxBrewMs: 2000 }, 36, ARM, frame({ steamBoilerStatus: 2 as never }));
  // Waage steht → ueber der Hoechstdauer Notstopp (action 0).
  clock = 2500;
  driver.onFrame(frame({ scaleWeightG: 0, flowRateGPerS: 0, steamBoilerStatus: 2 as never }));
  await flush();
  assert.ok(calls.some((c) => c.method === "machineControl" && c.arg === "0"), "Notstopp ausgeloest");
  clock = 13000;
  driver.onFrame(frame({ machineStatus: 0, steamBoilerStatus: 1 as never }));
  clock = 20000;
  driver.onFrame(frame({ machineStatus: 0, steamBoilerStatus: 1 as never }));
  await flush();
  assert.ok(!steamCmds(calls).includes("4"));
});

test("Dampf-Zustand vorher unbekannt: nichts anfassen", async () => {
  const { driver, calls } = makeDriver({ sbStatus: 2 });
  clock = 0;
  await driver.start(undefined, 36, ARM, frame({ steamBoilerStatus: 0 as never }));
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 }));
  driver.requestStop();
  await flush();
  assert.deepEqual(steamCmds(calls), []);
});

// ---------------------------------------------------------------------------
// Cut-2 step sequencer — power / pressure steps + extended exits
// ---------------------------------------------------------------------------

/** Drive into the hold phase (step 0 starts directly) with the given steps. */
async function startInHold(
  steps: BrewStep[],
  frameOver: Partial<LiveFrame> = {},
) {
  const d = makeDriver();
  clock = 0;
  await d.driver.start({ steps }, 36, ARM, frame());
  clock = 500;
  d.driver.onFrame(frame({ scaleWeightG: 1.5, ...frameOver })); // first hold tick
  return d;
}

test("a power step commands its open-loop setpoint", async () => {
  const { driver, calls } = await startInHold([
    { kind: "power", power: 44, exit: { seconds: 30 } },
    { kind: "power", power: 60 },
  ]);
  clock = 700;
  driver.onFrame(frame({ scaleWeightG: 1.6 })); // hold tick → step 0 power
  await flush();
  assert.ok(
    calls.some((c) => c.method === "paddlePumppower" && c.arg === 44),
    "power step did not command its open-loop setpoint",
  );
});

test("a power step with rampMs eases from the previous power to its target", async () => {
  // Decent-consistent "smooth": the power setpoint ramps from the previous power
  // step's value (40) to this step's target (80) — no explicit per-step "from".
  const { driver, calls } = await startInHold([
    { kind: "power", power: 40, exit: { seconds: 1 } },
    { kind: "power", power: 80, rampMs: 2000 },
  ]);
  clock = 1600; // elapsed ≥ 1s → advance to step 1; its ramp starts here at 40
  driver.onFrame(frame({ scaleWeightG: 1.6 }));
  clock = 2600; // 1000ms into the 2000ms ramp → 40 + (80-40)*0.5 = 60
  driver.onFrame(frame({ scaleWeightG: 1.7 }));
  await flush();
  assert.ok(
    calls.some((c) => c.method === "paddlePumppower" && c.arg === 60),
    "power ramp did not interpolate from the previous power to the mid-ramp value",
  );
});

test("step 0 starts directly — a PowerStep commands its own power as the first write", async () => {
  // No ramp phase: the drive enters step 0 at start. A PowerStep step 0 is the
  // pre-infusion, so the very first (forced) pump write is that step's power —
  // not the cfg.rampStartPower seed used to prime a flow/pressure controller.
  const { driver, calls } = makeDriver();
  clock = 0;
  await driver.start(
    { steps: [
      { kind: "power", power: 48, exit: { seconds: 6 } },
      { kind: "flow", targetFlowGs: 1.4, controller: "adaptive", exit: { weightG: 28 } },
    ] },
    28,
    ARM,
    frame({ scaleWeightG: 0 }),
  );
  await flush();
  assert.deepEqual(calls[0], { method: "paddlePumppower", arg: 48 });
});

test("a flow/pressure step with rampMs eases the setpoint in (slower power climb)", async () => {
  // Two identical pressure step-0 drives with measured pressure pinned at 3 bar.
  // The rampMs one interpolates the setpoint 0→9 over 6 s, so early on the setpoint
  // sits near/below the measured 3 bar (small or negative error → no climb), while
  // the no-ramp drive sees the full 9-bar error at once and drives the power up.
  const collectEarly = async (rampMs?: number) => {
    const { driver, calls } = await startInHold(
      [{ kind: "pressure", targetPressureBar: 9, ...(rampMs ? { rampMs } : {}) }],
      { pumpPressureBar: 3 },
    );
    for (let t = 700; t <= 2000; t += 200) {
      clock = t;
      driver.onFrame(frame({ scaleWeightG: 1.6, pumpPressureBar: 3 }));
    }
    await flush();
    return Math.max(
      ...calls.filter((c) => c.method === "paddlePumppower").map((c) => c.arg as number),
    );
  };
  const rampedMax = await collectEarly(6000);
  const jumpMax = await collectEarly();
  assert.ok(
    rampedMax < jumpMax,
    `rampMs setpoint did not ease in (ramped max ${rampedMax} ≥ jump max ${jumpMax})`,
  );
});

test("power→flow handoff ramps from the measured flow — pump does not crash to the floor", async () => {
  // Shots 126/127: on the power→flow handoff the setpoint ramp started at 0, which
  // the loop read as "far too much flow" and slammed the pump to the floor, so the
  // flow rang back up. With the fix the ramp starts at the measured flow and the
  // conductance is seeded from flow÷power, so the pump holds near the seed instead.
  const { driver, calls } = makeDriver();
  clock = 0;
  await driver.start(
    {
      steps: [
        { kind: "power", power: 35, exit: { weightG: 1.0 } },
        { kind: "flow", targetFlowGs: 0.9, controller: "adaptive", rampMs: 2000, exit: { weightG: 28 } },
      ],
    },
    35,
    ARM,
    frame({ scaleWeightG: 0, flowRateGPerS: 0 }),
  );
  // Pre-infusion: first drip arrives, flow ~0.9, weight crosses 1.0 g → advance.
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 0, flowRateGPerS: 0 }));
  clock = 1000;
  driver.onFrame(frame({ scaleWeightG: 0.5, flowRateGPerS: 0.6 }));
  clock = 1500; // weight 1.2 ≥ 1.0 → handoff this tick, real flow present
  driver.onFrame(frame({ scaleWeightG: 1.2, flowRateGPerS: 0.9 }));
  await flush();

  const powers = calls.filter((c) => c.method === "paddlePumppower").map((c) => c.arg as number);
  const afterHandoff = powers[powers.length - 1];
  assert.ok(
    afterHandoff > 25,
    `pump crashed to the floor at the handoff (got ${afterHandoff}); expected it to hold near the seed`,
  );
});

test("a step advances to the next on its seconds exit", async () => {
  const { driver, calls } = await startInHold([
    { kind: "power", power: 44, exit: { seconds: 1 } },
    { kind: "power", power: 66 },
  ]);
  clock = 700;
  driver.onFrame(frame({ scaleWeightG: 1.6 })); // still step 0
  clock = 1600; // now-500 = 1100ms ≥ 1s → advance to step 1
  driver.onFrame(frame({ scaleWeightG: 1.7 }));
  await flush();
  assert.ok(
    calls.some((c) => c.method === "paddlePumppower" && c.arg === 66),
    "seconds exit did not advance to the next step",
  );
});

test("a step advances to the next on its pressure exit", async () => {
  const { driver, calls } = await startInHold([
    { kind: "power", power: 44, exit: { pressureBar: 6 } },
    { kind: "power", power: 70 },
  ]);
  clock = 700;
  driver.onFrame(frame({ scaleWeightG: 1.6, pumpPressureBar: 4 })); // below → step 0
  clock = 900;
  driver.onFrame(frame({ scaleWeightG: 1.7, pumpPressureBar: 6 })); // ≥ 6 → advance
  await flush();
  assert.ok(
    calls.some((c) => c.method === "paddlePumppower" && c.arg === 70),
    "pressure exit did not advance to the next step",
  );
});

test("a step advances to the next on its flow-decline exit", async () => {
  const { driver, calls } = await startInHold([
    { kind: "power", power: 44, exit: { flowGs: 0.5 } },
    { kind: "power", power: 33 },
  ]);
  clock = 700;
  driver.onFrame(frame({ scaleWeightG: 1.6, flowRateGPerS: 2.0 })); // above → step 0
  clock = 900;
  driver.onFrame(frame({ scaleWeightG: 1.7, flowRateGPerS: 0.4 })); // ≤ 0.5 → advance
  await flush();
  assert.ok(
    calls.some((c) => c.method === "paddlePumppower" && c.arg === 33),
    "flow-decline exit did not advance to the next step",
  );
});

test("a pressure step raises power when measured pressure is under setpoint", async () => {
  const { driver, calls } = await startInHold(
    [{ kind: "pressure", targetPressureBar: 9 }],
    { pumpPressureBar: 3 },
  );
  // Hold measured pressure well below the 9-bar setpoint → the PI loop must
  // drive the pump power up past the seed (52) over several ticks.
  for (let t = 700; t <= 6000; t += 200) {
    clock = t;
    driver.onFrame(frame({ scaleWeightG: 1.6, pumpPressureBar: 3 }));
  }
  await flush();
  const powers = calls
    .filter((c) => c.method === "paddlePumppower")
    .map((c) => c.arg as number);
  assert.ok(
    powers.some((p) => p > 52),
    `pressure PI never climbed above the seed (max ${Math.max(...powers)})`,
  );
});

test("start rejects a malformed step sequence without arming", async () => {
  const { driver } = makeDriver();
  clock = 0;
  await assert.rejects(
    () => driver.start({ steps: [{ kind: "power", power: -1 } as BrewStep] }, 36, ARM, frame()),
    /power between 0 and 100/,
  );
  assert.equal(driver.isActive(), false);

  // A power step is written to the pump open-loop, so >100 % is not a setting.
  await assert.rejects(
    () => driver.start({ steps: [{ kind: "power", power: 150 } as BrewStep] }, 36, ARM, frame()),
    /power between 0 and 100/,
  );
  assert.equal(driver.isActive(), false);

  await assert.rejects(
    () =>
      driver.start(
        {
          steps: [
            { kind: "power", power: 40 } as BrewStep, // non-last, no exit
            { kind: "power", power: 50 },
          ],
        },
        36,
        ARM,
        frame(),
      ),
    /needs an exit/,
  );
  assert.equal(driver.isActive(), false);

  await assert.rejects(
    () =>
      driver.start(
        { steps: [{ kind: "pressure", targetPressureBar: 0 } as BrewStep] },
        36,
        ARM,
        frame(),
      ),
    /positive targetPressureBar/,
  );
  assert.equal(driver.isActive(), false);
});

test("SB watch re-fires action 3 while steam keeps coming back on (throttled)", async () => {
  const { driver, calls } = makeDriver();
  clock = 0;
  await driver.start(undefined, 36, ARM, frame());
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 }));
  driver.requestStop();
  await flush();

  clock = 1000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 1 as never })); // enter SB watch

  // Steam keeps re-activating across the window (the MA 5→1 re-activation races
  // a single action 3). Each SB=2 frame ≥ SB_OFF_REFIRE_MS apart re-fires.
  clock = 5000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 2 as never }));
  clock = 9000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 2 as never }));
  clock = 13000;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 2 as never }));
  await flush();

  const offCount = calls.filter((c) => c.method === "machineControl" && c.arg === "3").length;
  assert.ok(offCount >= 3, `expected ≥3 re-fired action 3, got ${offCount}`);

  // Two SB=2 frames closer than the throttle → only one extra send.
  clock = 13500;
  driver.onFrame(frame({ machineStatus: 1, steamBoilerStatus: 2 as never }));
  await flush();
  const throttled = calls.filter((c) => c.method === "machineControl" && c.arg === "3").length;
  assert.equal(throttled, offCount, "throttle should suppress a send within SB_OFF_REFIRE_MS");
});

// ---------------------------------------------------------------------------
// K-2 — serialized single-writer actuator pipeline
// ---------------------------------------------------------------------------

test("K-2: a stop settles the in-flight loop write before the stop sequence", async () => {
  const { driver, calls, gate } = makeGatedDriver();
  clock = 0;
  await driver.start(undefined, 36, ARM, frame({ flowRateGPerS: 2.0 }));
  // The forced start write is done (gate was open). Now block the next loop write.
  gate.hold();
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5, flowRateGPerS: 0.0 })); // loop write → blocks
  await new Promise((r) => setImmediate(r));

  const loopWrites = calls.filter((c) => c.method === "paddlePumppower").length;
  assert.ok(loopWrites >= 2, "expected a loop pump write to be in flight");

  // Request the stop while the loop write is still blocked in flight.
  driver.requestStop();
  await new Promise((r) => setImmediate(r));
  // The stop sequence must NOT have started — it awaits the in-flight write.
  assert.ok(
    !calls.some((c) => c.method === "paddleStop"),
    "stop sequence started before the in-flight loop write settled",
  );

  gate.open();
  await flush();

  // The stop ran: no stale loop pump write follows the idle command, and the
  // final pump write is the stop's 0.
  assert.ok(calls.some((c) => c.method === "paddleStop"));
  const idxIdle = calls.findIndex((c) => c.method === "machineControl" && c.arg === "1");
  assert.ok(idxIdle >= 0, "normal exit idle command missing");
  const leaked = calls
    .slice(idxIdle)
    .some((c) => c.method === "paddlePumppower" && c.arg !== 0);
  assert.ok(!leaked, "a loop pump write leaked after the stop");
  const pumpCalls = calls.filter((c) => c.method === "paddlePumppower");
  assert.equal(pumpCalls[pumpCalls.length - 1].arg, 0, "last pump write must be the stop's 0");
});

test("jeder Pumpenbefehl wird mit Wartezeit und Schreibdauer protokolliert", async () => {
  const events: Array<Record<string, unknown>> = [];
  const log = {
    child: () => log,
    info: (o: Record<string, unknown>) => events.push(o),
    warn: () => {},
    error: () => {},
  };
  const { driver, gate } = makeGatedDriver({ log });
  clock = 0;
  await driver.start(
    { steps: [{ kind: "power", power: 44, exit: { seconds: 1 } }, { kind: "power", power: 60 }] },
    36, ARM, frame(),
  );
  gate.hold();
  clock = 1200;
  driver.onFrame(frame({ scaleWeightG: 1.5 })); // Stufe 2 → 60 % geht raus und haengt
  await new Promise((r) => setImmediate(r));
  clock = 1500;
  driver.onFrame(frame({ scaleWeightG: 1.6 })); // naechste Korrektur wartet dahinter
  clock = 2000;
  gate.open();
  await flush();

  const writes = events
    .filter((e) => e.event === "pump_write")
    .map((e) => [e.power, e.wait_ms, e.write_ms, e.elapsed_ms]);
  assert.deepEqual(writes, [
    [60, 0, 800, 1200], // sofort geschickt, Maschine brauchte 800 ms
    [60, 500, 0, 2000], // 500 ms hinter dem laufenden Schreibvorgang gewartet
  ]);
});

// ---------------------------------------------------------------------------
// K-1 — shutdown stop + startup interlock
// ---------------------------------------------------------------------------

test("K-1: shutdown during a drive issues a verified hard stop and blocks new starts", async () => {
  const { driver, calls } = makeDriver({ maStatus: 1 });
  clock = 0;
  await driver.start(undefined, 36, ARM, frame());
  clock = 500;
  driver.onFrame(frame({ scaleWeightG: 1.5 })); // → hold

  await driver.shutdown();

  assert.equal(driver.isActive(), false);
  // Verified hard stop = machine/control 0 + at least one /overview confirmation.
  assert.ok(calls.some((c) => c.method === "machineControl" && c.arg === "0"));
  assert.ok(calls.some((c) => c.method === "overview"));

  // New starts are refused after shutdown.
  await assert.rejects(
    () => driver.start(undefined, 36, ARM, frame()),
    /shutting down/,
  );
});

test("K-1: an orphaned MA=5 at startup is hard-stopped and the driver stays startable", async () => {
  const { driver, calls } = makeDriver({ maStatus: 1 });
  await driver.recoverOrphanedDrive();
  assert.ok(calls.some((c) => c.method === "machineControl" && c.arg === "0"));
  assert.ok(calls.some((c) => c.method === "overview"));

  // The pipeline is unlocked afterwards → a legitimate drive can still start.
  clock = 0;
  await driver.start(undefined, 36, ARM, frame());
  assert.equal(driver.isActive(), true);
});

// ---------------------------------------------------------------------------
// Ausstieg auf fallenden Druck (Meticulous' "Dynamic Bloom")
// ---------------------------------------------------------------------------

test("pressureBelowBar beendet die Stufe erst, wenn der Druck wieder abgebaut ist", async () => {
  const { driver, state } = makeDriver();
  clock = 0;
  const steps: BrewStep[] = [
    // Bloom: Pumpe aus, weiter sobald der Druck auf 2 bar zurueckgefallen ist.
    { kind: "power", power: 0, exit: { seconds: 30, pressureBelowBar: 2 } },
    { kind: "flow", targetFlowGs: 1.4, exit: {} },
  ];
  await driver.start({ maxBrewMs: 60_000, steps }, 36, ARM, frame({ pumpPressureBar: 6 }));

  // Druck faellt langsam: 6 → 3 bar. Noch kein Wechsel.
  for (const [t, p] of [[500, 6], [1000, 5], [1500, 4], [2000, 3]] as const) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: p, scaleWeightG: 0, flowRateGPerS: 0 }));
    await flush();
  }
  assert.equal(state.stages.length, 1, "über 2 bar darf nichts wechseln");

  // Unter die Schwelle → Wechsel in die Flow-Stufe.
  clock = 2500;
  driver.onFrame(frame({ pumpPressureBar: 1.8, scaleWeightG: 0, flowRateGPerS: 0 }));
  await flush();
  assert.equal(state.stages.length, 2, "unter 2 bar muss die Stufe enden");
  const left = state.stages[0]!;
  assert.equal(left.exitReason, "pressureBelowBar");
});

test("⚠ startet die Stufe schon unterhalb der Schwelle, feuert sie NICHT sofort", async () => {
  const { driver, state } = makeDriver();
  clock = 0;
  const steps: BrewStep[] = [
    // Druck steht bei 0 — ohne Schaerfung waere die Stufe im ersten Frame vorbei
    // und die Vorinfusion uebersprungen.
    { kind: "power", power: 40, exit: { seconds: 6, pressureBelowBar: 2 } },
    { kind: "flow", targetFlowGs: 1.4, exit: {} },
  ];
  await driver.start({ maxBrewMs: 60_000, steps }, 36, ARM, frame({ pumpPressureBar: 0 }));

  for (const [t, p] of [[500, 0], [1000, 0.5], [1500, 1.2], [2000, 1.9]] as const) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: p, scaleWeightG: 0, flowRateGPerS: 0 }));
    await flush();
  }
  assert.equal(state.stages.length, 1, "unterhalb gestartet: darf nicht feuern");

  // Erst ueber die Schwelle (scharf), dann zurueck darunter → jetzt wechselt es.
  clock = 2500;
  driver.onFrame(frame({ pumpPressureBar: 3.5, scaleWeightG: 0, flowRateGPerS: 0 }));
  await flush();
  assert.equal(state.stages.length, 1, "über der Schwelle wird nur scharf gemacht");
  clock = 3000;
  driver.onFrame(frame({ pumpPressureBar: 1.5, scaleWeightG: 0, flowRateGPerS: 0 }));
  await flush();
  assert.equal(state.stages.length, 2);
});

test("die Schärfung gilt je Stufe, nicht für den ganzen Bezug", async () => {
  const { driver, state } = makeDriver();
  clock = 0;
  const steps: BrewStep[] = [
    { kind: "power", power: 40, exit: { pressureBar: 4 } },
    // Zweite Stufe startet bei ~4 bar; faellt der Druck, ohne je ueber 6 zu
    // steigen, darf sie nicht enden — die Schaerfung von Stufe 0 zaehlt nicht.
    { kind: "power", power: 0, exit: { seconds: 20, pressureBelowBar: 6 } },
    { kind: "flow", targetFlowGs: 1.4, exit: {} },
  ];
  await driver.start({ maxBrewMs: 60_000, steps }, 36, ARM, frame({ pumpPressureBar: 0 }));
  clock = 500;
  driver.onFrame(frame({ pumpPressureBar: 4.5, scaleWeightG: 0, flowRateGPerS: 0 }));
  await flush();
  assert.equal(state.stages.length, 2, "Stufe 0 endet am Druckanstieg");

  clock = 1000;
  driver.onFrame(frame({ pumpPressureBar: 3, scaleWeightG: 0, flowRateGPerS: 0 }));
  await flush();
  assert.equal(state.stages.length, 2, "Stufe 1 war nie über 6 bar — kein Wechsel");
});

// ---------------------------------------------------------------------------
// Preinfusion ueber den rechnerischen Zulauf
// ---------------------------------------------------------------------------

const PREINFUSION_STEPS: BrewStep[] = [
  { kind: "preinfusion", exit: { seconds: 25, pressureBar: 4 } },
  { kind: "flow", targetFlowGs: 1.1, rampMs: 4000, exit: { seconds: 8 } },
  { kind: "flow", targetFlowGs: 0.8, exit: { weightG: 27 } },
];

const lastPump = (calls: ClientCall[]) =>
  calls.filter((c) => c.method === "paddlePumppower").at(-1)?.arg as number | undefined;

test("Preinfusion: beginnt bei 0 und folgt dann dem Druck — füllen, ab 1 bar sanfter sättigen", async () => {
  const { driver, calls } = makeDriver();
  clock = 0;
  await driver.start({ steps: PREINFUSION_STEPS }, 27, ARM, frame({ pumpPressureBar: 0, flowRateGPerS: 0 }));
  assert.deepEqual(calls[0], { method: "paddlePumppower", arg: 0 }, "sanfter Anlauf ab 0");
  clock = 4000;
  driver.onFrame(frame({ pumpPressureBar: 0.4, flowRateGPerS: 0, scaleWeightG: 0 }));
  await flush();
  assert.equal(lastPump(calls), Math.round(9.4 + 3.26 * 0.4 + 9.5 * 3.5)); // Füllen, 3,5 ml/s
  clock = 4400;
  driver.onFrame(frame({ pumpPressureBar: 2, flowRateGPerS: 0, scaleWeightG: 0 }));
  await flush();
  assert.equal(lastPump(calls), Math.round(9.4 + 3.26 * 2 + 9.5 * 2)); // Sättigen, 2 ml/s
});

test("Preinfusion: übergibt an die Flussstufe, sobald der Kaffee ankommt — als Leistungsstufe mit 'arrived' verbucht", async () => {
  const { driver, state } = makeDriver();
  clock = 0;
  await driver.start({ steps: PREINFUSION_STEPS }, 27, ARM, frame({ pumpPressureBar: 0, flowRateGPerS: 0 }));
  clock = 5000;
  driver.onFrame(frame({ pumpPressureBar: 2.5, flowRateGPerS: 0.5, scaleWeightG: 0.4 }));
  assert.equal(state.stages.length, 1, "0,5 g/s ist noch nicht angekommen (Ziel 0,99)");
  clock = 5400;
  driver.onFrame(frame({ pumpPressureBar: 2.8, flowRateGPerS: 1.0, scaleWeightG: 0.8 }));
  assert.equal(state.stages.length, 2);
  assert.equal(state.stages[0].exitReason, "arrived");
  const recorded = state.stages as unknown as { stepKind: string }[];
  assert.equal(recorded[0].stepKind, "power", "shot_stage kennt keine eigene Preinfusions-Art");
  assert.equal(recorded[1].stepKind, "flow");
});

test("Preinfusion: kommt kein Kaffee, beendet die Druckgrenze sie wie bisher", async () => {
  const { driver, state } = makeDriver();
  clock = 0;
  await driver.start({ steps: PREINFUSION_STEPS }, 27, ARM, frame({ pumpPressureBar: 0, flowRateGPerS: 0 }));
  clock = 9000;
  driver.onFrame(frame({ pumpPressureBar: 4.1, flowRateGPerS: 0.1, scaleWeightG: 0 }));
  assert.equal(state.stages.length, 2);
  assert.equal(state.stages[0].exitReason, "pressureBar");
});

// ---------------------------------------------------------------------------
// Gagne: Druckspitze, dann den Fluss des Pucks uebernehmen
// ---------------------------------------------------------------------------

test("Druckrampe startet beim gemessenen Druck: nach der Füllstufe nimmt die Regelung die Pumpe nicht zurück", async () => {
  // Frueher startete die Rampe beim letzten Druck-Sollwert (0): bei 4 bar im Puck las
  // die Regelung „viel zu viel Druck“ und nahm die Pumpe auf ~24 % zurueck.
  const { driver, calls } = makeDriver();
  clock = 0;
  await driver.start(
    { steps: [
      { kind: "power", power: 40, exit: { pressureBar: 4 } },
      { kind: "pressure", targetPressureBar: 9, rampMs: 4000, exit: { seconds: 8 } },
    ] },
    36, ARM, frame({ pumpPressureBar: 0, flowRateGPerS: 0, scaleWeightG: 0 }),
  );
  clock = 500;
  driver.onFrame(frame({ pumpPressureBar: 2, flowRateGPerS: 0, scaleWeightG: 0 }));
  clock = 900; // ≥ 4 bar → Druckstufe
  driver.onFrame(frame({ pumpPressureBar: 4, flowRateGPerS: 0.3, scaleWeightG: 0.2 }));
  for (let t = 1300; t <= 2500; t += 400) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: 4.2, flowRateGPerS: 0.6, scaleWeightG: 0.5 }));
  }
  await flush();
  const powers = calls.filter((c) => c.method === "paddlePumppower").map((c) => c.arg as number);
  assert.ok(Math.min(...powers) >= 38, `Pumpe an der Übergabe zurückgenommen: ${powers.join(", ")}`);
});

test("Fluss übernehmen: Ziel ist das Mittel der letzten Sekunde, verbucht als Ziel der Stufe, Übergabe stoßfrei", async () => {
  const { driver, calls, state } = makeDriver();
  clock = 0;
  await driver.start(
    { steps: [
      { kind: "pressure", targetPressureBar: 9, exit: { seconds: 2 } },
      { kind: "flow", targetFlowGs: 1.0, adoptFlow: true, maxPressureBar: 9.5, exit: { weightG: 36 } },
    ] },
    36, ARM, frame({ pumpPressureBar: 0, flowRateGPerS: 0, scaleWeightG: 0 }),
  );
  // Druckspitze: der Puck liefert 1,5 … 1,7 g/s (Druck = Sollwert, Pumpe bleibt beim Seed).
  for (const [t, f] of [[500, 1.2], [1000, 1.4], [1400, 1.5], [1800, 1.6]] as const) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: 9, flowRateGPerS: f, scaleWeightG: t / 400 }));
  }
  await flush();
  const before = calls.filter((c) => c.method === "paddlePumppower").map((c) => c.arg as number).at(-1)!;
  clock = 2200; // 2 s → Flussstufe; Mittel aus 1,5 / 1,6 / 1,7 = 1,6
  driver.onFrame(frame({ pumpPressureBar: 9, flowRateGPerS: 1.7, scaleWeightG: 5.5 }));
  clock = 2600;
  driver.onFrame(frame({ pumpPressureBar: 9, flowRateGPerS: 1.62, scaleWeightG: 6.2 }));
  await flush();
  const recorded = state.stages as unknown as { stepKind: string; targetFlowGs: number | null }[];
  assert.equal(recorded.length, 2);
  assert.deepEqual([recorded[1]!.stepKind, recorded[1]!.targetFlowGs], ["flow", 1.6]);
  const after = calls.filter((c) => c.method === "paddlePumppower").map((c) => c.arg as number).at(-1)!;
  assert.ok(Math.abs(after - before) <= 6, `Übergabe nicht stoßfrei: ${before} % → ${after} %`);
});

test("Fluss übernehmen ohne Fluss beim Eintritt: es gilt der erwartete Wert", async () => {
  const { driver, state } = makeDriver();
  clock = 0;
  await driver.start(
    { steps: [
      { kind: "power", power: 40, exit: { seconds: 1 } },
      { kind: "flow", targetFlowGs: 1.1, adoptFlow: true, exit: { weightG: 36 } },
    ] },
    36, ARM, frame({ pumpPressureBar: 0, flowRateGPerS: 0, scaleWeightG: 0 }),
  );
  for (const t of [500, 900, 1300]) {
    clock = t;
    driver.onFrame(frame({ pumpPressureBar: 1, flowRateGPerS: 0, scaleWeightG: 0 }));
  }
  const recorded = state.stages as unknown as { targetFlowGs: number | null }[];
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1]!.targetFlowGs, 1.1);
});

// ---------------------------------------------------------------------------
// Nachsenden — die Maschine bestaetigt einen Pumpenbefehl, uebernimmt ihn aber
// nicht (#271 25→20 %, #272 60→45 %). Nach 1,5 s geht derselbe Wert noch einmal
// raus, hoechstens 3-mal je Befehl, dann eine Warnung; nie im Stopp.
// ---------------------------------------------------------------------------

/** Maschine mit gemeldeter Leistung: die ersten `swallow` Pumpenbefehle werden
 *  bestaetigt, aber nicht uebernommen. */
function makeSwallowingDriver(swallow: number, reportedBefore = 45) {
  const machine = { reported: reportedBefore, swallow };
  const writes: { at: number; level: number }[] = [];
  const calls: ClientCall[] = [];
  const events: Array<Record<string, unknown>> = [];
  const log = {
    child: () => log,
    info: (o: Record<string, unknown>) => events.push(o),
    warn: (o: Record<string, unknown>) => events.push(o),
    error: (o: Record<string, unknown>) => events.push(o),
  };
  const client = {
    async paddlePumppower(level: number) {
      calls.push({ method: "paddlePumppower", arg: level });
      writes.push({ at: clock, level });
      if (machine.swallow > 0) machine.swallow--;
      else machine.reported = level;
    },
    async paddleStop() { calls.push({ method: "paddleStop" }); return 200; },
    async machineControl(action: string) { calls.push({ method: "machineControl", arg: action }); },
    async overview() { return { SB_STATUS: 1, MA_STATUS: 1 }; },
  };
  const { recorder } = makeRecorder();
  const driver = new FlowHoldDriver(client as never, recorder as never, settings as never, log as never);
  return { driver, machine, writes, calls, events };
}

/** Haelt eine Leistungsstufe bei 60 % und tickt alle 370 ms bis `untilMs`. */
async function runPowerHold(d: ReturnType<typeof makeSwallowingDriver>, untilMs: number, fromMs = 370) {
  for (let t = fromMs; t <= untilMs; t += 370) {
    clock = t;
    d.driver.onFrame(frame({ scaleWeightG: 1 + t / 2000, flowRateGPerS: 0.5, pumpPressureBar: 4, pumpPwm: d.machine.reported }));
    await flush();
  }
}

const HOLD_60: BrewStep[] = [{ kind: "power", power: 60, exit: { seconds: 60 } }, { kind: "power", power: 60 }];

test("Nachsenden: ein verschluckter Befehl geht nach 1,5 s mit demselben Wert noch einmal raus — dann folgt die Maschine", async () => {
  const d = makeSwallowingDriver(1);
  clock = 0;
  await d.driver.start({ steps: HOLD_60 }, 36, ARM, frame({ pumpPwm: 45 }));
  await runPowerHold(d, 8000);
  assert.deepEqual(d.writes.map((w) => w.level), [60, 60], "genau ein Nachsenden");
  assert.ok(d.writes[1]!.at >= 1500, `zu früh nachgesendet: ${d.writes[1]!.at} ms`);
  assert.equal(d.machine.reported, 60);
  assert.deepEqual(d.events.filter((e) => e.event === "pump_resend").map((e) => [e.power, e.attempt]), [[60, 1]]);
  assert.ok(!d.events.some((e) => e.event === "pump_resend_failed"));
});

test("Nachsenden: höchstens 3-mal je Befehl im Abstand ≥ 1,5 s, dann eine Warnung — kein Abbruch", async () => {
  const d = makeSwallowingDriver(99);
  clock = 0;
  await d.driver.start({ steps: HOLD_60 }, 36, ARM, frame({ pumpPwm: 45 }));
  await runPowerHold(d, 15000);
  assert.deepEqual(d.writes.map((w) => w.level), [60, 60, 60, 60], "Startbefehl + 3 Nachsendungen");
  for (let i = 1; i < d.writes.length; i++) {
    assert.ok(d.writes[i]!.at - d.writes[i - 1]!.at >= 1500, `Abstand ${d.writes[i]!.at - d.writes[i - 1]!.at} ms`);
  }
  assert.deepEqual(d.events.filter((e) => e.event === "pump_resend").map((e) => e.attempt), [1, 2, 3]);
  const failed = d.events.filter((e) => e.event === "pump_resend_failed");
  assert.equal(failed.length, 1, "genau eine Warnung");
  assert.deepEqual([failed[0]!.power, failed[0]!.reported], [60, 45]);
  assert.equal(d.driver.isActive(), true, "kein Abbruch");
  assert.ok(!d.calls.some((c) => c.method === "machineControl"));
});

test("Nachsenden: folgt die Rückmeldung dem Befehl, wird nie nachgesendet", async () => {
  const d = makeSwallowingDriver(0);
  clock = 0;
  await d.driver.start({ steps: HOLD_60 }, 36, ARM, frame({ pumpPwm: 45 }));
  await runPowerHold(d, 15000);
  assert.deepEqual(d.writes.map((w) => w.level), [60]);
  assert.ok(!d.events.some((e) => e.event === "pump_resend" || e.event === "pump_resend_failed"));
});

test("Nachsenden: eine Abweichung bis 2 Punkte gilt als übernommen", async () => {
  const d = makeSwallowingDriver(99, 58);
  clock = 0;
  await d.driver.start({ steps: HOLD_60 }, 36, ARM, frame({ pumpPwm: 58 }));
  await runPowerHold(d, 8000);
  assert.deepEqual(d.writes.map((w) => w.level), [60]);
});

test("Nachsenden: ein neuer Wert ist ein neuer Befehl und darf wieder nachgesendet werden", async () => {
  const d = makeSwallowingDriver(99);
  clock = 0;
  await d.driver.start(
    { steps: [{ kind: "power", power: 60, exit: { seconds: 8 } }, { kind: "power", power: 80, exit: { seconds: 60 } }, { kind: "power", power: 80 }] },
    36, ARM, frame({ pumpPwm: 45 }),
  );
  await runPowerHold(d, 18000);
  assert.deepEqual(d.writes.map((w) => w.level), [60, 60, 60, 60, 80, 80, 80, 80]);
  assert.equal(d.events.filter((e) => e.event === "pump_resend_failed").length, 2);
});

test("⚠ Nachsenden nie im oder nach dem Stopp — der letzte Pumpenbefehl bleibt die 0", async () => {
  const d = makeSwallowingDriver(99);
  clock = 0;
  await d.driver.start({ steps: HOLD_60 }, 36, ARM, frame({ pumpPwm: 45 }));
  await runPowerHold(d, 1110);
  d.driver.requestStop();
  await flush();
  // Die Maschine bleibt im Paddle-Modus und meldet weiter die falsche Leistung.
  await runPowerHold(d, 8000, 1480);
  const pump = d.calls.filter((c) => c.method === "paddlePumppower").map((c) => c.arg);
  assert.deepEqual(pump, [60, 0], "kein Nachsenden im Stopp");
  assert.ok(!d.events.some((e) => e.event === "pump_resend"));
});
