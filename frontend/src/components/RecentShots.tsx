/**
 * RecentShots — dashboard section showing the last few brew shots as a row
 * of cards that flex-fill the available width. Sits below the chart area.
 *
 * Card count adapts to the breakpoint (mobile 3 / tablet 4 / desktop 5).
 * On the phone two cards fill the width; the third is a swipe away.
 * Always visible; the per-card repeat button is dimmed while a brew runs —
 * still clickable, so the refusal can explain itself instead of doing nothing.
 */

import { useTranslation } from "../i18n/index.js";
import { useBreakpoint } from "../hooks/useBreakpoint.js";
import { useRecentShots } from "../hooks/useRecentShots.js";
import { RecentShotCard } from "./RecentShotCard.js";
import type { RecentShot } from "@shared/types.js";
import theme from "../theme.js";

const C = theme;

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  overflowX: "auto",
  paddingBottom: 4,
};

interface RecentShotsProps {
  /** Changes whenever a shot ends → triggers a refetch. */
  reloadKey: number;
  /** Dims every card's repeat button (machine busy) — the tap still reports why. */
  repeatBlocked: boolean;
  onRepeat: (shot: RecentShot) => void;
}

export function RecentShots({ reloadKey, repeatBlocked, onRepeat }: RecentShotsProps) {
  const { t } = useTranslation();
  const breakpoint = useBreakpoint();
  const { shots, loading } = useRecentShots(reloadKey);

  // Fewer cards on smaller screens so each stays readable; the cards
  // themselves flex-fill whatever width the row has.
  const maxCards = breakpoint === "mobile" ? 3 : breakpoint === "tablet" ? 4 : 5;
  const visible = shots.slice(0, maxCards);

  // Skeleton — only on the very first load, before any data has arrived.
  if (loading && shots.length === 0) {
    return (
      <div style={rowStyle}>
        {Array.from({ length: maxCards }, (_, i) => (
          <div
            key={i}
            style={{
              flex: "1 1 0",
              minWidth: 120,
              height: 60,
              background: C.card,
              border: `1px solid ${C.bdr}`,
              borderRadius: 10,
              opacity: 0.4,
            }}
          />
        ))}
      </div>
    );
  }

  if (shots.length === 0) {
    return (
      <div style={{ fontSize: 12, color: C.mut, textAlign: "center", padding: "16px 0" }}>
        {t("dashboard.recentShots.empty")}
      </div>
    );
  }

  const compact = breakpoint === "mobile";
  return (
    <div style={compact ? { ...rowStyle, scrollSnapType: "x mandatory" } : rowStyle}>
      {visible.map((shot) => (
        <RecentShotCard
          key={shot.id}
          shot={shot}
          blocked={repeatBlocked}
          onRepeat={onRepeat}
          compact={compact}
        />
      ))}
    </div>
  );
}
