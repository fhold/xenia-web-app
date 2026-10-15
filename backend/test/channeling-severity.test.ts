/**
 * Channeling-Staerke: kein / leicht / stark statt nur ja/nein.
 *
 * Anlass: die Ja/Nein-Marke war bei 64 % der bewerteten Bezuege gesetzt und
 * trennte nichts mehr — eine Mahlgrad-Reihe mit „besser, aber immer noch
 * Channeling" war damit unsichtbar.
 *
 * Die shot-Tabelle ist 1:1 der Produktionsstand VOR dieser Migration (per
 * `.schema shot` gegen /var/lib/xenia abgelesen, 2026-09-26); darauf laeuft die
 * echte Migration — so ist der Uebergang vom heutigen Live-Stand geprueft, nicht
 * nur ein frischer Aufbau (den deckt schema-fresh.test.ts ab).
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DB_PATH = path.join(os.tmpdir(), `chan-test-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { migrateChannelingSeverity } = await import("../src/db/schema.js");
const { SqliteShotRepo } = await import("../src/db/shot-repo.js");

const repo = new SqliteShotRepo();

function createSchema(): void {
  getDb().exec(`
    CREATE TABLE xenia_script (id INTEGER PRIMARY KEY);
    CREATE TABLE profile (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE coffee (id INTEGER PRIMARY KEY, name TEXT, roaster TEXT, brew_type TEXT);
    CREATE TABLE bean (id INTEGER PRIMARY KEY, coffee_id INTEGER REFERENCES coffee(id));
    CREATE TABLE grinder (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE best_brew (coffee_id INTEGER PRIMARY KEY, shot_id INTEGER, created_at INTEGER);
    CREATE TABLE shot (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id     INTEGER REFERENCES profile(id) ON DELETE SET NULL,
        script_id      INTEGER REFERENCES xenia_script(id),
        shot_size      TEXT    NOT NULL CHECK(shot_size IN ('single','double')),
        category       TEXT    NOT NULL CHECK(category IN ('brew','maintenance')),
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        stop_mode      TEXT    CHECK(stop_mode IN ('cmd27','app','app_failed','manual','script_end','watchdog','flowhold','flowhold_watchdog')),
        yield_target_g REAL,
        yield_actual_g REAL,
        has_cmd27      INTEGER NOT NULL DEFAULT 0,
        cmd27_value    REAL,
        notes          TEXT,
        bean_id        INTEGER REFERENCES bean(id) ON DELETE SET NULL,
        grinder_id     INTEGER REFERENCES grinder(id) ON DELETE SET NULL,
        grind_setting  REAL,
        grinder_rpm    INTEGER,
        dose_g         REAL,
        tds_percent    REAL,
        rating         INTEGER CHECK(rating BETWEEN 1 AND 5),
        stop_trigger_weight_g   REAL,
        flow_at_trigger_g_per_s REAL,
        residual_lag_s_used     REAL,
        bbw_left_brewing_lag_ms INTEGER,
        post_brew_duration_ms   INTEGER,
        post_brew_stop_reason   TEXT CHECK(post_brew_stop_reason IN ('stable','timeout')),
        taste_tags              TEXT,
        grind_note              TEXT CHECK(grind_note IN ('finer','ok','coarser')),
        acidity                 INTEGER CHECK(acidity BETWEEN 1 AND 5),
        bitterness              INTEGER CHECK(bitterness BETWEEN 1 AND 5),
        extraction_under        INTEGER NOT NULL DEFAULT 0,
        extraction_over         INTEGER NOT NULL DEFAULT 0,
        profile_name            TEXT,
        profile_set_temp_c      REAL,
        channeling              INTEGER NOT NULL DEFAULT 0,
        scale_frozen            INTEGER NOT NULL DEFAULT 0
      , brew_steps TEXT, brew_def_hash TEXT, scale_lost INTEGER NOT NULL DEFAULT 0, bean_label TEXT);
  `);
}

before(() => { initDb(); createSchema(); migrateChannelingSeverity(getDb()); });
beforeEach(() => { getDb().exec("DELETE FROM shot;"); });
after(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
});

function shot(channeling = 0): number {
  const info = getDb()
    .prepare("INSERT INTO shot (started_at, category, shot_size, channeling) VALUES (0, 'brew', 'single', ?)")
    .run(channeling);
  return Number(info.lastInsertRowid);
}
// node:sqlite liefert Zeilen ohne Prototyp — fuer deepEqual in ein normales Objekt kopieren.
const row = (id: number) => ({
  ...(getDb().prepare("SELECT channeling, channeling_severity FROM shot WHERE id = ?").get(id) as
    { channeling: number; channeling_severity: string | null }),
});

test("Migration: Spalte existiert und ein zweiter Lauf schadet nicht", () => {
  migrateChannelingSeverity(getDb());
  const cols = (getDb().prepare("PRAGMA table_info(shot)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("channeling_severity"));
  assert.ok(cols.includes("channeling"), "die Ja/Nein-Marke bleibt");
});

test("⚠ Altbestand bleibt unbekannt, nicht nachtraeglich leicht oder stark", () => {
  const id = shot(1);
  assert.deepEqual(row(id), { channeling: 1, channeling_severity: null });
  assert.equal(repo.findById(id)!.channelingSeverity, null);
  assert.equal(repo.findById(id)!.channeling, true);
});

test("Staerke setzen schaltet Channeling mit ein", () => {
  const id = shot(0);
  repo.updateShot(id, { channelingSeverity: "strong" });
  assert.deepEqual(row(id), { channeling: 1, channeling_severity: "strong" });
});

test("⚠ Channeling aus loescht die Staerke mit", () => {
  const id = shot(0);
  repo.updateShot(id, { channeling: true, channelingSeverity: "light" });
  repo.updateShot(id, { channeling: false });
  assert.deepEqual(row(id), { channeling: 0, channeling_severity: null });
});

test("Staerke null laesst die Marke stehen (zurueck auf unbekannt)", () => {
  const id = shot(0);
  repo.updateShot(id, { channeling: true, channelingSeverity: "light" });
  repo.updateShot(id, { channelingSeverity: null });
  assert.deepEqual(row(id), { channeling: 1, channeling_severity: null });
});

test("Die Datenbank selbst laesst nur leicht/stark zu", () => {
  const id = shot(1);
  assert.throws(() => getDb().prepare("UPDATE shot SET channeling_severity = 'mittel' WHERE id = ?").run(id));
});

test("Liste traegt die Staerke mit", () => {
  const id = shot(0);
  repo.updateShot(id, { channelingSeverity: "light" });
  const list = repo.listShotsFiltered({ limit: 10, offset: 0, sort: "date_desc", category: "all" });
  const item = list.shots.find((s) => s.id === id)!;
  assert.equal(item.channeling, true);
  assert.equal(item.channelingSeverity, "light");
});
