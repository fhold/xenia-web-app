import { getDb } from "./index.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SettingsRepo {
  /** Returns the value for a single key, or undefined if not found. */
  get(key: string): string | undefined;

  /** Returns all settings as a key→value map. */
  getAll(): Map<string, string>;

  /**
   * Inserts key/value only if the key does not already exist.
   * Use this during seeding so user-edited values are never overwritten.
   */
  insertIfAbsent(key: string, value: string): void;

  /**
   * Unconditionally writes key/value and bumps updated_at.
   * Use this for explicit user-triggered changes (e.g. from the Settings UI).
   */
  set(key: string, value: string): void;

  /** Removes a key. Absent keys are not an error. */
  delete(key: string): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteSettingsRepo implements SettingsRepo {
  get(key: string): string | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  getAll(): Map<string, string> {
    const db = getDb();
    const rows = db
      .prepare("SELECT key, value FROM settings")
      .all() as { key: string; value: string }[];
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  insertIfAbsent(key: string, value: string): void {
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
    ).run(key, value);
  }

  set(key: string, value: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      updated_at = CURRENT_TIMESTAMP`,
    ).run(key, value);
  }

  delete(key: string): void {
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
