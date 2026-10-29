/**
 * Farbschemata (Einstellungen → Oberfläche, Flavio 22.10.): Dunkel, Hell,
 * wie das System, oder ein eigenes Schema. Ein eigenes Schema beruht auf
 * Dunkel oder Hell und ändert nur Grundfarben — die Abstufungen (Flächen,
 * Ränder, Knopfverlauf …) rechnet das Frontend daraus (theme.ts buildTheme).
 *
 * Hier liegt, was Frontend und Backend teilen: welche Farben einstellbar
 * sind, die Form eines Schemas und seine Prüfung.
 */

import { L } from "./shared-lang.js";

/** Einstellbare Grundfarben, in der Reihenfolge des Editors. */
export const EDITABLE_COLORS = [
  "bg", "card", "cardElev", "txt", "mut", "bdr",
  "acc",
  "grn", "org", "red",
  "seriesPressure", "seriesFlow", "seriesWeight", "seriesTemp", "seriesPower", "seriesTarget", "seriesStage",
  "seriesPressureB", "seriesFlowB", "seriesWeightB",
  "rateAcidity", "rateBitter",
] as const;
export type EditableColor = (typeof EDITABLE_COLORS)[number];

export type SchemeBase = "dark" | "light";

export interface ColorScheme {
  /** Kleinbuchstaben, Ziffern, Bindestrich — steckt in `ui_theme` als „scheme:<id>“. */
  id: string;
  name: string;
  base: SchemeBase;
  /** Nur die geänderten Grundfarben, als #rrggbb. */
  colors: Partial<Record<EditableColor, string>>;
}

/** Wert von `ui_theme`. */
export const UI_THEME_PATTERN = /^(dark|light|system|scheme:[a-z0-9-]{1,40})$/;
export const MAX_SCHEMES = 20;
const ID = /^[a-z0-9-]{1,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Fehler im gespeicherten Wert von `ui_color_schemes`, sonst null. */
export function checkColorSchemes(raw: string): string | null {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return L("ui_color_schemes muss JSON sein", "ui_color_schemes must be JSON");
  }
  if (!Array.isArray(list)) return L("ui_color_schemes muss eine Liste sein", "ui_color_schemes must be a list");
  if (list.length > MAX_SCHEMES) return L(`höchstens ${MAX_SCHEMES} Farbschemata`, `at most ${MAX_SCHEMES} color schemes`);
  const ids = new Set<string>();
  for (const s of list as Record<string, unknown>[]) {
    if (typeof s !== "object" || s === null) return L("jedes Farbschema muss ein Objekt sein", "each scheme must be an object");
    if (typeof s.id !== "string" || !ID.test(s.id)) return L("Farbschema-ID: a–z, 0–9 und -, höchstens 40 Zeichen", "scheme id: a-z, 0-9 and -, at most 40");
    if (ids.has(s.id)) return L(`Farbschema-ID ${s.id} gibt es zweimal`, `duplicate scheme id ${s.id}`);
    ids.add(s.id);
    if (typeof s.name !== "string" || s.name.trim() === "" || s.name.length > 40) return L("Name des Farbschemas: 1–40 Zeichen", "scheme name: 1–40 characters");
    if (s.base !== "dark" && s.base !== "light") return L("Grundton muss dark oder light sein", "scheme base must be dark or light");
    if (typeof s.colors !== "object" || s.colors === null || Array.isArray(s.colors)) return L("Farben des Schemas müssen ein Objekt sein", "scheme colors must be an object");
    for (const [k, v] of Object.entries(s.colors as Record<string, unknown>)) {
      if (!(EDITABLE_COLORS as readonly string[]).includes(k)) return L(`unbekannte Farbe ${k}`, `unknown color ${k}`);
      if (typeof v !== "string" || !HEX.test(v)) return L(`Farbe ${k} muss #rrggbb sein`, `color ${k} must be #rrggbb`);
    }
  }
  return null;
}

/** Gespeicherte Schemata lesen; Unbrauchbares ergibt eine leere Liste. */
export function parseColorSchemes(raw: string | null | undefined): ColorScheme[] {
  if (!raw || checkColorSchemes(raw) !== null) return [];
  return JSON.parse(raw) as ColorScheme[];
}
