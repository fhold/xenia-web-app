import { getDb } from "./index.js";
import type { ParsedScript, XeniaScript } from "../../../shared/src/types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ScriptRepo {
  upsert(script: XeniaScript): void;
  findById(id: number): XeniaScript | undefined;
  /** @param includeOrphaned - when false (default), excludes orphaned scripts */
  listAll(includeOrphaned?: boolean): XeniaScript[];
  /** Marks a script as no longer present on the Xenia (soft-delete). */
  markOrphaned(id: number, at: number): void;
  /** Shallow list-sync: update the title + un-orphan, without touching content. */
  updateTitle(id: number, title: string): void;
  /** SE-2: set/clear the manual category override (local metadata only). */
  setCategoryOverride(id: number, override: "brew" | "maintenance" | null): void;
  /** Returns IDs of non-orphaned scripts whose ID is NOT in activeIds. */
  findIdsNotIn(activeIds: number[]): number[];
  /** Hard-deletes all orphaned scripts that have no referencing shots or profiles.
   *  Returns { deleted: number[], blocked: BlockedScript[] }. */
  deleteOrphaned(): { deleted: number[]; blocked: BlockedScript[] };
}

export interface BlockedScript {
  id: number;
  title: string;
  shotCount: number;
  profileCount: number;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteScriptRepo implements ScriptRepo {
  upsert(script: XeniaScript): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO xenia_script
         (id, title, content, parsed_cmds, has_cmd27, cmd27_value,
          category_auto, fetched_at, orphaned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         -- Ein verwaister Platz, den die Maschine neu belegt, traegt ein NEUES
         -- Skript: die von Hand gesetzte Kategorie des alten verfaellt. (SQLite
         -- wertet alle Zuweisungen gegen die alte Zeile aus.)
         category_override = CASE WHEN xenia_script.orphaned_at IS NOT NULL
                                  THEN NULL ELSE xenia_script.category_override END,
         title         = excluded.title,
         content       = excluded.content,
         parsed_cmds   = excluded.parsed_cmds,
         has_cmd27     = excluded.has_cmd27,
         cmd27_value   = excluded.cmd27_value,
         category_auto = excluded.category_auto,
         fetched_at    = excluded.fetched_at,
         orphaned_at   = excluded.orphaned_at`,
    ).run(
      script.id,
      script.title,
      script.content,
      script.parsedCmds !== null ? JSON.stringify(script.parsedCmds) : null,
      script.hasCmd27 ? 1 : 0,
      script.cmd27Value,
      script.categoryAuto,
      script.fetchedAt,
      script.orphanedAt,
    );
  }

  findById(id: number): XeniaScript | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM xenia_script WHERE id = ?")
      .get(id) as unknown as RawScriptRow | undefined;
    return row ? toScript(row) : undefined;
  }

  listAll(includeOrphaned = false): XeniaScript[] {
    const db = getDb();
    const sql = includeOrphaned
      ? "SELECT * FROM xenia_script ORDER BY id"
      : "SELECT * FROM xenia_script WHERE orphaned_at IS NULL ORDER BY id";
    const rows = db.prepare(sql).all() as unknown as RawScriptRow[];
    return rows.map(toScript);
  }

  markOrphaned(id: number, at: number): void {
    const db = getDb();
    db.prepare("UPDATE xenia_script SET orphaned_at = ? WHERE id = ?").run(
      at,
      id,
    );
  }

  updateTitle(id: number, title: string): void {
    const db = getDb();
    db.prepare(
      // Un-orphan = neues Skript auf dem Platz → alte manuelle Kategorie verfaellt (wie in upsert).
      "UPDATE xenia_script SET title = ?, category_override = CASE WHEN orphaned_at IS NOT NULL THEN NULL ELSE category_override END, orphaned_at = NULL, fetched_at = ? WHERE id = ?",
    ).run(title, Date.now(), id);
  }

  setCategoryOverride(id: number, override: "brew" | "maintenance" | null): void {
    const db = getDb();
    db.prepare("UPDATE xenia_script SET category_override = ? WHERE id = ?").run(
      override,
      id,
    );
  }

  deleteOrphaned(): { deleted: number[]; blocked: BlockedScript[] } {
    const db = getDb();
    const orphans = db
      .prepare("SELECT id, title FROM xenia_script WHERE orphaned_at IS NOT NULL")
      .all() as unknown as { id: number; title: string }[];

    const deleted: number[] = [];
    const blocked: BlockedScript[] = [];

    for (const s of orphans) {
      const shotCount = (
        db.prepare("SELECT COUNT(*) as n FROM shot WHERE script_id = ?").get(s.id) as { n: number }
      ).n;
      // Auch Varianten ab der dritten — die alten Spalten kennen nur die ersten beiden.
      const profileCount = (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM profile p WHERE p.script_single = ? OR p.script_double = ?
               OR EXISTS (SELECT 1 FROM profile_variant v WHERE v.profile_id = p.id AND v.script_id = ?)`,
          )
          .get(s.id, s.id, s.id) as { n: number }
      ).n;

      if (shotCount === 0 && profileCount === 0) {
        db.prepare("DELETE FROM xenia_script WHERE id = ?").run(s.id);
        deleted.push(s.id);
      } else {
        blocked.push({ id: s.id, title: s.title, shotCount, profileCount });
      }
    }

    return { deleted, blocked };
  }

  findIdsNotIn(activeIds: number[]): number[] {
    const db = getDb();
    if (activeIds.length === 0) {
      // All non-orphaned scripts become orphans
      const rows = db
        .prepare("SELECT id FROM xenia_script WHERE orphaned_at IS NULL")
        .all() as unknown as { id: number }[];
      return rows.map((r) => r.id);
    }
    // SQLite doesn't support array binding — build placeholders manually
    const placeholders = activeIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id FROM xenia_script
         WHERE orphaned_at IS NULL AND id NOT IN (${placeholders})`,
      )
      .all(...activeIds) as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }
}

// ---------------------------------------------------------------------------
// Internal row → domain mapping
// ---------------------------------------------------------------------------

interface RawScriptRow {
  id: number;
  title: string;
  content: string;
  parsed_cmds: string | null;
  has_cmd27: number;
  cmd27_value: number | null;
  category_auto: string | null;
  category_override: string | null;
  fetched_at: number;
  orphaned_at: number | null;
}

function toScript(row: RawScriptRow): XeniaScript {
  let parsedCmds: ParsedScript | null = null;
  if (row.parsed_cmds !== null) {
    try {
      parsedCmds = JSON.parse(row.parsed_cmds) as ParsedScript;
    } catch {
      parsedCmds = null;
    }
  }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    parsedCmds,
    hasCmd27: row.has_cmd27 === 1,
    cmd27Value: row.cmd27_value,
    categoryAuto: row.category_auto as XeniaScript["categoryAuto"],
    categoryOverride: (row.category_override ?? null) as XeniaScript["categoryOverride"],
    fetchedAt: row.fetched_at,
    orphanedAt: row.orphaned_at,
  };
}
