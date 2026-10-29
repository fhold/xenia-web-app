/**
 * One Stop button, two brew engines.
 *
 * POST /api/shots/:id/stop always sent scripts/stop. That ends a machine script,
 * but a flow-hold drive is app-driven: the driver keeps commanding the pump until
 * BBW, the watchdog or the max-brew ceiling fires. The route therefore asks the
 * driver first — only it knows its exit sequence (paddle/stop → pumppower=0 →
 * action "1" → SB cleanup).
 *
 * Runner: node:test via tsx, through fastify.inject() — no socket, no machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerShotRoutes } from "../src/routes/shots.js";

const ACTIVE_SHOT_ID = 7;

interface Harness {
  app: FastifyInstance;
  /** scripts/stop calls — must stay empty while a drive is running. */
  scriptStops: number[];
  /** driver.requestStop() calls. */
  driveStops: number[];
  /** Shot ids marked as a manual stop, in order. */
  manualMarks: number[];
}

function makeApp(opts: { driveActive: boolean; scriptStopFails?: boolean }): Harness {
  const scriptStops: number[] = [];
  const driveStops: number[] = [];
  const manualMarks: number[] = [];

  const client = {
    scriptStop: async () => {
      scriptStops.push(Date.now());
      if (opts.scriptStopFails) throw new Error("machine unreachable");
    },
  };
  const recorder = {
    activeShotId: ACTIVE_SHOT_ID,
    markManualStop: (id: number) => manualMarks.push(id),
    clearManualStop: (id: number) => {
      const i = manualMarks.indexOf(id);
      if (i >= 0) manualMarks.splice(i, 1);
    },
  };
  const driver = {
    isActive: () => opts.driveActive,
    requestStop: () => driveStops.push(Date.now()),
  };

  const app = Fastify({ logger: false });
  registerShotRoutes(
    app,
    client as never,
    {} as never,
    recorder as never,
    {} as never,
    {} as never,
    {} as never,
    () => {},
    driver as never,
  );
  return { app, scriptStops, driveStops, manualMarks };
}

function stop(app: FastifyInstance, id: number) {
  return app.inject({ method: "POST", url: `/api/shots/${id}/stop` });
}

test("a running flow-hold drive is stopped by the driver, not by scripts/stop", async () => {
  const { app, scriptStops, driveStops } = makeApp({ driveActive: true });
  const res = await stop(app, ACTIVE_SHOT_ID);

  assert.equal(res.statusCode, 200);
  assert.equal(driveStops.length, 1, "the driver must be told to exit");
  assert.deepEqual(scriptStops, [], "scripts/stop does not end a drive — the pump would keep running");
});

test("without a drive the script stop path is unchanged", async () => {
  const { app, scriptStops, driveStops, manualMarks } = makeApp({ driveActive: false });
  const res = await stop(app, ACTIVE_SHOT_ID);

  assert.equal(res.statusCode, 200);
  assert.equal(scriptStops.length, 1);
  assert.deepEqual(driveStops, []);
  assert.deepEqual(manualMarks, [ACTIVE_SHOT_ID], "the shot is booked as a manual stop");
});

test("a failed script stop still takes its manual mark back (H-3)", async () => {
  const { app, manualMarks } = makeApp({ driveActive: false, scriptStopFails: true });
  const res = await stop(app, ACTIVE_SHOT_ID);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(manualMarks, [], "a stop the machine never took must not book 'manual'");
});

test("a shot that is not the active one is refused in both modes", async () => {
  for (const driveActive of [true, false]) {
    const { app, scriptStops, driveStops } = makeApp({ driveActive });
    const res = await stop(app, ACTIVE_SHOT_ID + 1);
    assert.equal(res.statusCode, 409, `driveActive=${driveActive}`);
    assert.deepEqual(scriptStops, []);
    assert.deepEqual(driveStops, [], "no engine may be stopped for a foreign shot id");
  }
});
