/**
 * RecentShotCard — one compact card in the dashboard's recent-shots row.
 *
 * The whole card is tappable to repeat the shot (re-opens the pre-shot dialog
 * prefilled with this shot's values); a discreet ↻ icon hints at this. Tapping
 * is blocked while a brew is running (machine busy). The bean name is
 * emphasised in the meta line. Rating display is intentionally omitted until
 * A 1–5 rating is shown as dots when present (else nothing).
 */

import { useState } from "react";
import { Repeat } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { RatingDots } from "./RatingDots.js";
import type { RecentShot } from "@shared/types.js";
import theme from "../theme.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

const ellipsis: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/**
 * Formats a unix-ms timestamp as a coarse relative time
 * ("gerade eben", "vor 2 Std", "gestern", "vor 3 Tagen").
 */
function formatRelativeTime(
  startedAt: number,
  t: (key: string) => string,
): string {
  const diffMin = Math.floor((Date.now() - startedAt) / 60_000);
  if (diffMin < 1) return t("dashboard.recentShots.relativeTime.justNow");
  if (diffMin < 60) {
    return t("dashboard.recentShots.relativeTime.minutesAgo").replace("{n}", String(diffMin));
  }
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) {
    return t("dashboard.recentShots.relativeTime.hoursAgo").replace("{n}", String(diffH));
  }
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return t("dashboard.recentShots.relativeTime.yesterday");
  return t("dashboard.recentShots.relativeTime.daysAgo").replace("{n}", String(diffD));
}

interface RecentShotCardProps {
  shot: RecentShot;
  /** Disables tap-to-repeat (e.g. while a brew is running). */
  blocked: boolean;
  onRepeat: (shot: RecentShot) => void;
  /** Handy: zwei Karten je Breite; Bewertung und Größe rücken in die letzte
   *  Zeile, sonst drücken sie den Profilnamen auf null Breite. */
  compact?: boolean;
}

export function RecentShotCard({ shot, blocked, onRepeat, compact = false }: RecentShotCardProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);

  const sizeLabel = t(`dashboard.recentShots.shotSize.${shot.shotSize}`);
  const active = hover && !blocked;

  // Dose → yield ("15g → 30g"), shown only when both were recorded. Whole
  // numbers drop the decimal; otherwise one decimal place.
  const fmtG = (x: number) => (x % 1 === 0 ? String(x) : x.toFixed(1));
  const doseYield =
    shot.doseG !== null && shot.yieldActualG !== null
      ? `${fmtG(shot.doseG)}g → ${fmtG(shot.yieldActualG)}g`
      : null;

  // Meta line: grinder · relative time. The bean name is rendered separately
  // (emphasised) ahead of these. The relative time is always present.
  const metaRest = [shot.grinderName, formatRelativeTime(shot.startedAt, t)]
    .filter(Boolean)
    .join(" · ");

  const ratingAndSize = (
    <>
      {shot.rating !== null && (
        <span style={{ display: "flex", flexShrink: 0 }}>
          <RatingDots rating={shot.rating} size={compact ? 6 : 7} />
        </span>
      )}
      <span
        style={{
          ...MONO,
          fontSize: 11,
          color: C.txtS,
          background: C.bg,
          border: `1px solid ${C.bdrL}`,
          borderRadius: 6,
          padding: "1px 6px",
          flexShrink: 0,
        }}
      >
        {sizeLabel}
      </span>
    </>
  );

  return (
    <div
      onClick={() => onRepeat(shot)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      title={t("dashboard.recentShots.repeat")}
      style={{
        ...(compact ? { flex: "0 0 calc(50% - 4px)", minWidth: 0, scrollSnapAlign: "start" } : { flex: "1 1 0", minWidth: 120 }),
        background: active ? C.cardHover : C.card,
        border: `1px solid ${active ? C.accB : C.bdr}`,
        borderRadius: 11,
        padding: compact ? "12px 11px" : "12px 13px",
        display: "flex",
        flexDirection: "column",
        gap: 7,
        cursor: "pointer",
        transform: pressed && !blocked ? "scale(0.99)" : "none",
        transition: "border-color 0.15s, background 0.15s, transform 0.1s",
      }}
    >
      {/* Line 1: profile name · (rating) · size badge · repeat hint */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13.5,
            fontWeight: 600,
            color: C.txt,
            ...ellipsis,
          }}
        >
          {shot.profileName}
        </span>
        {!compact && ratingAndSize}
        <span
          style={{
            display: "flex",
            color: active ? C.acc : C.mut,
            opacity: active ? 1 : 0.5,
            flexShrink: 0,
            transition: "color 0.15s, opacity 0.15s",
          }}
        >
          <Repeat size={14} />
        </span>
      </div>

      {/* Line 2: bean (emphasised) · grinder · relative time */}
      <div style={{ fontSize: 11.5, color: C.mut, ...ellipsis }}>
        {shot.beanName ? (
          <span style={{ color: C.txtS, fontWeight: 600 }}>{shot.beanName}</span>
        ) : shot.beanLabel ? (
          // Fremdbohne: gleicher Platz, aber nicht fett — es ist keine gepflegte Sorte.
          <span style={{ color: C.txtS }}>{shot.beanLabel}</span>
        ) : null}
        {(shot.beanName ?? shot.beanLabel) && metaRest ? " · " : ""}
        {metaRest}
      </div>

      {/* Line 3: dose → yield (only when both recorded); compact: plus rating and size */}
      {compact ? (
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ ...MONO, fontSize: 11, color: C.txtS, flex: 1, minWidth: 0, ...ellipsis }}>{doseYield}</span>
          {ratingAndSize}
        </div>
      ) : doseYield && (
        <div style={{ ...MONO, fontSize: 11, color: C.txtS, ...ellipsis }}>{doseYield}</div>
      )}
    </div>
  );
}
