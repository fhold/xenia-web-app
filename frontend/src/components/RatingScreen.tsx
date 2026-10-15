/**
 * RatingScreen — the shot rating control, shared by the Post-Shot-Review modal
 * and the History "Bewerten" flow. Laid out as a dense 3-column grid of tiles
 * (ÄW-A) that collapses to a single column on narrow (phone) widths:
 *
 *   Row 1: Gesamtnote        | Säure            | Bitterkeit
 *   Row 2: Extraktion        | Geschmacks-Tags (span 2)
 *   Row 3: Mahlgrad          | Notiz           (span 2)
 *
 * Extraction is three INDEPENDENT toggles (under / over / channeling) — there is
 * no derived "uneven" state anymore; channeling is its own marker (red).
 *
 * All elements are optional. Self-contained (seeds from `initial`); reports the
 * current values via `onChange` on every edit. Parent owns Save/Skip.
 */

import { useState } from "react";
import { Check, ArrowDown, ArrowUp, Split } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { TASTE_TAGS } from "@shared/types";
import type { GrindNote, TasteTag, ShotUpdate, ChannelingSeverity } from "@shared/types";
import { nextChanneling } from "@shared/shot-rating.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

const ACIDITY_COLOR = C.rateAcidity; // gelblich
const BITTER_COLOR = C.rateBitter;  // bräunlich

export interface ShotRatingValues {
  rating: number | null;
  acidity: number | null;
  bitterness: number | null;
  extractionUnder: boolean;
  extractionOver: boolean;
  /** Channeling / uneven flow — independent extraction-defect marker. */
  channeling: boolean;
  /** Staerke; null bei gesetztem channeling = unbekannt (Altbestand). */
  channelingSeverity: ChannelingSeverity | null;
  tasteTags: TasteTag[];
  grindNote: GrindNote | null;
  /** Free-text note, bound to shot.notes. */
  notes: string;
}

/** Map the rating control's values to a PUT /api/shots/:id patch. */
export function ratingValuesToPatch(v: ShotRatingValues): ShotUpdate {
  return {
    rating: v.rating,
    acidity: v.acidity,
    bitterness: v.bitterness,
    extractionUnder: v.extractionUnder,
    extractionOver: v.extractionOver,
    channeling: v.channeling,
    channelingSeverity: v.channeling ? v.channelingSeverity : null,
    tasteTags: v.tasteTags.length > 0 ? v.tasteTags : null,
    grindNote: v.grindNote,
    notes: v.notes.trim() || null,
  };
}

interface RatingScreenProps {
  initial: ShotRatingValues;
  onChange: (v: ShotRatingValues) => void;
  /** Single-column layout for narrow (phone) widths. */
  mobile?: boolean;
}

const labelRow: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "1.7px",
  textTransform: "uppercase",
  color: C.mut,
};

/** A labelled 5-node intensity axis (none → intense). */
function IntensityAxis({
  value,
  color,
  leftLabel,
  rightLabel,
  onPick,
}: {
  value: number | null;
  color: string;
  leftLabel: string;
  rightLabel: string;
  onPick: (n: number) => void;
}) {
  return (
    <div>
      {/* Fixed-height rail so the active (34px) node grows symmetrically and
          every node's centre stays on the track line (align-items: center). */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", minHeight: 38 }}>
        {/* Track line — vertically centred */}
        <div
          style={{
            position: "absolute",
            left: 14,
            right: 14,
            top: "50%",
            transform: "translateY(-50%)",
            height: 2,
            background: C.bdr2,
            borderRadius: 1,
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", position: "relative" }}>
          {[1, 2, 3, 4, 5].map((n) => {
            const active = value === n;
            return (
              <button
                key={n}
                onClick={() => { onPick(n); }}
                aria-label={String(n)}
                style={{
                  width: active ? 34 : 26,
                  height: active ? 34 : 26,
                  borderRadius: "50%",
                  border: active ? `2px solid ${color}` : `2px solid ${C.bdr2}`,
                  background: active ? color : C.bg,
                  boxShadow: active ? `0 0 0 4px ${color}22` : "none",
                  cursor: "pointer",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "width 0.12s, height 0.12s, background 0.12s, border-color 0.12s",
                }}
              >
                {!active && (
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.node }} />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
        <span style={{ fontSize: 10, color: C.mut }}>{leftLabel}</span>
        <span style={{ fontSize: 10, color: C.mut }}>{rightLabel}</span>
      </div>
    </div>
  );
}

export function RatingScreen({ initial, onChange, mobile = false }: RatingScreenProps) {
  const { t } = useTranslation();
  const [v, setV] = useState<ShotRatingValues>(initial);

  const patch = (next: Partial<ShotRatingValues>) => {
    const merged = { ...v, ...next };
    setV(merged);
    onChange(merged);
  };

  const noteWord = v.rating !== null ? t(`shotRating.noteWords.${v.rating}`) : "";

  /** Tile wrapper — a card on `sunken`; the controls inside sit on `bg`. */
  const tile = (span2 = false): React.CSSProperties => ({
    gridColumn: span2 && !mobile ? "span 2" : "auto",
    background: C.sunken,
    border: `1px solid ${C.bdr}`,
    borderRadius: 12,
    padding: 11,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minWidth: 0,
  });

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: mobile ? "1fr" : "repeat(3, 1fr)",
        gap: 10,
        alignItems: "start",
      }}
    >
      {/* 1 — Gesamtnote */}
      <div style={tile()}>
        <div style={labelRow}>{t("shotRating.overall")}</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = v.rating !== null && n <= v.rating;
            const selected = v.rating === n;
            return (
              <button
                key={n}
                onClick={() => { patch({ rating: v.rating === n ? null : n }); }}
                aria-label={String(n)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  border: filled ? `1px solid ${C.accB}` : `2px solid ${C.bdr2}`,
                  background: filled ? `linear-gradient(180deg,${C.rateDotTop},${C.rateDotBottom})` : C.bg,
                  boxShadow: selected ? `0 0 0 4px ${alpha(C.acc, 0.14)}` : "none",
                  cursor: "pointer",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.12s, border-color 0.12s, box-shadow 0.12s",
                }}
              >
                {!filled && (
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.node }} />
                )}
              </button>
            );
          })}
        </div>
        <div style={{ ...MONO, fontSize: 19, fontWeight: 700, color: v.rating !== null ? C.txt : C.dim, lineHeight: 1, whiteSpace: "nowrap" }}>
          {v.rating !== null ? v.rating : "–"}
          <span style={{ fontSize: 13, color: C.mut, fontWeight: 400 }}> / 5</span>
          {noteWord && <span style={{ fontSize: 12, color: C.acc, fontWeight: 600 }}>{"  ·  " + noteWord}</span>}
        </div>
      </div>

      {/* 2 — Säure */}
      <div style={tile()}>
        <div style={labelRow}>{t("shotRating.acidity")}</div>
        <IntensityAxis
          value={v.acidity}
          color={ACIDITY_COLOR}
          leftLabel={t("shotRating.axisNone")}
          rightLabel={t("shotRating.axisIntense")}
          onPick={(n) => { patch({ acidity: v.acidity === n ? null : n }); }}
        />
      </div>

      {/* 3 — Bitterkeit */}
      <div style={tile()}>
        <div style={labelRow}>{t("shotRating.bitterness")}</div>
        <IntensityAxis
          value={v.bitterness}
          color={BITTER_COLOR}
          leftLabel={t("shotRating.axisNone")}
          rightLabel={t("shotRating.axisIntense")}
          onPick={(n) => { patch({ bitterness: v.bitterness === n ? null : n }); }}
        />
      </div>

      {/* 4 — Extraktion: drei unabhängige Toggles (under / over / channeling) */}
      <div style={tile()}>
        <div style={labelRow}>{t("shotRating.extraction")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {([
            ["under",      v.extractionUnder, t("shotRating.under"),      <ArrowDown key="i" size={15} />, false],
            ["over",       v.extractionOver,  t("shotRating.over"),       <ArrowUp key="i" size={15} />,   false],
            ["channeling", v.channeling,
              v.channeling && v.channelingSeverity
                ? `${t("shotRating.channeling")} · ${t(v.channelingSeverity === "strong" ? "shotRating.channelingStrong" : "shotRating.channelingLight")}`
                : t("shotRating.channeling"),
              <Split key="i" size={15} />, true],
          ] as ["under" | "over" | "channeling", boolean, string, React.ReactNode, boolean][]).map(
            ([key, active, label, icon, isDefect]) => {
              // Channeling is a defect marker → red when active; under/over stay amber.
              const activeColor = isDefect ? C.red : C.org;
              const activeBg = isDefect ? C.redD : C.orgD;
              return (
                <button
                  key={key}
                  onClick={() => {
                    patch(
                      key === "under" ? { extractionUnder: !active }
                        : key === "over" ? { extractionOver: !active }
                        // Durchschalten aus → leicht → stark → aus (shared/shot-rating.ts).
                        : nextChanneling(v.channeling, v.channelingSeverity),
                    );
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0, // allow equal thirds to shrink; labels wrap instead of clipping
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 5,
                    padding: "7px 2px",
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    color: active ? activeColor : C.txtS,
                    background: active ? activeBg : C.bg,
                    border: `1.5px solid ${active ? `${activeColor}80` : C.bdr2}`,
                    transition: "background 0.12s, border-color 0.12s, color 0.12s",
                  }}
                >
                  {icon}
                  <span style={{ textAlign: "center", lineHeight: 1.15, overflowWrap: "anywhere" }}>{label}</span>
                </button>
              );
            },
          )}
        </div>
      </div>

      {/* 5 — Geschmacks-Tags (span 2) */}
      <div style={tile(true)}>
        <div style={{ ...labelRow, display: "flex", justifyContent: "space-between" }}>
          <span>{t("shotRating.taste")}</span>
          <span style={{ letterSpacing: 0, textTransform: "none", color: C.mut }}>
            {t("shotRating.multiHint")}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {TASTE_TAGS.map((tag) => {
            const active = v.tasteTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => {
                  patch({
                    tasteTags: active ? v.tasteTags.filter((x) => x !== tag) : [...v.tasteTags, tag],
                  });
                }}
                style={{
                  height: 34,
                  padding: active ? "0 14px 0 11px" : "0 14px",
                  borderRadius: 17,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: active ? C.acc : C.txtS,
                  background: active ? C.accG : C.bg,
                  border: `1.5px solid ${active ? C.accB : C.bdr2}`,
                  transition: "background 0.12s, border-color 0.12s, color 0.12s",
                }}
              >
                {active && <Check size={14} />}
                {t(`shotRating.tags.${tag}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* 6 — Mahlgrad: Segmented Control, text-only */}
      <div style={tile()}>
        <div style={labelRow}>{t("shotRating.grind")}</div>
        <div
          style={{
            display: "flex",
            height: 40,
            borderRadius: 12,
            border: `1.5px solid ${C.bdr2}`,
            background: C.bg,
            overflow: "hidden",
          }}
        >
          {([
            ["finer", t("shotRating.grindFiner")],
            ["ok", t("shotRating.grindOk")],
            ["coarser", t("shotRating.grindCoarser")],
          ] as [GrindNote, string][]).map(([g, label], i) => {
            const active = v.grindNote === g;
            const isOk = g === "ok";
            const col = isOk ? C.rateOk : C.acc;
            const bg = active ? (isOk ? alpha(C.grn, 0.13) : C.accG) : "transparent";
            return (
              <button
                key={g}
                onClick={() => { patch({ grindNote: v.grindNote === g ? null : g }); }}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  color: active ? col : C.mut,
                  background: bg,
                  border: "none",
                  borderLeft: i > 0 ? `1px solid ${C.bdr2}` : "none",
                  transition: "background 0.12s, color 0.12s",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 7 — Notiz (shot.notes) (span 2) */}
      <div style={tile(true)}>
        <div style={labelRow}>{t("shotRating.notes")}</div>
        <textarea
          value={v.notes}
          onChange={(e) => { patch({ notes: e.target.value }); }}
          placeholder={t("shotRating.notesPlaceholder")}
          style={{
            width: "100%", minHeight: 48, resize: "vertical", padding: "10px 12px",
            borderRadius: 10, background: C.bg, border: `1.5px solid ${C.bdr2}`,
            color: C.txt, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none",
          }}
        />
      </div>
    </div>
  );
}
