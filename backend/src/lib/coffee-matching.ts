/**
 * Shared coffee-matching component — §3.4b.
 *
 * One place, four uses: the migration's auto-grouping, JSON import, BC import,
 * and merge/move target suggestions. Given an incoming (name, roaster) it
 * classifies against existing coffees as:
 *   - "sicher"       → confidently the same coffee (auto-group / auto-attach)
 *   - "unklar"       → ask the user ("Deepwood, or a new coffee?")
 *   - "kein-treffer" → no match → new coffee
 *
 * Principle (fixed by the spec):
 *   - Roaster: normalized (lowercase, trim, collapse whitespace, fold
 *     diacritics) + fuzzy — catches "van Gülpen" vs "van Gülpen Coffee Roasters".
 *   - Name: fuzzy, where token-/prefix-containment counts as HIGH similarity —
 *     "Deepwood" ⊂ "Deepwood Espresso Blend" is *sicher gleich*, not "unklar".
 *     Pure character edit-distance would get that wrong.
 *   - As soon as roaster OR name is uncertain → ask (unklar). A confidently
 *     different name or roaster → kein-treffer.
 *
 * Thresholds (this file's tuning; the principle above is the spec contract):
 *   NAME_SURE    = 0.90   ROASTER_SURE  = 0.85
 *   NAME_MAYBE   = 0.70   ROASTER_MAYBE = 0.62
 *   Exact match, string-prefix, or whole-token-subset short-circuit ABOVE the
 *   "sure" thresholds (0.93–1.0), which is what makes containment "sicher".
 *   Roaster both-empty = non-disqualifying (treated "sure"); exactly-one-empty
 *   = "maybe" (can't confirm) → at best "unklar".
 */

import type { MatchVerdict, MatchCandidate } from "../../../shared/src/types.js";

// --- thresholds (documented above) ---
const NAME_SURE = 0.9;
const NAME_MAYBE = 0.7;
const ROASTER_SURE = 0.85;
const ROASTER_MAYBE = 0.62;

export interface CoffeeLike {
  id: number;
  name: string;
  roaster: string | null;
}

export interface MatchInput {
  name: string;
  roaster: string | null;
}

type Level = "sure" | "maybe" | "none";

/** lowercase + trim + collapse internal whitespace + fold diacritics. */
export function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (ü→u)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(norm: string): string[] {
  return norm.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Edit-distance ratio in 0..1 (1 = identical). */
function editRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Whole-token subset: every token of the shorter set appears in the longer. */
function tokenSubset(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longSet = new Set(long);
  return short.every((t) => longSet.has(t));
}

/**
 * Generic fuzzy similarity with containment short-circuits:
 *   exact → 1.0, string-prefix → 0.96, whole-token-subset → 0.93, else editRatio.
 */
function similarity(rawA: string | null | undefined, rawB: string | null | undefined): number {
  const a = normalizeForMatch(rawA);
  const b = normalizeForMatch(rawB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.96;
  if (tokenSubset(a, b)) return 0.93;
  return editRatio(a, b);
}

export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarity(a, b);
}

export function roasterSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarity(a, b);
}

function nameLevel(score: number): Level {
  return score >= NAME_SURE ? "sure" : score >= NAME_MAYBE ? "maybe" : "none";
}

function roasterLevel(
  rawA: string | null | undefined,
  rawB: string | null | undefined,
  score: number,
): Level {
  const aEmpty = !normalizeForMatch(rawA);
  const bEmpty = !normalizeForMatch(rawB);
  if (aEmpty && bEmpty) return "sure"; // no roaster info on either → non-disqualifying
  if (aEmpty || bEmpty) return "maybe"; // can't confirm same roaster
  return score >= ROASTER_SURE ? "sure" : score >= ROASTER_MAYBE ? "maybe" : "none";
}

function combine(nameV: Level, roasterV: Level): MatchVerdict {
  if (nameV === "none" || roasterV === "none") return "kein-treffer";
  if (nameV === "sure" && roasterV === "sure") return "sicher";
  return "unklar";
}

/** Classify a single pair. Returns the verdict + a 0..1 ranking score. */
export function classifyPair(a: MatchInput, b: MatchInput): { verdict: MatchVerdict; score: number } {
  const nScore = nameSimilarity(a.name, b.name);
  const rScore = roasterSimilarity(a.roaster, b.roaster);
  const verdict = combine(nameLevel(nScore), roasterLevel(a.roaster, b.roaster, rScore));
  // Ranking score: name-weighted; roaster contributes a neutral 0.5 when it
  // can't be evaluated (one/both empty) so it neither helps nor hurts ranking.
  const aEmpty = !normalizeForMatch(a.roaster);
  const bEmpty = !normalizeForMatch(b.roaster);
  const rRank = aEmpty || bEmpty ? 0.5 : rScore;
  const score = 0.6 * nScore + 0.4 * rRank;
  return { verdict, score };
}

/**
 * Match an incoming coffee against existing coffees. Returns candidates sorted
 * by descending score, each with its verdict. Caller decides what to do:
 * migration auto-groups only on "sicher"; UI surfaces "unklar"/top candidates.
 */
export function matchAgainstCoffees(input: MatchInput, coffees: CoffeeLike[]): MatchCandidate[] {
  return coffees
    .map((c) => {
      const { verdict, score } = classifyPair(input, { name: c.name, roaster: c.roaster });
      return { coffeeId: c.id, name: c.name, roaster: c.roaster, verdict, score };
    })
    .sort((x, y) => y.score - x.score);
}

/**
 * Best "sicher" match (highest score), or null. Used by the migration and the
 * legacy bean-create path to auto-attach to an existing coffee.
 */
export function bestSureMatch(input: MatchInput, coffees: CoffeeLike[]): CoffeeLike | null {
  const ranked = matchAgainstCoffees(input, coffees).filter((c) => c.verdict === "sicher");
  if (!ranked.length) return null;
  const top = ranked[0];
  return { id: top.coffeeId, name: top.name, roaster: top.roaster };
}
