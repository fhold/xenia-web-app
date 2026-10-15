/**
 * Review H-4 — HTTP bodies are validated at runtime, not just cast.
 *
 * A TypeScript cast is erased at runtime. `{"on":"false"}` was a truthy string
 * and switched the machine ON; a setpoint of 1e999 became Infinity and was sent
 * to the machine as the string "Infinity". The point of these tests is not the
 * status code but the machine call: an invalid body must never reach it.
 *
 * Runner: node:test via tsx, through fastify.inject() — no socket, no machine.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// The setpoints route reads the boiler-coupling setting live from the DB, so the
// happy path needs a settings table. Throwaway DB — DB_PATH before initDb.
process.env.DB_PATH = path.join(os.tmpdir(), `bodyval-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { registerMachineRoutes } = await import("../src/routes/machine.js");
const { registerDriveRoutes } = await import("../src/routes/drive.js");
const { apiErrorHandler } = await import("../src/lib/api-error-handler.js");

initDb();
getDb().exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

after(() => {
  closeDb();
  fs.rmSync(process.env.DB_PATH!, { force: true });
});

interface Harness {
  app: FastifyInstance;
  /** Every machine/control action sent, in order. Empty = machine untouched. */
  controlCalls: string[];
  /** Every temperature set sent, in order. */
  tempCalls: Record<string, string>[];
}

function makeApp(): Harness {
  const controlCalls: string[] = [];
  const tempCalls: Record<string, string>[] = [];

  const client = {
    machineControl: async (action: string) => {
      controlCalls.push(action);
    },
    toggleSteamBoiler: async (on: boolean) => {
      controlCalls.push(on ? "steam_on" : "steam_off");
    },
    setTemperatures: async (params: Record<string, string>) => {
      tempCalls.push(params);
    },
    scale: async () => ({}),
  };
  const poller = {
    refreshSetpoints: async () => {},
    getLastSetpoints: () => null,
  };
  const resetStore = { previous: () => null, arm: () => {}, clear: () => {} };

  const app = Fastify({ logger: false });
  app.setErrorHandler(apiErrorHandler);
  registerMachineRoutes(
    app,
    client as never,
    () => null,
    poller as never,
    resetStore as never,
  );
  return { app, controlCalls, tempCalls };
}

async function post(app: FastifyInstance, url: string, payload: unknown) {
  return app.inject({ method: "POST", url, payload: payload as never });
}

// ---------------------------------------------------------------------------
// The bug: a truthy string switched the machine on
// ---------------------------------------------------------------------------

test('H-4: {"on":"false"} must not switch the machine ON', async () => {
  const { app, controlCalls } = makeApp();
  const res = await post(app, "/api/machine/power", { on: "false" });

  assert.equal(res.statusCode, 200, "the string is coerced, not rejected");
  assert.deepEqual(controlCalls, ["0"], 'must send OFF ("0"), never an on-action');
});

test("H-4: a body that cannot mean a boolean is rejected, machine untouched", async () => {
  for (const on of ["banana", 42, {}]) {
    const { app, controlCalls } = makeApp();
    const res = await post(app, "/api/machine/power", { on });
    assert.equal(res.statusCode, 400, `on=${JSON.stringify(on)} must be rejected`);
    assert.deepEqual(controlCalls, [], "machine must stay untouched");
  }
});

/**
 * AJV coerces the unambiguous cases ("false"/"true", 0/1, null). That is fine as
 * long as it can only ever fall to the SAFE side: nothing but an explicit truthy
 * value may switch the machine on. This is the invariant that H-4 was about.
 */
test("H-4: no coercible value switches the machine ON by accident", async () => {
  for (const on of ["false", 0, null]) {
    const { app, controlCalls } = makeApp();
    await post(app, "/api/machine/power", { on });
    assert.deepEqual(controlCalls, ["0"], `on=${JSON.stringify(on)} must mean OFF`);
  }
  for (const on of ["true", 1, true]) {
    const { app, controlCalls } = makeApp();
    await post(app, "/api/machine/power", { on });
    assert.notEqual(controlCalls[0], "0", `on=${JSON.stringify(on)} must mean ON`);
  }
});

test("H-4: a missing body field is rejected", async () => {
  const { app, controlCalls } = makeApp();
  const res = await post(app, "/api/machine/steam", {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(controlCalls, []);
});

test("H-4: a rejected body answers in the ApiResponse shape", async () => {
  const { app } = makeApp();
  const res = await post(app, "/api/machine/eco", { on: "banana" });
  const body = res.json() as { ok: boolean; error?: string };
  assert.equal(body.ok, false, "clients branch on `ok` — it must be present");
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

// ---------------------------------------------------------------------------
// Setpoints — no Infinity, no out-of-range temperature to the machine
// ---------------------------------------------------------------------------

test("H-4: an overflowing setpoint (1e999 → Infinity) never reaches the machine", async () => {
  const { app, tempCalls } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/machine/setpoints",
    headers: { "content-type": "application/json" },
    payload: '{"brewGroupTargetC":1e999}',
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(tempCalls, [], 'must not send "Infinity" as a temperature');
});

test("H-4: setpoints outside the physical range are rejected", async () => {
  for (const t of [0, 69, 111, -5]) {
    const { app, tempCalls } = makeApp();
    const res = await post(app, "/api/machine/setpoints", { brewGroupTargetC: t });
    assert.equal(res.statusCode, 400, `${t}°C must be rejected`);
    assert.deepEqual(tempCalls, []);
  }
});

test("H-4: a setpoint inside the range still goes through", async () => {
  const { app, tempCalls } = makeApp();
  const res = await post(app, "/api/machine/setpoints", { brewGroupTargetC: 93 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(tempCalls, [{ BG_SET_TEMP: "93.0" }]);
});

// ---------------------------------------------------------------------------
// Drive start — the body decides what the pump does, so it must be bounded
// ---------------------------------------------------------------------------

interface DriveHarness {
  app: FastifyInstance;
  /** Overrides handed to the driver, per start. Empty = no brew was started. */
  startCalls: unknown[];
}

function makeDriveApp(): DriveHarness {
  const startCalls: unknown[] = [];

  const driver = {
    isActive: () => false,
    start: async (overrides: unknown) => {
      startCalls.push(overrides);
      return { yieldTargetG: 36, targetFlowGs: 2 };
    },
  };
  const recorder = { isMaintenanceActive: false, activeShotId: null };
  const profileRepo = {
    findById: () => ({
      name: "Testprofil",
      scriptIdSingle: null,
      scriptIdDouble: 7,
      yieldTargetSingleG: 18,
      yieldTargetDoubleG: 36,
      brewSteps: null,
      brewStepsDouble: null,
    }),
  };
  const settingsRepo = { set: () => {} };
  const frame = { machineStatus: 1 };

  const app = Fastify({ logger: false });
  app.setErrorHandler(apiErrorHandler);
  registerDriveRoutes(
    app,
    driver as never,
    recorder as never,
    profileRepo as never,
    settingsRepo as never,
    () => frame as never,
    () => frame as never,
  );
  return { app, startCalls };
}

const START_URL = "/api/drive/consistent-flow/start";

/** JSON.stringify turns Infinity into null, so an overflow case must be sent raw. */
async function postRaw(app: FastifyInstance, json: string) {
  return app.inject({
    method: "POST",
    url: START_URL,
    headers: { "content-type": "application/json" },
    payload: json,
  });
}

test("H-4: a start body that cannot be read is rejected, no drive starts", async () => {
  const bodies: unknown[] = [
    { profileId: "kein Profil", shotSize: "double" },
    { profileId: 1, shotSize: "triple" },
    { profileId: 1 }, // shotSize missing — decides script + yield target
    { profileId: 1, shotSize: "double", notes: { evil: true } },
  ];
  for (const body of bodies) {
    const { app, startCalls } = makeDriveApp();
    const res = await post(app, START_URL, body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be rejected`);
    assert.deepEqual(startCalls, [], "no drive may start");
  }
});

test("H-4: an overflowing dose (1e999 → Infinity) is rejected, no drive starts", async () => {
  const { app, startCalls } = makeDriveApp();
  const res = await postRaw(app, '{"profileId":1,"shotSize":"double","doseG":1e999}');
  assert.equal(res.statusCode, 400);
  assert.deepEqual(startCalls, []);
});

test("H-4: an out-of-range tuning override never reaches the driver", async () => {
  for (const overrides of [
    { powerFloor: 500 }, // pump-% — 500 is not a pump setting
    { rampStartPower: -10 },
    { targetFlowGs: 0 }, // a zero setpoint holds the pump at the floor forever
    { emaAlpha: 3 },
  ]) {
    const { app, startCalls } = makeDriveApp();
    const res = await post(app, START_URL, { profileId: 1, shotSize: "double", overrides });
    assert.equal(res.statusCode, 400, `${JSON.stringify(overrides)} must be rejected`);
    assert.deepEqual(startCalls, [], "no drive may start");
  }
});

test("H-4: an overflowing maxBrewMs (the hard-stop ceiling) is rejected", async () => {
  const { app, startCalls } = makeDriveApp();
  const res = await postRaw(
    app,
    '{"profileId":1,"shotSize":"double","overrides":{"maxBrewMs":1e999}}',
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(startCalls, []);
});

test("H-4: an unknown override key is dropped instead of reaching the config", async () => {
  const { app, startCalls } = makeDriveApp();
  const res = await post(app, START_URL, {
    profileId: 1,
    shotSize: "double",
    overrides: { targetFlowGs: 2.2, powerCeil: 200 },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(startCalls, [{ targetFlowGs: 2.2 }], "powerCeil is not a client knob");
});

test("H-4: a valid start body still starts the drive", async () => {
  const { app, startCalls } = makeDriveApp();
  const res = await post(app, START_URL, {
    profileId: 1,
    shotSize: "double",
    beanId: 13,
    doseG: 17.5,
    yieldTargetOverrideG: 38,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(startCalls.length, 1);
});
