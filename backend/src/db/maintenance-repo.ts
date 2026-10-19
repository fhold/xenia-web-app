import { getDb } from "./index.js";

/**
 * ÄW-B maintenance runs are deliberately NOT recorded as shots. This append-only
 * log captures every app-initiated maintenance run (script + profile it was
 * started from) so features like the backflush reminder can tell when a given
 * script was last run. No shot-table touch.
 */
export interface MaintenanceRunInput {
  scriptId: number | null;
  profileId: number | null;
  /** Title snapshot — the script may later be renamed or deleted. */
  scriptTitle: string | null;
  ranAt: number; // unix ms
}

export interface MaintenanceLogRepo {
  insert(entry: MaintenanceRunInput): void;
  /** Newest ran_at across the given profile ids, or null if none logged. */
  lastRanAt(profileIds: number[]): number | null;
}

export class SqliteMaintenanceLogRepo implements MaintenanceLogRepo {
  insert(entry: MaintenanceRunInput): void {
    getDb()
      .prepare(
        `INSERT INTO maintenance_log (script_id, profile_id, script_title, ran_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(entry.scriptId, entry.profileId, entry.scriptTitle, entry.ranAt);
  }

  lastRanAt(profileIds: number[]): number | null {
    if (profileIds.length === 0) return null;
    const placeholders = profileIds.map(() => "?").join(",");
    const row = getDb()
      .prepare(
        `SELECT MAX(ran_at) AS last FROM maintenance_log WHERE profile_id IN (${placeholders})`,
      )
      .get(...profileIds) as { last: number | null } | undefined;
    return row?.last ?? null;
  }
}
