/**
 * Hat ein Profil einen 2×-Platz? Profilliste und Start-Dialog muessen dieselbe
 * Antwort geben: die fruehere 1×/2×-Auswahl am Dashboard-Chip fragte nur nach
 * dem Double-Skript und bot App-Profilen mit 2×-Yield deshalb kein 2× an.
 */

import type { Profile, ProfileVariant, ProfileVariantInput, ShotSize } from "./types.js";

export function hasDoubleSlot(p: Pick<Profile, "brewSteps" | "scriptIdDouble" | "yieldTargetDoubleG">): boolean {
  // App-Profil: der 2×-Platz ist der eigene 2×-Yield. Skript-Profil: das Double-Skript.
  return p.brewSteps != null ? p.yieldTargetDoubleG !== null : p.scriptIdDouble !== null;
}

// ---------------------------------------------------------------------------
// Varianten (Schnitt 3d) — Start, Dialog und Liste fragen dieselben Helfer.
// ---------------------------------------------------------------------------

/** Die Varianten eines Profils in ihrer Reihenfolge. */
export function startVariants(p: Pick<Profile, "variants">): ProfileVariant[] {
  return [...(p.variants ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/** Die Kurve, die eine Variante faehrt: „wie Variante X“ → die von X. */
export function effectiveVariant(p: Pick<Profile, "variants">, v: ProfileVariant): ProfileVariant {
  return v.sameAsId !== null ? ((p.variants ?? []).find((x) => x.id === v.sameAsId) ?? v) : v;
}

/** Laeuft die Variante in der App (Stufen) statt als Skript? */
export function variantRunsInApp(p: Pick<Profile, "variants">, v: ProfileVariant): boolean {
  return effectiveVariant(p, v).brewSteps !== null;
}

/** shot_size fuer ein Sieb: Doppel bleibt Doppel, alles andere (Einzel, HE) zaehlt als Einzel. */
export function shotSizeForBasket(type: string | null | undefined): ShotSize {
  return type === "double" ? "double" : "single";
}

/** Die Varianten zum Speichern — „wie Variante X“ als Index statt als ID. */
export function variantInputs(p: Pick<Profile, "variants">): ProfileVariantInput[] {
  const list = startVariants(p);
  return list.map((v) => ({
    id: v.id, name: v.name, defaultBasketId: v.defaultBasketId, yieldG: v.yieldG, scriptId: v.scriptId, brewSteps: v.brewSteps, phaseNames: v.phaseNames,
    sameAs: v.sameAsId !== null ? list.findIndex((x) => x.id === v.sameAsId) : null,
  }));
}

/** Die Variante eines alten 1×/2×-Platzes (Wiederholen von Bezuegen ohne gespeicherte Variante). */
export function variantForSlot(p: Pick<Profile, "variants">, size: ShotSize): ProfileVariant | null {
  return (p.variants ?? []).find((v) => v.legacySlot === size) ?? null;
}

