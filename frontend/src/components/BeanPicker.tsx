/**
 * BeanPicker — the single shared roasting picker for every brew/shot path (§3l).
 *
 * One source of truth for which roastings are offered and how they are labelled,
 * so Pre-Brew (§3g), Dashboard-repeat (re-opens Pre-Brew) and Shot-Edit (§3j) can
 * never drift apart again. Rules:
 *   - only ACTIVE-SOURCE roastings (`isActive`) that are not used up (archived)
 *     are pickable — physical status (frozen/thawed) does not gate visibility;
 *   - the currently-assigned roasting is ALWAYS kept selectable, even if it is no
 *     longer pickable (a repeat / carry-over must not silently lose its bean) —
 *     it is then marked "(inaktiv)";
 *   - label = variety name · roast date (§3d) · frozen marker · inactive marker.
 *
 * Multiple active roastings showing at once is correct, not a bug — `isActive` is
 * a free flag (§3g); only INACTIVE roastings disappear from the picker.
 */

import { useEffect, useState } from "react";
import type { Bean } from "@shared/types.js";
import { useTranslation } from "../i18n/index.js";
import { formatRoastDate } from "../lib/dates.js";

// ---------------------------------------------------------------------------
// Shared bean-picker logic (exported for the callers' default-selection guards)
// ---------------------------------------------------------------------------

/** §3l: a roasting is pickable as a brew source when it is an active source
 *  (`isActive`) and not used up (`archived`). Frozen/thawed stay pickable. */
export function isPickableBean(b: Bean): boolean {
  return b.isActive && b.status !== "archived";
}

/** Roast-date label — "12. Jun. 2026", with year like everywhere (lib/dates). */
function fmtRoastDate(iso: string): string {
  return formatRoastDate(iso) || iso;
}

/**
 * Build the option list (§3l): pickable roastings sorted frozen-last,
 * favourite-first, most-recent-first; the currently-selected roasting is kept
 * (prepended) even when no longer pickable so a carry-over is never lost.
 */
export function buildBeanOptions(beans: Bean[], selectedId: number | null): Bean[] {
  const pickable = beans
    .filter(isPickableBean)
    .sort((a, b) => {
      const aFrozen = a.status === "frozen" ? 1 : 0;
      const bFrozen = b.status === "frozen" ? 1 : 0;
      if (aFrozen !== bFrozen) return aFrozen - bFrozen;
      if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
      // "Zuletzt verwendet" = letzter Bezug, nicht letzte Bearbeitung.
      return (b.lastShotAt ?? 0) - (a.lastShotAt ?? 0) || b.createdAt - a.createdAt;
    });
  if (selectedId !== null && !pickable.some((b) => b.id === selectedId)) {
    return [...beans.filter((b) => b.id === selectedId), ...pickable];
  }
  return pickable;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface BeanPickerProps {
  beans: Bean[];
  value: number | null;
  onChange: (beanId: number | null) => void;
  /** Inherits the caller's input styling so it blends into each form. */
  style?: React.CSSProperties;
  disabled?: boolean;
  id?: string;
}

export function BeanPicker({ beans, value, onChange, style, disabled, id }: BeanPickerProps) {
  const { t } = useTranslation();
  const options = buildBeanOptions(beans, value);

  return (
    <select
      id={id}
      disabled={disabled}
      style={style}
      value={value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : parseInt(e.target.value, 10))}
    >
      <option value="">{t("beanPicker.noBean")}</option>
      {options.map((b) => {
        const inactive = !isPickableBean(b);
        return (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.roastDate != null ? ` · ${fmtRoastDate(b.roastDate)}` : ""}
            {b.status === "frozen" ? t("beanPicker.frozenSuffix") : ""}
            {inactive ? t("beanPicker.inactiveSuffix") : ""}
          </option>
        );
      })}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Fremdbohne: Freitext mit Vorschlaegen — Pre-Brew und Shot-Edit nutzen ihn
// ---------------------------------------------------------------------------

interface BeanLabelInputProps {
  value: string;
  onChange: (label: string) => void;
  style?: React.CSSProperties;
  /** id der datalist — je Dialog eindeutig. */
  listId: string;
}

/** Bohnen, die hier bewusst nicht gepflegt werden. Freitext mit Vorschlaegen aus
 *  dem, was schon benutzt wurde — das native datalist rendert dank
 *  color-scheme: dark dunkel. */
export function BeanLabelInput({ value, onChange, style, listId }: BeanLabelInputProps) {
  const { t } = useTranslation();
  const [hints, setHints] = useState<{ label: string; count: number }[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/shots/bean-labels")
      .then((r) => (r.ok ? (r.json() as Promise<{ label: string; count: number }[]>) : []))
      .then((v) => { if (!cancelled) setHints(v); })
      .catch(() => { /* Vorschlaege sind Komfort, kein Muss */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        placeholder={t("preshot.beanLabelPlaceholder")}
        style={style}
      />
      <datalist id={listId}>
        {hints.map((h) => (
          <option key={h.label} value={h.label}>{`${h.count}×`}</option>
        ))}
      </datalist>
    </>
  );
}
