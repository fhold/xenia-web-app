/**
 * BackflushConfirmModal — safety prompt before a backflush run.
 *
 * A backflush pushes several rinses into the drip tray. Started on a tray that
 * was not emptied first, it overflows onto the counter. It also draws several
 * rinses' worth of water, so the prompt asks for the tank as well.
 */

import { Droplets, X } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import theme, { alpha } from "../theme.js";

const C = theme;

interface BackflushConfirmModalProps {
  onConfirm: () => void;
  onClose: () => void;
}

export function BackflushConfirmModal({ onConfirm, onClose }: BackflushConfirmModalProps) {
  const { t } = useTranslation();

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: C.overlay,
        backdropFilter: "blur(4px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => { e.stopPropagation(); }}
        style={{
          background: C.card,
          border: `1px solid ${C.bdr}`,
          borderRadius: 12,
          padding: "20px 24px",
          width: "100%",
          maxWidth: 340,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: `0 8px 40px ${alpha(C.black, 0.5)}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Droplets size={20} color={C.org} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: C.txt, flex: 1 }}>
            {t("dashboard.backflush.confirmTitle")}
          </span>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: C.mut,
              cursor: "pointer",
              padding: 2,
              display: "flex",
            }}
          >
            <X size={16} />
          </button>
        </div>

        <p style={{ fontSize: 13, color: C.txtS, lineHeight: 1.5, margin: 0 }}>
          {t("dashboard.backflush.confirmMessage")}
        </p>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: "10px 0",
              borderRadius: 8,
              background: "transparent",
              border: `1px solid ${C.bdr}`,
              color: C.mut,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("dashboard.backflush.confirmCancel")}
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: "10px 0",
              borderRadius: 8,
              background: C.orgD,
              border: `1px solid ${C.org}`,
              color: C.org,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("dashboard.backflush.confirmStart")}
          </button>
        </div>
      </div>
    </div>
  );
}
