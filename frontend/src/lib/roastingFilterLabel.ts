/**
 * makeUniqueRoastingLabels (3q) — build a guaranteed-unique, readable label for
 * each roasting in the History bean filter.
 *
 * The History filter lists EVERY roasting ever used (unfiltered — no is_active),
 * so two roastings of the same coffee can share a label: both undated ("Deepwood")
 * or roasted the same day ("Deepwood · 12. Jun."). This make-unique pass keeps the
 * clean base label when it's already unique and only escalates on collision:
 *   1. base — coffee · roastDate (short), else coffee · "angelegt <created>",
 *      else coffee · "ohne Datum".
 *   2. on collision — rebuild with the year spelled out (long date).
 *   3. still colliding — append " #1", " #2" … (stable order: createdAt, then id).
 *
 * Pure & deterministic: all date formatting is done by the caller and passed in
 * as strings, so this core has no Date/locale dependency and is trivially testable.
 */

export interface RoastingLabelInput {
  id: number;
  /** Coffee (Sorte) name — the current, colliding base label. */
  coffeeName: string;
  /** Roast date, short ("12. Jun.") — null when the roasting has no roast date. */
  roastDateShort: string | null;
  /** Roast date, long with year ("12. Jun. 2026") — null when no roast date. */
  roastDateLong: string | null;
  /** Created-at date, short ("10. Jun.") — fallback when there is no roast date. */
  createdAtShort: string | null;
  /** Created-at date, long with year ("10. Jun. 2026"). */
  createdAtLong: string | null;
  /** Stable sort key for the #n tiebreaker (created_at ms; fall back to id). */
  createdAtSort: number;
}

const SEP = " · ";

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(value);
}

export function makeUniqueRoastingLabels(
  items: RoastingLabelInput[],
  t: (key: string) => string,
): Map<number, string> {
  const created = (datePart: string): string =>
    t("history.beanFilter.created").replace("{date}", datePart);
  const undated = (): string => t("history.beanFilter.undated");

  // Base label (short date) and the year-expanded variant (long date) per item.
  const shortLabel = (it: RoastingLabelInput): string => {
    if (it.roastDateShort) return it.coffeeName + SEP + it.roastDateShort;
    if (it.createdAtShort) return it.coffeeName + SEP + created(it.createdAtShort);
    return it.coffeeName + SEP + undated();
  };
  const longLabel = (it: RoastingLabelInput): string => {
    if (it.roastDateLong) return it.coffeeName + SEP + it.roastDateLong;
    if (it.createdAtLong) return it.coffeeName + SEP + created(it.createdAtLong);
    return it.coffeeName + SEP + undated();
  };

  const result = new Map<number, string>();

  const byShort = new Map<string, RoastingLabelInput[]>();
  for (const it of items) push(byShort, shortLabel(it), it);

  for (const [short, group] of byShort) {
    if (group.length === 1) {
      result.set(group[0].id, short);
      continue;
    }
    // Collision — escalate to the long (year) label within this group.
    const byLong = new Map<string, RoastingLabelInput[]>();
    for (const it of group) push(byLong, longLabel(it), it);

    for (const [long, lg] of byLong) {
      if (lg.length === 1) {
        result.set(lg[0].id, long);
        continue;
      }
      // Still colliding (e.g. same roast day, or undated) — #n tiebreaker.
      const sorted = [...lg].sort(
        (a, b) => a.createdAtSort - b.createdAtSort || a.id - b.id,
      );
      sorted.forEach((it, i) => result.set(it.id, `${long} #${i + 1}`));
    }
  }

  return result;
}
