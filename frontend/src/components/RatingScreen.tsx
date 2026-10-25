/**
 * RatingScreen — the shot rating control, shared by the Post-Shot-Review modal
 * and the History "Bewerten" flow. Kompakte Zeilen (Flavio 22.10.: „der Screen
 * ist ziemlich voll, das Notizfeld nur noch mini“), auf dem Handy untereinander:
 *
 *   Zeile 1: Gesamtnote       | Säure            | Bitterkeit
 *   Zeile 2: Extraktion       | Mahlgrad         | Gegenüber letztem Bezug (Einstellung)
 *   Zeile 3: Geschmack (ganze Breite, eine Zeile auf dem Tablet)
 *   Zeile 4: Notiz (ganze Breite, 3 Zeilen; 5 ohne Geschmack)
 *
 * Extraktion: Channeling als eine Wahl keins / leicht / stark (ein Tipp je
 * Stufe, #264); „zu gering“ / „zu hoch“ als kleine Schalter im Kopf der Kachel
 * — selten genutzt (2 von 53 Bezügen seit September), aber nicht weg.
 *
 * Welche Felder erscheinen, steht in den Einstellungen (useRatingFieldSettings);
 * Gesamtnote, Channeling und Notiz sind immer da. Ausgeblendetes wird nicht
 * gelöscht — gespeicherte Werte bleiben und reisen unverändert mit.
 *
 * All elements are optional. Self-contained (seeds from `initial`); reports the
 * current values via `onChange` on every edit. Parent owns Save/Skip.
 */

import { useState } from "react";
import { Check, ArrowDown, ArrowUp, Split } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { TASTE_TAGS } from "@shared/types";
import type { GrindNote, TasteTag, ShotUpdate, ChannelingSeverity, ShotCompare, VsPrev } from "@shared/types";
import { formatDay } from "../lib/dates.js";
import { RATING_FIELD_DEFAULTS } from "../hooks/useRatingFieldSettings.js";
import type { RatingFieldSettings } from "../hooks/useRatingFieldSettings.js";
import theme, { alpha } from "../theme.js";
import { dec } from "../lib/num.js";

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
  /** Geschmack gegenueber dem letzten Bezug derselben Sorte, und welcher das war. */
  vsPrev: VsPrev | null;
  vsPrevShotId: number | null;
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
    vsPrev: v.vsPrev,
    vsPrevShotId: v.vsPrev ? v.vsPrevShotId : null,
  };
}

interface RatingScreenProps {
  initial: ShotRatingValues;
  onChange: (v: ShotRatingValues) => void;
  /** Single-column layout for narrow (phone) widths. */
  mobile?: boolean;
  /** Letzter Bezug derselben Sorte — nur gesetzt, wenn die Einstellung an ist. */
  compareTo?: ShotCompare["previous"];
  /** Welche Felder erscheinen (Einstellungen); fehlt es, alle. */
  fields?: RatingFieldSettings;
}

const labelRow: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: "1.2px",
  textTransform: "uppercase",
  color: C.mut,
};

/** A 5-node intensity axis (none → intense); the scale words sit in the tile head. */
function IntensityAxis({
  value,
  color,
  onPick,
}: {
  value: number | null;
  color: string;
  onPick: (n: number) => void;
}) {
  return (
    // Fixed-height rail so the active node grows symmetrically and every
    // node's centre stays on the track line (align-items: center).
    <div style={{ position: "relative", display: "flex", alignItems: "center", minHeight: 30 }}>
      <div
        style={{
          position: "absolute",
          left: 12,
          right: 12,
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
                width: active ? 28 : 22,
                height: active ? 28 : 22,
                borderRadius: "50%",
                border: active ? `2px solid ${color}` : `2px solid ${C.bdr2}`,
                background: active ? color : C.bg,
                boxShadow: active ? `0 0 0 3px ${color}22` : "none",
                cursor: "pointer",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "width 0.12s, height 0.12s, background 0.12s, border-color 0.12s",
              }}
            >
              {!active && <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.node }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SegItem {
  key: string;
  label: React.ReactNode;
  active: boolean;
  /** Text- und Hintergrundfarbe, wenn gewaehlt. */
  color: string;
  bg: string;
  onClick: () => void;
}

/** Eine Auswahl aus wenigen Stufen in einer Leiste — Channeling, Mahlgrad, Vergleich. */
function Segmented({ items, height = 32 }: { items: SegItem[]; height?: number }) {
  return (
    <div
      style={{
        flex: "1 1 auto",
        minWidth: 0,
        display: "flex",
        height,
        minHeight: height,
        maxHeight: height,
        borderRadius: 10,
        border: `1.5px solid ${C.bdr2}`,
        background: C.bg,
        overflow: "hidden",
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.key}
          onClick={it.onClick}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 4px",
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: it.active ? it.color : C.mut,
            background: it.active ? it.bg : "transparent",
            border: "none",
            borderLeft: i > 0 ? `1px solid ${C.bdr2}` : "none",
            transition: "background 0.12s, color 0.12s",
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function RatingScreen({ initial, onChange, mobile = false, compareTo = null, fields = RATING_FIELD_DEFAULTS }: RatingScreenProps) {
  const { t } = useTranslation();
  const [v, setV] = useState<ShotRatingValues>(initial);

  const patch = (next: Partial<ShotRatingValues>) => {
    const merged = { ...v, ...next };
    setV(merged);
    onChange(merged);
  };

  const noteWord = v.rating !== null ? t(`shotRating.noteWords.${v.rating}`) : "";

  /** Tile wrapper — a card on `sunken`; the controls inside sit on `bg`. */
  const tile: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    background: C.sunken,
    border: `1px solid ${C.bdr}`,
    borderRadius: 12,
    padding: "9px 11px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: 7,
  };
  const row: React.CSSProperties = { display: "flex", flexDirection: mobile ? "column" : "row", gap: 8 };
  /** Kopf einer Kachel: Bezeichnung links, rechts ein Zusatz (Wert, Skala, Schalter). */
  const head = (label: React.ReactNode, aside?: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 20 }}>
      <span style={{ ...labelRow, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>{label}</span>
      {aside}
    </div>
  );
  const scaleWords = mobile ? null : (
    <span style={{ fontSize: 10, color: C.mut, whiteSpace: "nowrap" }}>
      {t("shotRating.axisNone")} → {t("shotRating.axisIntense")}
    </span>
  );
  const scaleTitle = `${t("shotRating.axisNone")} → ${t("shotRating.axisIntense")}`;
  const okBg = alpha(C.grn, 0.13);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Zeile 1 — Gesamtnote, Säure, Bitterkeit (Handy: Säure und Bitterkeit nebeneinander) */}
      <div style={row}>
        <div style={tile}>
          {head(
            t("shotRating.overall"),
            <span style={{ ...MONO, fontSize: 12.5, fontWeight: 700, color: v.rating !== null ? C.txt : C.dim, whiteSpace: "nowrap" }}>
              {v.rating !== null ? v.rating : "–"}
              <span style={{ color: C.mut, fontWeight: 400 }}> / 5</span>
              {noteWord && <span style={{ color: C.acc, fontWeight: 600 }}>{" · " + noteWord}</span>}
            </span>,
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 30 }}>
            {[1, 2, 3, 4, 5].map((n) => {
              const filled = v.rating !== null && n <= v.rating;
              const selected = v.rating === n;
              return (
                <button
                  key={n}
                  onClick={() => { patch({ rating: v.rating === n ? null : n }); }}
                  aria-label={String(n)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    border: filled ? `1px solid ${C.accB}` : `2px solid ${C.bdr2}`,
                    background: filled ? `linear-gradient(180deg,${C.rateDotTop},${C.rateDotBottom})` : C.bg,
                    boxShadow: selected ? `0 0 0 3px ${alpha(C.acc, 0.14)}` : "none",
                    cursor: "pointer",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 0.12s, border-color 0.12s, box-shadow 0.12s",
                  }}
                >
                  {!filled && <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.node }} />}
                </button>
              );
            })}
          </div>
        </div>

        {(fields.acidity || fields.bitterness) && (
          <div style={{ display: "flex", gap: 8, flex: mobile ? "none" : 2, minWidth: 0 }}>
            {fields.acidity && (
              <div style={tile} title={scaleTitle}>
                {head(t("shotRating.acidity"), scaleWords)}
                <IntensityAxis value={v.acidity} color={ACIDITY_COLOR} onPick={(n) => { patch({ acidity: v.acidity === n ? null : n }); }} />
              </div>
            )}
            {fields.bitterness && (
              <div style={tile} title={scaleTitle}>
                {head(t("shotRating.bitterness"), scaleWords)}
                <IntensityAxis value={v.bitterness} color={BITTER_COLOR} onPick={(n) => { patch({ bitterness: v.bitterness === n ? null : n }); }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Zeile 2 — Extraktion (Channeling + zu gering/zu hoch), Mahlgrad, Vergleich */}
      <div style={row}>
        <div style={tile}>
          {head(
            t("shotRating.extraction"),
            fields.extraction && (
              <span style={{ display: "inline-flex", gap: 5 }}>
                {([
                  ["under", v.extractionUnder, t("shotRating.under"), <ArrowDown key="i" size={12} />],
                  ["over",  v.extractionOver,  t("shotRating.over"),  <ArrowUp key="i" size={12} />],
                ] as ["under" | "over", boolean, string, React.ReactNode][]).map(([key, active, label, icon]) => (
                  <button
                    key={key}
                    onClick={() => { patch(key === "under" ? { extractionUnder: !active } : { extractionOver: !active }); }}
                    aria-pressed={active}
                    style={{
                      height: 22,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      padding: "0 7px",
                      borderRadius: 11,
                      fontSize: 10.5,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      color: active ? C.org : C.txtS,
                      background: active ? C.orgD : C.bg,
                      border: `1.5px solid ${active ? `${C.org}80` : C.bdr2}`,
                    }}
                  >
                    {icon}
                    {label}
                  </button>
                ))}
              </span>
            ),
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Rot, wenn markiert — auch beim Altbestand ohne Staerke, wo keine
                der drei Wahlen leuchtet. */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: v.channeling ? C.red : C.txtS, flexShrink: 0 }}>
              <Split size={14} />
              {t("shotRating.channeling")}
            </span>
            <Segmented
              items={([
                ["none",   t("shotRating.channelingNone"),   C.rateOk, okBg],
                ["light",  t("shotRating.channelingLight"),  C.org,    C.orgD],
                ["strong", t("shotRating.channelingStrong"), C.red,    C.redD],
              ] as ["none" | ChannelingSeverity, string, string, string][]).map(([choice, label, col, bg]) => ({
                key: choice,
                label,
                color: col,
                bg,
                active: choice === "none" ? !v.channeling : v.channeling && v.channelingSeverity === choice,
                onClick: () => {
                  patch(choice === "none"
                    ? { channeling: false, channelingSeverity: null }
                    : { channeling: true, channelingSeverity: choice });
                },
              }))}
            />
          </div>
        </div>

        {fields.grindNote && (
          <div style={tile}>
            {head(t("shotRating.grind"))}
            <Segmented
              items={([
                ["finer", t("shotRating.grindFiner")],
                ["ok", t("shotRating.grindOk")],
                ["coarser", t("shotRating.grindCoarser")],
              ] as [GrindNote, string][]).map(([g, label]) => ({
                key: g,
                label,
                color: g === "ok" ? C.rateOk : C.acc,
                bg: g === "ok" ? okBg : C.accG,
                active: v.grindNote === g,
                onClick: () => { patch({ grindNote: v.grindNote === g ? null : g }); },
              }))}
            />
          </div>
        )}

        {/* Gegenueber dem letzten Bezug derselben Sorte (Einstellung). */}
        {compareTo && (
          <div
            style={tile}
            title={t("shotRating.vsPrev.title", {
              date: formatDay(compareTo.startedAt, { time: true }),
              profile: compareTo.profileName ?? "–",
              grind: compareTo.grindSetting !== null ? dec(String(compareTo.grindSetting)) : "–",
            })}
          >
            {head(t("shotRating.vsPrev.label", { date: formatDay(compareTo.startedAt, { style: "numeric" }) }))}
            <Segmented
              items={([
                ["worse", t("shotRating.vsPrev.worse"), C.org, C.orgD],
                ["same", t("shotRating.vsPrev.same"), C.acc, C.accG],
                ["better", t("shotRating.vsPrev.better"), C.rateOk, okBg],
              ] as [VsPrev, string, string, string][]).map(([choice, label, col, bg]) => ({
                key: choice,
                label,
                color: col,
                bg,
                active: v.vsPrev === choice,
                onClick: () => {
                  patch(v.vsPrev === choice ? { vsPrev: null, vsPrevShotId: null } : { vsPrev: choice, vsPrevShotId: compareTo.id });
                },
              }))}
            />
          </div>
        )}
      </div>

      {/* Zeile 3 — Geschmack, ganze Breite */}
      {fields.taste && (
        <div style={{ ...tile, flexDirection: mobile ? "column" : "row", justifyContent: "flex-start", alignItems: mobile ? "stretch" : "center", gap: mobile ? 7 : 12 }}>
          <span style={{ ...labelRow, flexShrink: 0 }} title={t("shotRating.multiHint")}>{t("shotRating.taste")}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {TASTE_TAGS.map((tag) => {
              const active = v.tasteTags.includes(tag);
              return (
                <button
                  key={tag}
                  onClick={() => {
                    patch({ tasteTags: active ? v.tasteTags.filter((x) => x !== tag) : [...v.tasteTags, tag] });
                  }}
                  style={{
                    height: 30,
                    padding: active ? "0 11px 0 9px" : "0 11px",
                    borderRadius: 15,
                    fontSize: 12.5,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    color: active ? C.acc : C.txtS,
                    background: active ? C.accG : C.bg,
                    border: `1.5px solid ${active ? C.accB : C.bdr2}`,
                    transition: "background 0.12s, border-color 0.12s, color 0.12s",
                  }}
                >
                  {active && <Check size={13} />}
                  {t(`shotRating.tags.${tag}`)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Zeile 4 — Notiz (shot.notes), ganze Breite; ohne Geschmack mehr Platz */}
      <div style={tile}>
        {head(t("shotRating.notes"))}
        <textarea
          value={v.notes}
          onChange={(e) => { patch({ notes: e.target.value }); }}
          placeholder={t("shotRating.notesPlaceholder")}
          rows={fields.taste ? 3 : 5}
          style={{
            width: "100%", resize: "vertical", padding: "8px 11px", lineHeight: 1.45,
            borderRadius: 10, background: C.bg, border: `1.5px solid ${C.bdr2}`,
            color: C.txt, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none",
          }}
        />
      </div>
    </div>
  );
}
