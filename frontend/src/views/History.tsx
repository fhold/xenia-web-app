/**
 * History view — Phase 1 Step 11.5.
 *
 * Lists all shots with filtering, sorting and infinite scroll. Delete is
 * wired here; the detail and edit modals are added in a later commit
 * (the card already supports onOpen / onEdit via optional props).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { SlidersHorizontal, ChevronLeft, X, ArrowLeftRight, Star } from "lucide-react";
import { useShots, DEFAULT_SHOT_FILTERS } from "../hooks/useShots.js";
import { makeUniqueRoastingLabels } from "../lib/roastingFilterLabel.js";
import { formatDay } from "../lib/dates.js";
import type { ShotCategoryFilter, ShotFilters } from "../hooks/useShots.js";
import { useBeans } from "../hooks/useBeans.js";
import { useGrinders } from "../hooks/useGrinders.js";
import { useProfiles } from "../hooks/useProfiles.js";
import { useBaskets, basketName } from "../hooks/useBaskets.js";
import { ShotHistoryCard, HISTORY_COLS } from "../components/ShotHistoryCard.js";
import { ShotDetailModal } from "../components/ShotDetailModal.js";
import { ShotEditModal } from "../components/ShotEditModal.js";
import { ShotCompareView } from "../components/ShotCompareView.js";
import { useTranslation } from "../i18n/index.js";
import type { CompareSuggestions, ShotListItem, ShotSortKey } from "@shared/types.js";
import theme from "../theme.js";

const C = theme;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: 7,
  background: C.bg,
  border: `1px solid ${C.bdr}`,
  color: C.txt,
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

const suggestBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "5px 10px",
  borderRadius: 7,
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
  background: C.accG,
  border: `1px solid ${C.accB}`,
  color: C.accLight,
  whiteSpace: "nowrap",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  color: C.mut,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 1,
  marginBottom: 4,
};

// ---------------------------------------------------------------------------
// Date presets
// ---------------------------------------------------------------------------

type DatePreset = "today" | "week" | "month" | "quarter" | "all" | "custom";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Start date for a preset (end date is always null = up to now). */
function presetStartDate(preset: Exclude<DatePreset, "custom">): string | null {
  switch (preset) {
    case "today":   return isoDaysAgo(0);
    case "week":    return isoDaysAgo(7);
    case "month":   return isoDaysAgo(30);
    case "quarter": return isoDaysAgo(90);
    case "all":     return null;
  }
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** A pill-style toggle button used for tabs / presets / rating filters. */
function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 11px",
        borderRadius: 7,
        fontSize: 12,
        fontFamily: "inherit",
        cursor: "pointer",
        background: active ? C.accG2 : C.bg,
        border: `1px solid ${active ? C.accB : C.bdr}`,
        color: active ? C.acc : C.mut,
        fontWeight: active ? 600 : 400,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      {children}
    </div>
  );
}

/** Dim placeholder card shown while shots are loading. */
function SkeletonCard() {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.bdr}`,
        borderRadius: 10,
        padding: "12px 14px",
        opacity: 0.45,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ height: 13, width: "55%", background: C.bdrL, borderRadius: 4 }} />
      <div style={{ height: 11, width: "82%", background: C.bdr, borderRadius: 4 }} />
    </div>
  );
}

function SkeletonList({ count }: { count: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

interface HistoryProps {
  mobile: boolean;
  /** True while a brew is running — disables per-row repeat (machine busy). */
  isBrewing: boolean;
  /** Central start-readiness guard — when false, all repeat controls disable. */
  canStartBrew?: boolean;
  /** Repeat a shot: opens the pre-shot dialog prefilled (App owns the dialog). */
  onRepeat: (shot: ShotListItem) => void;
  /** F-B7: pre-filter by this roasting (bean) id when arriving from the Beans view. */
  initialBeanId?: number | null;
  /** „Alle Bezüge“ aus der Profilliste: auf dieses Profil filtern. */
  initialProfileId?: number | null;
  /** Schnitt 4: Sprung aus dem Netz Profil ↔ Bohne mit diesen Filtern — und
   *  bei der Rueckkehr die zuletzt gesetzten. */
  initialFilters?: Partial<ShotFilters> | null;
  /** BB-a: open this shot's detail on arrival (Best-Brew reference tap from Beans). */
  initialShotId?: number | null;
  /** Rueckweg: Filter und offener Bezug, damit Zurueck sie wieder herstellt. */
  onLocationState?: (st: { filters: ShotFilters; shotId: number | null }) => void;
  /** Zurueck-Knopf, wenn man per Sprung hergekommen ist. */
  onBack?: () => void;
  /** Klick auf den Profilnamen in der Detailansicht: Profil im Editor oeffnen. */
  onOpenProfile?: (profileId: number, variantId?: number | null) => void;
}

export function History({ mobile, isBrewing, canStartBrew = !isBrewing, onRepeat, initialBeanId = null, initialProfileId = null, initialFilters = null, initialShotId = null, onLocationState, onBack, onOpenProfile }: HistoryProps) {
  const repeatBlocked = !canStartBrew;
  const { t, lang } = useTranslation();
  const {
    shots, total, hasMore, loading, loadingMore, error,
    filters, setFilters, resetFilters, loadMore, update, remove, toggleBestBrew,
  } = useShots();

  // F-B7: apply an incoming roasting filter from the Beans view, then clear it
  // in the app so a later manual filter change isn't overridden.
  useEffect(() => {
    if (initialBeanId !== null) {
      setFilters({ ...DEFAULT_SHOT_FILTERS, beanId: initialBeanId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBeanId]);
  useEffect(() => {
    if (initialFilters !== null) {
      setFilters({ ...DEFAULT_SHOT_FILTERS, ...initialFilters });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilters]);
  useEffect(() => {
    if (initialProfileId !== null) {
      setFilters({ ...DEFAULT_SHOT_FILTERS, profileId: initialProfileId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProfileId]);
  const { beans } = useBeans();
  const { grinders } = useGrinders();
  const { profiles } = useProfiles();
  const { baskets } = useBaskets();
  // Die Variante steht nur dabei, wenn das Profil mehrere hat.
  const variantName = (s: ShotListItem): string | null => {
    const vs = profiles.find((p) => p.id === s.profileId)?.variants ?? [];
    return vs.length > 1 ? (vs.find((v) => v.id === s.variantId)?.name ?? null) : null;
  };

  // 3q: unique, readable label per roasting in the bean filter (make-unique).
  // Date formatting (de-DE, same pattern as the §3d pickers) is done here and
  // passed into the pure helper as strings. `lang` in deps → relabel on switch.
  const beanFilterLabels = useMemo(() => {
    // Kurz: Jahr nur, wenn nicht das laufende — lang: immer (lib/dates).
    const fmt = (d: Date, withYear: boolean): string => formatDay(d, { year: withYear ? "always" : "auto" });
    const inputs = beans.map((b) => ({
      id: b.id,
      coffeeName: b.name,
      roastDateShort: b.roastDate ? fmt(new Date(b.roastDate), false) || null : null,
      roastDateLong: b.roastDate ? fmt(new Date(b.roastDate), true) || null : null,
      createdAtShort: fmt(new Date(b.createdAt), false) || null,
      createdAtLong: fmt(new Date(b.createdAt), true) || null,
      createdAtSort: b.createdAt,
    }));
    return makeUniqueRoastingLabels(inputs, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beans, lang]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [detailShot, setDetailShot] = useState<ShotListItem | null>(null);
  const [editShot, setEditShot] = useState<ShotListItem | null>(null);

  // Bezuege vergleichen: A gewaehlt → Leiste unten; der naechste Tipp auf eine
  // Zeile oeffnet den Vergleich statt des Details. Nach dem Schliessen bleibt A
  // gewaehlt, damit man gleich gegen einen anderen Bezug vergleichen kann.
  const [compareFrom, setCompareFrom] = useState<ShotListItem | null>(null);
  const [compareTo, setCompareTo] = useState<ShotListItem | null>(null);
  const [suggestions, setSuggestions] = useState<CompareSuggestions | null>(null);
  useEffect(() => {
    setSuggestions(null);
    if (compareFrom === null) return;
    let alive = true;
    fetch(`/api/shots/${compareFrom.id}/compare-suggestions`)
      .then((r) => (r.ok ? (r.json() as Promise<CompareSuggestions>) : null))
      .then((sg) => { if (alive) setSuggestions(sg); })
      .catch(() => { /* ohne Vorschlaege weiter */ });
    return () => { alive = false; };
  }, [compareFrom]);
  const openRow = (s: ShotListItem) => {
    if (compareFrom === null) setDetailShot(s);
    else if (s.id !== compareFrom.id) setCompareTo(s);
  };

  // BB-a deep-link: reset to defaults on arrival, then page until the target
  // shot is loaded and open its detail (it may sit past the first page).
  const [pendingShotId, setPendingShotId] = useState<number | null>(null);
  useEffect(() => {
    if (initialShotId !== null) {
      setPendingShotId(initialShotId);
      // Bei der Rueckkehr stehen die Filter mit drin — die bleiben.
      if (initialFilters === null) setFilters({ ...DEFAULT_SHOT_FILTERS });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialShotId]);
  useEffect(() => {
    if (pendingShotId === null || loading) return;
    const found = shots.find((s) => s.id === pendingShotId);
    if (found) { setDetailShot(found); setPendingShotId(null); }
    else if (hasMore) loadMore();
    else setPendingShotId(null);
  }, [pendingShotId, shots, loading, hasMore, loadMore]);

  // Rueckweg: Filter und offenen Bezug am Eintrag im Verlauf merken.
  useEffect(() => {
    onLocationState?.({ filters, shotId: detailShot?.id ?? pendingShotId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, detailShot, pendingShotId]);

  // --- Infinite scroll: observe a sentinel at the list bottom ---
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    });
    obs.observe(el);
    return () => { obs.disconnect(); };
  }, [loadMore]);

  // --- Filter helpers ---
  const patch = (p: Partial<typeof filters>) => { setFilters({ ...filters, ...p }); };

  const applyPreset = (preset: Exclude<DatePreset, "custom">) => {
    setDatePreset(preset);
    patch({ startDate: presetStartDate(preset), endDate: null });
  };

  const handleReset = () => {
    setDatePreset("all");
    resetFilters();
  };

  const handleDelete = async (shot: ShotListItem) => {
    if (!window.confirm(t("history.deleteConfirm"))) return;
    await remove(shot.id);
  };

  const anyNarrowing =
    filters.beanId !== null ||
    filters.grinderId !== null ||
    filters.profileId !== null ||
    filters.basketId !== null ||
    filters.coffeeId !== null ||
    filters.variantId !== null ||
    filters.rating !== null ||
    filters.startDate !== null ||
    filters.endDate !== null ||
    filters.category !== DEFAULT_SHOT_FILTERS.category;

  // Aktive Filter als Chips ueber der Liste — einzeln entfernbar, damit nach
  // einem Sprung (Profil, Bohne) sichtbar ist, was die Liste eingrenzt.
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.category !== DEFAULT_SHOT_FILTERS.category) {
    chips.push({ key: "cat", label: `${t("history.filter.category")}: ${t(`history.category.${filters.category}`)}`, clear: () => patch({ category: DEFAULT_SHOT_FILTERS.category }) });
  }
  if (filters.profileId !== null) {
    const name = profiles.find((p) => p.id === filters.profileId)?.name ?? `#${filters.profileId}`;
    chips.push({ key: "profile", label: `${t("history.filter.profile")}: ${name}`, clear: () => patch({ profileId: null }) });
  }
  if (filters.coffeeId !== null) {
    const name = beans.find((b) => b.coffeeId === filters.coffeeId)?.name ?? `#${filters.coffeeId}`;
    chips.push({ key: "coffee", label: `${t("history.filter.coffee")}: ${name}`, clear: () => patch({ coffeeId: null }) });
  }
  if (filters.variantId !== null) {
    const name = profiles.flatMap((p) => p.variants ?? []).find((v) => v.id === filters.variantId)?.name ?? `#${filters.variantId}`;
    chips.push({ key: "variant", label: `${t("history.filter.variant")}: ${name}`, clear: () => patch({ variantId: null }) });
  }
  if (filters.basketId !== null) {
    const name = basketName(baskets, filters.basketId) ?? `#${filters.basketId}`;
    chips.push({ key: "basket", label: `${t("history.filter.basket")}: ${name}`, clear: () => patch({ basketId: null }) });
  }
  if (filters.beanId !== null) {
    const name = beanFilterLabels.get(filters.beanId) ?? beans.find((b) => b.id === filters.beanId)?.name ?? `#${filters.beanId}`;
    chips.push({ key: "bean", label: `${t("history.filter.bean")}: ${name}`, clear: () => patch({ beanId: null }) });
  }
  if (filters.grinderId !== null) {
    const name = grinders.find((g) => g.id === filters.grinderId)?.name ?? `#${filters.grinderId}`;
    chips.push({ key: "grinder", label: `${t("history.filter.grinder")}: ${name}`, clear: () => patch({ grinderId: null }) });
  }
  if (filters.rating !== null) {
    chips.push({ key: "rating", label: `${t("history.filter.rating")}: ${filters.rating}★`, clear: () => patch({ rating: null }) });
  }
  if (filters.startDate !== null || filters.endDate !== null) {
    const label = datePreset !== "custom" && datePreset !== "all"
      ? t(`history.datePreset.${datePreset}`)
      : `${filters.startDate ?? "…"} – ${filters.endDate ?? "…"}`;
    chips.push({ key: "date", label: `${t("history.filter.dateRange")}: ${label}`, clear: () => { setDatePreset("all"); patch({ startDate: null, endDate: null }); } });
  }

  const CATEGORIES: ShotCategoryFilter[] = ["brew", "maintenance", "test", "all"];
  const RATINGS = [5, 4, 3, 2, 1];
  const SORTS: ShotSortKey[] = ["date_desc", "date_asc", "rating", "bean"];
  const PRESETS: Exclude<DatePreset, "custom">[] = ["today", "week", "month", "quarter", "all"];

  return (
    <div style={{ maxWidth: mobile ? undefined : 1100, margin: mobile ? undefined : "0 auto" }}>
      {/* Zurueck dorthin, woher der Sprung kam (Sorte, Editor, Profilliste). */}
      {onBack && (
        <button
          onClick={onBack}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: C.mut, cursor: "pointer", fontSize: 13, fontFamily: "inherit", marginBottom: 12, padding: 0 }}
        >
          <ChevronLeft size={16} />{t("history.back")}
        </button>
      )}
      {/* Header: count + filter toggle + sort */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13, color: C.mut, flex: 1 }}>
          {t(filters.category === "test" ? "history.countTest" : filters.category === "maintenance" ? "history.countMaintenance" : filters.category === "all" ? "history.countAll" : "history.count").replace("{n}", String(total))}
        </span>

        <select
          value={filters.sort}
          onChange={(e) => patch({ sort: e.target.value as ShotSortKey })}
          style={{ ...selectStyle, width: "auto" }}
          title={t("history.sort.label")}
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>{t(`history.sort.${s}`)}</option>
          ))}
        </select>

        <button
          onClick={() => setFiltersOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 12px",
            borderRadius: 7,
            fontSize: 12,
            fontFamily: "inherit",
            cursor: "pointer",
            background: filtersOpen || anyNarrowing ? C.accG2 : C.bg,
            border: `1px solid ${filtersOpen || anyNarrowing ? C.accB : C.bdr}`,
            color: filtersOpen || anyNarrowing ? C.acc : C.mut,
          }}
        >
          <SlidersHorizontal size={13} />
          {t("history.filterToggle")}
        </button>
      </div>

      {/* Filter panel */}
      {filtersOpen && (
        <div
          style={{
            background: C.card,
            border: `1px solid ${C.bdr}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* Category tabs */}
          <FilterField label={t("history.filter.category")}>
            <div style={{ display: "flex", gap: 6 }}>
              {CATEGORIES.map((cat) => (
                <Chip key={cat} active={filters.category === cat} onClick={() => patch({ category: cat })}>
                  {t(`history.category.${cat}`)}
                </Chip>
              ))}
            </div>
          </FilterField>

          {/* Bean / Grinder / Profile dropdowns */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr 1fr",
              gap: 10,
            }}
          >
            <FilterField label={t("history.filter.bean")}>
              <select
                style={selectStyle}
                value={filters.beanId ?? ""}
                onChange={(e) => patch({ beanId: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{t("history.allOption")}</option>
                {beans.map((b) => (
                  <option key={b.id} value={b.id}>{beanFilterLabels.get(b.id) ?? b.name}</option>
                ))}
              </select>
            </FilterField>
            <FilterField label={t("history.filter.grinder")}>
              <select
                style={selectStyle}
                value={filters.grinderId ?? ""}
                onChange={(e) => patch({ grinderId: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{t("history.allOption")}</option>
                {grinders.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </FilterField>
            <FilterField label={t("history.filter.profile")}>
              <select
                style={selectStyle}
                value={filters.profileId ?? ""}
                onChange={(e) => patch({ profileId: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{t("history.allOption")}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </FilterField>
            <FilterField label={t("history.filter.basket")}>
              <select
                style={selectStyle}
                value={filters.basketId ?? ""}
                onChange={(e) => patch({ basketId: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">{t("history.allOption")}</option>
                {baskets.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </FilterField>
          </div>

          {/* Rating filter */}
          <FilterField label={t("history.filter.rating")}>
            <div style={{ display: "flex", gap: 6 }}>
              <Chip active={filters.rating === null} onClick={() => patch({ rating: null })}>
                {t("history.allOption")}
              </Chip>
              {RATINGS.map((r) => (
                <Chip
                  key={r}
                  active={filters.rating === r}
                  onClick={() => patch({ rating: r })}
                >
                  {`${r}★`}
                </Chip>
              ))}
            </div>
          </FilterField>

          {/* Date range */}
          <FilterField label={t("history.filter.dateRange")}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {PRESETS.map((preset) => (
                <Chip
                  key={preset}
                  active={datePreset === preset}
                  onClick={() => applyPreset(preset)}
                >
                  {t(`history.datePreset.${preset}`)}
                </Chip>
              ))}
              <Chip active={datePreset === "custom"} onClick={() => setDatePreset("custom")}>
                {t("history.datePreset.custom")}
              </Chip>
            </div>
            {datePreset === "custom" && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  type="date"
                  value={filters.startDate ?? ""}
                  onChange={(e) => patch({ startDate: e.target.value || null })}
                  style={{ ...selectStyle, width: "auto" }}
                />
                <input
                  type="date"
                  value={filters.endDate ?? ""}
                  onChange={(e) => patch({ endDate: e.target.value || null })}
                  style={{ ...selectStyle, width: "auto" }}
                />
              </div>
            )}
          </FilterField>

          {/* Reset */}
          <div>
            <button
              onClick={handleReset}
              style={{
                padding: "7px 14px",
                borderRadius: 7,
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
                background: "transparent",
                border: `1px solid ${C.bdr}`,
                color: C.mut,
              }}
            >
              {t("history.reset")}
            </button>
          </div>
        </div>
      )}

      {/* Aktive Filter */}
      {chips.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {chips.map((c) => (
            <span
              key={c.key}
              style={{
                display: "inline-flex", alignItems: "center", gap: 2, height: 30, boxSizing: "border-box",
                padding: "0 2px 0 10px", borderRadius: 15, border: `1px solid ${C.accB}`,
                background: C.accG, color: C.accLight, fontSize: 12.5,
              }}
            >
              {c.label}
              <button
                onClick={c.clear}
                aria-label={`${c.label} — ${t("history.removeFilter")}`}
                style={{ width: 26, height: 26, border: "none", borderRadius: 13, background: "transparent", color: C.mut, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <X size={13} />
              </button>
            </span>
          ))}
          <button
            onClick={handleReset}
            style={{ height: 30, padding: "0 8px", border: "none", background: "transparent", color: C.mut, fontSize: 12.5, fontFamily: "inherit", cursor: "pointer" }}
          >
            {t("history.clearFilters")}
          </button>
        </div>
      )}

      {/* Spaltenkopf — dieselben Breiten wie die Zeilen */}
      {!mobile && shots.length > 0 && !loading && !error && (
        <div style={{ display: "flex", alignItems: "center", columnGap: 12, padding: "0 10px 6px 14px", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: C.mut }}>
          <span style={{ flex: 1 }}>{t("history.columns.shot")}</span>
          <span style={{ width: HISTORY_COLS.grind }}>{t("history.columns.grind")}</span>
          <span style={{ width: HISTORY_COLS.rating }}>{t("history.columns.rating")}</span>
          <span style={{ width: HISTORY_COLS.channeling }}>{t("history.columns.channeling")}</span>
          <span style={{ width: HISTORY_COLS.yield }}>{t("history.columns.yield")}</span>
          <span style={{ width: HISTORY_COLS.actions }} />
        </div>
      )}

      {/* List */}
      {error ? (
        <div style={{ color: C.red, fontSize: 13, padding: "40px 0", textAlign: "center" }}>
          {t("history.loadError")}
        </div>
      ) : loading ? (
        <SkeletonList count={6} />
      ) : shots.length === 0 ? (
        <div style={{ color: C.mut, fontSize: 13, padding: "40px 0", textAlign: "center" }}>
          {anyNarrowing ? t("history.emptyFiltered") : t("history.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {shots.map((shot) => (
            <ShotHistoryCard
              key={shot.id}
              shot={shot}
              basketName={basketName(baskets, shot.basketId)}
              variantName={variantName(shot)}
              mobile={mobile}
              onOpen={openRow}
              onEdit={setEditShot}
              onCompare={setCompareFrom}
              highlight={compareFrom?.id === shot.id}
              onRepeat={onRepeat}
              repeatBlocked={repeatBlocked}
              onToggleBest={(s, makeBest) => { void toggleBestBrew(s.id, makeBest); }}
              onDelete={(s) => { void handleDelete(s); }}
            />
          ))}

          {/* Infinite-scroll sentinel + load-more skeletons */}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {loadingMore && <SkeletonCard />}
        </div>
      )}

      {/* Detail modal */}
      {detailShot && (
        <ShotDetailModal
          shot={detailShot}
          mobile={mobile}
          onClose={() => setDetailShot(null)}
          onEdit={(s) => { setDetailShot(null); setEditShot(s); }}
          onDelete={(s) => { setDetailShot(null); void handleDelete(s); }}
          onUpdate={(patch) => update(detailShot.id, patch)}
          onRepeat={(s) => { setDetailShot(null); onRepeat(s); }}
          repeatBlocked={repeatBlocked}
          onToggleBest={(s, makeBest) => { void toggleBestBrew(s.id, makeBest); }}
          onOpenProfile={onOpenProfile ? (id, variantId) => { setDetailShot(null); onOpenProfile(id, variantId); } : undefined}
          onCompare={(s) => { setDetailShot(null); setCompareFrom(s); }}
        />
      )}

      {/* Vergleich: Leiste unten, solange A gewaehlt ist */}
      {compareFrom && (
        <>
          {/* Platz, damit die Leiste die letzte Zeile nicht verdeckt (Handy: zweizeilig) */}
          <div style={{ height: mobile ? 110 : 64 }} />
          <div
            style={{
              position: "fixed", left: 0, right: 0, bottom: "calc(14px + env(safe-area-inset-bottom))", zIndex: 50,
              display: "flex", justifyContent: "center", padding: "0 12px", pointerEvents: "none",
            }}
          >
            <div
              style={{
                pointerEvents: "auto", maxWidth: 760, width: "100%", boxSizing: "border-box",
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                padding: "8px 10px 8px 14px", borderRadius: 12,
                background: C.cardElev, border: `1px solid ${C.accB}`,
                boxShadow: `0 12px 36px ${C.overlay}`,
              }}
            >
              <ArrowLeftRight size={15} color={C.acc} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 160, fontSize: 13, color: C.txt }}>
                {t("history.compare.banner", { id: compareFrom.id, profile: compareFrom.profileName })}
              </span>
              {suggestions?.reference && (
                <button onClick={() => setCompareTo(suggestions.reference)} style={suggestBtn} title={t("history.compare.suggestReferenceTip")}>
                  <Star size={12} fill={C.acc} color={C.acc} />#{suggestions.reference.id}
                </button>
              )}
              {suggestions?.previous && (
                <button onClick={() => setCompareTo(suggestions.previous)} style={suggestBtn} title={t("history.compare.suggestPreviousTip")}>
                  {t("history.compare.suggestPrevious", { id: suggestions.previous.id })}
                </button>
              )}
              <button
                onClick={() => { setCompareFrom(null); }}
                style={{ ...suggestBtn, border: "none", color: C.mut }}
              >
                {t("history.compare.cancel")}
              </button>
            </div>
          </div>
        </>
      )}

      {compareFrom && compareTo && (
        <ShotCompareView
          a={compareFrom}
          b={compareTo}
          mobile={mobile}
          variantName={variantName}
          onOpenShot={(s) => { setCompareTo(null); setDetailShot(s); }}
          onClose={() => setCompareTo(null)}
        />
      )}

      {/* Edit modal */}
      {editShot && (
        <ShotEditModal
          shot={editShot}
          onSave={(patch) => update(editShot.id, patch)}
          onClose={() => setEditShot(null)}
        />
      )}
    </div>
  );
}
