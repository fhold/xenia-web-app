/**
 * Ghost curves — the resampling and the shot selection behind them.
 *
 * Two halves:
 *   1. resampleToGrid() — pure, no DB. The interesting part is what it does
 *      OUTSIDE a shot's own range: a 20 s ghost must stop at 20 s, not run
 *      flat to the right edge and claim it was still brewing.
 *   2. listGhostCandidates() — which past shots are allowed into the cloud.
 *      A throwaway temp DB (explicit DDL,
 *      not applySchema(), whose migration chain assumes an evolving live DB).
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  GHOST_GRID_MS,
  GHOST_MAX_POINTS,
  gridPointsFor,
  resampleToGrid,
} from "../../shared/src/shot-ghosts.js";

process.env.DB_PATH = path.join(os.tmpdir(), `ghost-test-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { SqliteShotRepo } = await import("../src/db/shot-repo.js");

const repo = new SqliteShotRepo();

// ---------------------------------------------------------------------------
// 1. Resampling
// ---------------------------------------------------------------------------

test("resampleToGrid: interpolates linearly onto the 500 ms grid", () => {
  const s = resampleToGrid(
    [
      { elapsedMs: 0, pressureBar: 0, flowMlS: 0 },
      { elapsedMs: 1000, pressureBar: 10, flowMlS: 4 },
    ],
    3,
  );
  assert.deepEqual(s.pressure, [0, 5, 10]);
  assert.deepEqual(s.flow, [0, 2, 4]);
});

test("resampleToGrid: a short shot stops instead of running flat to the edge", () => {
  const s = resampleToGrid(
    [
      { elapsedMs: 0, pressureBar: 2, flowMlS: 1 },
      { elapsedMs: 1000, pressureBar: 6, flowMlS: 3 },
    ],
    6, // grid runs to 2500 ms, the shot ends at 1000
  );
  assert.deepEqual(s.pressure, [2, 4, 6, null, null, null]);
  assert.deepEqual(s.flow, [1, 2, 3, null, null, null]);
});

test("resampleToGrid: a missing scale reading does not punch a hole into pressure", () => {
  const s = resampleToGrid(
    [
      { elapsedMs: 0, pressureBar: 0, flowMlS: 0 },
      { elapsedMs: 500, pressureBar: 4, flowMlS: null },
      { elapsedMs: 1000, pressureBar: 8, flowMlS: 4 },
    ],
    3,
  );
  assert.deepEqual(s.pressure, [0, 4, 8]);
  // Flow interpolates across the gap from its own neighbours.
  assert.deepEqual(s.flow, [0, 2, 4]);
});

test("resampleToGrid: no samples at all yields an all-null series, not a crash", () => {
  const s = resampleToGrid([], 3);
  assert.deepEqual(s.pressure, [null, null, null]);
  assert.deepEqual(s.flow, [null, null, null]);
});

test("gridPointsFor: covers the shot and is capped", () => {
  assert.equal(gridPointsFor(0), 0);
  assert.equal(gridPointsFor(1000), 3); // 0, 500, 1000
  assert.equal(gridPointsFor(30_000), 61);
  assert.equal(gridPointsFor(10 * 60_000), GHOST_MAX_POINTS);
  assert.equal(GHOST_GRID_MS, 500);
});

// ---------------------------------------------------------------------------
// 2. Which shots become ghosts
// ---------------------------------------------------------------------------

function createSchema(): void {
  getDb().exec(`
    CREATE TABLE shot (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER,
      category      TEXT NOT NULL CHECK(category IN ('brew','maintenance')),
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      brew_def_hash TEXT,
      scale_lost    INTEGER,
      shot_size     TEXT NOT NULL DEFAULT 'single',
      basket_id     INTEGER
    );

    CREATE TABLE shot_sample (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      shot_id      INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
      elapsed_ms   INTEGER NOT NULL,
      pressure_bar REAL,
      flow_ml_s    REAL
    );
  `);
}

/** Insert a shot plus `nSamples` evenly spaced samples. Returns its id. */
function addShot(o: {
  startedAt: number;
  profileId?: number | null;
  hash?: string | null;
  category?: string;
  ended?: boolean;
  scaleLost?: boolean;
  nSamples?: number;
  size?: string;
  basket?: number | null;
}): number {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO shot (profile_id, category, started_at, ended_at, brew_def_hash, scale_lost, shot_size, basket_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.profileId ?? 1,
      o.category ?? "brew",
      o.startedAt,
      o.ended === false ? null : o.startedAt + 30_000,
      o.hash ?? null,
      o.scaleLost ? 1 : 0,
      o.size ?? "single",
      o.basket ?? null,
    );
  const id = Number(info.lastInsertRowid);
  const n = o.nSamples ?? 20;
  const ins = db.prepare(
    "INSERT INTO shot_sample (shot_id, elapsed_ms, pressure_bar, flow_ml_s) VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < n; i++) ins.run(id, i * 400, 6 + i * 0.01, 2 + i * 0.01);
  return id;
}

const q = (over: Partial<Parameters<typeof repo.listGhostCandidates>[0]> = {}) =>
  repo.listGhostCandidates({
    excludeShotId: -1,
    basis: "profile",
    key: 1,
    minSamples: 10,
    limit: 20,
    shotSize: "single",
    ...over,
  });

before(() => {
  initDb(process.env.DB_PATH!);
  createSchema();
});

beforeEach(() => {
  getDb().exec("DELETE FROM shot_sample; DELETE FROM shot;");
});

after(() => {
  closeDb();
  fs.rmSync(process.env.DB_PATH!, { force: true });
  fs.rmSync(`${process.env.DB_PATH!}-wal`, { force: true });
  fs.rmSync(`${process.env.DB_PATH!}-shm`, { force: true });
});

test("the brew definition is the sharper group: only shots with the same hash", () => {
  const a = addShot({ startedAt: 1000, hash: "aaa" });
  const b = addShot({ startedAt: 2000, hash: "aaa" });
  addShot({ startedAt: 3000, hash: "bbb" }); // same profile, different definition
  assert.deepEqual(q({ basis: "brewdef", key: "aaa" }), [b, a]);
});

test("a shot is never its own ghost", () => {
  const a = addShot({ startedAt: 1000 });
  const b = addShot({ startedAt: 2000 });
  assert.deepEqual(q({ excludeShotId: b }), [a]);
});

test("a shot that lost the scale is left out — its flow is zeroed on purpose", () => {
  const good = addShot({ startedAt: 1000 });
  addShot({ startedAt: 2000, scaleLost: true });
  assert.deepEqual(q(), [good]);
});

test("maintenance runs and unfinished shots are not ghosts", () => {
  const good = addShot({ startedAt: 1000 });
  addShot({ startedAt: 2000, category: "maintenance" });
  addShot({ startedAt: 3000, ended: false });
  assert.deepEqual(q(), [good]);
});

test("stubs below minSamples are noise, not ghosts", () => {
  const good = addShot({ startedAt: 1000, nSamples: 20 });
  addShot({ startedAt: 2000, nSamples: 3 });
  assert.deepEqual(q(), [good]);
});

test("newest first, and the limit is respected", () => {
  const ids = [1000, 2000, 3000, 4000].map((t) => addShot({ startedAt: t }));
  assert.deepEqual(q({ limit: 2 }), [ids[3], ids[2]]);
});

test("1x and 2x never share a cloud, not even under the same hash", () => {
  // A profile whose 2x-slot is not configured reuses the 1x sequence — same
  // content, same hash, but a different yield target. Size decides too.
  const single = addShot({ startedAt: 1000, hash: "aaa", size: "single" });
  addShot({ startedAt: 2000, hash: "aaa", size: "double" });
  assert.deepEqual(q({ basis: "brewdef", key: "aaa", shotSize: "single" }), [single]);
});

test("the profile fallback separates the sizes as well", () => {
  const single = addShot({ startedAt: 1000, size: "single" });
  addShot({ startedAt: 2000, size: "double" });
  assert.deepEqual(q(), [single]);
});

test("samples come back grouped per shot and in time order", () => {
  const a = addShot({ startedAt: 1000, nSamples: 12 });
  const b = addShot({ startedAt: 2000, nSamples: 15 });
  const map = repo.listGhostSamples([a, b]);
  assert.equal(map.get(a)!.length, 12);
  assert.equal(map.get(b)!.length, 15);
  const ts = map.get(b)!.map((s) => s.elapsedMs);
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y));
});

test("no ids in, no query out", () => {
  assert.equal(repo.listGhostSamples([]).size, 0);
});

test("hat der Bezug ein Sieb, teilen nur Bezüge mit demselben Sieb die Wolke — zwei 1er-Siebe mischen sich nicht", () => {
  const ims = addShot({ startedAt: 9_000_000, basket: 1 });
  addShot({ startedAt: 9_001_000, basket: 4 });          // anderes 1er-Sieb, gleiche Groesse
  const imsAgain = addShot({ startedAt: 9_002_000, basket: 1 });
  const ids = q({ basketId: 1 });
  assert.ok(ids.includes(ims) && ids.includes(imsAgain));
  assert.equal(ids.some((id) => (getDb().prepare("SELECT basket_id FROM shot WHERE id = ?").get(id) as { basket_id: number | null }).basket_id !== 1), false);
  // ohne Sieb (Altbezug) wie bisher nach 1×/2×
  assert.ok(q().includes(ims));
});
