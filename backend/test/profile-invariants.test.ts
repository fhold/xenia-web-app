/**
 * Review M-1 — a stored profile must be startable.
 *
 * Create checked part of the invariants, update checked almost none: a partial
 * PUT could clear the last execution mode (no script, no steps), a flow profile
 * could be saved without a yield target, and a malformed step sequence was only
 * discovered by the driver — with the pump already running. Both routes now
 * check the same merged end state.
 *
 * The assertion that matters is `writes`: a rejected body must not reach the DB.
 *
 * Runner: node:test via tsx, through fastify.inject() — no DB, no machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerProfileRoutes } from "../src/routes/profiles.js";
import type { BrewProfile, Profile } from "../../shared/src/types.js";

const SCRIPT_ID = 3;

const flatFlow: BrewProfile = {
  version: 1,
  steps: [
    { kind: "power", power: 48, exit: { seconds: 6 } },
    { kind: "flow", targetFlowGs: 1.4, exit: { weightG: 28 } },
  ],
};

/** A stored flow profile, shaped like the live rows (1× sequence, 1× yield). */
const storedFlow: Profile = {
  id: 1,
  name: "Decaf Flow",
  description: null,
  scriptIdSingle: null,
  scriptIdDouble: null,
  yieldTargetSingleG: 28,
  yieldTargetDoubleG: null,
  isFavorite: false,
  favoriteOrder: null,
  notes: null,
  targetTempC: 93,
  brewSteps: flatFlow,
  brewStepsDouble: null,
  createdAt: "",
  updatedAt: "",
};

/** A stored script profile without any yield — the Flush/Rückspülen shape. */
const storedScript: Profile = {
  ...storedFlow,
  id: 2,
  name: "Flush",
  scriptIdSingle: SCRIPT_ID,
  yieldTargetSingleG: null,
  brewSteps: null,
  targetTempC: null,
};

interface Harness {
  app: FastifyInstance;
  /** Every repo write, in order. Empty = nothing was persisted. */
  writes: string[];
}

function makeApp(existing: Profile): Harness {
  const writes: string[] = [];
  const profileRepo = {
    listAll: () => [existing],
    findById: (id: number) => (id === existing.id ? existing : null),
    insert: () => {
      writes.push("insert");
      return existing.id;
    },
    update: () => writes.push("update"),
  };
  const scriptRepo = { findById: (id: number) => (id === SCRIPT_ID ? { id } : null) };

  const app = Fastify({ logger: false });
  registerProfileRoutes(app, profileRepo as never, scriptRepo as never, () => {});
  return { app, writes };
}

function create(app: FastifyInstance, body: unknown) {
  return app.inject({ method: "POST", url: "/api/profiles", payload: body as never });
}

function update(app: FastifyInstance, id: number, body: unknown) {
  return app.inject({ method: "PUT", url: `/api/profiles/${id}`, payload: body as never });
}

test("an update may not clear the last execution mode", async () => {
  // Script profile losing its script, flow profile losing its steps — both end
  // up as a profile that neither start path accepts.
  const cases: [Profile, Record<string, unknown>][] = [
    [storedScript, { scriptIdSingle: null }],
    [storedFlow, { brewSteps: null }],
  ];
  for (const [existing, patch] of cases) {
    const { app, writes } = makeApp(existing);
    const res = await update(app, existing.id, patch);
    assert.equal(res.statusCode, 400, `${existing.name}: ${JSON.stringify(patch)}`);
    assert.deepEqual(writes, [], "an unstartable profile must not be persisted");
  }
});

test("a step sequence needs a positive yield target — on create and on update", async () => {
  const { app: a, writes: wa } = makeApp(storedScript);
  const res = await create(a, { name: "Flow ohne Ziel", scriptIdSingle: null, brewSteps: flatFlow });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(wa, []);

  // Merged state: the patch clears the yield the stored profile still has.
  const { app: b, writes: wb } = makeApp(storedFlow);
  const res2 = await update(b, storedFlow.id, { yieldTargetSingleG: null });
  assert.equal(res2.statusCode, 400, "no yield target means BBW can never stop the shot");
  assert.deepEqual(wb, []);
});

test("a malformed step sequence is refused at save time, not at the pump", async () => {
  const bad: [string, unknown][] = [
    ["power out of range", { version: 1, steps: [{ kind: "power", power: 150, exit: { seconds: 5 } }] }],
    ["non-last step without exit", {
      version: 1,
      steps: [
        { kind: "flow", targetFlowGs: 1.4, exit: {} },
        { kind: "flow", targetFlowGs: 1, exit: { weightG: 28 } },
      ],
    }],
    ["exit that can never fire", {
      version: 1,
      steps: [
        { kind: "power", power: 30, exit: { seconds: 0 } },
        { kind: "flow", targetFlowGs: 1.4, exit: { weightG: 28 } },
      ],
    }],
    ["unknown kind", { version: 1, steps: [{ kind: "banana", exit: { seconds: 5 } }] }],
    ["steps not an array", { version: 1, steps: "flat" }],
    ["wrong version", { version: 2, steps: [] }],
  ];
  for (const [label, brewSteps] of bad) {
    const { app, writes } = makeApp(storedFlow);
    const res = await create(app, {
      name: "Kaputt",
      scriptIdSingle: null,
      yieldTargetSingleG: 28,
      brewSteps,
    });
    assert.equal(res.statusCode, 400, label);
    assert.deepEqual(writes, [], label);
  }
});

test("the 2× slot is held to the same rule as the 1× slot", async () => {
  const { app, writes } = makeApp(storedFlow);
  const res = await update(app, storedFlow.id, { brewStepsDouble: flatFlow });
  assert.equal(res.statusCode, 400, "a 2× sequence without yieldTargetDoubleG");
  assert.deepEqual(writes, []);

  const { app: b, writes: wb } = makeApp(storedFlow);
  const ok = await update(b, storedFlow.id, { brewStepsDouble: flatFlow, yieldTargetDoubleG: 40 });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(wb, ["update"]);
});

test("the profiles in the live DB stay editable", async () => {
  // Counter-check against locking existing rows out: a flow profile with a 1×
  // sequence and no 2× yield, and a script profile with no yield at all, must
  // both survive an unrelated edit.
  for (const existing of [storedFlow, storedScript]) {
    const { app, writes } = makeApp(existing);
    const res = await update(app, existing.id, { notes: "Mahlgrad 4.2" });
    assert.equal(res.statusCode, 200, existing.name);
    assert.deepEqual(writes, ["update"], existing.name);
  }
});

test("a script profile still needs an existing script, a flow profile does not", async () => {
  const { app, writes } = makeApp(storedScript);
  const missing = await create(app, { name: "Neu", scriptIdSingle: 999 });
  assert.equal(missing.statusCode, 400);

  const noMode = await create(app, { name: "Neu", scriptIdSingle: null });
  assert.equal(noMode.statusCode, 400, "neither script nor steps");
  assert.deepEqual(writes, []);

  const good = await create(app, { name: "Neu", scriptIdSingle: SCRIPT_ID });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(writes, ["insert"]);
});
