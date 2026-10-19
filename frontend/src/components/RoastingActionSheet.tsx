/**
 * RoastingActionSheet — bottom action-sheet for per-roasting actions (§3.4b,
 * design Variante A). Freeze/Thaw is context-aware on the roasting's status.
 * All per-roasting actions run through here (no separate roasting screen).
 */

import { Target, Snowflake, Flame, Move, ThumbsUp, Pencil, Archive } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { computeEffectiveAgeDays } from "@shared/coffee.js";
import { formatRoastDate } from "../lib/dates.js";
import type { Bean } from "@shared/types.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const MONO = "'JetBrains Mono', monospace";

interface Props {
  roasting: Bean;
  onClose: () => void;
  /** §3g: toggles the active-source flag (set ↔ unset). */
  onToggleActive: () => void;
  onFreeze: () => void;
  onThaw: () => void;
  onMove: () => void;
  onRateOverride: () => void;
  onEdit: () => void;
  onArchive: () => void;
}

function Row({ icon, label, color, onClick }: {
  icon: React.ReactNode; label: string; color?: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 15, padding: "14px 22px",
        width: "100%", background: "transparent", border: "none", cursor: "pointer",
        color: color ?? C.txtS, fontSize: 15, fontFamily: "inherit", textAlign: "left",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.white, 0.035))}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ width: 22, display: "flex", justifyContent: "center", flexShrink: 0 }}>{icon}</span>
      {label}
    </button>
  );
}

export function RoastingActionSheet({
  roasting, onClose, onToggleActive, onFreeze, onThaw, onMove, onRateOverride, onEdit, onArchive,
}: Props) {
  const { t } = useTranslation();
  const frozen = roasting.status === "frozen";
  const age = computeEffectiveAgeDays(roasting.roastDate, roasting.frozenDate, roasting.thawDate);
  const statusLabel = t(`beans.status.${roasting.status}`);
  const dateLabel = roasting.roastDate
    ? formatRoastDate(roasting.roastDate)
    : t("coffee.noDate");

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: alpha(C.black, 0.58), zIndex: 210 }} />
      <div style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 211, background: C.cardElev,
        borderTop: `1px solid ${C.bdrL}`, borderRadius: "20px 20px 0 0",
        padding: "8px 0 calc(14px + env(safe-area-inset-bottom))",
        boxShadow: `0 -24px 70px ${alpha(C.black, 0.55)}`, maxWidth: 560, margin: "0 auto",
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: C.bdr2, margin: "6px auto 4px" }} />
        <div style={{ padding: "8px 22px 12px", display: "flex", alignItems: "center", gap: 9, borderBottom: `1px solid ${C.bdr}`, marginBottom: 6 }}>
          <span style={{ color: frozen ? C.blu : C.mut, display: "flex" }}>
            {frozen ? <Snowflake size={16} /> : <Target size={16} />}
          </span>
          <span style={{ fontSize: 13, color: C.mut }}>
            {t("coffee.sheetTitle")} · <b style={{ color: C.txt, fontWeight: 600, fontFamily: MONO }}>{t("coffee.roastedOn")} {dateLabel}</b>
            {" · "}{statusLabel}{age !== null ? ` · ${age} ${t("coffee.days")}` : ""}
          </span>
        </div>

        <Row
          icon={<Target size={20} color={roasting.isActive ? C.mut : C.acc} />}
          label={roasting.isActive ? t("coffee.unsetActive") : t("coffee.setActive")}
          color={C.accLight}
          onClick={onToggleActive}
        />
        {frozen
          ? <Row icon={<Flame size={20} color={C.blu} />} label={t("coffee.thaw")} onClick={onThaw} />
          : <Row icon={<Snowflake size={20} color={C.blu} />} label={t("coffee.freeze")} onClick={onFreeze} />}
        <Row icon={<Move size={20} color={C.mut} />} label={t("coffee.move")} onClick={onMove} />
        <Row icon={<ThumbsUp size={20} color={C.mut} />} label={t("coffee.rateOverride")} onClick={onRateOverride} />
        <Row icon={<Pencil size={20} color={C.mut} />} label={t("coffee.edit")} onClick={onEdit} />
        <div style={{ height: 1, background: C.bdr, margin: "6px 22px" }} />
        <Row icon={<Archive size={20} color={C.red} />} label={t("coffee.archive")} color={C.redText} onClick={onArchive} />
      </div>
    </>
  );
}
