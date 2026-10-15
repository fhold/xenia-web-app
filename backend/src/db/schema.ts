import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./index.js";
import { classifyPair } from "../lib/coffee-matching.js";
import { extractionStarted } from "../../../shared/src/brew-phase.js";
import { brewDefHash, canonicalBrewDef } from "./brew-def.js";

/**
 * Creates all tables if they don't exist yet.
 * Schema source of truth: Handoff 3.4 + Step 8 + §3.4b (Sorte/Röstung).
 *
 * Tables:
 *   - xenia_script  (Xenia is source-of-truth for script content)
 *   - profile       (App is source-of-truth for profiles)
 *   - settings      (App-global key-value config)
 *   - shot          (Phase 1 Step 5, extended in Step 8)
 *   - shot_sample   (Phase 1 Step 5)
 *   - coffee        (§3.4b — Sorte/master data "Klammer")
 *   - bean          (Phase 1 Step 8; §3.4b — repurposed as Röstung/charge)
 *   - grinder       (Phase 1 Step 8)
 */

/**
 * Adds a column to a table only if it doesn't already exist.
 * Safe to call on every startup — no-op when column is present.
 */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Seed one app-driven flow profile ("Decaf Flow") so the step-based flow-hold
 * feature is usable from the frontend out of the box. Nur auf einer LEEREN
 * Datenbank (keine Profile, keine Bezuege): vorher pruefte das nur den Namen und
 * legte das Profil nach jedem Neustart wieder an, wenn es geloescht worden war
 * (2026-10-07, Profil 18). Fully flow-driven (script_single
 * NULL — no Xenia script). Mirrors the live-validated decaf config: an explicit
 * 48%/6s power pre-infusion, then a 1.4 g/s flow step until 28 g (adaptive), 93 °C.
 */
function seedDecafFlowProfile(db: DatabaseSync): void {
  const used = db
    .prepare("SELECT (SELECT COUNT(*) FROM profile) + (SELECT COUNT(*) FROM shot) AS n")
    .get() as { n: number };
  if (used.n > 0) return;

  const brewSteps = JSON.stringify({
    version: 1,
    steps: [
      { kind: "power", power: 48, exit: { seconds: 6 } },
      { kind: "flow", targetFlowGs: 1.4, controller: "adaptive", exit: { weightG: 28 } },
    ],
  });
  db.prepare(
    `INSERT INTO profile (name, script_single, yield_single_g, target_temp_c, brew_steps)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("Decaf Flow", null, 28.0, 93.0, brewSteps);
}

/**
 * One-time data migration: convert legacy flow profiles (BrewProfile carrying the
 * now-removed `rampStartPower` / `rampDurationMs`) into the step-only model. The
 * old dedicated ramp phase is preserved as an explicit leading PowerStep (same
 * power, exit seconds = rampDurationMs/1000), and the profile's `script_single`
 * is nulled — a flow-driven profile no longer piggybacks a Xenia script.
 *
 * Idempotent: a row is rewritten only while its brew_steps JSON still contains a
 * ramp field. Runs after seedDecafFlowProfile so a freshly-seeded (already
 * step-only) profile is skipped.
 */
function migrateFlowProfilesToSteps(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT id, brew_steps FROM profile WHERE brew_steps IS NOT NULL")
    .all() as Array<{ id: number; brew_steps: string }>;
  for (const row of rows) {
    let bp: {
      version?: number;
      rampStartPower?: unknown;
      rampDurationMs?: unknown;
      steps?: unknown;
    };
    try {
      bp = JSON.parse(row.brew_steps);
    } catch {
      continue; // malformed JSON — leave untouched
    }
    if (bp.rampStartPower === undefined && bp.rampDurationMs === undefined) continue;

    const rampPower = typeof bp.rampStartPower === "number" ? bp.rampStartPower : 48;
    const rampMs = typeof bp.rampDurationMs === "number" ? bp.rampDurationMs : 6000;
    const steps = Array.isArray(bp.steps) ? bp.steps : [];
    const newBp = {
      version: 1,
      steps: [{ kind: "power", power: rampPower, exit: { seconds: Math.round(rampMs / 1000) } }, ...steps],
    };
    db.prepare(
      "UPDATE profile SET brew_steps = ?, script_single = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(JSON.stringify(newBp), row.id);
  }
}

/**
 * One-time rebuild: `shot.rating` used to be a thumbs enum (TEXT CHECK). The
 * shot rating is now a 1–5 score (INTEGER CHECK). SQLite can't drop a CHECK via
 * ALTER, so the table is rebuilt. Idempotent: only runs while the old thumbs
 * CHECK is still present. Old thumbs values (all NULL in practice) map to NULL.
 * Verified against a copy of the production DB: row count, FK integrity,
 * sqlite_sequence continuity (next id preserved). Bean rating is a separate
 * column and is untouched.
 */
function migrateShotRatingThumbsToInt(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("rating TEXT CHECK(rating IN ('thumbs_down'")) {
    return; // already migrated, or fresh DB created with INTEGER rating
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id     INTEGER NOT NULL REFERENCES profile(id),
        script_id      INTEGER NOT NULL REFERENCES xenia_script(id),
        shot_size      TEXT    NOT NULL CHECK(shot_size IN ('single','double')),
        category       TEXT    NOT NULL CHECK(category IN ('brew','maintenance')),
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        stop_mode      TEXT    CHECK(stop_mode IN ('cmd27','app','manual','script_end')),
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
        extraction_balance      INTEGER CHECK(extraction_balance BETWEEN 1 AND 5),
        taste_tags              TEXT,
        grind_note              TEXT CHECK(grind_note IN ('finer','ok','coarser'))
      );

      INSERT INTO shot_new (
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason
      )
      SELECT
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, NULL, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason
      FROM shot;

      DROP TABLE shot;
      ALTER TABLE shot_new RENAME TO shot;
      CREATE INDEX IF NOT EXISTS idx_shot_started_at ON shot(started_at DESC);
      DELETE FROM sqlite_sequence WHERE name IN ('shot','shot_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'shot', COALESCE(MAX(id), 0) FROM shot;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * Extraction model v2 (2026-06): replace the single `extraction_balance`
 * (INTEGER 1–5, sour↔bitter axis) with `extraction_under` / `extraction_over`
 * (independent toggles). Rebuild drops the old column and back-fills the
 * toggles once from the old values (balance ≤2 → under, ≥4 → over, 3/NULL →
 * neither). Idempotent: only runs while `extraction_balance` still exists.
 * Verified against a copy of the production DB (row count, FK, back-fill).
 */
function migrateExtractionBalanceToToggles(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("extraction_balance")) {
    return; // already migrated, or fresh DB without the old column
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id     INTEGER NOT NULL REFERENCES profile(id),
        script_id      INTEGER NOT NULL REFERENCES xenia_script(id),
        shot_size      TEXT    NOT NULL CHECK(shot_size IN ('single','double')),
        category       TEXT    NOT NULL CHECK(category IN ('brew','maintenance')),
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        stop_mode      TEXT    CHECK(stop_mode IN ('cmd27','app','manual','script_end')),
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
        extraction_over         INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO shot_new (
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over
      )
      SELECT
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        NULL, NULL,
        CASE WHEN extraction_balance <= 2 THEN 1 ELSE 0 END,
        CASE WHEN extraction_balance >= 4 THEN 1 ELSE 0 END
      FROM shot;

      DROP TABLE shot;
      ALTER TABLE shot_new RENAME TO shot;
      CREATE INDEX IF NOT EXISTS idx_shot_started_at ON shot(started_at DESC);
      DELETE FROM sqlite_sequence WHERE name IN ('shot','shot_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'shot', COALESCE(MAX(id), 0) FROM shot;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * One-time rebuild: makes `shot.profile_id` nullable with ON DELETE SET NULL so
 * that deleting a profile no longer cascades to shot rows. Existing shots keep
 * their profile_id value; only future deletes will set it to NULL.
 * Idempotent: only runs while the old NOT NULL constraint is still present.
 */
function migrateShotProfileIdSetNull(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("profile_id     INTEGER NOT NULL REFERENCES profile(id)")) {
    return; // already migrated, or fresh DB without the old constraint
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id     INTEGER REFERENCES profile(id) ON DELETE SET NULL,
        script_id      INTEGER NOT NULL REFERENCES xenia_script(id),
        shot_size      TEXT    NOT NULL CHECK(shot_size IN ('single','double')),
        category       TEXT    NOT NULL CHECK(category IN ('brew','maintenance')),
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        stop_mode      TEXT    CHECK(stop_mode IN ('cmd27','app','manual','script_end')),
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
        extraction_over         INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO shot_new (
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over
      )
      SELECT
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over
      FROM shot;

      DROP TABLE shot;
      ALTER TABLE shot_new RENAME TO shot;
      CREATE INDEX IF NOT EXISTS idx_shot_started_at ON shot(started_at DESC);
      DELETE FROM sqlite_sequence WHERE name IN ('shot','shot_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'shot', COALESCE(MAX(id), 0) FROM shot;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * One-time rebuild: extend the `stop_mode` CHECK constraint with the new
 * 'app_failed' value (a brew-by-weight stop that was attempted but failed to
 * send after all retries). SQLite can't widen a CHECK via ALTER, so the table
 * is rebuilt. Idempotent: only runs while the constraint lacks 'app_failed'.
 * Existing rows are copied verbatim — no stop_mode value is changed.
 * Must run AFTER all column additions so the rebuild preserves the full shape.
 */
function migrateStopModeAddAppFailed(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'app_failed'")) {
    return; // already widened, or fresh DB created with the new CHECK
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id     INTEGER REFERENCES profile(id) ON DELETE SET NULL,
        script_id      INTEGER NOT NULL REFERENCES xenia_script(id),
        shot_size      TEXT    NOT NULL CHECK(shot_size IN ('single','double')),
        category       TEXT    NOT NULL CHECK(category IN ('brew','maintenance')),
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        stop_mode      TEXT    CHECK(stop_mode IN ('cmd27','app','app_failed','manual','script_end')),
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
        extraction_over         INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO shot_new (
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over
      )
      SELECT
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over
      FROM shot;

      DROP TABLE shot;
      ALTER TABLE shot_new RENAME TO shot;
      CREATE INDEX IF NOT EXISTS idx_shot_started_at ON shot(started_at DESC);
      DELETE FROM sqlite_sequence WHERE name IN ('shot','shot_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'shot', COALESCE(MAX(id), 0) FROM shot;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * One-time rebuild: extend the `stop_mode` CHECK constraint with the new
 * 'watchdog' value (Auftrag 3m — the BBW safety watchdog re-fired the stop after
 * the normal stop did not take effect). SQLite can't widen a CHECK via ALTER, so
 * the table is rebuilt. Idempotent: only runs while the constraint lacks
 * 'watchdog'. Existing rows are copied verbatim — no stop_mode value is changed.
 *
 * IMPORTANT: unlike the older migrateStopModeAddAppFailed (which predates the
 * profile_name / profile_set_temp_c columns and therefore omits them), this
 * rebuild runs AFTER those columns exist, so it MUST list and copy them — else
 * the rebuild would silently drop them. The shot_new shape below mirrors the
 * live production table exactly (verified read-only against /var/lib/xenia).
 * Must run AFTER all column additions so the rebuild preserves the full shape.
 */
function migrateStopModeAddWatchdog(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'watchdog'")) {
    return; // already widened, or fresh DB created with the new CHECK
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id     INTEGER REFERENCES profile(id) ON DELETE SET NULL,
        script_id      INTEGER NOT NULL REFERENCES xenia_script(id),
        shot_size      TEXT    NOT NULL CHECK(shot_size IN ('single','double')),
        category       TEXT    NOT NULL CHECK(category IN ('brew','maintenance')),
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        stop_mode      TEXT    CHECK(stop_mode IN ('cmd27','app','app_failed','manual','script_end','watchdog')),
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
        profile_set_temp_c      REAL
      );

      INSERT INTO shot_new (
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over, profile_name, profile_set_temp_c
      )
      SELECT
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over, profile_name, profile_set_temp_c
      FROM shot;

      DROP TABLE shot;
      ALTER TABLE shot_new RENAME TO shot;
      CREATE INDEX IF NOT EXISTS idx_shot_started_at ON shot(started_at DESC);
      DELETE FROM sqlite_sequence WHERE name IN ('shot','shot_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'shot', COALESCE(MAX(id), 0) FROM shot;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * One-time rebuild: extend the `stop_mode` CHECK constraint with the flow-hold
 * drive values 'flowhold' (normal paddle exit) and 'flowhold_watchdog' (hard
 * stop). SQLite can't widen a CHECK via ALTER, so the table is rebuilt.
 * Idempotent: only runs while the constraint lacks 'flowhold'. Existing rows are
 * copied verbatim — no stop_mode value is changed.
 *
 * Unlike migrateStopModeAddWatchdog (whose column list predates channeling /
 * scale_frozen and stays dormant on current DBs), THIS migration DOES run on the
 * live DB, so shot_new mirrors the exact production shape (37 columns incl.
 * channeling + scale_frozen — verified read-only against /var/lib/xenia). Must
 * run AFTER every column addition so the rebuild preserves the full shape.
 */
function migrateStopModeAddFlowhold(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'flowhold'")) {
    return; // already widened, or fresh DB created with the new CHECK
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id     INTEGER REFERENCES profile(id) ON DELETE SET NULL,
        script_id      INTEGER NOT NULL REFERENCES xenia_script(id),
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
      );

      INSERT INTO shot_new (
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over, profile_name, profile_set_temp_c,
        channeling, scale_frozen
      )
      SELECT
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over, profile_name, profile_set_temp_c,
        channeling, scale_frozen
      FROM shot;

      DROP TABLE shot;
      ALTER TABLE shot_new RENAME TO shot;
      CREATE INDEX IF NOT EXISTS idx_shot_started_at ON shot(started_at DESC);
      DELETE FROM sqlite_sequence WHERE name IN ('shot','shot_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'shot', COALESCE(MAX(id), 0) FROM shot;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * One-time rebuild: drop the NOT NULL on `shot.script_id`. App-driven step-based
 * brews (Cut-2, all-paddle) have no Xenia script, so they no longer piggyback a
 * dummy script id — script_id is NULL for those shots. SQLite can't drop NOT NULL
 * via ALTER, so the table is rebuilt. Idempotent: only runs while script_id is
 * still NOT NULL (PRAGMA table_info notnull=1). Runs AFTER migrateStopModeAddFlowhold
 * so the mirrored shape already carries the flowhold stop_mode CHECK; shot_new is
 * the exact 37-column production shape, only script_id loses NOT NULL. Existing
 * rows are copied verbatim.
 */
function migrateShotScriptIdNullable(db: DatabaseSync): void {
  const info = db
    .prepare("PRAGMA table_info(shot)")
    .all() as Array<{ name: string; notnull: number }>;
  const sc = info.find((c) => c.name === "script_id");
  if (!sc || sc.notnull === 0) {
    return; // already nullable, or no shot table yet
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_new (
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
      );

      INSERT INTO shot_new (
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over, profile_name, profile_set_temp_c,
        channeling, scale_frozen
      )
      SELECT
        id, profile_id, script_id, shot_size, category, started_at, ended_at, stop_mode,
        yield_target_g, yield_actual_g, has_cmd27, cmd27_value, notes, bean_id, grinder_id,
        grind_setting, grinder_rpm, dose_g, tds_percent, rating, stop_trigger_weight_g,
        flow_at_trigger_g_per_s, residual_lag_s_used, bbw_left_brewing_lag_ms,
        post_brew_duration_ms, post_brew_stop_reason, taste_tags, grind_note,
        acidity, bitterness, extraction_under, extraction_over, profile_name, profile_set_temp_c,
        channeling, scale_frozen
      FROM shot;

      DROP TABLE shot;
      ALTER TABLE shot_new RENAME TO shot;
      CREATE INDEX IF NOT EXISTS idx_shot_started_at ON shot(started_at DESC);
      DELETE FROM sqlite_sequence WHERE name IN ('shot','shot_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'shot', COALESCE(MAX(id), 0) FROM shot;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * §3.4b one-time migration: split the flat `bean` table into `coffee` (Sorte —
 * master data + favourite + canonical rating) and `bean` (Röstung/charge).
 *
 * Idempotent: only runs while `bean` lacks a `coffee_id` column. Assumes the
 * `coffee` table already exists (created by the base schema right before this
 * call). Runs in one transaction with FK off (mirrors the other rebuilds);
 * rolls back fully on any error. Operationally, a DB backup is taken before the
 * deploy that first runs this.
 *
 * Per bean: master data is lifted into a `coffee`, `bean.coffee_id` is set,
 * `bean.rating` → `coffee.rating` (then bean.rating cleared to NULL = inherit),
 * `favourite` → `coffee.favourite`. Conservative auto-grouping via the shared
 * matcher: only "sicher" pairs collapse into one coffee (master data + rating
 * from the YOUNGEST bean, favourite = OR); unclear cases stay separate (Merge
 * cleans up manually). Shots are untouched — `shot.bean_id` keeps pointing at
 * the same roasting, which keeps the same id through the rebuild.
 */
interface OldFlatBean {
  id: number;
  name: string;
  roaster: string | null;
  country: string | null;
  region: string | null;
  farm: string | null;
  variety: string | null;
  processing: string | null;
  altitude_min: number | null;
  altitude_max: number | null;
  roast_date: string | null;
  roast_level: string | null;
  brew_type: string | null;
  bag_size_g: number | null;
  remaining_g: number | null;
  price_per_bag_eur: number | null;
  flavor_notes: string | null;
  notes: string | null;
  status: string;
  frozen_date: string | null;
  thaw_date: string | null;
  rating: string | null;
  favourite: number;
  created_at: number;
  updated_at: number;
}

function migrateCoffeeSorteRoestung(db: DatabaseSync): void {
  const cols = db
    .prepare("PRAGMA table_info(bean)")
    .all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "coffee_id")) return; // already migrated / fresh new-shape DB

  // Oldest → youngest, so the canonical (last writer wins) ends up youngest.
  const beans = db
    .prepare("SELECT * FROM bean ORDER BY created_at ASC, id ASC")
    .all() as unknown as OldFlatBean[];

  // Conservative grouping: only "sicher" pairs collapse. canonical = youngest
  // member; favourite = OR over the group.
  interface Group {
    canonical: OldFlatBean;
    favourite: boolean;
    beanIds: number[];
  }
  const groups: Group[] = [];
  for (const b of beans) {
    let best: { g: Group; score: number } | null = null;
    for (const g of groups) {
      const { verdict, score } = classifyPair(
        { name: b.name, roaster: b.roaster },
        { name: g.canonical.name, roaster: g.canonical.roaster },
      );
      if (verdict === "sicher" && (!best || score > best.score)) best = { g, score };
    }
    if (best) {
      best.g.beanIds.push(b.id);
      best.g.favourite = best.g.favourite || b.favourite === 1;
      best.g.canonical = b; // beans are asc → keep youngest as canonical
    } else {
      groups.push({ canonical: b, favourite: b.favourite === 1, beanIds: [b.id] });
    }
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    const now = Date.now();
    const insCoffee = db.prepare(
      `INSERT INTO coffee
         (name, roaster, country, region, farm, variety, processing,
          altitude_min, altitude_max, roast_level, brew_type, flavor_notes,
          notes, favourite, rating, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const beanToCoffee = new Map<number, number>();
    for (const g of groups) {
      const c = g.canonical;
      const res = insCoffee.run(
        c.name,
        c.roaster,
        c.country,
        c.region,
        c.farm,
        c.variety,
        c.processing,
        c.altitude_min,
        c.altitude_max,
        c.roast_level,
        c.brew_type,
        c.flavor_notes,
        c.notes,
        g.favourite ? 1 : 0,
        c.rating, // bean.rating → coffee.rating (canonical = youngest)
        now,
        now,
      ) as { lastInsertRowid: number | bigint };
      const coffeeId = Number(res.lastInsertRowid);
      for (const bid of g.beanIds) beanToCoffee.set(bid, coffeeId);
    }

    // Rebuild bean as Röstung (drops the migrated master-data columns + the old
    // favourite index, adds coffee_id NOT NULL). bean.rating becomes the charge
    // override and is cleared to NULL (= inherit) for every migrated row.
    db.exec(`
      CREATE TABLE bean_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        coffee_id         INTEGER NOT NULL REFERENCES coffee(id) ON DELETE RESTRICT,
        roast_date        TEXT,
        bag_size_g        REAL,
        remaining_g       REAL,
        price_per_bag_eur REAL,
        status            TEXT NOT NULL DEFAULT 'active'
                            CHECK(status IN ('active','frozen','thawed','archived')),
        frozen_date       TEXT,
        thaw_date         TEXT,
        rating            TEXT CHECK(rating IN ('thumbs_down','meh','thumbs_up')),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
    `);
    const insBean = db.prepare(
      `INSERT INTO bean_new
         (id, coffee_id, roast_date, bag_size_g, remaining_g, price_per_bag_eur,
          status, frozen_date, thaw_date, rating, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of beans) {
      const coffeeId = beanToCoffee.get(b.id);
      if (coffeeId === undefined) {
        throw new Error(`migrateCoffeeSorteRoestung: no coffee mapping for bean ${b.id}`);
      }
      insBean.run(
        b.id,
        coffeeId,
        b.roast_date,
        b.bag_size_g,
        b.remaining_g,
        b.price_per_bag_eur,
        b.status,
        b.frozen_date,
        b.thaw_date,
        null, // rating override cleared — inherits coffee.rating
        b.created_at,
        b.updated_at,
      );
    }

    db.exec(`
      DROP TABLE bean;
      ALTER TABLE bean_new RENAME TO bean;
      DELETE FROM sqlite_sequence WHERE name IN ('bean','bean_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'bean', COALESCE(MAX(id), 0) FROM bean;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * §3g — split `bean.status` into two axes:
 *   - physical status: 'active' is removed; the enum becomes
 *     ('stock','frozen','thawed','archived').
 *   - active-source flag: new `is_active INTEGER NOT NULL DEFAULT 0`.
 *
 * Mapping (conservative): rows with status='active' → is_active=1 and a
 * physical status of 'thawed' (in-use bags; Flavio adjusts the few afterwards).
 * Every other status is preserved verbatim and lands inactive (is_active=0).
 *
 * Idempotent: guarded on the table SQL still allowing the old 'active' status.
 * A fresh DB is created with the new shape (CHECK already lists 'stock') and is
 * skipped. Rebuild via CREATE/INSERT/DROP/RENAME (SQLite can't ALTER a CHECK),
 * matching the established migration pattern; FK off during the swap, ids and
 * sqlite_sequence preserved → shot.bean_id stays valid.
 */
function migrateBeanStatusTwoAxis(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bean'")
    .get() as { sql: string } | undefined;
  // Fresh/new-shape DB already has the four-value CHECK → nothing to do.
  if (!row || !row.sql.includes("'active'")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE bean_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        coffee_id         INTEGER NOT NULL REFERENCES coffee(id) ON DELETE RESTRICT,
        roast_date        TEXT,
        bag_size_g        REAL,
        remaining_g       REAL,
        price_per_bag_eur REAL,
        status            TEXT NOT NULL DEFAULT 'stock'
                            CHECK(status IN ('stock','frozen','thawed','archived')),
        is_active         INTEGER NOT NULL DEFAULT 0,
        frozen_date       TEXT,
        thaw_date         TEXT,
        rating            TEXT CHECK(rating IN ('thumbs_down','meh','thumbs_up')),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO bean_new
        (id, coffee_id, roast_date, bag_size_g, remaining_g, price_per_bag_eur,
         status, is_active, frozen_date, thaw_date, rating, created_at, updated_at)
      SELECT
        id, coffee_id, roast_date, bag_size_g, remaining_g, price_per_bag_eur,
        CASE WHEN status = 'active' THEN 'thawed' ELSE status END,
        CASE WHEN status = 'active' THEN 1 ELSE 0 END,
        frozen_date, thaw_date, rating, created_at, updated_at
      FROM bean;
    `);
    db.exec(`
      DROP TABLE bean;
      ALTER TABLE bean_new RENAME TO bean;
      DELETE FROM sqlite_sequence WHERE name IN ('bean','bean_new');
      INSERT INTO sqlite_sequence(name, seq) SELECT 'bean', COALESCE(MAX(id), 0) FROM bean;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * Widen the shot_sample.phase CHECK to allow the pre-infusion/extraction
 * sub-phases (2026-06-27). SQLite can't drop a CHECK in place, so rebuild the
 * table. Idempotent: skips once the CHECK already lists 'preinfusion'. Legacy
 * 'brewing' rows are preserved (kept valid in the new CHECK). All columns —
 * including the later-added `phase`/`pump_pwm` — are listed explicitly so they
 * survive the copy.
 */
function migratePhaseAddSubphases(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot_sample'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'preinfusion'")) {
    return; // already widened, or fresh DB created with the new CHECK
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE shot_sample_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        shot_id       INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
        elapsed_ms    INTEGER NOT NULL,
        pressure_bar  REAL,
        flow_ml_s     REAL,
        flow_meter_ml REAL,
        temp_bg_c     REAL,
        temp_bb_c     REAL,
        weight_g      REAL,
        phase         TEXT NOT NULL DEFAULT 'brewing'
                       CHECK(phase IN ('brewing','preinfusion','extraction','post_brew')),
        pump_pwm      REAL
      );

      INSERT INTO shot_sample_new (
        id, shot_id, elapsed_ms, pressure_bar, flow_ml_s, flow_meter_ml,
        temp_bg_c, temp_bb_c, weight_g, phase, pump_pwm
      )
      SELECT
        id, shot_id, elapsed_ms, pressure_bar, flow_ml_s, flow_meter_ml,
        temp_bg_c, temp_bb_c, weight_g, phase, pump_pwm
      FROM shot_sample;

      DROP TABLE shot_sample;
      ALTER TABLE shot_sample_new RENAME TO shot_sample;
      CREATE INDEX IF NOT EXISTS idx_shot_sample_shot_id ON shot_sample(shot_id);
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * Backfill historical samples (tagged 'brewing' before the sub-phase split) into
 * 'preinfusion'/'extraction' using the SAME monotonic latch as the live recorder
 * (shared/src/brew-phase.ts) over the stored pressure + cumulative weight. One
 * pass per shot in sample order. Idempotent: skips once no 'brewing' rows remain
 * (new brews are written split already, so 'brewing' only ever exists pre-split).
 */
function backfillSamplePhases(db: DatabaseSync): void {
  const pending = db
    .prepare("SELECT 1 FROM shot_sample WHERE phase = 'brewing' LIMIT 1")
    .get() as unknown;
  if (!pending) return;

  const shotIds = db
    .prepare("SELECT DISTINCT shot_id FROM shot_sample WHERE phase = 'brewing' ORDER BY shot_id")
    .all() as { shot_id: number }[];
  const selSamples = db.prepare(
    "SELECT id, pressure_bar, weight_g FROM shot_sample WHERE shot_id = ? AND phase = 'brewing' ORDER BY elapsed_ms, id",
  );
  const updPhase = db.prepare("UPDATE shot_sample SET phase = ? WHERE id = ?");

  db.exec("BEGIN");
  try {
    for (const { shot_id } of shotIds) {
      let latched = false;
      const rows = selSamples.all(shot_id) as {
        id: number;
        pressure_bar: number | null;
        weight_g: number | null;
      }[];
      for (const r of rows) {
        latched = extractionStarted(latched, r.pressure_bar, r.weight_g);
        updPhase.run(latched ? "extraction" : "preinfusion", r.id);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Channeling-Staerke als eigene Spalte neben der Ja/Nein-Marke. Idempotent,
 * kein Backfill (Altbestand = NULL = unbekannt). Exportiert, damit der Test die
 * Migration gegen den nachgebauten Produktionsstand pruefen kann.
 */
export function migrateChannelingSeverity(db: DatabaseSync): void {
  addColumnIfMissing(db, "shot", "channeling_severity",
    "TEXT CHECK(channeling_severity IN ('light','strong'))");
}

/**
 * Profilversion ohne Stufennamen (2026-09-28): der Hash eines Flow-Ablaufs
 * deckt nur noch ab, was den Bezug bestimmt (s. canonicalBrewDef). Bestehende
 * 'steps'-Definitionen werden in die kanonische Form ueberfuehrt und ihre
 * Bezuege auf den neuen Hash umgehaengt — sonst risse die Geisterwolke genau am
 * Umstieg, weil der naechste Bezug derselben Fassung einen anderen Hash bekaeme.
 * Idempotent: eine bereits kanonische Zeile ergibt denselben Hash und bleibt.
 */
export function migrateBrewDefCanonical(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT hash, content, first_seen_at FROM brew_def WHERE kind = 'steps'")
    .all() as { hash: string; content: string; first_seen_at: number }[];
  for (const r of rows) {
    const content = canonicalBrewDef("steps", r.content);
    const hash = brewDefHash("steps", content);
    if (hash === r.hash) continue;
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO brew_def (hash, kind, content, first_seen_at) VALUES (?, 'steps', ?, ?)
         ON CONFLICT(hash) DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at)`,
      ).run(hash, content, r.first_seen_at);
      db.prepare("UPDATE shot SET brew_def_hash = ? WHERE brew_def_hash = ?").run(hash, r.hash);
      db.prepare("DELETE FROM brew_def WHERE hash = ?").run(r.hash);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function applySchema(): void {
  const db = getDb();

  db.exec(`
    -- Cache of Xenia scripts.
    -- Source-of-truth for script content is the Xenia machine itself.
    -- Synced on backend start, manual refresh, and pre-brew (see Handoff 3.5).
    CREATE TABLE IF NOT EXISTS xenia_script (
      id            INTEGER PRIMARY KEY,     -- == Xenia script ID from /scripts/list
      title         TEXT    NOT NULL,        -- title from /scripts/list
      content       TEXT    NOT NULL,        -- raw semicolon-separated token string from /scripts/read
      parsed_cmds   TEXT,                   -- JSON: parsed cmd list (see Handoff 2.8)
      has_cmd27     INTEGER DEFAULT 0,       -- 1 if script contains at least one Cmd 27
      cmd27_value   REAL,                   -- last Cmd 27 target value in grams (for display)
      category_auto TEXT,                   -- 'brew' | 'maintenance' | 'unknown' (auto-detected)
      fetched_at    TIMESTAMP NOT NULL,
      orphaned_at   TIMESTAMP               -- set when script no longer exists on Xenia
    );

    -- App-level profiles bundle Xenia scripts with metadata.
    -- Xenia has no concept of profiles — they exist only in the app.
    CREATE TABLE IF NOT EXISTS profile (
      id            INTEGER PRIMARY KEY,
      name          TEXT    NOT NULL,
      description   TEXT,
      icon          TEXT,                   -- Lucide icon name
      script_single INTEGER REFERENCES xenia_script(id),
      script_double INTEGER REFERENCES xenia_script(id),
      yield_single_g REAL,                  -- yield target for single shot in grams
      yield_double_g REAL,                  -- yield target for double shot in grams
      fav           INTEGER DEFAULT 0,      -- show on dashboard?
      sort_order    INTEGER,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Global app settings as key-value pairs.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ---------------------------------------------------------------------------
  // Shot recording tables (Phase 1 Step 5)
  // ---------------------------------------------------------------------------
  db.exec(`
    -- One row per executed profile shot. Populated by ShotRecorder.
    -- Only shots started via the app are recorded (not hardware starts).
    -- profile_id / script_id stehen hier schon in ihrer heutigen, nullbaren
    -- Form. Frueher standen sie als NOT NULL da: auf einer LEEREN DB loeste das
    -- migrateShotProfileIdSetNull und migrateShotScriptIdNullable aus, deren
    -- Neuaufbau mit fester Spaltenliste bereits angelegte Spalten verwarf (und
    -- die stop_mode-CHECK zurueckschraubte) — applySchema() brach dann ab. Auf
    -- einer gewachsenen DB ist diese Anweisung ein No-op.
    CREATE TABLE IF NOT EXISTS shot (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id     INTEGER REFERENCES profile(id) ON DELETE SET NULL,
      script_id      INTEGER REFERENCES xenia_script(id),
      shot_size      TEXT    NOT NULL CHECK(shot_size IN ('single','double')),
      category       TEXT    NOT NULL CHECK(category IN ('brew','maintenance')),
      started_at     INTEGER NOT NULL,   -- unix ms when first MA_STATUS=3 (or =5 for flow-hold) frame seen
      ended_at       INTEGER,            -- unix ms; NULL while shot is in progress
      stop_mode      TEXT    CHECK(stop_mode IN ('cmd27','app','app_failed','manual','script_end','watchdog','flowhold','flowhold_watchdog')),
      yield_target_g REAL,               -- from profile at execution time
      yield_actual_g REAL,               -- last SCALE_WEIGHT when shot ended
      has_cmd27      INTEGER NOT NULL DEFAULT 0,
      cmd27_value    REAL,
      notes          TEXT                -- post-shot review (Step 8)
    );

    -- One row per polling frame received while MA_STATUS=3.
    -- All sensor fields nullable so a partial frame never blocks recording.
    CREATE TABLE IF NOT EXISTS shot_sample (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      shot_id       INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
      elapsed_ms    INTEGER NOT NULL,    -- ms since shot.started_at
      pressure_bar  REAL,
      flow_ml_s     REAL,               -- live flow rate (g/s ≈ ml/s) from scale (PU_SENS_SCALE_RATE)
      flow_meter_ml REAL,               -- cumulative flow-meter volume (ml, PU_SENS_FLOW_METER_VOLUME) — for Visualizer export
      temp_bg_c     REAL,
      temp_bb_c     REAL,
      weight_g      REAL
    );

    CREATE INDEX IF NOT EXISTS idx_shot_started_at     ON shot(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shot_sample_shot_id ON shot_sample(shot_id);
  `);

  // ---------------------------------------------------------------------------
  // Shot table — Step 8 column extensions
  // Added via ALTER TABLE so existing DBs are migrated safely on startup.
  // ---------------------------------------------------------------------------
  addColumnIfMissing(db, "shot", "bean_id",       "INTEGER REFERENCES bean(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "shot", "grinder_id",    "INTEGER REFERENCES grinder(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "shot", "grind_setting", "REAL");
  addColumnIfMissing(db, "shot", "grinder_rpm",   "INTEGER");
  addColumnIfMissing(db, "shot", "dose_g",        "REAL");
  addColumnIfMissing(db, "shot", "tds_percent",   "REAL");
  // Shot rating is a 1–5 score (fresh DBs). Existing DBs with the old thumbs
  // TEXT column are converted by migrateShotRatingThumbsToInt() below.
  addColumnIfMissing(db, "shot", "rating",        "INTEGER CHECK(rating BETWEEN 1 AND 5)");

  // T5 (§3.4): denormalized snapshot of the profile name at brew time, so a
  // later profile deletion (ON DELETE SET NULL on profile_id) doesn't lose the
  // name. Display = live profile name if it still exists, else this snapshot +
  // "(Profil gelöscht)". Backfill once for shots whose profile still exists;
  // already-orphaned shots (profile_id NULL) stay nameless (irrecoverable).
  addColumnIfMissing(db, "shot", "profile_name", "TEXT");
  db.exec(
    `UPDATE shot
       SET profile_name = (SELECT name FROM profile WHERE profile.id = shot.profile_id)
     WHERE profile_name IS NULL AND profile_id IS NOT NULL`,
  );

  // H4 (3c): snapshot of the brew-group SET temperature (°C) in effect at brew
  // time, for the History "Soll-Temp". Profiles MAY carry a target temp (PT-1),
  // but this snapshot stays mechanically unchanged: it is the machine-global BG
  // setpoint actually in effect at brew start (the recorder snapshots
  // SetpointsFrame.brewGroupTargetC), NOT the profile's target. NO backfill: there is no
  // historical per-shot setpoint to recover (applying today's setpoint to old
  // shots would be wrong) → existing shots stay NULL; only new shots get it.
  addColumnIfMissing(db, "shot", "profile_set_temp_c", "REAL");

  // Snapshot of the BrewProfile steps (JSON) actually in effect at brew time, so
  // the History "Soll-Kurve" reflects what THIS shot ran — not the profile as it
  // reads today (profiles are edited between shots). NULL for shots recorded
  // before this column / non-step (script-only) brews. No backfill: an old shot's
  // brew-time steps are irrecoverable. addColumnIfMissing, no rebuild.
  addColumnIfMissing(db, "shot", "brew_steps", "TEXT");

  // Content hash of the brew definition this shot ran (→ brew_def.hash). Covers
  // BOTH drives: the script token string and the flow-hold step JSON. No
  // backfill — the brew-time content of an older shot is irrecoverable, and
  // stamping today's script onto it would assert something we cannot know.
  addColumnIfMissing(db, "shot", "brew_def_hash", "TEXT");

  // ---------------------------------------------------------------------------
  // Profile table — free-text notes (3j)
  // Description / temp recommendation / etc. NULL = no note (no backfill needed:
  // a missing note is the correct default). Idempotent, no table rebuild.
  // ---------------------------------------------------------------------------
  addColumnIfMissing(db, "profile", "notes", "TEXT");

  // ---------------------------------------------------------------------------
  // Profile table — optional target brew temperature °C (PT-1, Spec §3.4)
  // NULL = no profile target → today's behaviour. Stage 1 only stores/shows it;
  // no machine interaction. No backfill / rebuild — existing rows stay NULL.
  // ---------------------------------------------------------------------------
  addColumnIfMissing(db, "profile", "target_temp_c", "REAL");

  // ---------------------------------------------------------------------------
  // Profile table — step-based flow/pressure/script definition (Decent-style).
  // JSON BrewProfile, or NULL for a classic script-only profile. When present,
  // the profile can be started as an app-driven flow-hold shot. No rebuild /
  // backfill — existing rows stay NULL (script-only).
  // ---------------------------------------------------------------------------
  addColumnIfMissing(db, "profile", "brew_steps", "TEXT");
  // Optional 2×-slot flow sequence (JSON BrewProfile). NULL = the 2× shot reuses
  // the 1× sequence (brew_steps) with its own yield_double_g. addColumnIfMissing,
  // no rebuild/backfill — existing rows stay NULL.
  addColumnIfMissing(db, "profile", "brew_steps_double", "TEXT");
  seedDecafFlowProfile(db);
  // Convert any legacy ramp-based flow profile to the step-only model (leading
  // PowerStep pre-infusion) and null its script. Idempotent; after the seed.
  migrateFlowProfilesToSteps(db);

  // ---------------------------------------------------------------------------
  // xenia_script — manual category override (SE-2). Local app metadata only:
  // 'brew' | 'maintenance' | NULL (= auto). NULL = use category_auto. Validated
  // in the route, not via DB CHECK. NOT touched by the sync upsert, so it
  // survives re-syncs from the machine. addColumnIfMissing, no rebuild/backfill.
  // ---------------------------------------------------------------------------
  addColumnIfMissing(db, "xenia_script", "category_override", "TEXT");

  // ---------------------------------------------------------------------------
  // Shot table — Brew-by-Weight stop snapshot (Spec §4.12)
  // Per-shot diagnostic snapshot of the stop event. Populated for every shot
  // (not only BBW/app-stops) where the values are available — BBW-specific
  // fields stay NULL for manual/cmd27/script_end stops.
  // ---------------------------------------------------------------------------
  addColumnIfMissing(db, "shot", "stop_trigger_weight_g",   "REAL");
  addColumnIfMissing(db, "shot", "flow_at_trigger_g_per_s", "REAL");
  addColumnIfMissing(db, "shot", "residual_lag_s_used",     "REAL");
  addColumnIfMissing(db, "shot", "bbw_left_brewing_lag_ms", "INTEGER");
  addColumnIfMissing(db, "shot", "post_brew_duration_ms",   "INTEGER");
  addColumnIfMissing(
    db,
    "shot",
    "post_brew_stop_reason",
    "TEXT CHECK(post_brew_stop_reason IN ('stable','timeout'))",
  );

  // ---------------------------------------------------------------------------
  // Shot rating (post-shot review) — 1–5 score + extraction balance + taste
  // tags + grind note. Rating replaces the old thumbs enum (rebuilt above for
  // existing DBs). Modelled flat so the axis/tag set can change without a
  // schema migration. Bean rating (bean.rating) is a separate feature.
  // ---------------------------------------------------------------------------
  migrateShotRatingThumbsToInt(db);
  addColumnIfMissing(db, "shot", "taste_tags",         "TEXT");
  addColumnIfMissing(db, "shot", "grind_note",         "TEXT CHECK(grind_note IN ('finer','ok','coarser'))");

  // Extraction model v2: the single `extraction_balance` (1–5 sour↔bitter) axis
  // is replaced by two independent flavour axes (acidity/bitterness) + two
  // extraction toggles (under/over). For existing DBs the old column is dropped
  // by a rebuild that back-fills the toggles; fresh DBs get the columns below.
  migrateExtractionBalanceToToggles(db);
  migrateShotProfileIdSetNull(db);
  addColumnIfMissing(db, "shot", "acidity",          "INTEGER CHECK(acidity BETWEEN 1 AND 5)");
  addColumnIfMissing(db, "shot", "bitterness",       "INTEGER CHECK(bitterness BETWEEN 1 AND 5)");
  addColumnIfMissing(db, "shot", "extraction_under", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "shot", "extraction_over",  "INTEGER NOT NULL DEFAULT 0");

  // ÄW-A: channeling is now its own extraction marker (previously derived from
  // under && over). addColumnIfMissing, no rebuild/backfill; existing rows = 0.
  // No history filter for it yet (deferred).
  addColumnIfMissing(db, "shot", "channeling",       "INTEGER NOT NULL DEFAULT 0");

  // Frozen-scale detection: the machine occasionally reports a constant,
  // implausibly high SCALE_WEIGHT for a whole brew (scale glitch; #71/#75 ~141g)
  // while the flow rate stays live. Recorded so the null yield's reason is visible
  // and the tablet can alert. addColumnIfMissing, no rebuild/backfill; rows = 0.
  addColumnIfMissing(db, "shot", "scale_frozen",     "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "shot", "scale_lost",       "INTEGER NOT NULL DEFAULT 0");

  // Widen the stop_mode CHECK with 'app_failed' (failed brew-by-weight stop).
  // Runs last so the table rebuild preserves every column added above.
  migrateStopModeAddAppFailed(db);

  // Widen the stop_mode CHECK with 'watchdog' (BBW safety watchdog re-fire, 3m).
  // Runs after app_failed AND after profile_name/profile_set_temp_c are added —
  // its rebuild lists those columns explicitly so they survive (see fn comment).
  migrateStopModeAddWatchdog(db);

  // Widen the stop_mode CHECK with 'flowhold'/'flowhold_watchdog' (Flow-Hold
  // drive normal-exit / watchdog hard-stop). Runs last: its rebuild mirrors the
  // full current column shape incl. channeling + scale_frozen (see fn comment).
  migrateStopModeAddFlowhold(db);

  // Drop NOT NULL on shot.script_id so app-driven step-based brews (Cut-2) can
  // record with script_id = NULL (no dummy-script piggyback). Runs after the
  // flowhold rebuild so it mirrors the full current shape (see fn comment).
  migrateShotScriptIdNullable(db);

  // ---------------------------------------------------------------------------
  // shot_sample — phase marker (Spec §4.12 / Lücke 5; sub-phases added 2026-06-27)
  // 'preinfusion'/'extraction' split a brewing sample by pressure; 'post_brew' is
  // the post-brew tracking phase. Legacy 'brewing' rows (pre-split) stay valid.
  // Fresh DBs get the widened CHECK here; existing DBs are rebuilt below.
  // ---------------------------------------------------------------------------
  addColumnIfMissing(
    db,
    "shot_sample",
    "phase",
    "TEXT NOT NULL DEFAULT 'brewing' CHECK(phase IN ('brewing','preinfusion','extraction','post_brew'))",
  );

  // ---------------------------------------------------------------------------
  // shot_sample — pump power level % (PU_LEVEL_PW_CONTROL, frame.pumpPwm).
  // Logged per sample so the power(%)↔pressure(bar) relationship can be derived
  // empirically and replace the assumed powerToBar() curve (SE-2b). NULL on old
  // samples (was never recorded). addColumnIfMissing, no rebuild/backfill.
  // ---------------------------------------------------------------------------
  addColumnIfMissing(db, "shot_sample", "pump_pwm", "REAL");

  // Freitext-Bohne am Bezug: fuer Bohnen, die hier bewusst nicht gepflegt
  // werden (Turbo mit Filterbohne, Pourover). Bewusst eine Spalte am Bezug und
  // keine Schatten-Sorte — sonst waechst die Bohnenliste mit Eintraegen, die
  // niemand pflegt, und der Bestand rechnet mit Phantomen.
  addColumnIfMissing(db, "shot", "bean_label", "TEXT");

  // Channeling-Staerke (2026-09-26): die Ja/Nein-Marke war bei 64 % der
  // bewerteten Bezuege gesetzt und trennte nichts mehr. `channeling` bleibt als
  // Marke bestehen, die Staerke kommt daneben. Altbestand = NULL (unbekannt),
  // bewusst kein Backfill. Steht HINTER allen shot-Neuaufbauten mit fester
  // Spaltenliste, sonst ginge die Spalte bei einem frischen Aufbau verloren.
  migrateChannelingSeverity(db);

  // Widen the shot_sample.phase CHECK with the pre-infusion/extraction sub-phases.
  // Runs after phase AND pump_pwm are added so the rebuild lists both explicitly.
  migratePhaseAddSubphases(db);

  // Backfill historical 'brewing' samples into preinfusion/extraction (same latch
  // as the live recorder). Runs after the CHECK is widened. Idempotent.
  backfillSamplePhases(db);

  // ---------------------------------------------------------------------------
  // Auto-calibration history (Spec §4.12 / Lücke 2)
  // Append-only audit log of BBW residual-lag auto-calibration runs. One row
  // per calibration run that passed the gates — including no-change runs
  // (calibration_applied=0), so lag convergence/stability is observable.
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_calibration_log (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      shot_id                 INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
      created_at              INTEGER NOT NULL,   -- unix ms
      old_lag_s               REAL    NOT NULL,
      new_lag_s               REAL    NOT NULL,
      weight_error_g          REAL    NOT NULL,   -- final − target (+over / −under)
      flow_at_trigger_g_per_s REAL    NOT NULL,
      calibration_applied     INTEGER NOT NULL    -- 1 if new_lag ≠ old_lag, else 0
    );

    CREATE INDEX IF NOT EXISTS idx_autocal_shot_id ON auto_calibration_log(shot_id);

    -- Rückspül-Reminder: ÄW-B maintenance runs are not shots; log them here so
    -- the backflush reminder knows when a designated script last ran. Append-only.
    CREATE TABLE IF NOT EXISTS maintenance_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id     INTEGER,             -- maintenance script that ran
      profile_id    INTEGER,             -- profile it was started from
      script_title  TEXT,                -- title snapshot (may be renamed/deleted)
      ran_at        INTEGER NOT NULL     -- unix ms
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_log_ran_at ON maintenance_log(ran_at);

    -- Flow-Hold stage transitions (Soll-Kurve History). One row per stage the
    -- driver actually ENTERED (index 0 = first step, then each stage_advance),
    -- so the History can draw which target plateaus really ran and which planned
    -- ones never did. NOT derivable from shot_sample.phase (that only splits
    -- preinfusion/extraction/post_brew, not the flow 1.1→1.0→0.8→0.7 stages).
    -- exit_reason = which StepExit branch fired to LEAVE this stage (NULL for the
    -- final/master-stop stage). Append-only; written once at shot finalize.
    CREATE TABLE IF NOT EXISTS shot_stage (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      shot_id             INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
      stage_index         INTEGER NOT NULL,   -- 0-based step index in the BrewProfile
      step_kind           TEXT    NOT NULL CHECK(step_kind IN ('flow','pressure','power')),
      target_flow_gs      REAL,               -- set for flow steps
      target_pressure_bar REAL,               -- set for pressure steps
      target_power        REAL,               -- set for power steps
      exit_reason         TEXT,               -- which exit fired ('seconds'|'weightG'|'pressureBar'|'flowGs'|'master_stop'); NULL if unknown
      entered_ms          INTEGER NOT NULL    -- ms since shot.started_at when this stage was entered
    );
    CREATE INDEX IF NOT EXISTS idx_shot_stage_shot_id ON shot_stage(shot_id);

    -- Brew definition a shot actually ran, content-addressed. A script shot only
    -- referenced script_id, and xenia_script.content is overwritten by the next
    -- sync — so editing a script on the machine silently rewrote the history of
    -- every past shot pointing at it. Keyed by content hash, so identical
    -- definitions share one row and two shots are comparable iff their hash is
    -- equal. kind 'script' = the raw Xenia token string, kind 'steps' = the
    -- canonical BrewProfile JSON of a flow-hold drive.
    CREATE TABLE IF NOT EXISTS brew_def (
      hash          TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK(kind IN ('script','steps')),
      content       TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL   -- unix ms
    );
  `);

  // Steht hinter brew_def UND shot.brew_def_hash (addColumnIfMissing weiter oben).
  migrateBrewDefCanonical(db);

  // ---------------------------------------------------------------------------
  // Coffee (Sorte) + Bean (Röstung) — §3.4b
  // `coffee` is the canonical "Klammer" (master data, favourite, canonical
  // rating); `bean` is repurposed as a roasting/charge pointing at one coffee.
  // Fresh DBs get this shape directly; pre-§3.4b flat-bean DBs are converted by
  // migrateCoffeeSorteRoestung() right after these creates.
  //
  // NOTE: bean indexes are created AFTER the migration (below), because on a
  // pre-§3.4b DB the `bean` table here is the old flat shape (no coffee_id) and
  // an idx on coffee_id would fail until the rebuild has happened.
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS coffee (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      roaster         TEXT,
      country         TEXT,
      region          TEXT,
      farm            TEXT,
      variety         TEXT,
      processing      TEXT,
      altitude_min    INTEGER,
      altitude_max    INTEGER,
      roast_level     TEXT CHECK(roast_level IN ('light','light-medium','medium','medium-dark','dark')),
      brew_type       TEXT CHECK(brew_type IN ('espresso','filter','omni')),
      flavor_notes    TEXT,               -- JSON array of strings
      notes           TEXT,               -- general coffee note (e.g. "8 Tage ruhen, Blend")
      favourite       INTEGER NOT NULL DEFAULT 0,
      rating          TEXT CHECK(rating IN ('thumbs_down','meh','thumbs_up')),  -- canonical
      created_at      INTEGER NOT NULL,   -- unix ms
      updated_at      INTEGER NOT NULL    -- unix ms
    );

    CREATE INDEX IF NOT EXISTS idx_coffee_updated_at ON coffee(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_coffee_favourite  ON coffee(favourite DESC);

    -- bean = "Röstung" (charge/bag). All master data lives on coffee.
    -- §3g: status is the PHYSICAL axis (stock/frozen/thawed/archived); the
    -- "active source" axis is the separate free flag is_active.
    CREATE TABLE IF NOT EXISTS bean (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      coffee_id         INTEGER NOT NULL REFERENCES coffee(id) ON DELETE RESTRICT,
      roast_date        TEXT,                -- ISO 8601 YYYY-MM-DD
      bag_size_g        REAL,
      remaining_g       REAL,
      price_per_bag_eur REAL,               -- per roasting — price varies between buys
      status            TEXT    NOT NULL DEFAULT 'stock'
                          CHECK(status IN ('stock','frozen','thawed','archived')),
      is_active         INTEGER NOT NULL DEFAULT 0,  -- §3g: active-source flag (free, any number)
      frozen_date       TEXT,               -- ISO 8601
      thaw_date         TEXT,               -- ISO 8601
      rating            TEXT CHECK(rating IN ('thumbs_down','meh','thumbs_up')),  -- charge override; NULL = inherit coffee.rating
      created_at        INTEGER NOT NULL,   -- unix ms
      updated_at        INTEGER NOT NULL    -- unix ms
    );
  `);

  // Convert pre-§3.4b flat beans → coffee + roasting (idempotent).
  migrateCoffeeSorteRoestung(db);

  // §3g: split the conflated 'active' status into status (physical) + is_active.
  migrateBeanStatusTwoAxis(db);

  // bean indexes — safe now that bean always has coffee_id (fresh or migrated).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bean_coffee_id  ON bean(coffee_id);
    CREATE INDEX IF NOT EXISTS idx_bean_updated_at ON bean(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bean_status     ON bean(status);
    CREATE INDEX IF NOT EXISTS idx_bean_is_active  ON bean(is_active);
  `);

  // Restbestand wird aus den Bezügen abgeleitet (bean-repo BEAN_SELECT), nicht
  // fortgeschrieben. remaining_g ist nur noch der manuelle Korrektur-Anker und
  // gilt ab remaining_set_at — abgezogen werden ausschliesslich Bezüge danach.
  // NULL = nie von Hand korrigiert, dann ist die Beutelgrösse der Anker und
  // alle Bezüge zählen. addColumnIfMissing, kein Rebuild/Backfill.
  addColumnIfMissing(db, "bean", "remaining_set_at", "INTEGER");

  // Aufgebraucht-Hinweis pro Roestung weggeklickt (unix ms). Bewusst nicht als
  // globaler Snooze-Key wie beim Rueckspuel-Reminder: die Bedingung haengt an
  // einer einzelnen Roestung. Wird beim Korrigieren von Restmenge oder
  // Beutelgroesse zurueckgesetzt, damit der Hinweis wiederkommen kann.
  addColumnIfMissing(db, "bean", "stock_alert_dismissed_at", "INTEGER");

  // ---------------------------------------------------------------------------
  // Coffee image — one photo per Sorte, in its own table on purpose: the coffee
  // row is read with `c.*` all over the place and a BLOB in there would drag the
  // image through every list query. In the DB rather than on disk because it is
  // tiny (a handful of coffees, ~150 kB each after the browser downscales) and
  // this way it rides along in the daily `sqlite3 .backup` instead of needing a
  // second backup path of its own.
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS coffee_image (
      coffee_id  INTEGER PRIMARY KEY REFERENCES coffee(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      bytes      BLOB NOT NULL,
      updated_at INTEGER NOT NULL   -- unix ms, doubles as the cache buster
    );
  `);

  // ---------------------------------------------------------------------------
  // Best Brew (BB-a) — per-Sorte reference pointer to one shot.
  // Exactly one reference per coffee (coffee_id PRIMARY KEY → upsert moves the
  // star). Pure pointer, no snapshot: the reference values are live-joined from
  // the shot. Both FKs cascade ONTO the pointer only — deleting the shot or the
  // coffee removes the reference, but never the reverse (shot/coffee history is
  // untouched). Fresh + existing DBs alike get this via CREATE IF NOT EXISTS.
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS best_brew (
      coffee_id  INTEGER PRIMARY KEY REFERENCES coffee(id) ON DELETE CASCADE,
      shot_id    INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL   -- unix ms when flagged
    );

    CREATE INDEX IF NOT EXISTS idx_best_brew_shot_id ON best_brew(shot_id);
  `);

  // ---------------------------------------------------------------------------
  // Grinder table (Phase 1 Step 8)
  // ---------------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS grinder (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      supports_rpm INTEGER NOT NULL DEFAULT 0,
      rpm_min      INTEGER,
      rpm_max      INTEGER,
      notes        TEXT,
      created_at   INTEGER NOT NULL,   -- unix ms
      updated_at   INTEGER NOT NULL    -- unix ms
    );

    CREATE INDEX IF NOT EXISTS idx_grinder_name ON grinder(name ASC);
  `);
}
