/**
 * Popup for selecting 1× (single) or 2× (double) shot size.
 * Shown when a ProfilePill is tapped on the Dashboard.
 *
 * Variant B: onExecute prop — caller is responsible for the execute call.
 * Click outside the card closes without picking.
 */

import { Coffee } from "lucide-react";
import type { Profile, ShotSize } from "@shared/types.js";

import theme, { alpha } from '../theme';
const C = theme;

interface ShotSizePickerProps {
  profile: Profile;
  /** Called with the chosen shot size. Parent triggers execute. */
  onExecute: (profile: Profile, shotSize: ShotSize) => void;
  onClose: () => void;
}

export function ShotSizePicker({ profile, onExecute, onClose }: ShotSizePickerProps) {
  const hasDouble = profile.scriptIdDouble !== null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: alpha(C.black, 0.55),
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        backdropFilter: "blur(6px)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          borderRadius: 14,
          border: `1px solid ${C.bdr}`,
          padding: "20px 24px",
          width: "100%",
          maxWidth: 260,
          textAlign: "center",
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: C.accG,
            border: `1px solid ${C.acc}20`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 10px",
          }}
        >
          <Coffee size={20} color={C.acc} strokeWidth={1.8} />
        </div>

        {/* Name */}
        <div style={{ fontSize: 14, fontWeight: 700, color: C.txt, marginBottom: 2 }}>
          {profile.name}
        </div>
        {/* Description placeholder */}
        <div style={{ fontSize: 11, color: C.mut, marginBottom: 18 }}>
          {profile.description ?? ""}
        </div>

        {/* Size buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => onExecute(profile, "single")}
            style={{
              flex: 1,
              padding: "14px 8px",
              borderRadius: 10,
              background: C.accG2,
              border: `1px solid ${C.acc}40`,
              color: C.acc,
              fontSize: 18,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            1×
            <span
              style={{
                fontSize: 9,
                fontWeight: 500,
                fontFamily: "'DM Sans', sans-serif",
                color: C.mut,
              }}
            >
              Single
            </span>
          </button>

          <button
            onClick={() => hasDouble && onExecute(profile, "double")}
            disabled={!hasDouble}
            title={hasDouble ? undefined : "Kein Double-Skript konfiguriert"}
            style={{
              flex: 1,
              padding: "14px 8px",
              borderRadius: 10,
              background: hasDouble ? C.accG2 : "transparent",
              border: `1px solid ${hasDouble ? `${C.acc}40` : C.bdr}`,
              color: hasDouble ? C.acc : C.dim,
              fontSize: 18,
              fontWeight: 700,
              cursor: hasDouble ? "pointer" : "not-allowed",
              fontFamily: "'JetBrains Mono', monospace",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              opacity: hasDouble ? 1 : 0.45,
            }}
          >
            2×
            <span
              style={{
                fontSize: 9,
                fontWeight: 500,
                fontFamily: "'DM Sans', sans-serif",
                color: hasDouble ? C.mut : C.dim,
              }}
            >
              Double
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
