import { getDb } from "./index.js";
import type { BestBrewSummary } from "../../../shared/src/types.js";

// ---------------------------------------------------------------------------
// BB-a — Best Brew reference repository. One reference per Sorte (coffee):
// `best_brew.coffee_id` is the PK, so setting a new reference upserts (moves the
// star). The reference is a pure pointer into the shot; summary values are
// aggregated live from the shot's samples (BC-1 semantics: peak/avg over
// non-post_brew frames, brew time = last non-post_brew sample).
// ---------------------------------------------------------------------------

export type SetBestBrewResult =
  | { ok: true; coffeeId: number }
  | { ok: false; error: string };

export interface BestBrewRepo {
  /**
   * Set/move the reference from a shotId: derives the Sorte via
   * shot → bean → coffee and upserts (replaces any existing reference of the
   * same Sorte). Rejects non-brew shots and shots with no resolvable Sorte.
   */
  setByShot(shotId: number): SetBestBrewResult;
  /** Remove the reference that points at this shot. Returns true if one existed. */
  unsetByShot(shotId: number): boolean;
  /** Remove the reference of this Sorte. Returns true if one existed. */
  unsetByCoffee(coffeeId: number): boolean;
  /** True if this shot is currently a best-brew reference. */
  isBestBrewShot(shotId: number): boolean;
  /** Live-joined reference summary for a Sorte, or null if none/shot gone. */
  getSummary(coffeeId: number): BestBrewSummary | null;
}

interface RawSummaryRow {
  shot_id: number;
  created_at: number;
  dose_g: number | null;
  yield_actual_g: number | null;
  profile_name: string | null;
  live_profile_name: string | null;
  max_elapsed_ms: number | null;
  peak_pressure: number | null;
  avg_temp: number | null;
}

export class SqliteBestBrewRepo implements BestBrewRepo {
  setByShot(shotId: number): SetBestBrewResult {
    const db = getDb();
    // Derive the Sorte (coffee) via shot → bean → coffee. A shot with no bean
    // (or a deleted bean, ON DELETE SET NULL) yields no row → not flaggable.
    const row = db
      .prepare(
        `SELECT s.category AS category, b.coffee_id AS coffee_id
           FROM shot s
           JOIN bean b ON b.id = s.bean_id
          WHERE s.id = ?`,
      )
      .get(shotId) as { category: string; coffee_id: number } | undefined;

    if (!row) {
      // Distinguish "no shot" from "shot without a resolvable Sorte".
      const exists = db.prepare("SELECT 1 FROM shot WHERE id = ?").get(shotId);
      return exists
        ? { ok: false, error: "Shot has no resolvable Sorte (no bean/roasting)" }
        : { ok: false, error: `Shot ${shotId} not found` };
    }
    if (row.category !== "brew") {
      return { ok: false, error: "Only brew shots can be flagged as best brew" };
    }

    db.prepare(
      `INSERT INTO best_brew (coffee_id, shot_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(coffee_id)
         DO UPDATE SET shot_id = excluded.shot_id, created_at = excluded.created_at`,
    ).run(row.coffee_id, shotId, Date.now());

    return { ok: true, coffeeId: row.coffee_id };
  }

  unsetByShot(shotId: number): boolean {
    const db = getDb();
    const res = db
      .prepare("DELETE FROM best_brew WHERE shot_id = ?")
      .run(shotId) as { changes: number | bigint };
    return Number(res.changes) > 0;
  }

  unsetByCoffee(coffeeId: number): boolean {
    const db = getDb();
    const res = db
      .prepare("DELETE FROM best_brew WHERE coffee_id = ?")
      .run(coffeeId) as { changes: number | bigint };
    return Number(res.changes) > 0;
  }

  isBestBrewShot(shotId: number): boolean {
    const db = getDb();
    return db.prepare("SELECT 1 FROM best_brew WHERE shot_id = ?").get(shotId) !== undefined;
  }

  getSummary(coffeeId: number): BestBrewSummary | null {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT bb.shot_id, bb.created_at,
                s.dose_g, s.yield_actual_g, s.profile_name,
                p.name AS live_profile_name,
                (SELECT MAX(ss.elapsed_ms) FROM shot_sample ss
                   WHERE ss.shot_id = s.id AND ss.phase != 'post_brew') AS max_elapsed_ms,
                (SELECT MAX(ss.pressure_bar) FROM shot_sample ss
                   WHERE ss.shot_id = s.id AND ss.phase != 'post_brew') AS peak_pressure,
                (SELECT AVG(ss.temp_bg_c) FROM shot_sample ss
                   WHERE ss.shot_id = s.id AND ss.phase != 'post_brew'
                     AND ss.temp_bg_c IS NOT NULL) AS avg_temp
           FROM best_brew bb
           JOIN shot s ON s.id = bb.shot_id
           LEFT JOIN profile p ON p.id = s.profile_id
          WHERE bb.coffee_id = ?`,
      )
      .get(coffeeId) as RawSummaryRow | undefined;

    if (!row) return null;

    const ratio =
      row.dose_g !== null && row.dose_g > 0 && row.yield_actual_g !== null
        ? row.yield_actual_g / row.dose_g
        : null;

    return {
      shotId: row.shot_id,
      brewTimeS: row.max_elapsed_ms !== null ? row.max_elapsed_ms / 1000 : null,
      ratio,
      peakPressureBar: row.peak_pressure,
      avgTempC: row.avg_temp,
      profileName: row.live_profile_name ?? row.profile_name,
      createdAt: row.created_at,
    };
  }
}
