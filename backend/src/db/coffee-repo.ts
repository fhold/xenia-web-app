import { getDb } from "./index.js";
import type {
  Coffee,
  CoffeeCreate,
  CoffeeUpdate,
  BeanRating,
  RoastLevel,
  BrewType,
} from "../../../shared/src/types.js";
import type { CoffeeLike } from "../lib/coffee-matching.js";

// ---------------------------------------------------------------------------
// §3.4b — Coffee (Sorte) repository. The canonical "Klammer" that holds master
// data + favourite + canonical rating across roastings (beans).
// ---------------------------------------------------------------------------

interface RawCoffeeRow {
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
  roast_level: string | null;
  brew_type: string | null;
  flavor_notes: string | null;
  notes: string | null;
  favourite: number;
  rating: string | null;
  created_at: number;
  updated_at: number;
  roasting_count?: number;
  shot_count?: number;
  last_shot_at?: number | null;
  image_updated_at?: number | null;
}

function parseFlavorNotes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toCoffee(row: RawCoffeeRow): Coffee {
  return {
    id: row.id,
    name: row.name,
    roaster: row.roaster,
    country: row.country,
    region: row.region,
    farm: row.farm,
    variety: row.variety,
    processing: row.processing,
    altitudeMin: row.altitude_min,
    altitudeMax: row.altitude_max,
    roastLevel: (row.roast_level ?? null) as RoastLevel | null,
    brewType: (row.brew_type ?? null) as BrewType | null,
    flavorNotes: parseFlavorNotes(row.flavor_notes),
    notes: row.notes,
    favourite: row.favourite === 1,
    rating: (row.rating ?? null) as BeanRating | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.roasting_count !== undefined ? { roastingCount: row.roasting_count } : {}),
    ...(row.shot_count !== undefined ? { shotCount: row.shot_count } : {}),
    ...(row.last_shot_at !== undefined ? { lastShotAt: row.last_shot_at } : {}),
    ...(row.image_updated_at !== undefined ? { imageUpdatedAt: row.image_updated_at } : {}),
  };
}

export interface CoffeeRepo {
  insert(coffee: CoffeeCreate): number;
  findById(id: number): Coffee | undefined;
  /** All coffees with derived roastingCount + shotCount, fav first. */
  listAll(): Coffee[];
  /** Lightweight {id,name,roaster} list for the matching component. */
  listForMatching(): CoffeeLike[];
  update(id: number, patch: CoffeeUpdate): void;
  /** Number of roastings (beans) under this coffee. */
  roastingCount(id: number): number;
  /**
   * Deletes a coffee. Guarded: throws if any roasting still references it
   * (mirrors the ON DELETE RESTRICT contract with a clear error).
   */
  delete(id: number): void;
  /** Bezüge, die über die Röstungen dieser Sorte hängen. */
  shotCount(coffeeId: number): number;
  /**
   * Löscht die Sorte MIT ihren Röstungen — aber nur, wenn an keiner ein Bezug
   * hängt. Wirft sonst: ein Bezug, dessen Bohne verschwindet, behält seine
   * Zeile, weiß aber nicht mehr, womit er gebrüht wurde.
   */
  deleteWithRoastings(id: number): void;
  /** The stored photo of a Sorte, or undefined. */
  getImage(coffeeId: number): CoffeeImage | undefined;
  /** Stores/replaces the photo. One per Sorte — the PK makes it an upsert. */
  putImage(coffeeId: number, mime: string, bytes: Buffer): void;
  /** Removes the photo. Returns false when there was none. */
  deleteImage(coffeeId: number): boolean;
}

export interface CoffeeImage {
  mime: string;
  bytes: Buffer;
  /** Doubles as the cache buster in the image URL. */
  updatedAt: number;
}

const COUNT_SELECT = `
  c.*,
  (SELECT COUNT(*) FROM bean b WHERE b.coffee_id = c.id) AS roasting_count,
  (SELECT COUNT(*) FROM shot s JOIN bean b ON b.id = s.bean_id WHERE b.coffee_id = c.id AND s.category = 'brew') AS shot_count,
  (SELECT MAX(s.started_at) FROM shot s JOIN bean b ON b.id = s.bean_id
    WHERE b.coffee_id = c.id AND s.category = 'brew') AS last_shot_at,
  (SELECT updated_at FROM coffee_image i WHERE i.coffee_id = c.id) AS image_updated_at
`;

export class SqliteCoffeeRepo implements CoffeeRepo {
  insert(coffee: CoffeeCreate): number {
    const db = getDb();
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT INTO coffee
           (name, roaster, country, region, farm, variety, processing,
            altitude_min, altitude_max, roast_level, brew_type, flavor_notes,
            notes, favourite, rating, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        coffee.name,
        coffee.roaster ?? null,
        coffee.country ?? null,
        coffee.region ?? null,
        coffee.farm ?? null,
        coffee.variety ?? null,
        coffee.processing ?? null,
        coffee.altitudeMin ?? null,
        coffee.altitudeMax ?? null,
        coffee.roastLevel ?? null,
        coffee.brewType ?? null,
        coffee.flavorNotes ? JSON.stringify(coffee.flavorNotes) : null,
        coffee.notes ?? null,
        (coffee.favourite ?? false) ? 1 : 0,
        coffee.rating ?? null,
        now,
        now,
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  findById(id: number): Coffee | undefined {
    const db = getDb();
    const row = db
      .prepare(`SELECT ${COUNT_SELECT} FROM coffee c WHERE c.id = ?`)
      .get(id) as unknown as RawCoffeeRow | undefined;
    return row ? toCoffee(row) : undefined;
  }

  listAll(): Coffee[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT ${COUNT_SELECT} FROM coffee c
         ORDER BY c.favourite DESC, c.updated_at DESC`,
      )
      .all() as unknown as RawCoffeeRow[];
    return rows.map(toCoffee);
  }

  listForMatching(): CoffeeLike[] {
    const db = getDb();
    return db
      .prepare("SELECT id, name, roaster FROM coffee")
      .all() as unknown as CoffeeLike[];
  }

  update(id: number, patch: CoffeeUpdate): void {
    const db = getDb();
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (patch.name !== undefined)        { fields.push("name = ?");          values.push(patch.name); }
    if (patch.roaster !== undefined)     { fields.push("roaster = ?");       values.push(patch.roaster ?? null); }
    if (patch.country !== undefined)     { fields.push("country = ?");       values.push(patch.country ?? null); }
    if (patch.region !== undefined)      { fields.push("region = ?");        values.push(patch.region ?? null); }
    if (patch.farm !== undefined)        { fields.push("farm = ?");          values.push(patch.farm ?? null); }
    if (patch.variety !== undefined)     { fields.push("variety = ?");       values.push(patch.variety ?? null); }
    if (patch.processing !== undefined)  { fields.push("processing = ?");    values.push(patch.processing ?? null); }
    if (patch.altitudeMin !== undefined) { fields.push("altitude_min = ?");  values.push(patch.altitudeMin ?? null); }
    if (patch.altitudeMax !== undefined) { fields.push("altitude_max = ?");  values.push(patch.altitudeMax ?? null); }
    if (patch.roastLevel !== undefined)  { fields.push("roast_level = ?");   values.push(patch.roastLevel ?? null); }
    if (patch.brewType !== undefined)    { fields.push("brew_type = ?");     values.push(patch.brewType ?? null); }
    if (patch.flavorNotes !== undefined) { fields.push("flavor_notes = ?");  values.push(patch.flavorNotes ? JSON.stringify(patch.flavorNotes) : null); }
    if (patch.notes !== undefined)       { fields.push("notes = ?");         values.push(patch.notes ?? null); }
    if (patch.favourite !== undefined)   { fields.push("favourite = ?");     values.push(patch.favourite ? 1 : 0); }
    if (patch.rating !== undefined)      { fields.push("rating = ?");        values.push(patch.rating ?? null); }

    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    db.prepare(`UPDATE coffee SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  getImage(coffeeId: number): CoffeeImage | undefined {
    const row = getDb()
      .prepare("SELECT mime, bytes, updated_at FROM coffee_image WHERE coffee_id = ?")
      .get(coffeeId) as { mime: string; bytes: Buffer; updated_at: number } | undefined;
    return row ? { mime: row.mime, bytes: row.bytes, updatedAt: row.updated_at } : undefined;
  }

  putImage(coffeeId: number, mime: string, bytes: Buffer): void {
    getDb()
      .prepare(
        `INSERT INTO coffee_image (coffee_id, mime, bytes, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(coffee_id) DO UPDATE SET
           mime = excluded.mime, bytes = excluded.bytes, updated_at = excluded.updated_at`,
      )
      .run(coffeeId, mime, bytes, Date.now());
  }

  deleteImage(coffeeId: number): boolean {
    const info = getDb().prepare("DELETE FROM coffee_image WHERE coffee_id = ?").run(coffeeId);
    return info.changes > 0;
  }

  roastingCount(id: number): number {
    const db = getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM bean WHERE coffee_id = ?")
      .get(id) as { n: number };
    return row.n;
  }

  shotCount(coffeeId: number): number {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM shot s
           JOIN bean b ON b.id = s.bean_id
          WHERE b.coffee_id = ?`,
      )
      .get(coffeeId) as { n: number };
    return row.n;
  }

  deleteWithRoastings(id: number): void {
    const shots = this.shotCount(id);
    if (shots > 0) {
      throw new Error(`coffee has ${shots} shots on its roastings — refusing to delete`);
    }
    const db = getDb();
    // Beide Loeschungen in EINER Transaktion: sonst bliebe bei einem Fehler
    // dazwischen eine Sorte ohne Roestungen oder umgekehrt stehen.
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM bean WHERE coffee_id = ?").run(id);
      db.prepare("DELETE FROM coffee WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  delete(id: number): void {
    if (this.roastingCount(id) > 0) {
      throw new Error("coffee has roastings — reassign or delete them first (ON DELETE RESTRICT)");
    }
    const db = getDb();
    db.prepare("DELETE FROM coffee WHERE id = ?").run(id);
  }
}
