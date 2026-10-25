/**
 * Profil als Datei — Export und Import (2026-10-20).
 *
 * Die Datei traegt alles, was ein Profil auf einer anderen Maschine braucht:
 * Varianten mit Yield, Sieb (Name, Beschreibung, Nenndosis) und Kurve — Stufen,
 * „wie Variante X“ (per Name) oder das Skript mit Titel und vollem Text. Keine
 * IDs, keine Favoriten, keine Verknuepfungen zu Bohnen, keine Bezuege.
 *
 * Versionen: v1 (bis 15.10.) kannte nur die alten 1×/2×-Spalten und von
 * Skripten nur die Nummer; v2 (Schnitt 3e) Varianten mit Sieb als Name + Typ;
 * v3 Sieb mit Beschreibung und Nenndosis. Gelesen werden alle drei.
 */

import type { Basket, BrewProfile, Profile, ProfileFit, ProfileKind, XeniaScript } from "./types.js";
import { isProfileFitList } from "./types.js";
import type { TranslationHint, TranslationRow } from "./decent-profile.js";
import { startVariants } from "./profile-slots.js";
import { parseScript } from "./script-parser.js";
import { serializeScript } from "./script-serializer.js";
import { L } from "./shared-lang.js";

export const PROFILE_FILE_KIND = "xenia-profile";
export const PROFILE_FILE_VERSION = 3;

export interface ProfileFileBasket {
  name: string;
  description: string | null;
  nominalDoseG: number | null;
}

export interface ProfileFileVariant {
  name: string;
  basket: ProfileFileBasket | null;
  yieldG: number | null;
  /** „wie Variante X“ — per Name, IDs gelten nur in einer Datenbank. */
  sameAs: string | null;
  script: { title: string; content: string } | null;
  phaseNames: (string | null)[] | null;
  brewSteps: BrewProfile | null;
}

export interface ProfileFileProfile {
  name: string;
  kind: ProfileKind;
  isTrial: boolean;
  /** Einordnung (dark/light/filter); aeltere Dateien haben sie nicht → leer. */
  fit: ProfileFit[];
  targetTempC: number | null;
  notes: string | null;
  variants: ProfileFileVariant[];
}

export interface ProfileFile {
  kind: typeof PROFILE_FILE_KIND;
  version: number;
  profile: ProfileFileProfile;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function buildProfileFile(p: Profile, scripts: XeniaScript[], baskets: Basket[]): ProfileFile {
  const list = startVariants(p);
  return {
    kind: PROFILE_FILE_KIND,
    version: PROFILE_FILE_VERSION,
    profile: {
      name: p.name,
      kind: p.kind,
      isTrial: p.isTrial,
      fit: p.fit,
      targetTempC: p.targetTempC,
      notes: p.notes,
      variants: list.map((v) => {
        const basket = baskets.find((b) => b.id === v.defaultBasketId);
        const script = v.scriptId !== null ? scripts.find((s) => s.id === v.scriptId) : undefined;
        return {
          name: v.name,
          basket: basket ? { name: basket.name, description: basket.description, nominalDoseG: basket.nominalDoseG } : null,
          yieldG: v.yieldG,
          sameAs: v.sameAsId !== null ? (list.find((x) => x.id === v.sameAsId)?.name ?? null) : null,
          script: script ? { title: script.title, content: script.content } : null,
          phaseNames: v.phaseNames,
          brewSteps: v.brewSteps,
        };
      }),
    },
  };
}

/** „Adaptive Gagné · 9 bar“ → „adaptive-gagné-9-bar.xenia-profile.json“. */
export function profileFileName(name: string): string {
  const slug = name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${slug || L("profil", "profile")}.xenia-profile.json`;
}

// ---------------------------------------------------------------------------
// Lesen (v1–v3) — nur Form und Typen; Stufen, Skripte und Varianten prueft der
// Import mit denselben Pruefungen wie das Speichern im Editor.
// ---------------------------------------------------------------------------

export type ReadResult = { ok: true; profile: ProfileFileProfile } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const strOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";
const numOrNull = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isFinite(x));

export function readProfileFile(raw: unknown): ReadResult {
  if (!isObj(raw) || raw.kind !== PROFILE_FILE_KIND || !isObj(raw.profile)) {
    return { ok: false, error: L("Das ist keine Profil-Datei der Xenia App.", "This is not a profile file of the Xenia app.") };
  }
  const version = raw.version;
  if (version === 1) return readV1(raw.profile);
  if (version === 2 || version === PROFILE_FILE_VERSION) return readV2V3(raw.profile);
  if (typeof version === "number" && version > PROFILE_FILE_VERSION) {
    return { ok: false, error: L(
      `Die Datei stammt aus einer neueren App (Format v${version}) — bitte erst aktualisieren.`,
      `The file comes from a newer app (format v${version}) — please update first.`,
    ) };
  }
  return { ok: false, error: L("Unbekanntes Format der Profil-Datei.", "Unknown format of the profile file.") };
}

function readHead(p: Obj): { ok: true; head: Omit<ProfileFileProfile, "variants"> } | { ok: false; error: string } {
  if (typeof p.name !== "string" || p.name.trim() === "") return { ok: false, error: L("Das Profil hat keinen Namen.", "The profile has no name.") };
  const kind = p.kind ?? "brew";
  if (kind !== "brew" && kind !== "maintenance" && kind !== "test") return { ok: false, error: L("Unbekannte Art des Profils.", "Unknown kind of profile.") };
  const isTrial = p.isTrial ?? false;
  if (typeof isTrial !== "boolean") return { ok: false, error: L("„Versuch“ ist ungültig.", "“Trial” is invalid.") };
  const fit = p.fit ?? [];
  if (!isProfileFitList(fit)) return { ok: false, error: L("Die Einordnung ist ungültig.", "The classification is invalid.") };
  const targetTempC = p.targetTempC ?? null;
  const notes = p.notes ?? null;
  if (!numOrNull(targetTempC)) return { ok: false, error: L("Die Temperatur ist ungültig.", "The temperature is invalid.") };
  if (!strOrNull(notes)) return { ok: false, error: L("Die Notiz ist ungültig.", "The note is invalid.") };
  return { ok: true, head: { name: p.name.trim(), kind, isTrial, fit, targetTempC, notes } };
}

function readV2V3(p: Obj): ReadResult {
  const h = readHead(p);
  if (!h.ok) return h;
  if (!Array.isArray(p.variants) || p.variants.length === 0) return { ok: false, error: L("Das Profil hat keine Varianten.", "The profile has no variants.") };
  const variants: ProfileFileVariant[] = [];
  for (const [i, raw] of p.variants.entries()) {
    const label = L(`Variante ${i + 1}`, `Variant ${i + 1}`);
    if (!isObj(raw) || typeof raw.name !== "string") return { ok: false, error: L(`${label}: ungültig.`, `${label}: invalid.`) };
    const b = raw.basket ?? null;
    if (b !== null && (!isObj(b) || typeof b.name !== "string")) return { ok: false, error: L(`„${raw.name}“: Sieb ungültig.`, `“${raw.name}”: basket invalid.`) };
    const s = raw.script ?? null;
    if (s !== null && (!isObj(s) || typeof s.title !== "string" || typeof s.content !== "string")) {
      return { ok: false, error: L(`„${raw.name}“: Skript ungültig.`, `“${raw.name}”: script invalid.`) };
    }
    const yieldG = raw.yieldG ?? null;
    const sameAs = raw.sameAs ?? null;
    const phaseNames = raw.phaseNames ?? null;
    const brewSteps = raw.brewSteps ?? null;
    if (!numOrNull(yieldG) || !strOrNull(sameAs) || (phaseNames !== null && !Array.isArray(phaseNames)) || (brewSteps !== null && !isObj(brewSteps))) {
      return { ok: false, error: L(`„${raw.name}“: ungültige Angaben.`, `“${raw.name}”: invalid data.`) };
    }
    variants.push({
      name: raw.name,
      // v2 hatte am Sieb nur Name + Typ — der Typ hat keine Funktion mehr.
      basket: b === null ? null : {
        name: b.name as string,
        description: typeof b.description === "string" ? b.description : null,
        nominalDoseG: typeof b.nominalDoseG === "number" && Number.isFinite(b.nominalDoseG) ? b.nominalDoseG : null,
      },
      yieldG,
      sameAs,
      script: s === null ? null : { title: s.title as string, content: s.content as string },
      phaseNames: phaseNames as (string | null)[] | null,
      brewSteps: brewSteps as unknown as BrewProfile | null,
    });
  }
  return { ok: true, profile: { ...h.head, variants } };
}

/** v1: die alten Spalten. Skripte nur als Nummer — die gilt auf einer anderen Maschine nicht. */
function readV1(p: Obj): ReadResult {
  const h = readHead(p);
  if (!h.ok) return h;
  const steps = p.brewSteps ?? null;
  if (steps === null || !isObj(steps)) {
    return { ok: false, error: L(
      "Diese Datei (Format v1) enthält vom Skript nur die Nummer, nicht das Skript selbst — bitte mit der aktuellen App neu exportieren.",
      "This file (format v1) contains only the script's number, not the script itself — please export again with the current app.",
    ) };
  }
  const ySingle = p.yieldTargetSingleG ?? null;
  const yDouble = p.yieldTargetDoubleG ?? null;
  const stepsDouble = p.brewStepsDouble ?? null;
  if (!numOrNull(ySingle) || !numOrNull(yDouble) || (stepsDouble !== null && !isObj(stepsDouble))) {
    return { ok: false, error: L("Ungültige Angaben im Profil.", "Invalid data in the profile.") };
  }
  const base = { basket: null, script: null, phaseNames: null };
  const variants: ProfileFileVariant[] = [{ ...base, name: "Einzel", yieldG: ySingle, sameAs: null, brewSteps: steps as unknown as BrewProfile }];
  // Wie die Umstellung auf Varianten: Doppel gibt es mit 2×-Yield, ohne eigene Stufen „wie Einzel“.
  if (yDouble !== null) {
    variants.push({
      ...base, name: "Doppel", yieldG: yDouble,
      sameAs: stepsDouble === null ? "Einzel" : null,
      brewSteps: stepsDouble as unknown as BrewProfile | null,
    });
  }
  return { ok: true, profile: { ...h.head, variants } };
}

// ---------------------------------------------------------------------------
// Import-Plan — was der Import anlegen, wiederverwenden oder fragen wuerde.
// Rein: arbeitet auf den Listen, die das Backend hereingibt.
// ---------------------------------------------------------------------------

/** Skripttext in kanonischer Form — so vergleicht der Import „identisch“. */
export function canonicalScript(content: string): string {
  try {
    return serializeScript(parseScript(content));
  } catch {
    return content.trim();
  }
}

export type ScriptPlan =
  /** Ein Skript mit genau diesem Text liegt schon auf der Maschine. */
  | { status: "same"; title: string; scriptId: number }
  /** Gibt es nicht — wird angelegt. */
  | { status: "new"; title: string }
  /** Gleicher Titel, anderer Text: der Nutzer entscheidet. */
  | { status: "conflict"; title: string; scriptId: number };

export interface VariantPlan {
  name: string;
  basketId: number | null;
  /** Sieb aus der Datei, das es hier nicht gibt (Name). */
  missingBasket: string | null;
  curve: "steps" | "sameAs" | "script";
  script: ScriptPlan | null;
}

export interface ImportPlan {
  /** Name, unter dem das Profil angelegt wird — „Name (2)“, wenn es ihn schon gibt. */
  name: string;
  renamed: boolean;
  variants: VariantPlan[];
}

export function uniqueProfileName(name: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function planProfileImport(
  profile: ProfileFileProfile,
  here: { scripts: XeniaScript[]; baskets: Basket[]; profileNames: string[] },
): ImportPlan {
  const live = here.scripts.filter((s) => s.orphanedAt === null);
  const name = uniqueProfileName(profile.name, here.profileNames);
  return {
    name,
    renamed: name !== profile.name,
    variants: profile.variants.map((v) => {
      const basket = v.basket
        ? here.baskets.find((b) => b.name.trim().toLowerCase() === v.basket!.name.trim().toLowerCase())
        : undefined;
      let script: ScriptPlan | null = null;
      if (v.script) {
        const want = canonicalScript(v.script.content);
        const same = live.find((s) => canonicalScript(s.content) === want);
        const titled = live.find((s) => s.title === v.script!.title);
        script = same ? { status: "same", title: same.title, scriptId: same.id }
          : titled ? { status: "conflict", title: v.script.title, scriptId: titled.id }
          : { status: "new", title: v.script.title };
      }
      return {
        name: v.name,
        basketId: basket?.id ?? null,
        missingBasket: v.basket && !basket ? v.basket.name : null,
        curve: v.script ? "script" : v.sameAs !== null ? "sameAs" : "steps",
        script,
      };
    }),
  };
}

/** Antwort von POST /api/profiles/import/preview: der Plan, das gelesene Profil
 *  und — bei einer Decent-Datei — der Bericht der Uebersetzung. */
export interface ImportPreview extends ImportPlan {
  profile: ProfileFileProfile;
  translation: { title: string; rows: TranslationRow[]; hints: TranslationHint[] } | null;
}

/** Antwort von POST /api/profiles/import. */
export interface ProfileImportResult {
  profile: Profile;
  createdScripts: { id: number; title: string }[];
  reusedScripts: { id: number; title: string }[];
  missingBaskets: string[];
}
