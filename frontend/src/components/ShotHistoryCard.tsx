/**
 * ShotHistoryCard — one row in the History view, in the column layout of the
 * bean view: Bezug (profile, size, warnings, #id · date · bean) · Mahlgrad
 * (setting · grind note, grinder · RPM) · Bewertung · Channeling · Ausbeute
 * (dose → yield (target), duration · temp · stop) · actions.
 *
 * Reference ★ and repeat stay one tap away; edit and delete live in the row
 * menu, like in the profile list. On a phone the columns wrap below the Bezug.
 */

import { useState } from "react";
import { hasRating, ratedWithoutStars } from "@shared/shot-rating.js";
import { Pencil, Trash2, StickyNote, Repeat, AlertTriangle, ShieldAlert, Star, ClipboardCheck, MoreHorizontal } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { stopModeLabel } from "../lib/stopMode.js";
import { formatDay } from "../lib/dates.js";
import { RatingDots } from "./RatingDots.js";
import type { ShotListItem } from "@shared/types.js";
import theme, { alpha } from "../theme.js";

const C = theme;
// Best-Brew accent — the flagged-reference star colour (per BB-a spec).
const BEST = C.acc;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const ellipsis: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** Spaltenbreiten — der Spaltenkopf in History.tsx nutzt dieselben. */
export const HISTORY_COLS = { grind: 120, rating: 96, channeling: 80, yield: 170, actions: 116 } as const;

const actionBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  flexShrink: 0,
  borderRadius: 9,
  border: `1px solid ${C.bdrL}`,
  background: "transparent",
  color: C.mut,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

/** „17. Okt., 05:54“ — Jahr nur, wenn nicht das laufende (lib/dates). */
function formatAbsoluteDate(ms: number, locale: string): string {
  return formatDay(ms, { time: true, locale });
}

// Brew duration in whole seconds, e.g. "47 s".
function formatDuration(ms: number): string {
  return `${Math.floor(ms / 1000)} s`;
}

interface ShotHistoryCardProps {
  shot: ShotListItem;
  /** Schnitt 3e: das benutzte Sieb als Etikett statt Einzel/Doppel. */
  basketName?: string | null;
  /** Die Variante — nur, wenn das Profil mehrere hat. */
  variantName?: string | null;
  onOpen?: (shot: ShotListItem) => void;
  onEdit?: (shot: ShotListItem) => void;
  /** Repeat this shot (prefill pre-shot dialog). Hidden when not provided. */
  onRepeat?: (shot: ShotListItem) => void;
  /** Disables the repeat action (e.g. while a brew is running). */
  repeatBlocked?: boolean;
  /** Flag/move (or clear) the Best-Brew reference. Only shown for brew shots. */
  onToggleBest?: (shot: ShotListItem, makeBest: boolean) => void;
  onDelete: (shot: ShotListItem) => void;
  mobile?: boolean;
}

export function ShotHistoryCard({ shot, basketName, variantName, onOpen, onEdit, onRepeat, repeatBlocked, onToggleBest, onDelete, mobile = false }: ShotHistoryCardProps) {
  const { t, lang } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const dateLabel = formatAbsoluteDate(shot.startedAt, lang === "de" ? "de-DE" : "en-US");
  const fmtG = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  // A failed app-stop and a watchdog intervention are each surfaced as a distinct
  // warning badge, so they are not also repeated as a plain stop label.
  const stopFailed = shot.stopMode === "app_failed";
  const stopWatchdog = shot.stopMode === "watchdog";

  // Bezug, zweite Zeile: #id · Datum · Bohne. Fremdbohne steht an derselben
  // Stelle wie die gepflegte Sorte — nur ist sie eben nur ein Name.
  const bean = shot.beanName ?? shot.beanLabel;
  const meta = [`#${shot.id}`, dateLabel, bean].filter(Boolean).join(" · ");
  // Etikett: das Sieb; aeltere Bezuege ohne Sieb wie bisher Einzel/Doppel, Wartung ohne.
  const sizeTag = basketName ?? (shot.category === "brew" ? t(shot.shotSize === "single" ? "history.size.single" : "history.size.double") : null);

  // Mahlgrad: Wert + Mahlgrad-Hinweis, darunter Muehle + RPM (gilt nur je Muehle).
  const grindWord = shot.grindNote === "finer" ? t("shotRating.grindFiner")
    : shot.grindNote === "coarser" ? t("shotRating.grindCoarser")
    : shot.grindNote === "ok" ? t("shotRating.grindOk") : null;
  const grinderLine = [shot.grinderName, shot.grinderRpm !== null ? `${shot.grinderRpm} RPM` : null]
    .filter(Boolean).join(" · ");

  // Channeling nur, wenn der Bezug bewertet ist — sonst heisst "false" nur
  // "nicht gefragt", nicht "keins".
  const chan: { word: string; color: string } | null = shot.channeling
    ? shot.channelingSeverity === "strong" ? { word: t("shotRating.channelingStrong"), color: C.red }
      : shot.channelingSeverity === "light" ? { word: t("shotRating.channelingLight"), color: C.org }
      : { word: t("history.channelingYes"), color: C.org }
    : hasRating(shot) ? { word: t("shotRating.channelingNone"), color: C.mut } : null;

  // Ausbeute: "Dose → Ist (Ziel)". The target yield is shown in parentheses
  // whenever it exists — even when there is no measured actual (scale
  // disconnected), where the actual is shown as "—", e.g. "12 g → — (36 g)".
  let weight = "";
  if (shot.doseG !== null) weight += `${fmtG(shot.doseG)} → `;
  if (shot.yieldActualG !== null) weight += `${fmtG(shot.yieldActualG)} g`;
  else if (shot.yieldTargetG !== null) weight += "—";
  if (shot.yieldTargetG !== null) weight += ` (${fmtG(shot.yieldTargetG)})`;
  weight = weight.trim();
  const sub = [
    shot.endedAt !== null ? formatDuration(shot.endedAt - shot.startedAt) : null,
    shot.profileSetTempC !== null ? `${shot.profileSetTempC.toFixed(1)} °C` : null,
    shot.stopMode && !stopFailed && !stopWatchdog ? stopModeLabel(t, shot.stopMode) : null,
  ].filter(Boolean).join(" · ");

  const hasNotes = shot.notes !== null && shot.notes.trim() !== "";
  // Bewertet ohne Note: nur noch eigens markieren, wenn die Zeile es nicht
  // schon zeigt (Channeling oder Mahlgrad-Hinweis stehen in den Spalten).
  const ratedHidden = ratedWithoutStars(shot) && !shot.channeling && shot.grindNote === null;

  const stop = (e: React.MouseEvent) => { e.stopPropagation(); };

  return (
    <div
      onClick={onOpen ? () => onOpen(shot) : undefined}
      style={{
        position: "relative",
        display: "flex",
        flexWrap: mobile ? "wrap" : "nowrap",
        alignItems: "center",
        columnGap: 12,
        rowGap: 6,
        minHeight: 54,
        boxSizing: "border-box",
        padding: "6px 10px 6px 14px",
        background: C.card,
        border: `1px solid ${C.bdr}`,
        borderRadius: 12,
        cursor: onOpen ? "pointer" : "default",
      }}
    >
      {/* Bezug */}
      <div style={{ flex: mobile ? "1 1 100%" : 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ minWidth: 0, fontSize: 14, fontWeight: 600, color: C.txt, ...ellipsis }}>{shot.profileName}</span>
          {variantName && <span style={{ flexShrink: 0, fontSize: 12.5, color: C.mut }}>{variantName}</span>}
          {sizeTag !== null && (
            <span style={{ flexShrink: 0, maxWidth: 150, fontSize: 11, color: C.acc, border: `1px solid ${C.bdr2}`, borderRadius: 6, padding: "1px 6px", ...ellipsis }}>
              {sizeTag}
            </span>
          )}
          {stopFailed && (
            <span title={t("history.stopMode.app_failed")} style={{ ...badge, background: C.redD, color: C.red }}>
              <AlertTriangle size={10} />
              {t("history.stopMode.app_failed")}
            </span>
          )}
          {stopWatchdog && (
            <span title={t("history.watchdog.postShotNotice")} style={{ ...badge, background: C.orgD, color: C.org }}>
              <ShieldAlert size={10} />
              {t("history.watchdog.badge")}
            </span>
          )}
          {hasNotes && <StickyNote size={12} color={C.mut} style={{ flexShrink: 0 }} aria-label={t("history.hasNotes")} />}
          {ratedHidden && <ClipboardCheck size={12} color={C.mut} style={{ flexShrink: 0 }} aria-label="bewertet ohne Note" />}
        </div>
        {/* Bezugsnummer: die Kennung, unter der ein Bezug in Notizen und
            Gespraechen auftaucht — ohne sie ist er nur "der von Dienstag". */}
        <span style={{ ...MONO, fontSize: 10.5, color: C.mut, ...ellipsis }}>{meta}</span>
      </div>

      {/* Mahlgrad */}
      <div style={{ width: HISTORY_COLS.grind, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 12.5, color: C.txt, ...ellipsis }}>
          <span style={MONO}>{shot.grindSetting !== null ? fmtG(shot.grindSetting) : "–"}</span>
          {grindWord && <span style={{ color: C.mut }}> · {grindWord.toLowerCase()}</span>}
        </span>
        {grinderLine !== "" && <span style={{ ...MONO, fontSize: 10.5, color: C.mut, ...ellipsis }}>{grinderLine}</span>}
      </div>

      {/* Bewertung */}
      <span style={{ width: HISTORY_COLS.rating, flexShrink: 0, display: "flex", alignItems: "center" }}>
        {shot.rating !== null ? <RatingDots rating={shot.rating} size={9} /> : <span style={{ fontSize: 12, color: C.mut }}>–</span>}
      </span>

      {/* Channeling */}
      <span style={{ width: HISTORY_COLS.channeling, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: chan?.color ?? C.mut }}>
        {chan ? (
          <>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: chan.color, flexShrink: 0 }} />
            {chan.word}
          </>
        ) : "–"}
      </span>

      {/* Ausbeute */}
      <div style={{ width: HISTORY_COLS.yield, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ ...MONO, fontSize: 12.5, color: C.txt, ...ellipsis }}>{weight !== "" ? weight : "–"}</span>
        {sub !== "" && <span style={{ fontSize: 10.5, color: C.mut, ...ellipsis }}>{sub}</span>}
      </div>

      {/* Aktionen */}
      <div style={{ width: mobile ? undefined : HISTORY_COLS.actions, marginLeft: mobile ? "auto" : 0, flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 4 }}>
        {onToggleBest && shot.category === "brew" && (
          <button
            onClick={(e) => { stop(e); onToggleBest(shot, !shot.isBestBrew); }}
            title={shot.isBestBrew ? t("bestBrew.unflag") : t("bestBrew.flag")}
            aria-label={shot.isBestBrew ? t("bestBrew.unflag") : t("bestBrew.flag")}
            aria-pressed={shot.isBestBrew}
            style={{ ...actionBtn, color: shot.isBestBrew ? BEST : C.mut }}
          >
            <Star size={15} fill={shot.isBestBrew ? BEST : "none"} />
          </button>
        )}
        {onRepeat && (
          <button
            onClick={(e) => { stop(e); onRepeat(shot); }}
            title={t("history.repeat")}
            aria-label={t("history.repeat")}
            style={{ ...actionBtn, opacity: repeatBlocked ? 0.35 : 1 }}
          >
            <Repeat size={14} />
          </button>
        )}
        <button
          onClick={(e) => { stop(e); setMenuOpen((o) => !o); }}
          title={t("history.moreActions")}
          aria-label={t("history.moreActions")}
          aria-expanded={menuOpen}
          style={actionBtn}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>

      {menuOpen && (
        <>
          <div onClick={(e) => { stop(e); setMenuOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 40, cursor: "default" }} />
          <div
            onClick={stop}
            style={{
              position: "absolute", top: 50, right: 8, zIndex: 41, minWidth: 180, padding: 5,
              background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 12,
              boxShadow: `0 22px 56px ${alpha(C.black, 0.55)}`, cursor: "default",
            }}
          >
            {onEdit && (
              <MenuItem icon={<Pencil size={15} />} label={t("history.edit")} onClick={() => { setMenuOpen(false); onEdit(shot); }} />
            )}
            <div style={{ height: 1, background: C.bdr, margin: "5px 4px" }} />
            <MenuItem icon={<Trash2 size={15} />} label={t("history.delete")} danger onClick={() => { setMenuOpen(false); onDelete(shot); }} />
          </div>
        </>
      )}
    </div>
  );
}

const badge: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  flexShrink: 0,
  padding: "1px 6px",
  borderRadius: 6,
  fontSize: 10,
  fontWeight: 600,
};

function MenuItem({ icon, label, danger, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => { setHover(true); }}
      onMouseLeave={() => { setHover(false); }}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
        fontFamily: "inherit", fontSize: 13, textAlign: "left",
        background: hover ? (danger ? alpha(C.red, 0.10) : C.cardHover) : "transparent",
        color: danger ? C.red : C.txtS,
      }}
    >
      {icon}{label}
    </button>
  );
}
