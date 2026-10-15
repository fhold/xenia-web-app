import { getDb } from "./index.js";
import type {
  Bean,
  BeanCreate,
  BeanUpdate,
  BeanStatus,
  BeanRating,
  RoastLevel,
  BrewType,
} from "../../../shared/src/types.js";
import { computeEffectiveAgeDays, computeRemainingG, isStockDepleted } from "../../../shared/src/coffee.js";

// ---------------------------------------------------------------------------
// §3.4b — Bean is now a "Röstung" (charge/bag). Master data lives on `coffee`;
// read paths JOIN it back in so the response stays backward compatible (the
// current UI still reads bean.name/roaster/etc.). Write paths split: master
// data + favourite go to the coffee, roasting fields stay on the bean, and
// bean.rating is a charge-level override (NULL = inherit coffee.rating).
// ---------------------------------------------------------------------------

interface RawBeanRow {
  // bean (Röstung)
  id: number;
  coffee_id: number;
  roast_date: string | null;
  bag_size_g: number | null;
  remaining_g: number | null;
  price_per_bag_eur: number | null;
  status: string;
  is_active: number;
  frozen_date: string | null;
  thaw_date: string | null;
  rating: string | null; // charge override
  created_at: number;
  updated_at: number;
  // coffee (Sorte) — joined master data
  cf_name: string;
  cf_roaster: string | null;
  cf_country: string | null;
  cf_region: string | null;
  cf_farm: string | null;
  cf_variety: string | null;
  cf_processing: string | null;
  cf_altitude_min: number | null;
  cf_altitude_max: number | null;
  cf_roast_level: string | null;
  cf_brew_type: string | null;
  cf_flavor_notes: string | null;
  cf_notes: string | null;
  cf_favourite: number;
  cf_rating: string | null;
  shot_count: number;
  remaining_set_at: number | null;
  consumed_g: number;
  last_dose_g: number | null;
  last_shot_at: number | null;
  stock_alert_dismissed_at: number | null;
}

const BEAN_SELECT = `
  SELECT b.id, b.coffee_id, b.roast_date, b.bag_size_g, b.remaining_g,
         b.price_per_bag_eur, b.status, b.is_active, b.frozen_date, b.thaw_date, b.rating,
         b.created_at, b.updated_at, b.remaining_set_at, b.stock_alert_dismissed_at,
         c.name AS cf_name, c.roaster AS cf_roaster, c.country AS cf_country,
         c.region AS cf_region, c.farm AS cf_farm, c.variety AS cf_variety,
         c.processing AS cf_processing, c.altitude_min AS cf_altitude_min,
         c.altitude_max AS cf_altitude_max, c.roast_level AS cf_roast_level,
         c.brew_type AS cf_brew_type, c.flavor_notes AS cf_flavor_notes,
         c.notes AS cf_notes, c.favourite AS cf_favourite, c.rating AS cf_rating,
         (SELECT COUNT(*) FROM shot s WHERE s.bean_id = b.id) AS shot_count,
         (SELECT COALESCE(SUM(s.dose_g), 0) FROM shot s
           WHERE s.bean_id = b.id
             AND s.category = 'brew'
             AND s.started_at > COALESCE(b.remaining_set_at, 0)) AS consumed_g,
         (SELECT s.dose_g FROM shot s
           WHERE s.bean_id = b.id AND s.category = 'brew' AND s.dose_g IS NOT NULL
           ORDER BY s.started_at DESC LIMIT 1) AS last_dose_g,
         (SELECT MAX(s.started_at) FROM shot s
           WHERE s.bean_id = b.id AND s.category = 'brew') AS last_shot_at
  FROM bean b
  JOIN coffee c ON c.id = b.coffee_id
`;

function toBean(row: RawBeanRow): Bean {
  let flavorNotes: string[] = [];
  if (row.cf_flavor_notes) {
    try {
      const parsed = JSON.parse(row.cf_flavor_notes) as unknown;
      flavorNotes = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      flavorNotes = [];
    }
  }
  const overrideRating = (row.rating ?? null) as BeanRating | null;
  const coffeeRating = (row.cf_rating ?? null) as BeanRating | null;
  const remainingG = computeRemainingG(row.bag_size_g, row.remaining_g, row.remaining_set_at, row.consumed_g);
  return {
    id: row.id,
    coffeeId: row.coffee_id,
    // master data (from coffee, read-only on a bean)
    name: row.cf_name,
    roaster: row.cf_roaster,
    country: row.cf_country,
    region: row.cf_region,
    farm: row.cf_farm,
    variety: row.cf_variety,
    processing: row.cf_processing,
    altitudeMin: row.cf_altitude_min,
    altitudeMax: row.cf_altitude_max,
    roastLevel: (row.cf_roast_level ?? null) as RoastLevel | null,
    brewType: (row.cf_brew_type ?? null) as BrewType | null,
    flavorNotes,
    notes: row.cf_notes,
    // roasting fields (from bean)
    roastDate: row.roast_date,
    bagSizeG: row.bag_size_g,
    remainingG,
    stockDepleted: isStockDepleted(remainingG, row.last_dose_g),
    stockAlertDismissedAt: row.stock_alert_dismissed_at,
    pricePerBagEur: row.price_per_bag_eur,
    status: row.status as BeanStatus,
    isActive: row.is_active === 1,
    frozenDate: row.frozen_date,
    thawDate: row.thaw_date,
    rating: overrideRating,
    favourite: row.cf_favourite === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // derived
    effectiveAgeDays: computeEffectiveAgeDays(row.roast_date, row.frozen_date, row.thaw_date),
    effectiveRating: overrideRating ?? coffeeRating,
    shotCount: row.shot_count,
    lastShotAt: row.last_shot_at,
  };
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface BeanFilter {
  status?: BeanStatus;
  favourite?: boolean;
  coffeeId?: number;
  /** §3g: filter by the active-source flag. */
  isActive?: boolean;
}

export interface BeanRepo {
  /** Insert a roasting. `coffeeId` MUST be set (the route resolves it). */
  insert(bean: BeanCreate): number;
  findById(id: number): Bean | undefined;
  listAll(filter?: BeanFilter): Bean[];
  /** All roastings of one coffee, newest first. */
  listByCoffee(coffeeId: number): Bean[];
  update(id: number, patch: BeanUpdate): void;
  setStatus(id: number, status: BeanStatus, date?: string): void;
  /** §3g: toggle the active-source flag (independent of physical status). */
  setActive(id: number, isActive: boolean): void;
  /** Aufgebraucht-Hinweis fuer diese Roestung weggeklickt. */
  dismissStockAlert(id: number): void;
  /** Charge rating override (NULL = inherit coffee.rating). */
  setRatingOverride(id: number, rating: BeanRating | null): void;
  /** Reassign this roasting to another coffee (Merge/Move primitive). */
  move(id: number, coffeeId: number): void;
  delete(id: number): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteBeanRepo implements BeanRepo {
  insert(bean: BeanCreate): number {
    if (bean.coffeeId === undefined || bean.coffeeId === null) {
      throw new Error("bean.insert requires a resolved coffeeId");
    }
    const db = getDb();
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT INTO bean
           (coffee_id, roast_date, bag_size_g, remaining_g, price_per_bag_eur,
            status, is_active, frozen_date, thaw_date, rating, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bean.coffeeId,
        bean.roastDate ?? null,
        bean.bagSizeG ?? null,
        bean.remainingG ?? null,
        bean.pricePerBagEur ?? null,
        bean.status ?? "stock", // §3g: physical default; new roastings start in stock
        bean.isActive ? 1 : 0,  // §3g: inactive by default (not auto-activated)
        bean.frozenDate ?? null,
        bean.thawDate ?? null,
        bean.rating ?? null, // charge override (usually null)
        now,
        now,
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  findById(id: number): Bean | undefined {
    const db = getDb();
    const row = db
      .prepare(`${BEAN_SELECT} WHERE b.id = ?`)
      .get(id) as unknown as RawBeanRow | undefined;
    return row ? toBean(row) : undefined;
  }

  listAll(filter?: BeanFilter): Bean[] {
    const db = getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.status !== undefined)    { conditions.push("b.status = ?");     params.push(filter.status); }
    if (filter?.favourite !== undefined) { conditions.push("c.favourite = ?");  params.push(filter.favourite ? 1 : 0); }
    if (filter?.coffeeId !== undefined)  { conditions.push("b.coffee_id = ?");  params.push(filter.coffeeId); }
    if (filter?.isActive !== undefined)  { conditions.push("b.is_active = ?");  params.push(filter.isActive ? 1 : 0); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(`${BEAN_SELECT} ${where} ORDER BY c.favourite DESC, b.updated_at DESC`)
      .all(...params) as unknown as RawBeanRow[];
    return rows.map(toBean);
  }

  listByCoffee(coffeeId: number): Bean[] {
    const db = getDb();
    const rows = db
      .prepare(`${BEAN_SELECT} WHERE b.coffee_id = ? ORDER BY b.roast_date DESC, b.created_at DESC`)
      .all(coffeeId) as unknown as RawBeanRow[];
    return rows.map(toBean);
  }

  /**
   * Update a roasting. Roasting-level fields go to `bean`; master-data fields
   * (name/roaster/origin/process/roastLevel/brewType/flavorNotes/notes) and
   * `favourite` are routed to the parent `coffee`; `rating` updates the
   * canonical coffee rating (the editor primarily rates the Sorte — §3.4b).
   * Use setRatingOverride() for the charge-level "abweichend bewerten".
   */
  update(id: number, patch: BeanUpdate): void {
    const db = getDb();
    const now = Date.now();

    const bean = db.prepare("SELECT coffee_id FROM bean WHERE id = ?").get(id) as
      | { coffee_id: number }
      | undefined;
    if (!bean) return;

    // --- roasting (bean) fields ---
    const bFields: string[] = [];
    const bValues: (string | number | null)[] = [];
    if (patch.roastDate !== undefined)      { bFields.push("roast_date = ?");        bValues.push(patch.roastDate ?? null); }
    if (patch.bagSizeG !== undefined)       { bFields.push("bag_size_g = ?");        bValues.push(patch.bagSizeG ?? null); }
    // Wer Beutelgroesse oder Restmenge korrigiert, beantwortet den
    // Aufgebraucht-Hinweis neu — ein frueheres Wegklicken gilt nicht mehr.
    if (patch.bagSizeG !== undefined || patch.remainingG !== undefined) {
      bFields.push("stock_alert_dismissed_at = NULL");
    }
    // Ein von Hand gesetzter Restbestand ist ein Korrektur-Anker: er gilt ab
    // jetzt, abgezogen werden nur Bezüge danach. Wird das Feld geleert, faellt
    // die Rechnung auf "Beutelgrösse minus alle Bezüge" zurueck.
    if (patch.remainingG !== undefined) {
      bFields.push("remaining_g = ?");      bValues.push(patch.remainingG ?? null);
      bFields.push("remaining_set_at = ?"); bValues.push(patch.remainingG == null ? null : now);
    }
    if (patch.pricePerBagEur !== undefined) { bFields.push("price_per_bag_eur = ?"); bValues.push(patch.pricePerBagEur ?? null); }
    if (patch.status !== undefined)         { bFields.push("status = ?");            bValues.push(patch.status); }
    // Archiviert ist nie aktiv — dieselbe Regel wie setStatus(); sonst liesse
    // der Bearbeiten-Dialog (Status archiviert, Aktiv-Haken stehen gelassen)
    // genau den Widerspruch zu, den setStatus ausschliesst.
    const isActive = patch.status === "archived" ? false : patch.isActive;
    if (isActive !== undefined)             { bFields.push("is_active = ?");         bValues.push(isActive ? 1 : 0); }
    if (patch.frozenDate !== undefined)     { bFields.push("frozen_date = ?");       bValues.push(patch.frozenDate ?? null); }
    if (patch.thawDate !== undefined)       { bFields.push("thaw_date = ?");         bValues.push(patch.thawDate ?? null); }
    if (bFields.length > 0) {
      bFields.push("updated_at = ?");
      bValues.push(now, id);
      db.prepare(`UPDATE bean SET ${bFields.join(", ")} WHERE id = ?`).run(...bValues);
    }

    // --- master-data (coffee) fields ---
    const cFields: string[] = [];
    const cValues: (string | number | null)[] = [];
    if (patch.name !== undefined)        { cFields.push("name = ?");          cValues.push(patch.name); }
    if (patch.roaster !== undefined)     { cFields.push("roaster = ?");       cValues.push(patch.roaster ?? null); }
    if (patch.country !== undefined)     { cFields.push("country = ?");       cValues.push(patch.country ?? null); }
    if (patch.region !== undefined)      { cFields.push("region = ?");        cValues.push(patch.region ?? null); }
    if (patch.farm !== undefined)        { cFields.push("farm = ?");          cValues.push(patch.farm ?? null); }
    if (patch.variety !== undefined)     { cFields.push("variety = ?");       cValues.push(patch.variety ?? null); }
    if (patch.processing !== undefined)  { cFields.push("processing = ?");    cValues.push(patch.processing ?? null); }
    if (patch.altitudeMin !== undefined) { cFields.push("altitude_min = ?");  cValues.push(patch.altitudeMin ?? null); }
    if (patch.altitudeMax !== undefined) { cFields.push("altitude_max = ?");  cValues.push(patch.altitudeMax ?? null); }
    if (patch.roastLevel !== undefined)  { cFields.push("roast_level = ?");   cValues.push(patch.roastLevel ?? null); }
    if (patch.brewType !== undefined)    { cFields.push("brew_type = ?");     cValues.push(patch.brewType ?? null); }
    if (patch.flavorNotes !== undefined) { cFields.push("flavor_notes = ?");  cValues.push(patch.flavorNotes ? JSON.stringify(patch.flavorNotes) : null); }
    if (patch.notes !== undefined)       { cFields.push("notes = ?");         cValues.push(patch.notes ?? null); }
    if (patch.favourite !== undefined)   { cFields.push("favourite = ?");     cValues.push(patch.favourite ? 1 : 0); }
    if (patch.rating !== undefined)      { cFields.push("rating = ?");        cValues.push(patch.rating ?? null); }
    if (cFields.length > 0) {
      cFields.push("updated_at = ?");
      cValues.push(now, bean.coffee_id);
      db.prepare(`UPDATE coffee SET ${cFields.join(", ")} WHERE id = ?`).run(...cValues);
    }
  }

  setStatus(id: number, status: BeanStatus, date?: string): void {
    const db = getDb();
    const now = Date.now();
    const isoDate = date ?? new Date().toISOString().slice(0, 10);
    if (status === "frozen") {
      // thaw_date mit löschen: es gehört zum vorigen Zyklus und würde sonst vor
      // dem neuen frozen_date liegen, was die Frostdauer negativ macht.
      db.prepare("UPDATE bean SET status = ?, frozen_date = ?, thaw_date = NULL, updated_at = ? WHERE id = ?").run(status, isoDate, now, id);
    } else if (status === "thawed") {
      db.prepare("UPDATE bean SET status = ?, thaw_date = ?, updated_at = ? WHERE id = ?").run(status, isoDate, now, id);
    } else if (status === "archived") {
      // Ein verbrauchter Beutel ist keine Bezugsquelle mehr. Der Picker filtert
      // archivierte Roestungen zwar ohnehin, aber das Aktiv-Flag stehenzulassen
      // haelt die Bohnenliste dauerhaft in einem widerspruechlichen Zustand.
      db.prepare("UPDATE bean SET status = ?, is_active = 0, updated_at = ? WHERE id = ?").run(status, now, id);
    } else {
      db.prepare("UPDATE bean SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    }
  }

  setActive(id: number, isActive: boolean): void {
    const db = getDb();
    db.prepare("UPDATE bean SET is_active = ?, updated_at = ? WHERE id = ?").run(isActive ? 1 : 0, Date.now(), id);
  }

  dismissStockAlert(id: number): void {
    const db = getDb();
    const now = Date.now();
    db.prepare("UPDATE bean SET stock_alert_dismissed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  }

  setRatingOverride(id: number, rating: BeanRating | null): void {
    const db = getDb();
    db.prepare("UPDATE bean SET rating = ?, updated_at = ? WHERE id = ?").run(rating, Date.now(), id);
  }

  move(id: number, coffeeId: number): void {
    const db = getDb();
    db.prepare("UPDATE bean SET coffee_id = ?, updated_at = ? WHERE id = ?").run(coffeeId, Date.now(), id);
  }

  delete(id: number): void {
    const db = getDb();
    db.prepare("DELETE FROM bean WHERE id = ?").run(id);
  }
}
