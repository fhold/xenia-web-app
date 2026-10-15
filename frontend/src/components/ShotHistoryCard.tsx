/**
 * ShotHistoryCard — one row in the History view.
 *
 * Three lines: profile + size + date (+ action icons); bean · grinder ·
 * yield · stop-mode; and an optional rating + notes-indicator line.
 *
 * onOpen / onEdit are optional — the card is clickable and shows the edit
 * icon only when those handlers are provided (wired in Step 11.5 commit 3).
 */

import { hasRating, ratedWithoutStars } from "@shared/shot-rating.js";
import { Pencil, Trash2, StickyNote, Repeat, AlertTriangle, ShieldAlert, Star, ClipboardCheck } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { stopModeLabel } from "../lib/stopMode.js";
import { RatingDots } from "./RatingDots.js";
import type { ShotListItem } from "@shared/types.js";
import theme from "../theme.js";

const C = theme;
// Best-Brew accent — the flagged-reference star colour (per BB-a spec).
const BEST = C.acc;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const ellipsis: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: C.mut,
  display: "flex",
  padding: 2,
  flexShrink: 0,
};

function formatAbsoluteDate(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

// Brew duration in whole seconds, e.g. "47 s".
function formatDuration(ms: number): string {
  return `${Math.floor(ms / 1000)} s`;
}

interface ShotHistoryCardProps {
  shot: ShotListItem;
  onOpen?: (shot: ShotListItem) => void;
  onEdit?: (shot: ShotListItem) => void;
  /** Repeat this shot (prefill pre-shot dialog). Hidden when not provided. */
  onRepeat?: (shot: ShotListItem) => void;
  /** Disables the repeat action (e.g. while a brew is running). */
  repeatBlocked?: boolean;
  /** Flag/move (or clear) the Best-Brew reference. Only shown for brew shots. */
  onToggleBest?: (shot: ShotListItem, makeBest: boolean) => void;
  onDelete: (shot: ShotListItem) => void;
}

export function ShotHistoryCard({ shot, onOpen, onEdit, onRepeat, repeatBlocked, onToggleBest, onDelete }: ShotHistoryCardProps) {
  const { t, lang } = useTranslation();

  const sizeLabel = shot.shotSize === "single" ? "1×" : "2×";
  const dateLabel = formatAbsoluteDate(shot.startedAt, lang === "de" ? "de-DE" : "en-US");

  // Line 2 — bean · grinder · stop-label (yield moved to the mono data line below).
  const parts: string[] = [];
  // Fremdbohne steht an derselben Stelle wie die gepflegte Sorte — nur ist
  // sie eben nur ein Name, ohne Sorte dahinter.
  if (shot.beanName) parts.push(shot.beanName);
  else if (shot.beanLabel) parts.push(shot.beanLabel);
  if (shot.grinderName) parts.push(shot.grinderName);
  // A failed app-stop and a watchdog intervention are each surfaced as a distinct
  // warning badge (below), so they are not also repeated as a plain text token.
  const stopFailed = shot.stopMode === "app_failed";
  const stopWatchdog = shot.stopMode === "watchdog";
  if (shot.stopMode && !stopFailed && !stopWatchdog) parts.push(stopModeLabel(t, shot.stopMode));
  const line2 = parts.join(" · ");

  // Mono data line (F-H4): Dose → Yield · Mahlgrad/RPM. (Temp is not stored per
  // shot — only in samples — so it stays in the detail modal, not on the card.)
  const fmtG = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const dataParts: string[] = [];
  // Weight segment: "Dose → Ist (Ziel)". The target yield is shown in
  // parentheses with unit behind the actual yield whenever it exists — even
  // when there is no measured actual (scale disconnected), where the actual is
  // shown as "—" so the target still anchors, e.g. "12 g → — (36 g)".
  {
    let weight = "";
    if (shot.doseG !== null) weight += `${fmtG(shot.doseG)} g → `;
    if (shot.yieldActualG !== null) weight += `${fmtG(shot.yieldActualG)} g`;
    else if (shot.yieldTargetG !== null) weight += "—";
    if (shot.yieldTargetG !== null) weight += ` (${fmtG(shot.yieldTargetG)} g)`;
    weight = weight.trim();
    if (weight !== "") dataParts.push(weight);
  }
  // Brew duration right after the yield weight (every finished shot).
  if (shot.endedAt !== null) {
    dataParts.push(formatDuration(shot.endedAt - shot.startedAt));
  }
  if (shot.grindSetting !== null) {
    dataParts.push(shot.grinderRpm !== null ? `${fmtG(shot.grindSetting)} / ${shot.grinderRpm} rpm` : `${fmtG(shot.grindSetting)}`);
  }
  if (shot.profileSetTempC !== null) dataParts.push(`${shot.profileSetTempC.toFixed(1)} °C`);
  const dataLine = dataParts.join(" · ");

  const hasNotes = shot.notes !== null && shot.notes.trim() !== "";
  // Ein Bezug mit Channeling-Marke oder Mahlgrad-Hinweis IST bewertet, auch
  // ohne Sterne — sonst behauptet die Liste "nicht bewertet", waehrend im
  // Detail eine Einschaetzung steht.
  const rated = hasRating(shot);
  const hasLine3 = rated || hasNotes;

  return (
    <div
      onClick={onOpen ? () => onOpen(shot) : undefined}
      style={{
        background: C.card,
        border: `1px solid ${C.bdr}`,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        cursor: onOpen ? "pointer" : "default",
      }}
    >
      {/* Line 1 — profile, size, date, actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: C.txt, ...ellipsis }}
        >
          {shot.profileName}
        </span>
        <span style={{ ...MONO, fontSize: 12, color: C.acc, flexShrink: 0 }}>{sizeLabel}</span>
        {stopFailed && (
          <span
            title={t("history.stopMode.app_failed")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              padding: "1px 6px",
              borderRadius: 6,
              background: C.redD,
              color: C.red,
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            <AlertTriangle size={10} />
            {t("history.stopMode.app_failed")}
          </span>
        )}
        {stopWatchdog && (
          <span
            title={t("history.watchdog.postShotNotice")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              padding: "1px 6px",
              borderRadius: 6,
              background: C.orgD,
              color: C.org,
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            <ShieldAlert size={10} />
            {t("history.watchdog.badge")}
          </span>
        )}
        {/* Bezugsnummer: die Kennung, unter der ein Bezug in Notizen und
            Gespraechen auftaucht — ohne sie ist er nur "der von Dienstag". */}
        <span style={{ ...MONO, fontSize: 10.5, color: C.mut, flexShrink: 0 }}>#{shot.id}</span>
        <span style={{ fontSize: 11, color: C.mut, flexShrink: 0 }}>{dateLabel}</span>
        {onToggleBest && shot.category === "brew" && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleBest(shot, !shot.isBestBrew); }}
            title={shot.isBestBrew ? t("bestBrew.unflag") : t("bestBrew.flag")}
            style={{ ...iconBtnStyle, color: shot.isBestBrew ? BEST : C.mut }}
          >
            <Star size={14} fill={shot.isBestBrew ? BEST : "none"} />
          </button>
        )}
        {onRepeat && (
          <button
            onClick={(e) => { e.stopPropagation(); onRepeat(shot); }}
            title={t("history.repeat")}
            style={{ ...iconBtnStyle, opacity: repeatBlocked ? 0.35 : 1 }}
          >
            <Repeat size={13} />
          </button>
        )}
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(shot); }}
            title={t("history.edit")}
            style={iconBtnStyle}
          >
            <Pencil size={13} />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(shot); }}
          title={t("history.delete")}
          style={iconBtnStyle}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Line 2 — bean · grinder · stop-mode */}
      {line2 !== "" && (
        <div style={{ fontSize: 12, color: C.txtS, ...ellipsis }}>{line2}</div>
      )}

      {/* Mono data line — Dose → Yield · Mahlgrad/RPM */}
      {dataLine !== "" && (
        <div style={{ ...MONO, fontSize: 11.5, color: C.mut, ...ellipsis }}>{dataLine}</div>
      )}

      {/* Line 3 — rating + notes indicator */}
      {hasLine3 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {shot.rating !== null && <RatingDots rating={shot.rating} size={8} />}
          {ratedWithoutStars(shot) && (
            <ClipboardCheck size={11} color={C.mut} aria-label="bewertet ohne Note" />
          )}
          {hasNotes && <StickyNote size={11} color={C.mut} />}
        </div>
      )}
    </div>
  );
}
