import { getDb } from "./index.js";
import type { Grinder, GrinderCreate, GrinderUpdate } from "../../../shared/src/types.js";

// ---------------------------------------------------------------------------
// Raw DB row shape
// ---------------------------------------------------------------------------

interface RawGrinderRow {
  id: number;
  name: string;
  supports_rpm: number;
  rpm_min: number | null;
  rpm_max: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

function toGrinder(row: RawGrinderRow): Grinder {
  return {
    id: row.id,
    name: row.name,
    supportsRpm: row.supports_rpm === 1,
    rpmMin: row.rpm_min,
    rpmMax: row.rpm_max,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface GrinderRepo {
  insert(grinder: GrinderCreate): number;
  findById(id: number): Grinder | undefined;
  /** Sorted by name ASC. */
  listAll(): Grinder[];
  update(id: number, patch: GrinderUpdate): void;
  delete(id: number): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteGrinderRepo implements GrinderRepo {
  insert(grinder: GrinderCreate): number {
    const db = getDb();
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT INTO grinder
           (name, supports_rpm, rpm_min, rpm_max, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grinder.name,
        (grinder.supportsRpm ?? false) ? 1 : 0,
        grinder.rpmMin ?? null,
        grinder.rpmMax ?? null,
        grinder.notes ?? null,
        now,
        now,
      ) as { lastInsertRowid: number };
    return result.lastInsertRowid;
  }

  findById(id: number): Grinder | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM grinder WHERE id = ?")
      .get(id) as unknown as RawGrinderRow | undefined;
    return row ? toGrinder(row) : undefined;
  }

  listAll(): Grinder[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM grinder ORDER BY name ASC")
      .all() as unknown as RawGrinderRow[];
    return rows.map(toGrinder);
  }

  update(id: number, patch: GrinderUpdate): void {
    const db = getDb();
    const now = Date.now();

    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (patch.name !== undefined)       { fields.push("name = ?");         values.push(patch.name); }
    if (patch.supportsRpm !== undefined){ fields.push("supports_rpm = ?"); values.push(patch.supportsRpm ? 1 : 0); }
    if (patch.rpmMin !== undefined)     { fields.push("rpm_min = ?");      values.push(patch.rpmMin ?? null); }
    if (patch.rpmMax !== undefined)     { fields.push("rpm_max = ?");      values.push(patch.rpmMax ?? null); }
    if (patch.notes !== undefined)      { fields.push("notes = ?");        values.push(patch.notes ?? null); }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);

    db.prepare(`UPDATE grinder SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  delete(id: number): void {
    const db = getDb();
    db.prepare("DELETE FROM grinder WHERE id = ?").run(id);
  }
}
