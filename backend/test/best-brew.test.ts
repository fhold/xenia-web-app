/**
 * BB-a — Best Brew repository tests. Runner: node:test (tsx --test).
 *
 * Uses a throwaway temp DB (DB_PATH set before initDb) with foreign_keys = ON,
 * so the FK cascades (best_brew.coffee_id / .shot_id ON DELETE CASCADE) run
 * exactly as in production. The DDL below mirrors the production post-migration
 * shape for the columns/relationships this feature touches (verified via PRAGMA
 * against /var/lib/xenia): bean.coffee_id RESTRICT, shot.bean_id SET NULL,
 * shot_sample.shot_id CASCADE, plus the real best_brew table. We don't call
 * applySchema() because its historical migration chain assumes an evolving live
 * DB, not a from-scratch build.
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DB_PATH = path.join(os.tmpdir(), `bb-test-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { SqliteBestBrewRepo } = await import("../src/db/best-brew-repo.js");

const repo = new SqliteBestBrewRepo();

function createSchema(): void {
  getDb().exec(`
    CREATE TABLE profile (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);

    CREATE TABLE coffee (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      favourite  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE bean (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      coffee_id  INTEGER NOT NULL REFERENCES coffee(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE shot (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id     INTEGER REFERENCES profile(id) ON DELETE SET NULL,
      script_id      INTEGER NOT NULL,
      shot_size      TEXT NOT NULL,
      category       TEXT NOT NULL CHECK(category IN ('brew','maintenance')),
      started_at     INTEGER NOT NULL,
      bean_id        INTEGER REFERENCES bean(id) ON DELETE SET NULL,
      dose_g         REAL,
      yield_actual_g REAL,
      profile_name   TEXT
    );

    CREATE TABLE shot_sample (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      shot_id      INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
      elapsed_ms   INTEGER NOT NULL,
      pressure_bar REAL,
      temp_bg_c    REAL,
      phase        TEXT NOT NULL DEFAULT 'brewing'
    );

    CREATE TABLE best_brew (
      coffee_id  INTEGER PRIMARY KEY REFERENCES coffee(id) ON DELETE CASCADE,
      shot_id    INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
  `);
}

// --- seed helpers -----------------------------------------------------------

function insCoffee(name: string): number {
  const now = Date.now();
  const r = getDb()
    .prepare("INSERT INTO coffee (name, favourite, created_at, updated_at) VALUES (?, 0, ?, ?)")
    .run(name, now, now) as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

function insBean(coffeeId: number): number {
  const now = Date.now();
  const r = getDb()
    .prepare("INSERT INTO bean (coffee_id, created_at, updated_at) VALUES (?, ?, ?)")
    .run(coffeeId, now, now) as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

function insShot(opts: {
  beanId: number | null;
  category?: "brew" | "maintenance";
  doseG?: number | null;
  yieldActualG?: number | null;
  profileName?: string | null;
}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO shot
         (script_id, shot_size, category, started_at, bean_id, dose_g, yield_actual_g, profile_name)
       VALUES (1, 'double', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.category ?? "brew",
      Date.now(),
      opts.beanId,
      opts.doseG ?? null,
      opts.yieldActualG ?? null,
      opts.profileName ?? null,
    ) as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

function insSample(
  shotId: number,
  elapsedMs: number,
  pressureBar: number | null,
  tempBgC: number | null,
  phase: "preinfusion" | "extraction" | "post_brew",
): void {
  getDb()
    .prepare(
      "INSERT INTO shot_sample (shot_id, elapsed_ms, pressure_bar, temp_bg_c, phase) VALUES (?, ?, ?, ?, ?)",
    )
    .run(shotId, elapsedMs, pressureBar, tempBgC, phase);
}

before(() => {
  initDb();
  createSchema();
});

beforeEach(() => {
  // Clean slate per test — explicit order (FKs would cascade, but be explicit).
  const db = getDb();
  db.exec("DELETE FROM best_brew");
  db.exec("DELETE FROM shot_sample");
  db.exec("DELETE FROM shot");
  db.exec("DELETE FROM bean");
  db.exec("DELETE FROM coffee");
});

after(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
  }
});

// --- tests ------------------------------------------------------------------

test("setByShot upserts — a second flag of the same Sorte replaces the first", () => {
  const coffee = insCoffee("Ethiopia");
  const bean = insBean(coffee);
  const shot1 = insShot({ beanId: bean });
  const shot2 = insShot({ beanId: bean });

  assert.deepEqual(repo.setByShot(shot1), { ok: true, coffeeId: coffee });
  assert.deepEqual(repo.setByShot(shot2), { ok: true, coffeeId: coffee });

  const rows = getDb().prepare("SELECT coffee_id, shot_id FROM best_brew").all() as {
    coffee_id: number;
    shot_id: number;
  }[];
  assert.equal(rows.length, 1, "exactly one reference per Sorte");
  assert.equal(rows[0].coffee_id, coffee);
  assert.equal(rows[0].shot_id, shot2);
});

test("Sorte is derived from the shot via bean → coffee", () => {
  const coffee = insCoffee("Kenya");
  const bean = insBean(coffee);
  const shot = insShot({ beanId: bean });

  repo.setByShot(shot);
  const summary = repo.getSummary(coffee);
  assert.ok(summary);
  assert.equal(summary.shotId, shot);
});

test("unsetByShot removes the reference", () => {
  const coffee = insCoffee("Colombia");
  const shot = insShot({ beanId: insBean(coffee) });
  repo.setByShot(shot);

  assert.equal(repo.unsetByShot(shot), true);
  assert.equal(repo.getSummary(coffee), null);
  assert.equal(repo.unsetByShot(shot), false, "second unset is a no-op");
});

test("category guard — a maintenance shot cannot be flagged", () => {
  const coffee = insCoffee("Brazil");
  const shot = insShot({ beanId: insBean(coffee), category: "maintenance" });

  const res = repo.setByShot(shot);
  assert.equal(res.ok, false);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM best_brew").get().n, 0);
});

test("a shot with no resolvable Sorte (no bean) is rejected", () => {
  const shot = insShot({ beanId: null });
  const res = repo.setByShot(shot);
  assert.equal(res.ok, false);
});

test("deleting the referenced shot removes the pointer but leaves other shots/history intact", () => {
  const coffee = insCoffee("Guatemala");
  const bean = insBean(coffee);
  const refShot = insShot({ beanId: bean });
  const otherShot = insShot({ beanId: bean });
  repo.setByShot(refShot);

  getDb().prepare("DELETE FROM shot WHERE id = ?").run(refShot);

  assert.equal(repo.getSummary(coffee), null, "pointer cascaded away");
  const remaining = (getDb().prepare("SELECT id FROM shot ORDER BY id").all() as { id: number }[])
    .map((r) => r.id);
  assert.deepEqual(remaining, [otherShot], "unrelated shot history untouched");
});

test("deleting the Sorte removes the pointer (coffee → best_brew cascade)", () => {
  const coffee = insCoffee("Panama");
  const bean = insBean(coffee);
  const shot = insShot({ beanId: bean });
  repo.setByShot(shot);

  // A coffee can only be deleted once its roastings are gone (bean.coffee_id is
  // ON DELETE RESTRICT). Removing the bean sets shot.bean_id → NULL but leaves
  // the shot (and thus the pointer) alive; deleting the coffee then cascades.
  getDb().prepare("DELETE FROM bean WHERE id = ?").run(bean);
  assert.ok(repo.getSummary(coffee), "pointer survives bean deletion");

  getDb().prepare("DELETE FROM coffee WHERE id = ?").run(coffee);
  assert.equal(repo.getSummary(coffee), null, "pointer cascaded on Sorte deletion");
  assert.ok(getDb().prepare("SELECT 1 FROM shot WHERE id = ?").get(shot), "shot itself survives");
});

test("getSummary computes values over non-post_brew frames; null without a reference", () => {
  const coffee = insCoffee("Sumatra");
  const bean = insBean(coffee);
  const shot = insShot({ beanId: bean, doseG: 18, yieldActualG: 36, profileName: "Turbo" });
  insSample(shot, 2000, 4.0, 90, "preinfusion");
  insSample(shot, 26000, 9.0, 94, "extraction"); // peak pressure, last real frame
  insSample(shot, 40000, 1.0, 20, "post_brew");  // must be excluded everywhere

  assert.equal(repo.getSummary(coffee), null, "no reference yet");

  repo.setByShot(shot);
  const s = repo.getSummary(coffee);
  assert.ok(s);
  assert.equal(s.shotId, shot);
  assert.equal(s.brewTimeS, 26, "brew time = last non-post_brew sample");
  assert.equal(s.peakPressureBar, 9.0, "peak over non-post_brew only");
  assert.equal(s.avgTempC, 92, "avg temp over non-post_brew only ((90+94)/2)");
  assert.equal(s.ratio, 2, "36 / 18");
  assert.equal(s.profileName, "Turbo");
});

test("isBestBrewShot reflects the current reference", () => {
  const coffee = insCoffee("Yemen");
  const shot = insShot({ beanId: insBean(coffee) });
  assert.equal(repo.isBestBrewShot(shot), false);
  repo.setByShot(shot);
  assert.equal(repo.isBestBrewShot(shot), true);
});
