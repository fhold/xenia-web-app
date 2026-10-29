/**
 * Netz Profil ↔ Bohne (Schnitt 4): wer lief womit — rein, aus Bezugszeilen.
 *
 * Die Sorte zeigt „Mit diesen Profilen“ (je Sieb und Muehle eine Zeile je
 * Profil), das Profil „Lief mit“ (je Variante und Muehle eine Zeile je Sorte).
 * Reihenfolge aus starken Signalen — Referenz, Anzahl, zuletzt —, nicht aus dem
 * Bewertungsschnitt: der steht nur zur Information daneben, immer mit seiner
 * Anzahl, weil er oft auf ein, zwei Bezuegen beruht. Bezuege ohne Muehle zaehlen
 * nicht in Mahlgrad-Spannen.
 */

import type { ChannelingSeverity, GrindNote } from "./types.js";
import { hasRating } from "./shot-rating.js";

/** Ein beendeter Bezug, wie das Netz ihn braucht. */
export interface NetShot {
  id: number;
  startedAt: number;
  profileId: number | null;
  profileName: string;
  variantId: number | null;
  basketId: number | null;
  grinderId: number | null;
  coffeeId: number | null;
  coffeeName: string | null;
  /** Fremdbohne als Freitext (ohne gepflegte Sorte). */
  beanLabel: string | null;
  grindSetting: number | null;
  grindNote: GrindNote | null;
  rating: number | null;
  acidity: number | null;
  bitterness: number | null;
  extractionUnder: boolean;
  extractionOver: boolean;
  channeling: boolean;
  channelingSeverity: ChannelingSeverity | null;
  tasteTags: string[] | null;
}

/** Channeling des letzten Bezugs: keins/leicht/stark, „yes“ = markiert ohne Staerke; null = nicht bewertet. */
export type NetChanneling = "none" | "light" | "strong" | "yes";

export interface NetRow {
  /** „p12“ (Profil), „c5“ (Sorte), „l:Name“ (Fremdbohne), „-“ (ohne Bohne). */
  key: string;
  /** Profil- bzw. Sorten-ID; null bei Fremdbohne oder ohne Bohne. */
  id: number | null;
  label: string;
  n: number;
  grindMin: number | null;
  grindMax: number | null;
  /** Schnitt der Sterne der bewerteten Bezuege; null = keiner bewertet. */
  ratingAvg: number | null;
  rated: number;
  last: {
    shotId: number;
    at: number;
    grind: number | null;
    note: GrindNote | null;
    channeling: NetChanneling | null;
    variantId: number | null;
    basketId: number | null;
  };
}

export interface NetGroup {
  basketId: number | null;
  variantId: number | null;
  grinderId: number | null;
  n: number;
  rows: NetRow[];
}

function channelingOf(s: NetShot): NetChanneling | null {
  if (s.channeling) return s.channelingSeverity ?? "yes";
  return hasRating(s) ? "none" : null;
}

/**
 * Bezuege in Gruppen (`group`) und darin in Zeilen (`row`) zusammenfassen.
 * Gruppen nach Anzahl, Zeilen nach Referenz, Anzahl, zuletzt.
 */
export function groupNetwork(
  shots: readonly NetShot[],
  group: (s: NetShot) => { basketId: number | null; variantId: number | null; grinderId: number | null },
  row: (s: NetShot) => { key: string; id: number | null; label: string },
): NetGroup[] {
  const groups = new Map<string, { g: NetGroup; rows: Map<string, { r: NetRow; sum: number }> }>();
  const ordered = [...shots].sort((a, b) => a.startedAt - b.startedAt);
  for (const s of ordered) {
    const gk = group(s);
    const gKey = `${gk.basketId}|${gk.variantId}|${gk.grinderId}`;
    let g = groups.get(gKey);
    if (!g) {
      g = { g: { ...gk, n: 0, rows: [] }, rows: new Map() };
      groups.set(gKey, g);
    }
    g.g.n++;
    const rk = row(s);
    let r = g.rows.get(rk.key);
    if (!r) {
      r = {
        r: { ...rk, n: 0, grindMin: null, grindMax: null, ratingAvg: null, rated: 0, last: null as unknown as NetRow["last"] },
        sum: 0,
      };
      g.rows.set(rk.key, r);
    }
    const x = r.r;
    x.n++;
    if (s.grinderId !== null && s.grindSetting !== null) {
      x.grindMin = x.grindMin === null ? s.grindSetting : Math.min(x.grindMin, s.grindSetting);
      x.grindMax = x.grindMax === null ? s.grindSetting : Math.max(x.grindMax, s.grindSetting);
    }
    if (s.rating !== null) {
      r.sum += s.rating;
      x.rated++;
      x.ratingAvg = r.sum / x.rated;
    }
    // Aufsteigend sortiert: der letzte gewinnt.
    x.last = { shotId: s.id, at: s.startedAt, grind: s.grindSetting, note: s.grindNote, channeling: channelingOf(s), variantId: s.variantId, basketId: s.basketId };
  }
  const out = [...groups.values()].map(({ g, rows }) => ({
    ...g,
    rows: [...rows.values()].map((v) => v.r).sort((a, b) => b.n - a.n || b.last.at - a.last.at),
  }));
  return out.sort((a, b) => b.n - a.n);
}

/** Bewertung auf halbe Punkte, wie die Punkte sie zeigen. */
export const halfStars = (avg: number) => Math.round(avg * 2) / 2;

/** GET /api/network/coffee/:id — „Mit diesen Profilen“: nur Siebe mit Bezuegen. */
export interface CoffeeNetwork {
  groups: NetGroup[];
}

/** GET /api/network/profile/:id — „Lief mit“, je Variante und Muehle. */
export interface ProfileNetwork {
  groups: NetGroup[];
}
