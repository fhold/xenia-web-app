import { getDb } from "./index.js";
import type { Basket, BasketCreate, BasketType, BasketUpdate } from "../../../shared/src/types.js";

// ---------------------------------------------------------------------------
// Raw DB row shape
// ---------------------------------------------------------------------------

interface RawBasketRow {
  id: number;
  name: string;
  type: BasketType;
  description: string | null;
  nominal_dose_g: number | null;
  created_at: number;
  updated_at: number;
}

function toBasket(row: RawBasketRow): Basket {
  return {
    id: row.id, name: row.name, type: row.type, description: row.description ?? null, nominalDoseG: row.nominal_dose_g ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// SQLite implementation — wie die Muehlen (grinder-repo.ts)
// ---------------------------------------------------------------------------

export class SqliteBasketRepo {
  insert(basket: BasketCreate): number {
    const now = Date.now();
    const result = getDb()
      .prepare("INSERT INTO basket (name, type, description, nominal_dose_g, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(basket.name, basket.type ?? "single", basket.description ?? null, basket.nominalDoseG ?? null, now, now) as { lastInsertRowid: number };
    return result.lastInsertRowid;
  }

  findById(id: number): Basket | undefined {
    const row = getDb().prepare("SELECT * FROM basket WHERE id = ?").get(id) as unknown as RawBasketRow | undefined;
    return row ? toBasket(row) : undefined;
  }

  /** Nach Nenndosis (ohne zuletzt), dann wie bisher nach Typ (Einzel, Doppel, HE), dann nach Name. */
  listAll(): Basket[] {
    const rows = getDb()
      .prepare(`SELECT * FROM basket
                 ORDER BY nominal_dose_g IS NULL, nominal_dose_g,
                          CASE type WHEN 'single' THEN 0 WHEN 'double' THEN 1 ELSE 2 END, name ASC`)
      .all() as unknown as RawBasketRow[];
    return rows.map(toBasket);
  }

  update(id: number, patch: BasketUpdate): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.name !== undefined) { fields.push("name = ?"); values.push(patch.name); }
    if (patch.type !== undefined) { fields.push("type = ?"); values.push(patch.type); }
    if (patch.description !== undefined) { fields.push("description = ?"); values.push(patch.description); }
    if (patch.nominalDoseG !== undefined) { fields.push("nominal_dose_g = ?"); values.push(patch.nominalDoseG); }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    getDb().prepare(`UPDATE basket SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  delete(id: number): void {
    getDb().prepare("DELETE FROM basket WHERE id = ?").run(id);
  }

  /** Wie oft das Sieb benutzt wird — Vorgabe einer Variante bzw. Bezug. */
  usage(id: number): { variants: number; shots: number } {
    const db = getDb();
    const v = db.prepare("SELECT count(*) AS n FROM profile_variant WHERE default_basket_id = ?").get(id) as { n: number };
    const s = db.prepare("SELECT count(*) AS n FROM shot WHERE basket_id = ?").get(id) as { n: number };
    return { variants: v.n, shots: s.n };
  }
}
