/**
 * Favorite profile chip for the Dashboard header (Variante C).
 * Accent-tinted, natural width; tapping opens the pre-shot dialog directly
 * (Einzel/Doppel is chosen there).
 */

import { Coffee } from "lucide-react";
import type { Profile } from "@shared/types.js";

import theme from '../theme';
const C = theme;

interface ProfilePillProps {
  profile: Profile;
  /** mobile mode — narrower padding */
  mobile?: boolean;
  onTap: (profile: Profile) => void;
  /** When true, the chip is shown but non-interactive (machine not ready). */
  blocked?: boolean;
}

export function ProfilePill({ profile, mobile = false, onTap, blocked = false }: ProfilePillProps) {
  return (
    <button
      // Auch gesperrt anklickbar: ein Knopf ohne Handler kann nicht sagen,
      // warum er nicht geht. Der Aufrufer erklaert es (MachineErrorLine).
      // Der feste Text "Maschine nicht bereit" war ausserdem falsch, wenn der
      // vorige Bezug nur noch nachlaeuft — die Maschine IST dann bereit.
      onClick={() => onTap(profile)}
      title={profile.name}
      style={{
        background: C.accG,
        border: `1px solid ${C.accB}`,
        borderRadius: 9,
        padding: mobile ? "7px 10px" : "8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 7,
        cursor: "pointer",
        fontFamily: "inherit",
        // Desktop/tablet: uniform fixed chip width. Mobile (UP-4): chips share
        // the row width (flex), truncate with ellipsis — flush with the gauges,
        // never overflowing the viewport. box-sizing keeps padding inside width.
        width: mobile ? undefined : 128,
        flex: mobile ? "1 1 0" : undefined,
        minWidth: 0,
        flexShrink: mobile ? 1 : 0,
        boxSizing: "border-box",
        opacity: blocked ? 0.45 : 1,
        transition: "border-color 0.15s, background 0.15s, opacity 0.15s",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        if (blocked) return;
        e.currentTarget.style.borderColor = C.acc;
        e.currentTarget.style.background = C.accG2;
      }}
      onMouseLeave={(e) => {
        if (blocked) return;
        e.currentTarget.style.borderColor = C.accB;
        e.currentTarget.style.background = C.accG;
      }}
    >
      <Coffee size={14} color={blocked ? C.mut : C.acc} strokeWidth={1.8} style={{ flexShrink: 0 }} />
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: blocked ? C.mut : C.txt,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {profile.name}
      </span>
    </button>
  );
}
