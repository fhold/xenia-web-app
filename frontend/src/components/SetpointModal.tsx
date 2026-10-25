/**
 * SetpointModal — temperature setpoint editor (Handoff 5.8.2).
 *
 * Opens for Brühgruppe or Brühboiler gauges. SB pressure is not editable
 * here because /inc_dec only documents BG and BB (Handoff 2.1).
 *
 * Layout:
 *   Fixed backdrop → centered card (max-width 280px)
 *   Title 10px uppercase → large value 36px Mono → –/+ buttons → footer
 */

import { useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import type { SetpointsUpdateRequest } from "@shared/types";
import { useTranslation } from "../i18n/index.js";

type GaugeTarget = "brewGroup" | "brewBoiler";

interface SetpointModalProps {
  gauge: GaugeTarget;
  /** Live sensor reading — shown as reference when setpoint is available. */
  currentValue: number;
  /** Current setpoint from /overview_single. Undefined until first 60s poll. */
  setpoint: number | undefined;
  onSave: (params: SetpointsUpdateRequest) => Promise<void>;
  onClose: () => void;
}

import theme, { alpha } from '../theme';
const C = theme;

const STEP = 0.5;

const KEY: Record<GaugeTarget, keyof SetpointsUpdateRequest> = {
  brewGroup:  "brewGroupTargetC",
  brewBoiler: "brewBoilerTargetC",
};

export function SetpointModal({
  gauge,
  currentValue,
  setpoint,
  onSave,
  onClose,
}: SetpointModalProps) {
  const { t } = useTranslation();
  const label: Record<GaugeTarget, string> = {
    brewGroup:  t("ui.setpoint.brewGroup"),
    brewBoiler: t("ui.setpoint.brewBoiler"),
  };
  // Start from the current setpoint, or round the live value to nearest 0.5
  const initial =
    setpoint !== undefined
      ? setpoint
      : Math.round(currentValue / STEP) * STEP;

  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);

  const adjust = (delta: number) => {
    setValue((v) => Math.round((v + delta) / STEP) * STEP);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ [KEY[gauge]]: value } as SetpointsUpdateRequest);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
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
        }}
      >
        {/* Card — stop click propagation so backdrop click doesn't close it */}
        <div
          onClick={(e) => { e.stopPropagation(); }}
          style={{
            background: C.card,
            border: `1px solid ${C.bdr}`,
            borderRadius: 12,
            padding: "20px 24px",
            width: "100%",
            maxWidth: 280,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            boxShadow: `0 8px 40px ${alpha(C.black, 0.5)}`,
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: C.mut,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                fontWeight: 600,
              }}
            >
              {label[gauge]}
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

          {/* Value + controls */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <button
              onClick={() => { adjust(-STEP); }}
              style={btnStyle}
            >
              <Minus size={16} />
            </button>

            <div style={{ textAlign: "center" }}>
              <span
                style={{
                  fontSize: 36,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 300,
                  color: C.txt,
                  lineHeight: 1,
                }}
              >
                {value.toFixed(1)}
              </span>
              <span style={{ fontSize: 12, color: C.mut, marginLeft: 4 }}>°C</span>
              {setpoint !== undefined && (
                <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>
                  {t("ui.setpoint.current", { v: currentValue.toFixed(1) })}
                </div>
              )}
            </div>

            <button
              onClick={() => { adjust(STEP); }}
              style={btnStyle}
            >
              <Plus size={16} />
            </button>
          </div>

          {/* Footer */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: "9px 0",
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
              {t("ui.common.cancel")}
            </button>
            <button
              onClick={() => { void handleSave(); }}
              disabled={saving}
              style={{
                flex: 1,
                padding: "9px 0",
                borderRadius: 8,
                background: C.accG,
                border: `1px solid ${C.accB}`,
                color: C.acc,
                fontSize: 12,
                fontWeight: 600,
                cursor: saving ? "wait" : "pointer",
                opacity: saving ? 0.6 : 1,
                fontFamily: "inherit",
              }}
            >
              {t("ui.setpoint.set")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const btnStyle: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 8,
  background: C.accG,
  border: `1px solid ${C.accB}`,
  color: C.acc,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
