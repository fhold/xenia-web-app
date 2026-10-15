/**
 * Beans view — §3.4b Sorte/Röstung (3b refinement).
 *
 * Two levels (F-B1): ONE library list with the active coffees grouped on top
 * (each marked "Aktiv"); favourites first within each group; default sort
 * "Zuletzt". Tapping a coffee opens the detail (master data + rating + favourite
 * + Nachkaufen + overflow; roastings list with Verbrauch + Preis, kebab →
 * action sheet, archive collapsed). Tapping a roasting row (not the kebab) opens
 * the History pre-filtered to that roasting (F-B7).
 *
 * All sub-components live at MODULE scope (F-T3) so a parent re-render (e.g. the
 * refetch after archiving) does not remount them and reset their local state
 * (the "Archiv anzeigen" toggle stays open).
 *
 * Mobile: single column, detail = full screen (back). Tablet/Desktop: 2-column.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Star, ThumbsUp, ThumbsDown, Minus, ChevronRight, ChevronLeft, Snowflake,
  Layers, Plus, ArrowUpDown, Check, ChevronDown, MoreVertical, MoreHorizontal,
  Pencil, GitMerge, Trash2, Target, Package, Flame, Filter, Search, X,
  Camera, ImageOff, ShoppingBag, ChevronUp, Archive,
} from "lucide-react";
import { useCoffees, type CoffeeView, type UseCoffeesReturn } from "../hooks/useCoffees.js";
import { resizeForUpload } from "../lib/imageResize.js";
import { CoffeeEditor } from "../components/CoffeeEditor.js";
import { RoastingEditor } from "../components/RoastingEditor.js";
import { RoastingActionSheet } from "../components/RoastingActionSheet.js";
import { CoffeePicker } from "../components/CoffeePicker.js";
import { useTranslation } from "../i18n/index.js";
import type { Bean, BeanRating, BestBrewSummary, Coffee } from "@shared/types.js";
import { activeSiblings, preferDeactivate } from "@shared/coffee.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const MONO = "'JetBrains Mono', monospace";
// BB-a: Best-Brew reference accent (per spec).
const BEST = C.acc;

type SortKey = "recent" | "name" | "rating" | "age";
type FilterKey = "all" | "active" | "favourite" | "available" | "archived";
const RATING_ORDER: Record<string, number> = { thumbs_up: 3, meh: 2, thumbs_down: 1 };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" }).format(d);
}
const fmtG = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ---------------------------------------------------------------------------
// Atoms (module scope)
// ---------------------------------------------------------------------------

function TypeChip({ brewType }: { brewType: Coffee["brewType"] }) {
  if (!brewType) return null;
  const filter = brewType === "filter";
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, letterSpacing: ".4px", textTransform: "uppercase",
      color: filter ? C.blu : C.acc, border: `1px solid ${filter ? alpha(C.blu, 0.36) : C.accB}`,
      borderRadius: 6, padding: "2px 7px", lineHeight: 1.4, flexShrink: 0,
    }}>{brewType}</span>
  );
}

function StarBtn({ on, onClick, size = 30 }: { on: boolean; onClick: (e: React.MouseEvent) => void; size?: number }) {
  return (
    <button onClick={onClick} aria-label="Favorit"
      style={{
        width: size, height: size, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center",
        justifyContent: "center", cursor: "pointer", transition: ".15s",
        border: `1px solid ${on ? C.accB : C.bdr}`, background: on ? C.accG : "transparent", color: on ? C.acc : C.dim,
      }}>
      <Star size={16} fill={on ? "currentColor" : "none"} />
    </button>
  );
}

function VerdictGlyph({ rating }: { rating: BeanRating | null }) {
  if (!rating) return null;
  const col = rating === "thumbs_up" ? C.grn : rating === "thumbs_down" ? C.red : C.mut;
  const Icon = rating === "thumbs_up" ? ThumbsUp : rating === "thumbs_down" ? ThumbsDown : Minus;
  return <span style={{ display: "inline-flex", color: col }}><Icon size={13} /></span>;
}

function AgeView({ days, frozen }: { days: number | null; frozen: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 15, color: C.txt, lineHeight: 1, whiteSpace: "nowrap" }}>
      {days !== null ? <>{days}<small style={{ fontSize: 11, color: C.mut, marginLeft: 3, fontWeight: 400 }}>Tage</small></> : <span style={{ color: C.dim }}>—</span>}
      {frozen && <span style={{ display: "inline-flex", color: C.blu }}><Snowflake size={13} /></span>}
    </div>
  );
}

function ThumbsSeg({ value, onChange }: { value: BeanRating | null; onChange: (v: BeanRating | null) => void }) {
  const opts: { k: BeanRating; Icon: typeof ThumbsUp; col: string }[] = [
    { k: "thumbs_down", Icon: ThumbsDown, col: C.red },
    { k: "meh", Icon: Minus, col: C.txtS },
    { k: "thumbs_up", Icon: ThumbsUp, col: C.grn },
  ];
  return (
    <div style={{ display: "inline-flex", gap: 4, background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 11, padding: 3 }}>
      {opts.map(({ k, Icon, col }) => {
        const on = value === k;
        return (
          <button key={k} onClick={() => onChange(on ? null : k)}
            style={{
              width: 50, height: 38, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", border: "none", transition: ".15s", color: on ? col : C.dim,
              background: on ? (k === "thumbs_up" ? alpha(C.grn, 0.14) : k === "thumbs_down" ? alpha(C.red, 0.14) : C.bdrL) : "transparent",
            }}>
            <Icon size={17} fill={on && k === "thumbs_up" ? "currentColor" : "none"} />
          </button>
        );
      })}
    </div>
  );
}

const secLabel: React.CSSProperties = {
  fontSize: 10.5, letterSpacing: "1.7px", textTransform: "uppercase", color: C.mut,
  display: "flex", alignItems: "center", gap: 9, margin: "2px 2px 11px", whiteSpace: "nowrap",
};
const secCount: React.CSSProperties = { fontFamily: MONO, color: C.mut, letterSpacing: "1px" };

// ---------------------------------------------------------------------------
// Library row (active marker; F-B1/F-B3 — no shotCount)
// ---------------------------------------------------------------------------

function LibraryRow({ c, onOpen, onToggleFav }: {
  c: CoffeeView; onOpen: (id: number) => void; onToggleFav: (c: Coffee) => void;
}) {
  const { t } = useTranslation();
  const active = c.activeRoasting !== null;
  return (
    <div onClick={() => onOpen(c.id)}
      style={{ display: "flex", alignItems: "center", gap: 13, padding: "13px 15px", borderTop: `1px solid ${C.bdr}`, cursor: "pointer" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          {active && <span title={t("coffee.active")} style={{ width: 7, height: 7, borderRadius: "50%", background: C.grn, flexShrink: 0 }} />}
          <span style={{ fontSize: 15, fontWeight: 600, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
          <TypeChip brewType={c.brewType} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: C.mut, marginTop: 3, whiteSpace: "nowrap" }}>
          {c.roaster ?? ""}<VerdictGlyph rating={c.rating} />
          {c.stockG !== null && (
            <span style={{ color: c.stockG < 0 ? C.red : C.mut }} title={t("coffee.stockTotal")}>
              {c.roaster ? "· " : ""}{fmtG(c.stockG)} g
            </span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <AgeView days={c.effectiveAgeDays} frozen={false} />
          {c.hasFrozen && <span style={{ display: "inline-flex", color: C.blu }} title={t("beans.status.frozen")}><Snowflake size={13} /></span>}
          {c.reserveCount > 0 && <span style={{ display: "inline-flex", color: C.dim }} title={t("coffee.roastings")}><Layers size={12} /></span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <StarBtn on={c.favourite} onClick={(e) => { e.stopPropagation(); onToggleFav(c); }} />
          <span style={{ display: "flex", color: C.dim }}><ChevronRight size={18} /></span>
        </div>
      </div>
    </div>
  );
}

function SortControl({ sortKey, setSortKey }: { sortKey: SortKey; setSortKey: (k: SortKey) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const SORTS: { k: SortKey; label: string }[] = [
    { k: "recent", label: t("coffee.sortRecent") },
    { k: "name", label: t("coffee.sortName") },
    { k: "rating", label: t("coffee.sortRating") },
    { k: "age", label: t("coffee.sortAge") },
  ];
  const cur = SORTS.find((s) => s.k === sortKey)!;
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 10px", borderRadius: 8, border: `1px solid ${C.bdr}`, background: "transparent", color: C.txtS, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
        <ArrowUpDown size={14} color={C.mut} /><span>{cur.label}</span><ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", top: 36, right: 0, zIndex: 41, background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 13, padding: 6, minWidth: 208, boxShadow: `0 22px 56px ${alpha(C.black, 0.55)}` }}>
            {SORTS.map((s) => {
              const on = s.k === sortKey;
              return (
                <div key={s.k} onClick={() => { setSortKey(s.k); setOpen(false); }}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 9, fontSize: 13.5, color: on ? C.txt : C.txtS, cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.white, 0.045))}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <span style={{ width: 16, display: "flex" }}>{on && <Check size={15} color={C.acc} />}</span>{s.label}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function FilterControl({ filterKey, setFilterKey }: { filterKey: FilterKey; setFilterKey: (k: FilterKey) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const FILTERS: { k: FilterKey; label: string }[] = [
    { k: "all", label: t("coffee.filterAll") },
    { k: "active", label: t("coffee.filterActive") },
    { k: "favourite", label: t("coffee.filterFav") },
    { k: "available", label: t("coffee.filterAvailable") },
    { k: "archived", label: t("coffee.filterArchived") },
  ];
  const cur = FILTERS.find((f) => f.k === filterKey)!;
  const on = filterKey !== "all";
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 10px", borderRadius: 8, border: `1px solid ${on ? C.accB : C.bdr}`, background: "transparent", color: on ? C.acc : C.txtS, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
        <Filter size={14} color={on ? C.acc : C.mut} /><span>{cur.label}</span><ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", top: 36, left: 0, zIndex: 41, background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 13, padding: 6, minWidth: 184, boxShadow: `0 22px 56px ${alpha(C.black, 0.55)}` }}>
            {FILTERS.map((f) => {
              const sel = f.k === filterKey;
              return (
                <div key={f.k} onClick={() => { setFilterKey(f.k); setOpen(false); }}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 9, fontSize: 13.5, color: sel ? C.txt : C.txtS, cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.white, 0.045))}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <span style={{ width: 16, display: "flex" }}>{sel && <Check size={15} color={C.acc} />}</span>{f.label}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function SearchField({ q, setQ }: { q: string; setQ: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", display: "flex", color: C.mut, pointerEvents: "none" }}>
        <Search size={14} />
      </span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("coffee.search")}
        style={{ width: "100%", height: 30, boxSizing: "border-box", padding: q ? "0 28px 0 28px" : "0 10px 0 28px", borderRadius: 8, border: `1px solid ${C.bdr}`, background: "transparent", color: C.txt, fontSize: 12.5, fontFamily: "inherit", outline: "none" }}
      />
      {q && (
        <button onClick={() => setQ("")} aria-label={t("coffee.cancel")}
          style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 6, border: "none", background: "transparent", color: C.mut, cursor: "pointer", padding: 0 }}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail (master data F-B2; roastings F-B4/F-B6/F-B7)
// ---------------------------------------------------------------------------

/**
 * Meta-Zeile statt gerahmter 3-Spalten-Box.
 *
 * Die alte Box klemmte jeden Wert per `nowrap` + Ellipse auf eine Zeile —
 * daher stand dort "Brasilien, Guate…". Hier darf umbrochen werden, die
 * Herkunft steht vollstaendig.
 */
function MetaRow({ c }: { c: CoffeeView }) {
  const { t } = useTranslation();
  const altitude =
    c.altitudeMin !== null && c.altitudeMax !== null ? `${c.altitudeMin}–${c.altitudeMax} m`
    : c.altitudeMin !== null ? `${c.altitudeMin} m`
    : c.altitudeMax !== null ? `${c.altitudeMax} m` : null;
  const region = [c.region, c.farm].filter(Boolean).join(" · ") || null;
  // F-B2: only fields that are actually filled are shown.
  const specs: { k: string; v: string }[] = [];
  if (c.country) specs.push({ k: t("coffee.specOrigin"), v: c.country });
  if (region) specs.push({ k: t("beans.fields.region"), v: region });
  if (c.variety) specs.push({ k: t("beans.fields.variety"), v: c.variety });
  if (c.processing) specs.push({ k: t("coffee.specProcess"), v: c.processing });
  if (c.roastLevel) specs.push({ k: t("coffee.specRoast"), v: t(`beans.roastLevel.${c.roastLevel}`) });
  if (altitude) specs.push({ k: t("beans.fields.altitudeMin"), v: altitude });
  if (specs.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "5px 18px", marginTop: 14, fontSize: 12.5, color: C.txt }}>
      {specs.map((sp) => (
        <span key={sp.k} style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
          <i style={{ fontStyle: "normal", fontSize: 8.5, letterSpacing: "1.1px", textTransform: "uppercase", color: C.mut }}>{sp.k}</i>
          {sp.v}
        </span>
      ))}
    </div>
  );
}

/**
 * Beschreibung als Referenztext: zwei Zeilen, Rest hinter "mehr".
 *
 * Der Knopf erscheint nur, wenn wirklich etwas abgeschnitten ist — gemessen
 * am eingeklappten Absatz, nicht an einer Zeichenzahl geraten (die stimmt bei
 * anderer Spaltenbreite nicht mehr).
 */
function Description({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  const clamp: React.CSSProperties = open ? {} : {
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
  };
  return (
    <div style={{ marginTop: 9 }}>
      <p ref={ref} style={{ fontSize: 12.5, lineHeight: 1.6, color: C.mut, margin: 0, whiteSpace: "pre-wrap", ...clamp }}>
        {text}
      </p>
      {(truncated || open) && (
        <button onClick={() => { setOpen((o) => !o); }}
          style={{ background: "none", border: "none", padding: "2px 0 0", fontSize: 12.5, fontWeight: 600, color: C.acc, cursor: "pointer", fontFamily: "inherit" }}>
          {open ? t("coffee.less") : t("coffee.more")}
        </button>
      )}
    </div>
  );
}

function OverflowItem({ icon, label, danger, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 9, fontSize: 13.5, color: danger ? C.redText : C.txtS, cursor: "pointer" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.white, 0.045))}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <span style={{ width: 18, display: "flex", color: danger ? C.redText : C.mut }}>{icon}</span>{label}
    </div>
  );
}

// BB-a: the Sorte's Best-Brew reference — live-joined stats + tap-to-shot.
/** Best-Brew als ruhige Fusszeile statt als eigene Box. */
function BestBrewLine({ summary, onOpenShot }: {
  summary: BestBrewSummary | null; onOpenShot: (shotId: number) => void;
}) {
  const { t } = useTranslation();
  const bits = summary
    ? [
        summary.brewTimeS !== null ? `${Math.round(summary.brewTimeS)} s` : null,
        summary.ratio !== null ? `1:${summary.ratio.toFixed(1)}` : null,
        summary.peakPressureBar !== null ? `${summary.peakPressureBar.toFixed(1)} bar` : null,
      ].filter(Boolean).join(" · ")
    : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 12, fontSize: 11.5, color: C.mut }}>
      {/* dim ist hier richtig: Icon, kein Text. */}
      <span style={{ display: "inline-flex", color: summary ? BEST : C.dim }}>
        <Star size={12} fill="currentColor" color="currentColor" />
      </span>
      {summary ? (
        <button onClick={() => onOpenShot(summary.shotId)}
          style={{ background: "none", border: "none", padding: 0, font: "inherit", color: C.acc, cursor: "pointer", textAlign: "left" }}>
          {t("bestBrew.slotLabel")}{bits ? ` — ${bits}` : ""}
        </button>
      ) : (
        <span>{t("bestBrew.slotLabel")} — {t("bestBrew.noneShort")}</span>
      )}
    </div>
  );
}

function DetailHead({ c, onNachkaufen, onEdit, onMerge, onDelete, onToggleFav, onRate, onOpenShot,
                     onPickImage, onRemoveImage, imageBusy }: {
  c: CoffeeView;
  onNachkaufen: () => void; onEdit: () => void; onMerge: () => void; onDelete: () => void;
  onToggleFav: () => void; onRate: (v: BeanRating | null) => void;
  onOpenShot: (shotId: number) => void;
  onPickImage: (file: File) => void; onRemoveImage: () => void; imageBusy: boolean;
}) {
  const { t } = useTranslation();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(false);
  return (
    <div style={{ position: "relative", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 14, padding: "15px 16px 16px", overflow: "hidden" }}>
      {/* Kopf: Bild | Name+Chip+Röster | Aktionen.
          Der Textblock wird per align-self zentriert, damit die Namenszeile auf
          halber Höhe der Tüte sitzt; die Aktionen bleiben oben rechts. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 13 }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onPickImage(f);
          }}
        />
        <button
          onClick={() => { if (c.imageUpdatedAt) setZoom(true); else fileRef.current?.click(); }}
          disabled={imageBusy}
          title={c.imageUpdatedAt ? t("coffee.image.view") : t("coffee.image.add")}
          style={{
            width: 54, height: 66, flex: "0 0 auto", borderRadius: 7, padding: 0, overflow: "hidden",
            cursor: imageBusy ? "default" : "pointer", opacity: imageBusy ? 0.5 : 1,
            background: "transparent", border: `1px ${c.imageUpdatedAt ? "solid" : "dashed"} ${C.bdr2}`,
            display: "flex", alignItems: "center", justifyContent: "center", color: C.mut,
          }}
        >
          {c.imageUpdatedAt ? (
            <img src={`/api/coffees/${c.id}/image?v=${c.imageUpdatedAt}`} alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          ) : (
            <Camera size={18} />
          )}
        </button>

        <div style={{ flex: 1, minWidth: 0, alignSelf: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <span style={{ fontSize: 21, fontWeight: 700, color: C.txt, letterSpacing: "-.015em", lineHeight: 1.15 }}>{c.name}</span>
            <TypeChip brewType={c.brewType} />
          </div>
          {c.roaster && <div style={{ fontSize: 13, color: C.mut, marginTop: 3 }}>{c.roaster}</div>}
        </div>

        <div style={{ display: "flex", gap: 7, flex: "0 0 auto", alignSelf: "flex-start", position: "relative" }}>
          <button onClick={onNachkaufen} title={t("coffee.repurchase")} aria-label={t("coffee.repurchase")}
            style={{ width: 38, height: 38, borderRadius: 10, border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: `linear-gradient(180deg,${C.accTop},${C.accBottom})`, color: C.onAcc,
              boxShadow: `0 5px 15px ${alpha(C.acc, 0.22)}` }}>
            <ShoppingBag size={17} />
          </button>
          <button onClick={() => setOverflowOpen((o) => !o)} aria-label="more"
            style={{ width: 38, height: 38, borderRadius: 10, border: `1px solid ${C.bdr}`, background: "transparent", color: C.mut, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <MoreHorizontal size={18} />
          </button>
          {overflowOpen && (
            <>
              <div onClick={() => setOverflowOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
              <div style={{ position: "absolute", top: 42, right: 0, zIndex: 41, background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 13, padding: 6, minWidth: 208, boxShadow: `0 22px 56px ${alpha(C.black, 0.55)}` }}>
                <OverflowItem icon={<Pencil size={16} />} label={t("coffee.edit")} onClick={() => { setOverflowOpen(false); onEdit(); }} />
                <OverflowItem icon={<GitMerge size={16} />} label={t("coffee.merge")} onClick={() => { setOverflowOpen(false); onMerge(); }} />
                {c.imageUpdatedAt != null && (
                  <>
                    <OverflowItem icon={<Camera size={16} />} label={t("coffee.image.replace")}
                      onClick={() => { setOverflowOpen(false); fileRef.current?.click(); }} />
                    <OverflowItem icon={<ImageOff size={16} />} label={t("coffee.image.remove")}
                      onClick={() => { setOverflowOpen(false); onRemoveImage(); }} />
                  </>
                )}
                <div style={{ height: 1, background: C.bdr, margin: "5px 4px" }} />
                <OverflowItem icon={<Trash2 size={16} />} label={t("coffee.delete")} danger onClick={() => { setOverflowOpen(false); onDelete(); }} />
              </div>
            </>
          )}
        </div>
      </div>

      <MetaRow c={c} />

      {c.flavorNotes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
          {c.flavorNotes.map((n) => (
            <span key={n} style={{ fontSize: 11.5, color: C.txtS, border: `1px solid ${C.bdr2}`, borderRadius: 999, padding: "3px 10px" }}>{n}</span>
          ))}
        </div>
      )}

      {c.notes && <Description text={c.notes} />}

      {/* Bewertung und Favorit in einer Zeile — die Micro-Labels erklärten
          nichts, was Daumen und Stern nicht selbst sagen. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, paddingTop: 13, borderTop: `1px solid ${C.bdr}` }}>
        <ThumbsSeg value={c.rating} onChange={onRate} />
        <div style={{ marginLeft: "auto" }}><StarBtn on={c.favourite} size={36} onClick={onToggleFav} /></div>
      </div>

      <BestBrewLine summary={c.bestBrew ?? null} onOpenShot={onOpenShot} />

      {/* Bild gross ansehen. z 150: ueber der Ansicht, aber unter der
          MachineErrorLine (200) — ein Maschinenfehler darf nie verdeckt
          werden. Klick irgendwohin schliesst. */}
      {zoom && c.imageUpdatedAt != null && (
        <div
          onClick={() => { setZoom(false); }}
          style={{
            position: "fixed", inset: 0, zIndex: 150, background: C.overlay,
            backdropFilter: "blur(4px)", display: "flex", alignItems: "center",
            justifyContent: "center", padding: 24, cursor: "zoom-out",
          }}
        >
          <img
            src={`/api/coffees/${c.id}/image?v=${c.imageUpdatedAt}`}
            alt={c.name}
            onClick={(e) => { e.stopPropagation(); }}
            style={{
              maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
              borderRadius: 12, boxShadow: `0 24px 70px ${alpha(C.black, 0.6)}`, cursor: "default",
            }}
          />
          <button
            onClick={() => { setZoom(false); }}
            aria-label={t("coffee.image.close")}
            style={{
              position: "fixed", top: 16, right: 16, width: 40, height: 40, borderRadius: 10,
              border: `1px solid ${C.bdr}`, background: C.cardElev, color: C.txtS,
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

function Badge({ color, icon, label }: { color: string; icon: React.ReactNode; label: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".5px", padding: "3px 9px", borderRadius: 7, display: "inline-flex", alignItems: "center", gap: 5, color, background: `${color}1f`, border: `1px solid ${color}4d` }}>
      {icon}{label}
    </span>
  );
}

function RoastingRow({ r, onOpenHistory, onKebab }: {
  r: Bean; onOpenHistory: (beanId: number) => void; onKebab: (r: Bean) => void;
}) {
  const { t } = useTranslation();
  const frozen = r.status === "frozen";
  const archived = r.status === "archived";
  // §3g: active-source marker (isActive) is independent of the physical status.
  const activeBadge = r.isActive
    ? <Badge color={C.grn} icon={<Target size={11} />} label={t("coffee.badgeActive")} />
    : null;
  // Physical-status badge (archived is rendered in the sub-line instead).
  const statusBadge =
    r.status === "stock" ? <Badge color={C.mut} icon={<Package size={11} />} label={t("beans.status.stock")} />
    : frozen ? <Badge color={C.blu} icon={<Snowflake size={11} />} label={t("beans.status.frozen")} />
    : r.status === "thawed" ? <Badge color={C.blu} icon={<Flame size={11} />} label={t("beans.status.thawed")} />
    : null;
  // F-B4 Verbrauch + F-B6 Preis (mono).
  const consumption = r.remainingG !== null && r.bagSizeG !== null
    ? `${fmtG(r.remainingG)} g / ${fmtG(r.bagSizeG)} g`
    : r.remainingG !== null ? `${fmtG(r.remainingG)} g`
    : r.bagSizeG !== null ? `${fmtG(r.bagSizeG)} g` : null;
  // Negativer Rest = mehr bezogen als der Beutel hergibt (falsche Beutelgrösse
  // oder fehlende Korrektur) — das faellt in Mut-Grau nicht auf.
  const overdrawn = r.remainingG !== null && r.remainingG < 0;
  const sub: { text: string; color?: string }[] = [];
  if (!archived && r.effectiveAgeDays !== null) sub.push({ text: `${r.effectiveAgeDays} ${t("coffee.days")}` });
  if (consumption) sub.push({ text: consumption, color: overdrawn ? C.red : undefined });
  if (r.pricePerBagEur !== null) sub.push({ text: `${r.pricePerBagEur.toFixed(2)} €` });
  if ((r.shotCount ?? 0) > 0) sub.push({ text: `${r.shotCount} ${t("coffee.bezuege")}` }); // SD-2
  return (
    <div
      onClick={() => onOpenHistory(r.id)}
      title={t("coffee.roastings")}
      style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 16px", borderTop: `1px solid ${C.bdr}`, opacity: archived ? 0.6 : 1, cursor: "pointer" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: MONO, fontSize: 13.5, color: C.txt, display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          {t("coffee.roastedOn")} {fmtDate(r.roastDate)}{activeBadge}{statusBadge}
          {r.rating && <span style={{ fontFamily: "inherit", fontSize: 11, color: C.mut }}>{t("coffee.override")}</span>}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.mut, marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {archived
            ? <span>{t("beans.status.archived")}{consumption ? " · " : ""}<span style={overdrawn ? { color: C.red } : undefined}>{consumption}</span></span>
            : sub.map((s, i) => <span key={i}>{i > 0 ? "· " : ""}<span style={s.color ? { color: s.color } : undefined}>{s.text}</span></span>)}
          {frozen && r.frozenDate && <span style={{ color: C.blu }}>❄ {t("coffee.frozenSince")} {fmtDate(r.frozenDate)}</span>}
        </div>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onKebab(r); }} aria-label="Aktionen"
        style={{ width: 34, height: 42, borderRadius: 9, border: "1px solid transparent", background: "transparent", color: C.mut, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        onMouseEnter={(e) => { e.currentTarget.style.background = C.bg; e.currentTarget.style.color = C.txt; e.currentTarget.style.borderColor = C.bdr; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.mut; e.currentTarget.style.borderColor = "transparent"; }}>
        <MoreVertical size={20} />
      </button>
    </div>
  );
}

/**
 * Archiv-Zeile: aufgebrauchte Tüte, ruhig gehalten.
 *
 * Eigene Zeile statt der Vorrats-Darstellung — hier zählt nur noch, wann sie
 * geröstet war und was sie geliefert hat. Datum und Zahlen in Mono.
 */
function ArchiveRow({ r, onOpenHistory, onKebab }: {
  r: Bean; onOpenHistory: (beanId: number) => void; onKebab: (r: Bean) => void;
}) {
  const { t } = useTranslation();
  const overdrawn = r.remainingG !== null && r.remainingG < 0;
  const sub: string[] = [t("beans.status.archived")];
  if (r.remainingG !== null) sub.push(`${fmtG(r.remainingG)} g`);
  if ((r.shotCount ?? 0) > 0) sub.push(`${r.shotCount} ${t("coffee.bezuege")}`);
  return (
    <div
      onClick={() => onOpenHistory(r.id)}
      title={t("coffee.roastings")}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderTop: `1px solid ${C.bdr}`, cursor: "pointer" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: MONO, fontSize: 13, color: C.txtS }}>
          {t("coffee.roastedOn")} {fmtDate(r.roastDate)}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: overdrawn ? C.red : C.mut, marginTop: 4 }}>
          {sub.join(" · ")}
        </div>
      </div>
      <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: ".4px", color: C.mut, border: `1px solid ${C.bdr2}`, borderRadius: 5, padding: "2px 7px", marginLeft: "auto", flex: "0 0 auto" }}>
        {t("coffee.archiveBadge")}
      </span>
      <div
        onClick={(e) => { e.stopPropagation(); onKebab(r); }}
        style={{ width: 30, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: C.dim, cursor: "pointer", flex: "0 0 auto" }}>
        <MoreVertical size={17} />
      </div>
    </div>
  );
}

/** Primär-Knopf "Röstung hinzufügen" — gross in der Karte, schlank im Banner. */
function AddRoastingBtn({ onClick, slim }: { onClick: () => void; slim?: boolean }) {
  const { t } = useTranslation();
  return (
    <button onClick={onClick}
      style={{
        height: slim ? 32 : 38, borderRadius: 10, border: "none", cursor: "pointer",
        padding: slim ? "0 12px" : "0 16px", display: "inline-flex", alignItems: "center", gap: 8,
        fontFamily: "inherit", fontSize: slim ? 12.5 : 13.5, fontWeight: 600,
        background: `linear-gradient(180deg,${C.accTop},${C.accBottom})`, color: C.onAcc,
        boxShadow: slim ? "none" : `0 5px 15px ${alpha(C.acc, 0.2)}`,
        marginTop: slim ? 0 : 14, marginLeft: slim ? "auto" : undefined, flex: "0 0 auto",
      }}>
      <Plus size={slim ? 14 : 15} />{t("coffee.addRoasting")}
    </button>
  );
}

// Module scope (F-T3): showArchive state survives parent refetch/re-render.
function RoastingList({ c, onOpenHistory, onKebab, onAddRoasting }: {
  c: CoffeeView; onOpenHistory: (beanId: number) => void; onKebab: (r: Bean) => void;
  onAddRoasting: () => void;
}) {
  const { t } = useTranslation();
  const [showArchive, setShowArchive] = useState(false);
  const live = c.roastings.filter((r) => r.status !== "archived");
  const archived = c.roastings.filter((r) => r.status === "archived");
  const activeCount = c.roastings.filter((r) => r.isActive).length;
  // Leerzustand haengt am Bestand, nicht an der Aktiv-Markierung: "nicht im
  // Bestand" stimmt nur, wenn ueberhaupt keine unarchivierte Tuete da ist.
  const empty = live.length === 0;
  return (
    <>
      <div style={secLabel}>
        {t("coffee.roastings")}
        <span style={secCount}>
          {activeCount} {t("coffee.activeWord")}
          {archived.length ? ` · ${archived.length} ${t("coffee.archivedWord")}` : ""}
        </span>
      </div>

      {empty && !showArchive && (
        <div style={{ background: C.card, border: `1px dashed ${C.bdr2}`, borderRadius: 14, padding: "26px 24px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: C.cardElev, border: `1px solid ${C.bdr}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.mut }}>
            <ShoppingBag size={21} />
          </div>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, margin: "12px 0 0", color: C.txt }}>{t("coffee.emptyRoastingTitle")}</h3>
          <p style={{ fontSize: 12, color: C.mut, margin: "4px 0 0", maxWidth: 320, lineHeight: 1.5 }}>{t("coffee.emptyRoastingText")}</p>
          <AddRoastingBtn onClick={onAddRoasting} />
        </div>
      )}

      {empty && showArchive && (
        <div style={{ display: "flex", alignItems: "center", gap: 11, background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 11, padding: "11px 13px" }}>
          <span style={{ color: C.mut, display: "flex" }}><ShoppingBag size={17} /></span>
          <span style={{ fontSize: 12.5, color: C.mut }}>
            <b style={{ color: C.txtS, fontWeight: 600 }}>{t("coffee.emptyRoastingTitle")}</b> — {t("coffee.emptyRoastingSlim")}
          </span>
          <AddRoastingBtn onClick={onAddRoasting} slim />
        </div>
      )}

      {!empty && (
        <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 14, overflow: "hidden" }}>
          {live.map((r, i) => (
            <div key={r.id} style={i === 0 ? { borderTop: "none" } : undefined}>
              <RoastingRow r={r} onOpenHistory={onOpenHistory} onKebab={onKebab} />
            </div>
          ))}
        </div>
      )}

      {showArchive && archived.length > 0 && (
        <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 12, overflow: "hidden", marginTop: 11 }}>
          {archived.map((r, i) => (
            <div key={r.id} style={i === 0 ? { borderTop: "none" } : undefined}>
              <ArchiveRow r={r} onOpenHistory={onOpenHistory} onKebab={onKebab} />
            </div>
          ))}
        </div>
      )}

      {archived.length > 0 && (
        // Textlink statt gestrecktem Knopf: er ist eine Nebenhandlung und soll
        // keine leere Fläche als Container vortäuschen.
        <button onClick={() => setShowArchive((v) => !v)}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "none", border: "none", color: C.mut, fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "11px 4px", marginTop: 4 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = C.txtS)}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.mut)}>
          {showArchive ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {showArchive ? t("coffee.archiveHide") : `${t("coffee.archiveShow")} (${archived.length})`}
        </button>
      )}
    </>
  );
}

function RatingOverrideModal({ current, onPick, onClose }: {
  current: BeanRating | null; onPick: (v: BeanRating | null) => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const opts: { k: BeanRating | null; label: string }[] = [
    { k: null, label: t("coffee.inherit") },
    { k: "thumbs_down", label: t("beans.rating.thumbs_down") },
    { k: "meh", label: t("beans.rating.meh") },
    { k: "thumbs_up", label: t("beans.rating.thumbs_up") },
  ];
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 220 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 221, width: "min(360px, 94vw)", background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 14, padding: 18 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 600, color: C.txt }}>{t("coffee.ratingOverrideTitle")}</h2>
        <div style={{ fontSize: 12, color: C.mut, marginBottom: 12 }}>{t("coffee.ratingOverrideHint")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {opts.map((o) => {
            const on = current === o.k || (current == null && o.k === null);
            return (
              <button key={String(o.k)} onClick={() => void onPick(o.k)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, textAlign: "left",
                  border: `1px solid ${on ? C.accB : C.bdr}`, background: on ? C.accG : "transparent", color: on ? C.acc : C.txtS }}>
                {o.k === "thumbs_up" && <ThumbsUp size={15} />}{o.k === "thumbs_down" && <ThumbsDown size={15} />}{o.k === "meh" && <Minus size={15} />}{o.k === null && <Minus size={15} style={{ opacity: 0.4 }} />}
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * Rückfrage, sobald eine Röstung aktiv wird, während eine andere derselben
 * Sorte noch aktiv ist. Die neue ist dann schon aktiv — gefragt wird nur, was
 * mit den alten passiert. Zuerst steht die naheliegende Antwort: archivieren,
 * ausser alle alten sind eingefroren (pausiert, nicht aufgebraucht).
 */
function ActiveSiblingsModal({ siblings, onArchive, onDeactivate, onKeep }: {
  siblings: Bean[]; onArchive: () => void; onDeactivate: () => void; onKeep: () => void;
}) {
  const { t } = useTranslation();
  const many = siblings.length > 1;
  const dates = siblings.map((b) => fmtDate(b.roastDate)).join(", ");
  const archive = { key: "archive", label: t("coffee.siblingsArchive"), icon: <Archive size={15} />, onClick: onArchive };
  const deactivate = { key: "deactivate", label: t("coffee.siblingsDeactivate"), icon: <Target size={15} />, onClick: onDeactivate };
  const opts = preferDeactivate(siblings) ? [deactivate, archive] : [archive, deactivate];
  return (
    <>
      <div onClick={onKeep} style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 220 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 221, width: "min(360px, 94vw)", background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 14, padding: 18 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 600, color: C.txt }}>
          {t(many ? "coffee.siblingsTitleMany" : "coffee.siblingsTitle")}
        </h2>
        <div style={{ fontSize: 12, color: C.mut, marginBottom: 12 }}>
          {t(many ? "coffee.siblingsBodyMany" : "coffee.siblingsBody").replace("{dates}", dates)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {opts.map((o, i) => (
            <button key={o.key} onClick={o.onClick}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, textAlign: "left",
                border: `1px solid ${i === 0 ? C.accB : C.bdr}`, background: i === 0 ? C.accG : "transparent", color: i === 0 ? C.acc : C.txtS }}>
              {o.icon}{o.label}
            </button>
          ))}
          <button onClick={onKeep}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, textAlign: "left",
              border: `1px solid ${C.bdr}`, background: "transparent", color: C.mut }}>
            <Minus size={15} style={{ opacity: 0.4 }} />{t(many ? "coffee.siblingsKeepMany" : "coffee.siblingsKeep")}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface BeansProps {
  mobile: boolean;
  /** F-B7: open the History view pre-filtered to a roasting (bean) id; the
   *  coffeeId lets the app offer a "back to this Sorte" affordance (SD-1). */
  onOpenHistory: (beanId: number, coffeeId: number) => void;
  /** BB-a: open the History detail for a Best-Brew reference shot (Sorte card tap). */
  onOpenShot: (shotId: number, coffeeId: number) => void;
  /** Selected coffee id (controlled by the app so the detail survives a trip to
   *  the filtered History and back — SD-1). */
  selectedId: number | null;
  onSelectId: (id: number | null) => void;
}

export function Beans({ mobile, onOpenHistory, onOpenShot, selectedId, onSelectId }: BeansProps) {
  const { t } = useTranslation();
  const api: UseCoffeesReturn = useCoffees();
  const { coffees, loading, error } = api;

  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [filterKey, setFilterKey] = useState<FilterKey>("available");
  const [q, setQ] = useState("");
  const [coffeeEditor, setCoffeeEditor] = useState<Coffee | "new" | null>(null);
  const [roastingEditor, setRoastingEditor] = useState<{ coffee: CoffeeView; roasting?: Bean } | null>(null);
  const [sheet, setSheet] = useState<Bean | null>(null);
  const [picker, setPicker] = useState<
    | { kind: "merge"; coffee: CoffeeView }
    | { kind: "move"; roasting: Bean; coffee: CoffeeView }
    | null
  >(null);
  const [ratingOverride, setRatingOverride] = useState<Bean | null>(null);
  const [siblingPrompt, setSiblingPrompt] = useState<Bean[] | null>(null);
  /** Wird `id` aktiv, während eine andere Röstung der Sorte aktiv ist → nachfragen. */
  const askAboutSiblings = (coffee: CoffeeView, id: number) => {
    const siblings = activeSiblings(coffee.roastings, id);
    if (siblings.length > 0) setSiblingPrompt(siblings);
  };

  const selected = useMemo(() => coffees.find((c) => c.id === selectedId) ?? null, [coffees, selectedId]);

  // F-B1: one list, active coffees grouped on top; favourites first within each
  // group; then the chosen sort key.
  const sorted = useMemo(() => {
    const cmp = (a: CoffeeView, b: CoffeeView): number => {
      switch (sortKey) {
        case "name": return a.name.localeCompare(b.name);
        case "rating": return (RATING_ORDER[b.rating ?? ""] ?? 0) - (RATING_ORDER[a.rating ?? ""] ?? 0) || a.name.localeCompare(b.name);
        case "age": {
          const av = a.effectiveAgeDays ?? Infinity, bv = b.effectiveAgeDays ?? Infinity;
          return av - bv || a.name.localeCompare(b.name);
        }
        case "recent":
        // "Zuletzt verwendet" = letzter Bezug, nicht letzte Bearbeitung.
        default: return (b.lastShotAt ?? 0) - (a.lastShotAt ?? 0) || a.name.localeCompare(b.name);
      }
    };
    const needle = q.trim().toLowerCase();
    const hit = (c: CoffeeView) =>
      needle === "" ||
      [c.name, c.roaster, c.country, c.region, c.variety]
        .some((v) => v != null && v.toLowerCase().includes(needle));
    const pass = (c: CoffeeView) => {
      switch (filterKey) {
        case "active": return c.activeRoasting !== null;
        case "favourite": return c.favourite;
        // Verfügbar = es liegt ein nicht archivierter Beutel da, der nicht
        // nachweislich leer ist. stockG bleibt null, solange nirgends eine Menge
        // gepflegt ist — das heißt "unbekannt", nicht "leer", sonst fielen genau
        // die Bohnen ohne Tütengröße raus, die man gerade benutzt.
        case "available": {
          const hasBag = c.roastings.some((b) => b.status !== "archived");
          return hasBag && (c.stockG === null || c.stockG > 0);
        }
        // Archiviert = das Gegenstueck: es gibt Roestungen, aber keine einzige
        // liegt noch da. Bewusst nicht "hat irgendeine archivierte Roestung" —
        // sonst stuende jede Sorte drin, von der schon mal eine Tuete leer war.
        case "archived":
          return c.roastings.length > 0 && c.roastings.every((b) => b.status === "archived");
        default: return true;
      }
    };
    const rank = (c: CoffeeView) => (c.activeRoasting !== null ? 0 : 1) * 2 + (c.favourite ? 0 : 1);
    return coffees.filter((c) => pass(c) && hit(c)).sort((a, b) => rank(a) - rank(b) || cmp(a, b));
  }, [coffees, sortKey, filterKey, q]);

  // Sortenfoto: im Browser verkleinern, als Base64 hochladen, Liste neu holen.
  // Ein fehlgeschlagener Upload muss es sagen — ein Bild, das einfach nicht
  // erscheint, sieht aus wie ein Fehler der App und nicht wie einer des Fotos.
  const [imageBusy, setImageBusy] = useState(false);

  const handleImagePick = useCallback(async (coffeeId: number, file: File) => {
    setImageBusy(true);
    try {
      const { base64 } = await resizeForUpload(file);
      const r = await fetch(`/api/coffees/${coffeeId}/image`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: base64 }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      await api.refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setImageBusy(false);
    }
  }, [api]);

  const handleImageRemove = useCallback(async (coffeeId: number) => {
    setImageBusy(true);
    try {
      const r = await fetch(`/api/coffees/${coffeeId}/image`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      await api.refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setImageBusy(false);
    }
  }, [api]);

  async function handleDeleteCoffee(c: CoffeeView) {
    // Roestungen duerfen mitgehen, solange an keiner ein Bezug haengt — dann
    // geht nichts von der Historie verloren. Haengt einer daran, bleibt es
    // gesperrt: der Bezug wuesste sonst nicht mehr, womit er gebrueht wurde.
    const shots = c.shotCount ?? 0;
    if (shots > 0) {
      window.alert(shots === 1 ? t("coffee.deleteBlockedOne") : t("coffee.deleteBlockedMany", { n: String(shots) }));
      return;
    }
    const n = c.roastingCount ?? 0;
    const question = n > 0
      ? t(n === 1 ? "coffee.deleteWithRoastingOne" : "coffee.deleteWithRoastingsMany", { n: String(n) })
      : t("coffee.deleteConfirm");
    if (!window.confirm(question)) return;
    try { await api.deleteCoffee(c.id); onSelectId(null); } catch (e) { window.alert(e instanceof Error ? e.message : String(e)); }
  }

  if (loading) return <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: 40 }}>Lade…</div>;
  if (error) return <div style={{ color: C.red, fontSize: 13, textAlign: "center", padding: 40 }}>{error}</div>;

  const detail = selected && (
    <div>
      <button onClick={() => onSelectId(null)}
        style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: C.mut, cursor: "pointer", fontSize: 13, fontFamily: "inherit", marginBottom: 12, padding: 0 }}>
        <ChevronLeft size={16} />{t("coffee.back")}
      </button>
      {(() => {
        const head = (
          <DetailHead
            c={selected}
            onPickImage={(f) => { void handleImagePick(selected.id, f); }}
            onRemoveImage={() => { void handleImageRemove(selected.id); }}
            imageBusy={imageBusy}
            onNachkaufen={() => setRoastingEditor({ coffee: selected })}
            onEdit={() => setCoffeeEditor(selected)}
            onMerge={() => setPicker({ kind: "merge", coffee: selected })}
            onDelete={() => void handleDeleteCoffee(selected)}
            onToggleFav={() => void api.toggleFavourite(selected)}
            onRate={(v) => void api.setCoffeeRating(selected.id, v)}
            onOpenShot={(shotId) => onOpenShot(shotId, selected.id)}
          />
        );
        const list = <RoastingList c={selected} onOpenHistory={(bid) => onOpenHistory(bid, selected.id)} onKebab={setSheet} onAddRoasting={() => setRoastingEditor({ coffee: selected })} />;
        return mobile
          ? <>{head}<div style={{ height: 18 }} />{list}</>
          // 436 px + 22 gap sind die Werte aus dem Mockup. Mit 392 px brach ein
          // zweiteiliger Sortenname im Kopf um ("Nightingale / Espresso") —
          // bei "Deepwood" fiel das nicht auf.
          : <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
              <div style={{ flex: "0 0 436px" }}>{head}</div>
              <div style={{ flex: 1, minWidth: 0 }}>{list}</div>
            </div>;
      })()}
    </div>
  );

  const library = (
    <div>
      <div style={{ display: "flex", alignItems: "center", margin: "2px 2px 11px" }}>
        <div style={{ ...secLabel, margin: 0 }}>{t("coffee.library")}<span style={secCount}>{sorted.length} {t("coffee.sorten")}</span></div>
        <div style={{ marginLeft: "auto" }}><SortControl sortKey={sortKey} setSortKey={setSortKey} /></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 11px" }}>
        <SearchField q={q} setQ={setQ} />
        <FilterControl filterKey={filterKey} setFilterKey={setFilterKey} />
      </div>
      {coffees.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: C.mut, fontSize: 13 }}>
          <div>{t("coffee.empty")}</div><div style={{ fontSize: 12, color: C.mut, marginTop: 6 }}>{t("coffee.emptyHint")}</div>
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: C.mut, fontSize: 13 }}>
          <div>{t("coffee.noMatch")}</div><div style={{ fontSize: 12, color: C.mut, marginTop: 6 }}>{t("coffee.noMatchHint")}</div>
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 14, overflow: "hidden" }}>
          {sorted.map((c, i) => (
            <div key={c.id} style={i === 0 ? { borderTop: "none" } : undefined}>
              <LibraryRow c={c} onOpen={onSelectId} onToggleFav={(cf) => void api.toggleFavourite(cf)} />
            </div>
          ))}
        </div>
      )}
      <div style={{ height: 12 }} />
      <button onClick={() => setCoffeeEditor("new")}
        style={{ width: "100%", height: 48, borderRadius: 12, border: `1px dashed ${C.bdr2}`, background: "transparent", color: C.txtS, fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 9, cursor: "pointer", fontFamily: "inherit" }}>
        <Plus size={17} />{t("coffee.newSorte")}
      </button>
    </div>
  );

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      {selected ? detail : library}

      {coffeeEditor !== null && (
        <CoffeeEditor
          coffee={coffeeEditor === "new" ? undefined : coffeeEditor}
          match={coffeeEditor === "new" ? api.match : undefined}
          onJumpToCoffee={(id) => { setCoffeeEditor(null); onSelectId(id); }}
          onSave={async (data) => {
            if (coffeeEditor === "new") await api.createCoffee(data as Parameters<typeof api.createCoffee>[0]);
            else await api.updateCoffee(coffeeEditor.id, data);
          }}
          onClose={() => setCoffeeEditor(null)}
        />
      )}

      {roastingEditor !== null && (
        <RoastingEditor
          roasting={roastingEditor.roasting}
          coffeeName={roastingEditor.coffee.name}
          prefill={roastingEditor.roasting ? undefined : {
            bagSizeG: roastingEditor.coffee.roastings[0]?.bagSizeG ?? null,
            pricePerBagEur: roastingEditor.coffee.roastings[0]?.pricePerBagEur ?? null,
          }}
          onSave={async (data) => {
            if (roastingEditor.roasting) {
              const r = roastingEditor.roasting;
              await api.updateRoasting(r.id, data);
              if (data.isActive && !r.isActive && data.status !== "archived") {
                askAboutSiblings(roastingEditor.coffee, r.id);
              }
            }
            else await api.createRoasting(roastingEditor.coffee.id, {
              roastDate: data.roastDate ?? null, bagSizeG: data.bagSizeG ?? null, pricePerBagEur: data.pricePerBagEur ?? null,
            });
          }}
          onClose={() => setRoastingEditor(null)}
        />
      )}

      {sheet !== null && selected && (
        <RoastingActionSheet
          roasting={sheet}
          onClose={() => setSheet(null)}
          onToggleActive={() => {
            void api.setRoastingActive(sheet.id, !sheet.isActive);
            if (!sheet.isActive) askAboutSiblings(selected, sheet.id);
            setSheet(null);
          }}
          onFreeze={() => { void api.setRoastingStatus(sheet.id, "frozen"); setSheet(null); }}
          onThaw={() => { void api.setRoastingStatus(sheet.id, "thawed"); setSheet(null); }}
          onMove={() => { setPicker({ kind: "move", roasting: sheet, coffee: selected }); setSheet(null); }}
          onRateOverride={() => { setRatingOverride(sheet); setSheet(null); }}
          onEdit={() => { setRoastingEditor({ coffee: selected, roasting: sheet }); setSheet(null); }}
          onArchive={() => { void api.setRoastingStatus(sheet.id, "archived"); setSheet(null); }}
        />
      )}

      {picker !== null && (
        <CoffeePicker
          title={picker.kind === "merge" ? t("coffee.mergeTitle") : t("coffee.moveTitle")}
          hint={picker.kind === "merge" ? t("coffee.mergeHint") : t("coffee.moveHint")}
          confirmLabel={picker.kind === "merge" ? t("coffee.merge") : t("coffee.move")}
          queryName={picker.coffee.name}
          queryRoaster={picker.coffee.roaster}
          coffees={coffees.filter((c) => c.id !== picker.coffee.id)}
          match={api.match}
          onPick={async (targetId) => {
            if (picker.kind === "merge") { await api.mergeCoffee(picker.coffee.id, targetId); onSelectId(null); }
            else await api.moveRoasting(picker.roasting.id, targetId);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {siblingPrompt !== null && (
        <ActiveSiblingsModal
          siblings={siblingPrompt}
          onArchive={() => { for (const b of siblingPrompt) void api.setRoastingStatus(b.id, "archived"); setSiblingPrompt(null); }}
          onDeactivate={() => { for (const b of siblingPrompt) void api.setRoastingActive(b.id, false); setSiblingPrompt(null); }}
          onKeep={() => setSiblingPrompt(null)}
        />
      )}

      {ratingOverride !== null && (
        <RatingOverrideModal
          current={ratingOverride.rating}
          onPick={async (v) => { await api.setRatingOverride(ratingOverride.id, v); setRatingOverride(null); }}
          onClose={() => setRatingOverride(null)}
        />
      )}
    </div>
  );
}
