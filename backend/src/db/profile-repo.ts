import { getDb } from "./index.js";
import { saveVariants, syncProfileVariants, variantsByProfile, variantsOf } from "./variant-repo.js";
import type { Profile, ProfileCreate, ProfileUpdate } from "../../../shared/src/types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ProfileRepo {
  insert(profile: ProfileCreate): number;
  findById(id: number): Profile | undefined;
  /** Sorted: favorites first, each group by sort_order ASC (unset last, then updated_at DESC). */
  listAll(): Profile[];
  update(id: number, patch: ProfileUpdate): void;
  delete(id: number): void;
  /** Max 5, sorted by favoriteOrder ASC. */
  listFavorites(): Profile[];
  /** Sets sort_order for each ID in the given order (0, 1, 2, ...) — favorites
   *  and the rest alike; listAll keeps favorites on top regardless. */
  reorder(orderedIds: number[]): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteProfileRepo implements ProfileRepo {
  insert(profile: ProfileCreate): number {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO profile
           (name, kind, trial, description, script_single, script_double,
            yield_single_g, yield_double_g, fav, sort_order, notes, target_temp_c,
            brew_steps, brew_steps_double)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.name,
        profile.kind ?? "brew",
        profile.isTrial ? 1 : 0,
        null, // description always null in V1 — no editor field yet
        profile.scriptIdSingle ?? null,
        profile.scriptIdDouble ?? null,
        profile.yieldTargetSingleG ?? null,
        profile.yieldTargetDoubleG ?? null,
        (profile.isFavorite ?? false) ? 1 : 0,
        profile.favoriteOrder ?? null,
        profile.notes ?? null,
        profile.targetTempC ?? null,
        profile.brewSteps ? JSON.stringify(profile.brewSteps) : null,
        profile.brewStepsDouble ? JSON.stringify(profile.brewStepsDouble) : null,
      ) as { lastInsertRowid: number };
    // Mit Varianten (Schnitt 3c) fuehren sie und leiten die Kurven-Spalten ab;
    // sonst entstehen sie aus den Spalten wie bisher.
    if (profile.variants) saveVariants(Number(result.lastInsertRowid), profile.variants);
    else syncProfileVariants(Number(result.lastInsertRowid));
    return result.lastInsertRowid;
  }

  findById(id: number): Profile | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM profile WHERE id = ?")
      .get(id) as unknown as RawProfileRow | undefined;
    return row ? { ...toProfile(row), variants: variantsOf(id) } : undefined;
  }

  listAll(): Profile[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM profile
         ORDER BY fav DESC, sort_order ASC NULLS LAST, updated_at DESC`,
      )
      .all() as unknown as RawProfileRow[];
    const variants = variantsByProfile();
    return rows.map((r) => ({ ...toProfile(r), variants: variants.get(r.id) ?? [] }));
  }

  update(id: number, patch: ProfileUpdate): void {
    const db = getDb();

    // isFavorite toggle: auto-manages sort_order so the list stays contiguous.
    if (patch.isFavorite !== undefined) {
      const cur = db.prepare("SELECT fav FROM profile WHERE id = ?")
        .get(id) as { fav: number } | undefined;
      if (!cur) return;

      if (patch.isFavorite && cur.fav === 0) {
        // Append to end of favorites (unless caller explicitly provides favoriteOrder).
        const r = db.prepare("SELECT MAX(sort_order) AS m FROM profile WHERE fav = 1")
          .get() as { m: number | null };
        const order = patch.favoriteOrder ?? (r.m ?? -1) + 1;
        db.prepare(
          "UPDATE profile SET fav = 1, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).run(order, id);
      } else if (!patch.isFavorite && cur.fav === 1) {
        // Remove from favorites; clear slot and renumber the rest contiguously.
        db.prepare(
          "UPDATE profile SET fav = 0, sort_order = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).run(id);
        const remaining = db.prepare(
          "SELECT id FROM profile WHERE fav = 1 ORDER BY sort_order ASC NULLS LAST, id ASC",
        ).all() as { id: number }[];
        if (remaining.length > 0) {
          const stmt = db.prepare(
            "UPDATE profile SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          );
          db.exec("BEGIN");
          try {
            remaining.forEach((row, i) => stmt.run(i, row.id));
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        }
      }
      // isFavorite and favoriteOrder are now fully handled — fall through to
      // the generic path only for any remaining fields (name, scripts, yields).
    }

    // Generic field update — isFavorite and favoriteOrder excluded here;
    // include favoriteOrder only for standalone reorder calls (no isFavorite).
    const columnMap: Record<string, string> = {
      name:               "name",
      kind:               "kind",
      isTrial:            "trial",
      scriptIdSingle:     "script_single",
      scriptIdDouble:     "script_double",
      yieldTargetSingleG: "yield_single_g",
      yieldTargetDoubleG: "yield_double_g",
      notes:              "notes",
      targetTempC:        "target_temp_c",
      brewSteps:          "brew_steps",
      brewStepsDouble:    "brew_steps_double",
      ...(patch.isFavorite === undefined ? { favoriteOrder: "sort_order" } : {}),
    };

    // Mit Varianten (Schnitt 3c) leiten sich die Kurven-Spalten aus ihnen ab.
    const curveFields = ["scriptIdSingle", "scriptIdDouble", "yieldTargetSingleG", "yieldTargetDoubleG", "brewSteps", "brewStepsDouble"];
    const entries = Object.entries(patch).filter(([k]) => k in columnMap && !(patch.variants && curveFields.includes(k)));

    if (entries.length > 0) {
      const setClauses = entries
        .map(([k]) => `${columnMap[k]} = ?`)
        .concat("updated_at = CURRENT_TIMESTAMP");

      const values: (null | number | string)[] = entries.map(([k, v]) => {
        if (k === "brewSteps" || k === "brewStepsDouble") return v ? JSON.stringify(v) : null;
        if (k === "isTrial") return v ? 1 : 0;
        return (v as null | number | string) ?? null;
      });

      db.prepare(`UPDATE profile SET ${setClauses.join(", ")} WHERE id = ?`).run(...values, id);
    }
    if (patch.variants) saveVariants(id, patch.variants);
    // Ein alter Schreiber aendert die Kurven-Spalten: in die Varianten ihrer
    // Plaetze uebernehmen. Name, Favorit, Notiz … beruehren die Varianten nicht.
    else if (entries.some(([k]) => curveFields.includes(k))) syncProfileVariants(id);
  }

  delete(id: number): void {
    const db = getDb();
    db.prepare("DELETE FROM profile WHERE id = ?").run(id);
  }

  listFavorites(): Profile[] {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM profile WHERE fav = 1 ORDER BY sort_order ASC NULLS LAST LIMIT 5",
      )
      .all() as unknown as RawProfileRow[];
    const variants = variantsByProfile();
    return rows.map((r) => ({ ...toProfile(r), variants: variants.get(r.id) ?? [] }));
  }

  reorder(orderedIds: number[]): void {
    if (orderedIds.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(
      "UPDATE profile SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    );
    // node:sqlite has no .transaction() — use explicit BEGIN/COMMIT
    db.exec("BEGIN");
    try {
      orderedIds.forEach((id, i) => stmt.run(i, id));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal row → domain mapping
// ---------------------------------------------------------------------------

interface RawProfileRow {
  id: number;
  name: string;
  kind: "brew" | "maintenance";
  trial: number;
  description: string | null;
  icon: string | null; // column exists in DB, intentionally ignored
  script_single: number | null;
  script_double: number | null;
  yield_single_g: number | null;
  yield_double_g: number | null;
  fav: number;
  sort_order: number | null;
  notes: string | null;
  target_temp_c: number | null;
  brew_steps: string | null;
  brew_steps_double: string | null;
  created_at: string;
  updated_at: string;
}

function toProfile(row: RawProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    isTrial: row.trial === 1,
    description: row.description,
    scriptIdSingle: row.script_single, // null = flow-driven profile (brewSteps)
    scriptIdDouble: row.script_double,
    yieldTargetSingleG: row.yield_single_g,
    yieldTargetDoubleG: row.yield_double_g,
    isFavorite: row.fav === 1,
    favoriteOrder: row.sort_order,
    notes: row.notes ?? null,
    targetTempC: row.target_temp_c ?? null,
    brewSteps: row.brew_steps ? JSON.parse(row.brew_steps) : null,
    brewStepsDouble: row.brew_steps_double ? JSON.parse(row.brew_steps_double) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
