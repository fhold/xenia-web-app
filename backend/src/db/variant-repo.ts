import { getDb } from "./index.js";
import type { BrewProfile, ProfileVariant, ProfileVariantInput, ShotSize } from "../../../shared/src/types.js";
import { endsWithoutYield } from "../../../shared/src/brew-steps.js";

/**
 * Varianten eines Profils (vereinter Editor, Schnitt 3).
 *
 * Seit 3c fuehren die Varianten: der Editor speichert sie mit `saveVariants`,
 * und die alten Profilspalten (script_single/double, yield_single/double_g,
 * brew_steps(_double)) werden daraus abgeleitet — fuer Anzeigen, die sie noch
 * lesen. Aus den alten Spalten entstehen Varianten nur noch, wo ein Profil noch
 * keine hat (Umstellung, neues Profil) oder ein alter Schreiber genau diese
 * Spalten aendert; dann an Ort und Stelle ueber `legacy_slot`, damit IDs stabil
 * bleiben und Bezuege (`shot.variant_id`) ihre Variante behalten.
 *
 * ⚠ Beim Start nie mehr aus den alten Spalten ueberschreiben (das tat 3a) —
 * sonst ginge alles verloren, was nur Varianten koennen (Namen, dritte Variante,
 * Laufart je Variante).
 */

interface LegacyRow {
  script_single: number | null;
  script_double: number | null;
  yield_single_g: number | null;
  yield_double_g: number | null;
  brew_steps: string | null;
  brew_steps_double: string | null;
}

/** Das erste Sieb eines Typs (nach Anlage) — Vorgabe fuer neue Varianten. */
function firstBasket(type: "single" | "double"): number | null {
  const row = getDb().prepare("SELECT id FROM basket WHERE type = ? ORDER BY id LIMIT 1").get(type) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Wartung (Rueckspuelen, Flush) braucht kein Sieb — das sagt die Art des Profils. */
function isMaintenance(profileId: number): boolean {
  const row = getDb().prepare("SELECT kind FROM profile WHERE id = ?").get(profileId) as { kind: string } | undefined;
  return row?.kind === "maintenance";
}

export function syncProfileVariants(profileId: number): void {
  const db = getDb();
  const p = db
    .prepare("SELECT script_single, script_double, yield_single_g, yield_double_g, brew_steps, brew_steps_double FROM profile WHERE id = ?")
    .get(profileId) as LegacyRow | undefined;
  if (!p) return;
  const isApp = p.brew_steps !== null;
  const now = Date.now();
  const bySlot = new Map(
    (db.prepare("SELECT id, legacy_slot, yield_g, script_id, brew_steps, same_as_id FROM profile_variant WHERE profile_id = ? AND legacy_slot IS NOT NULL").all(profileId) as
      { id: number; legacy_slot: string; yield_g: number | null; script_id: number | null; brew_steps: string | null; same_as_id: number | null }[])
      .map((v) => [v.legacy_slot, v] as const),
  );
  const maintenance = isMaintenance(profileId);

  const upsert = (slot: "single" | "double", name: string, sort: number, f: { yieldG: number | null; scriptId: number | null; steps: string | null; sameAs: number | null }): number => {
    const cur = bySlot.get(slot);
    if (cur !== undefined) {
      // Nur schreiben, was sich geaendert hat — sonst wanderte updated_at bei jedem Start.
      if (cur.yield_g !== f.yieldG || cur.script_id !== f.scriptId || cur.brew_steps !== f.steps || cur.same_as_id !== f.sameAs) {
        db.prepare("UPDATE profile_variant SET yield_g = ?, script_id = ?, brew_steps = ?, same_as_id = ?, updated_at = ? WHERE id = ?")
          .run(f.yieldG, f.scriptId, f.steps, f.sameAs, now, cur.id);
      }
      return cur.id;
    }
    const r = db
      .prepare(
        `INSERT INTO profile_variant
           (profile_id, legacy_slot, name, sort_order, default_basket_id, yield_g, script_id, brew_steps, same_as_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(profileId, slot, name, sort, maintenance ? null : firstBasket(slot), f.yieldG, f.scriptId, f.steps, f.sameAs, now, now) as { lastInsertRowid: number };
    return Number(r.lastInsertRowid);
  };

  const single = upsert("single", "Einzel", 0, {
    yieldG: p.yield_single_g, scriptId: isApp ? null : p.script_single, steps: isApp ? p.brew_steps : null, sameAs: null,
  });
  // Doppel gibt es wie heute: App-Profil mit 2×-Yield, Skript-Profil mit Doppel-Skript.
  const hasDouble = isApp ? p.yield_double_g !== null : p.script_double !== null;
  if (hasDouble) {
    // „wie Einzelsieb“: App ohne eigene 2×-Stufen bzw. dasselbe Skript fuer beide.
    const shared = isApp ? p.brew_steps_double === null : p.script_double === p.script_single;
    upsert("double", "Doppel", 1, {
      yieldG: p.yield_double_g,
      scriptId: isApp || shared ? null : p.script_double,
      steps: isApp && !shared ? p.brew_steps_double : null,
      sameAs: shared ? single : null,
    });
  } else if (bySlot.has("double")) {
    db.prepare("DELETE FROM profile_variant WHERE id = ?").run(bySlot.get("double")!.id);
  }
}

/** Profile ohne Varianten bekommen sie aus den alten Spalten — nur die, nie ueberschreiben. */
export function ensureProfileVariants(): void {
  const rows = getDb()
    .prepare("SELECT p.id FROM profile p WHERE NOT EXISTS (SELECT 1 FROM profile_variant v WHERE v.profile_id = p.id)")
    .all() as { id: number }[];
  for (const { id } of rows) syncProfileVariants(id);
}

/**
 * Bezuege ohne Sieb/Variante bekommen sie aus `shot_size` — nur leere Felder.
 * Wartungsbezuege bekommen kein Sieb. Die Variante nur mit `variants`, also beim
 * Anlegen der Spalte: danach heisst eine leere Variante „geloescht“, und ihr
 * alter Platz gehoert womoeglich schon einer anderen.
 */
export function backfillShotVariantBasket(variants: boolean): void {
  const db = getDb();
  db.exec(`
    UPDATE shot SET basket_id = (SELECT b.id FROM basket b WHERE b.type = shot.shot_size ORDER BY b.id LIMIT 1)
     WHERE basket_id IS NULL AND category = 'brew';
  `);
  if (!variants) return;
  db.exec(`
    UPDATE shot SET variant_id = (SELECT v.id FROM profile_variant v WHERE v.profile_id = shot.profile_id AND v.legacy_slot = shot.shot_size)
     WHERE variant_id IS NULL AND profile_id IS NOT NULL;
  `);
}

// ---------------------------------------------------------------------------
// Lesen und Start (Schnitt 3d)
// ---------------------------------------------------------------------------

interface VariantRow {
  id: number;
  profile_id: number;
  legacy_slot: "single" | "double" | null;
  name: string;
  sort_order: number;
  default_basket_id: number | null;
  yield_g: number | null;
  script_id: number | null;
  brew_steps: string | null;
  same_as_id: number | null;
  phase_names: string | null;
}

function toVariant(r: VariantRow): ProfileVariant {
  return {
    id: r.id,
    name: r.name,
    sortOrder: r.sort_order,
    defaultBasketId: r.default_basket_id,
    yieldG: r.yield_g,
    scriptId: r.script_id,
    brewSteps: r.brew_steps ? (JSON.parse(r.brew_steps) as BrewProfile) : null,
    sameAsId: r.same_as_id,
    phaseNames: r.phase_names ? (JSON.parse(r.phase_names) as (string | null)[]) : null,
    legacySlot: r.legacy_slot,
  };
}

/** Varianten aller Profile, je Profil nach Reihenfolge — fuer die Profilliste in einem Zug. */
export function variantsByProfile(): Map<number, ProfileVariant[]> {
  const out = new Map<number, ProfileVariant[]>();
  const rows = getDb().prepare("SELECT * FROM profile_variant ORDER BY profile_id, sort_order, id").all() as unknown as VariantRow[];
  for (const r of rows) {
    const list = out.get(r.profile_id) ?? [];
    list.push(toVariant(r));
    out.set(r.profile_id, list);
  }
  return out;
}

export function variantsOf(profileId: number): ProfileVariant[] {
  const rows = getDb().prepare("SELECT * FROM profile_variant WHERE profile_id = ? ORDER BY sort_order, id").all(profileId) as unknown as VariantRow[];
  return rows.map(toVariant);
}

export type StartResolution =
  | {
      ok: true;
      /** true: Skript/Stufen/Yield kommen aus der Variante; false: wie bisher aus dem Profil-Platz. */
      fromVariant: boolean;
      variantId: number | null;
      basketId: number | null;
      /** Folgt dem Siebtyp (HE zaehlt als Einzel); ohne Variante der angefragte Platz. */
      shotSize: ShotSize;
      scriptId: number | null;
      brewSteps: BrewProfile | null;
      yieldG: number | null;
    }
  | { ok: false; error: string };

/**
 * Was ein Start mit Variante und Sieb faehrt. Ohne Variante gilt der Platz aus
 * shotSize wie bisher — dann liefert dies nur Variante und Sieb fuer die
 * Aufzeichnung, und Skript/Stufen/Yield bleiben Sache der Route.
 * „wie Variante X“ faehrt die Kurve von X mit dem eigenen Yield.
 *
 * Rein: die Varianten kommen vom gelesenen Profil, den Siebtyp fragt
 * `basketTypeOf` nur, wenn ein Sieb im Spiel ist.
 */
export function resolveStart(
  all: ProfileVariant[],
  basketTypeOf: (id: number) => string | undefined,
  req: { variantId?: number | null; basketId?: number | null; shotSize: ShotSize },
): StartResolution {
  const basketType = (id: number | null): string | null | undefined => (id === null ? null : basketTypeOf(id));
  if (req.basketId != null && basketType(req.basketId) === undefined) return { ok: false, error: `Sieb ${req.basketId} gibt es nicht.` };
  if (req.variantId == null) {
    const v = all.find((x) => x.legacySlot === req.shotSize) ?? null;
    return {
      ok: true, fromVariant: false, variantId: v?.id ?? null, basketId: req.basketId ?? v?.defaultBasketId ?? null,
      shotSize: req.shotSize, scriptId: null, brewSteps: null, yieldG: null,
    };
  }
  const v = all.find((x) => x.id === req.variantId);
  if (!v) return { ok: false, error: `Variante ${req.variantId} gehört nicht zu diesem Profil.` };
  const eff = v.sameAsId !== null ? (all.find((x) => x.id === v.sameAsId) ?? v) : v;
  const basketId = req.basketId ?? v.defaultBasketId;
  return {
    ok: true, fromVariant: true, variantId: v.id, basketId,
    shotSize: basketType(basketId) === "double" ? "double" : "single",
    scriptId: eff.scriptId, brewSteps: eff.brewSteps, yieldG: v.yieldG,
  };
}

// ---------------------------------------------------------------------------
// Speichern (Schnitt 3c) — die Varianten fuehren
// ---------------------------------------------------------------------------

type VariantInput = ProfileVariantInput;

export interface LegacyColumns {
  scriptIdSingle: number | null;
  scriptIdDouble: number | null;
  yieldTargetSingleG: number | null;
  yieldTargetDoubleG: number | null;
  brewSteps: BrewProfile | null;
  brewStepsDouble: BrewProfile | null;
}

/** Die Kurve, die Variante i faehrt („wie Variante X“ → die von X). */
const effective = (list: VariantInput[], i: number): VariantInput => {
  const v = list[i]!;
  return v.sameAs != null ? list[v.sameAs]! : v;
};

/**
 * Pruefung vor dem Speichern — rein, die Existenz von Sieb und Skript fragt der
 * Aufrufer. Jede Variante hat genau eine Kurve: Skript, Stufen oder „wie
 * Variante X“ (X faehrt selbst eine, keine Ketten). App-Varianten werden nach
 * Gewicht gestoppt und brauchen einen Yield.
 */
export function checkVariants(
  list: unknown,
  has: { basket: (id: number) => boolean; script: (id: number) => boolean; validSteps: (bp: BrewProfile) => string | null },
): string | null {
  if (!Array.isArray(list) || list.length === 0) return "Ein Profil braucht mindestens eine Variante.";
  if (list.length > 8) return "Höchstens 8 Varianten.";
  const names = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const v = list[i] as VariantInput;
    const label = `Variante ${i + 1}`;
    if (typeof v !== "object" || v === null || typeof v.name !== "string") return `${label}: ungültig.`;
    const ints = [v.id, v.defaultBasketId, v.scriptId, v.sameAs];
    if (ints.some((x) => x != null && !Number.isInteger(x)) || (v.yieldG != null && !Number.isFinite(v.yieldG))) return `${label}: ungültige Zahl.`;
    const name = v.name.trim();
    if (name.length === 0 || name.length > 40) return `${label}: Name fehlt oder ist länger als 40 Zeichen.`;
    if (names.has(name.toLowerCase())) return `Variante „${name}“ gibt es zweimal.`;
    names.add(name.toLowerCase());
    const curves = [v.scriptId != null, v.brewSteps != null, v.sameAs != null].filter(Boolean).length;
    if (curves !== 1) return `„${name}“: braucht genau eine Kurve (Skript, Stufen oder wie eine andere Variante).`;
    if (v.sameAs != null) {
      const t = list[v.sameAs] as VariantInput | undefined;
      if (v.sameAs === i || t === undefined || t.sameAs != null) return `„${name}“: „wie Variante“ muss auf eine Variante mit eigener Kurve zeigen.`;
    }
    if (v.defaultBasketId != null && !has.basket(v.defaultBasketId)) return `„${name}“: Sieb ${v.defaultBasketId} gibt es nicht.`;
    if (v.scriptId != null && !has.script(v.scriptId)) return `„${name}“: Skript ${v.scriptId} gibt es nicht.`;
    if (v.brewSteps != null) {
      const err = has.validSteps(v.brewSteps);
      if (err) return `„${name}“: ${err}`;
    }
    const pn = v.phaseNames;
    if (pn != null && (!Array.isArray(pn) || pn.length > 50 || pn.some((n) => n !== null && (typeof n !== "string" || n.length > 40)))) {
      return `„${name}“: Phasennamen ungültig (höchstens 50, je 40 Zeichen).`;
    }
    const steps = effective(list as VariantInput[], i).brewSteps;
    if (steps != null && !(v.yieldG != null && v.yieldG > 0) && !endsWithoutYield(steps.steps)) {
      return `„${name}“: läuft in der App und braucht einen Yield — oder einen Ausstieg in der letzten Phase, die den Bezug dann beendet.`;
    }
  }
  return null;
}

/**
 * Die alten Profilspalten aus den Varianten: Einzel = erste, Doppel = zweite.
 * Nur noch fuer Anzeigen, die sie lesen — gestartet wird ueber die Variante.
 */
export function legacyFromVariants(list: VariantInput[]): LegacyColumns {
  const v0 = list[0]!;
  const e0 = effective(list, 0);
  const v1 = list[1];
  const e1 = v1 ? effective(list, 1) : null;
  if (e0.brewSteps != null) {
    return {
      brewSteps: e0.brewSteps, scriptIdSingle: null, yieldTargetSingleG: v0.yieldG,
      scriptIdDouble: null, yieldTargetDoubleG: v1?.yieldG ?? null,
      // 2× ohne eigene Stufen = „wie Einzel“; eine Skript-Variante kennt die alte Welt hier nicht.
      brewStepsDouble: v1 && v1.sameAs !== 0 ? (e1!.brewSteps ?? null) : null,
    };
  }
  return {
    brewSteps: null, brewStepsDouble: null, scriptIdSingle: e0.scriptId, yieldTargetSingleG: v0.yieldG,
    scriptIdDouble: v1 ? (e1!.scriptId ?? null) : null, yieldTargetDoubleG: v1?.yieldG ?? null,
  };
}

/**
 * Varianten eines Profils speichern: nicht mehr genannte loeschen (ihre Bezuege
 * behalten das Sieb, die Variante wird leer), vorhandene (per id) aendern, neue
 * anlegen, dann die alten Spalten ableiten. Die alten Plaetze folgen der
 * Reihenfolge (erste = Einzel, zweite = Doppel) — so passen Start ohne Variante,
 * abgeleitete Spalten und Spiegelung zusammen. Alles in einer Transaktion.
 */
export function saveVariants(profileId: number, list: VariantInput[]): void {
  const db = getDb();
  const now = Date.now();
  const existing = new Set((db.prepare("SELECT id FROM profile_variant WHERE profile_id = ?").all(profileId) as { id: number }[]).map((r) => r.id));
  const keep = new Set(list.map((v) => v.id).filter((id): id is number => id != null && existing.has(id)));
  const steps = (bp: BrewProfile | null) => (bp ? JSON.stringify(bp) : null);
  // Namen gibt es nur zum eigenen Skript; leer = keine.
  const names = (v: VariantInput) => (v.scriptId != null && v.phaseNames?.some((n) => n) ? JSON.stringify(v.phaseNames) : null);
  const slot = (i: number) => (i === 0 ? "single" : i === 1 ? "double" : null);
  db.exec("BEGIN");
  try {
    for (const id of existing) if (!keep.has(id)) db.prepare("DELETE FROM profile_variant WHERE id = ?").run(id);
    // Plaetze erst freimachen — UNIQUE(profile_id, legacy_slot)
    db.prepare("UPDATE profile_variant SET legacy_slot = NULL WHERE profile_id = ?").run(profileId);
    const ids = list.map((v, i) => {
      const name = v.name.trim();
      if (v.id != null && keep.has(v.id)) {
        db.prepare(
          `UPDATE profile_variant SET legacy_slot = ?, name = ?, sort_order = ?, default_basket_id = ?, yield_g = ?, script_id = ?, brew_steps = ?,
             phase_names = ?, same_as_id = NULL, updated_at = ? WHERE id = ?`,
        ).run(slot(i), name, i, v.defaultBasketId, v.yieldG, v.scriptId, steps(v.brewSteps), names(v), now, v.id);
        return v.id;
      }
      const r = db.prepare(
        `INSERT INTO profile_variant (profile_id, legacy_slot, name, sort_order, default_basket_id, yield_g, script_id, brew_steps, phase_names, same_as_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(profileId, slot(i), name, i, v.defaultBasketId, v.yieldG, v.scriptId, steps(v.brewSteps), names(v), now, now) as { lastInsertRowid: number };
      return Number(r.lastInsertRowid);
    });
    list.forEach((v, i) => {
      if (v.sameAs != null) db.prepare("UPDATE profile_variant SET same_as_id = ? WHERE id = ?").run(ids[v.sameAs]!, ids[i]!);
    });
    const l = legacyFromVariants(list);
    db.prepare(
      `UPDATE profile SET script_single = ?, script_double = ?, yield_single_g = ?, yield_double_g = ?, brew_steps = ?, brew_steps_double = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(l.scriptIdSingle, l.scriptIdDouble, l.yieldTargetSingleG, l.yieldTargetDoubleG, steps(l.brewSteps), steps(l.brewStepsDouble), profileId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

