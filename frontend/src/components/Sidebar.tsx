/**
 * Sidebar — Phase 1 Step 3.
 *
 * Desktop: 200px, icons + labels, Power/Steam/ECO in a row.
 * Tablet:  64px icon rail, icons only (title tooltips), buttons stacked.
 * Mobile:  rendered inside a drawer overlay by App.tsx — same labelled
 *          layout as desktop, plus an X close button (onClose prop).
 *
 * Colour semantics (Handoff + Flavio):
 *   OFFLINE / AUS  → grey    disconnected/off
 *   HEIZT          → red     elements actively drawing power
 *   BEREIT         → green   ready, nothing left to do
 *   ECO            → blue    standby / power-save
 *   BEZUG          → accent  (pulsing)
 *   ENTLEEREN      → accent  (steady)
 */

import {
  Bean,
  ChevronLeft,
  ChevronRight,
  Clock,
  Layers,
  Leaf,
  LayoutDashboard,
  Power,
  Settings,
  X,
} from "lucide-react";
import { SteamIcon } from "./icons/SteamIcon.js";
import type { LucideIcon } from "lucide-react";
import type { ConnectionState } from "../hooks/useXeniaFrame.js";
import type { MachineControlHook } from "../hooks/useMachineControl.js";
import type { LiveFrame, MachineState } from "@shared/types";
import theme from '../theme';

// ---------------------------------------------------------------------------
// State → colour + label mapping (exported for re-use in App.tsx TopBar)
// ---------------------------------------------------------------------------

export interface StateConfig {
  color: string;
  label: string;
  pulse: boolean;
}

export const STATE_CONFIG: Record<MachineState, StateConfig> = {
  disconnected: { color: theme.dim, label: "OFFLINE",    pulse: false },
  off:          { color: theme.dim, label: "AUS",        pulse: false },
  heating:      { color: theme.red, label: "HEIZT",      pulse: false },
  ready:        { color: theme.grn, label: "BEREIT",     pulse: false },
  eco:          { color: theme.blu, label: "ECO",        pulse: false },
  brewing:      { color: theme.acc, label: "BEZUG",      pulse: true  },
  draining:     { color: theme.acc, label: "ENTLEEREN",  pulse: false },
};

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const C = theme;

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

export type ViewId =
  | "dashboard"
  | "profiles"
  | "history"
  | "beans"
  | "settings"
  // Secondary view — reached from Settings, deliberately NOT in NAV_ITEMS (SE-2).
  | "scripts";

const NAV_ITEMS: { id: ViewId; label: string; Icon: LucideIcon }[] = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "profiles",  label: "Profile",   Icon: Layers },
  { id: "history",   label: "History",   Icon: Clock },
  { id: "beans",     label: "Bohnen",    Icon: Bean },
  { id: "settings",  label: "Settings",  Icon: Settings },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarProps {
  connectionState: ConnectionState;
  machineState: MachineState;
  frame: LiveFrame | null;
  /** When true, render the compact 64px icon-only rail (no labels). */
  collapsed: boolean;
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  control: MachineControlHook;
  /** When set, shows the collapse/expand toggle (inline sidebar only). */
  onToggleCollapse?: () => void;
  /** Mobile only: close the drawer */
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({
  connectionState,
  machineState,
  frame,
  collapsed,
  activeView,
  onNavigate,
  control,
  onToggleCollapse,
  onClose,
}: SidebarProps) {
  // Treat 'connecting' as 'disconnected' for display purposes
  const displayState: MachineState =
    connectionState === "connecting" ? "disconnected" : machineState;

  const stateConf = STATE_CONFIG[displayState];

  // ---- Control states ----
  const isMachineOff = displayState === "off" || displayState === "disconnected";
  const isEco = displayState === "eco";
  const isBusy = displayState === "brewing" || displayState === "draining";
  const steamOn = frame?.steamBoilerStatus === 2;
  const controlDisabled = displayState === "disconnected" || control.isLoading;

  // ---- Power button: binary toggle — OFF (grey) or ON (green) ----
  // When machine is off/disconnected → show "OFF", click turns on
  // When machine is in any other state → show "ON", click turns off
  const powerIsOff = isMachineOff;
  const powerColor = powerIsOff ? C.dim : C.grn;
  const powerBg    = powerIsOff ? C.dimG : C.grnD;
  const powerBorder = `1px solid ${powerColor}30`;
  const powerLabel = powerIsOff ? "OFF" : "ON";

  // ---- Steam button ----
  const steamColor = steamOn ? C.red : C.blu;
  const steamBg    = steamOn ? C.redD : C.bluD;
  const steamLabel = steamOn ? "Hot" : "Cold";

  // ---- ECO button: binary toggle ----
  // eco → blue active; off/disconnected → disabled; other → dimmed, click enters eco
  const ecoDisabled = controlDisabled || isMachineOff || isBusy;
  const ecoColor = isEco ? C.blu : C.mut;
  const ecoBg    = isEco ? C.bluD : "transparent";

  const width = collapsed ? 64 : 200;

  return (
    <div
      style={{
        width,
        height: "100%",
        flexShrink: 0,
        background: C.bg,
        borderRight: `1px solid ${C.bdr}`,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        // Smooth collapse/expand; overflow hides label spill mid-animation.
        transition: "width 0.2s ease",
        overflow: "hidden",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          padding: collapsed ? "16px 0" : "16px 14px",
          borderBottom: `1px solid ${C.bdr}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: stateConf.color,
            flexShrink: 0,
            animation: stateConf.pulse ? "xenia-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
        {!collapsed && (
          <span
            style={{
              fontSize: 11,
              color: C.mut,
              fontWeight: 600,
              letterSpacing: "0.08em",
              flex: 1,
            }}
          >
            {stateConf.label}
          </span>
        )}
        {onClose && (
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
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav
        style={{
          padding: collapsed ? "12px 8px" : "12px 10px",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {NAV_ITEMS.map(({ id, label, Icon }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              onClick={() => { onNavigate(id); }}
              title={label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: collapsed ? "center" : "flex-start",
                gap: 10,
                padding: collapsed ? "10px" : "9px 12px",
                borderRadius: 8,
                background: active ? C.accG : "transparent",
                border: active ? `1px solid ${C.acc}25` : "1px solid transparent",
                color: active ? C.acc : C.mut,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                fontFamily: "inherit",
                textAlign: "left",
              }}
            >
              <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
              {!collapsed && label}
            </button>
          );
        })}
      </nav>

      {/* Machine controls */}
      <div
        style={{
          padding: collapsed ? "12px 8px" : "12px 10px",
          borderTop: `1px solid ${C.bdr}`,
          display: "flex",
          flexDirection: collapsed ? "column" : "row",
          gap: 4,
        }}
      >
        {/* Power */}
        <button
          onClick={() => { void control.setPower(powerIsOff); }}
          disabled={controlDisabled && !powerIsOff}
          title={powerLabel}
          style={{
            flex: collapsed ? undefined : 1,
            padding: collapsed ? "10px" : "8px 0",
            borderRadius: 8,
            fontSize: 10,
            fontWeight: 700,
            background: powerBg,
            border: powerBorder,
            color: powerColor,
            cursor: controlDisabled && !powerIsOff ? "not-allowed" : "pointer",
            opacity: controlDisabled && !powerIsOff ? 0.5 : 1,
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <Power size={12} />
          {!collapsed && powerLabel}
        </button>

        {/* Steam */}
        <button
          onClick={() => { void control.setSteam(!steamOn); }}
          disabled={controlDisabled || isMachineOff}
          title={steamLabel}
          style={{
            flex: collapsed ? undefined : 1,
            padding: collapsed ? "10px" : "8px 0",
            borderRadius: 8,
            fontSize: 10,
            fontWeight: 700,
            background: steamBg,
            border: `1px solid ${steamColor}30`,
            color: steamColor,
            cursor: controlDisabled || isMachineOff ? "not-allowed" : "pointer",
            opacity: controlDisabled || isMachineOff ? 0.5 : 1,
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <SteamIcon size={12} />
          {!collapsed && steamLabel}
        </button>

        {/* ECO */}
        <button
          onClick={() => { void control.setEco(!isEco); }}
          disabled={ecoDisabled}
          title="ECO"
          style={{
            flex: collapsed ? undefined : 1,
            padding: collapsed ? "10px" : "8px 0",
            borderRadius: 8,
            fontSize: 10,
            fontWeight: 700,
            background: ecoBg,
            border: `1px solid ${ecoColor}30`,
            color: ecoColor,
            cursor: ecoDisabled ? "not-allowed" : "pointer",
            opacity: ecoDisabled ? 0.5 : 1,
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <Leaf size={12} />
          {!collapsed && "ECO"}
        </button>
      </div>

      {/* Collapse / expand toggle — inline sidebar only (not in the drawer).
          Placed at the bottom: full-width, never overlaps nav or status. */}
      {onToggleCollapse && (
        <button
          onClick={onToggleCollapse}
          title={collapsed ? "Sidebar ausklappen" : "Sidebar einklappen"}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 36,
            padding: "8px",
            background: "transparent",
            border: "none",
            borderTop: `1px solid ${C.bdr}`,
            color: C.mut,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      )}
    </div>
  );
}
