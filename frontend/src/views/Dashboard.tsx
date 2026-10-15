/**
 * Dashboard — Phase 1 Step 2 / Step 5.5.
 *
 * Context-sensitive layout:
 *   Idle:    Gauges row + Favorites pills
 *   Brewing: Gauges row + Chart placeholder + Live values + Stop button
 *
 * Opacity rules:
 *   disconnected (WS) → 0.3  (greyed out)
 *   off                → 0.6  (dimmed)
 *   all other states   → 1.0  (full opacity)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Octagon, Droplet, Droplets } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { Gauge } from "../components/Gauge.js";
import { ProfilePill } from "../components/ProfilePill.js";
import { ShotChart } from "../components/ShotChart.js";
import { useShotGhosts } from "../hooks/useShotGhosts.js";
import { RecentShots } from "../components/RecentShots.js";
import type { ChartMode } from "../components/ShotChart.js";
import type { ConnectionState } from "../hooks/useXeniaFrame.js";
import type { ChartSample } from "../hooks/useShotSamples.js";
import type { ChartXSettings } from "../hooks/useChartSettings.js";
import { canStartShotFromState } from "../lib/shotReadiness.js";
import type {
  LiveFrame,
  MachineState,
  MaintenanceRun,
  SetpointsFrame,
  Profile,
  Shot,
  RecentShot,
} from "@shared/types";
import theme, { alpha } from "../theme";

const C = theme;

const MONO: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
};

/** Rückspül-Reminder banner action button style. */
const backflushBtn = (primary: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
  whiteSpace: "nowrap",
  color: primary ? C.org : C.txtS,
  background: primary ? C.orgD : C.sunken,
  border: `1px solid ${primary ? C.org : C.bdr2}`,
});

interface DashboardProps {
  frame: LiveFrame | null;
  setpoints: SetpointsFrame | null;
  /** Rückspül-Reminder: show a backflush-due banner (idle only). */
  backflushDue?: boolean;
  backflushDaysAgo?: number | null;
  /** Whether "Jetzt rückspülen" is possible (a matching maintenance profile exists). */
  backflushCanRun?: boolean;
  onBackflushRun?: () => void;
  onBackflushDone?: () => void;
  onBackflushSnooze?: () => void;
  connectionState: ConnectionState;
  machineState: MachineState;
  /** Called when BG or BB gauge is tapped. */
  onGaugeTap?: (gauge: "brewGroup" | "brewBoiler") => void;
  /** Favorite profiles for the header chips (idle/ended). */
  favorites?: Profile[];
  /** Called when a favorite chip is tapped. */
  onPillTap?: (profile: Profile) => void;
  mobile?: boolean;
  /** Set when a shot is in progress — switches to brewing layout. */
  activeShot?: Shot | null;
  /** Last completed shot — keeps brewing layout visible after shot ends. */
  lastEndedShot?: Shot | null;
  /** lastEndedShot kommt aus der DB (App neu geladen), nicht aus einem eben
   *  beendeten Bezug — dann kein "Bezug beendet"-Hinweis. */
  restoredShot?: boolean;
  /** ÄW-B: app-initiated maintenance run in progress (backflush etc.). When set,
   *  the chart area shows a "maintenance running" banner + countdown instead. */
  maintenance?: MaintenanceRun | null;
  /** A finished backflush, held in the chart area until acknowledged — the drip
   *  tray is full at this point and must be emptied before the next brew. */
  maintenanceDone?: MaintenanceRun | null;
  onMaintenanceDoneAck?: () => void;
  /** Called when user clicks the stop button. */
  onStop?: () => Promise<void>;
  /** Live + finalized chart samples from useShotSamples. */
  samples?: ChartSample[];
  /** Chart x-axis settings loaded from backend (sliding window, resize). */
  xSettings?: ChartXSettings;
  /** Bumped by the app after a rating save → forces a recent-shots refetch. */
  recentRefreshKey?: number;
  /** Central start-readiness guard (machine ready + not brewing). When provided,
   *  it drives both the favourite chips and the recent-card repeat. */
  canStartBrew?: boolean;
  /** Called when a recent-shot card's repeat button is clicked. */
  onRepeatShot?: (shot: RecentShot) => void;
}

function resolveOpacity(
  connectionState: ConnectionState,
  machineState: MachineState,
): number {
  if (connectionState === "disconnected") return 0.3;
  if (machineState === "off") return 0.6;
  return 1;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function Dashboard({
  frame,
  setpoints,
  connectionState,
  machineState,
  onGaugeTap,
  favorites = [],
  onPillTap,
  mobile = false,
  activeShot = null,
  lastEndedShot = null,
  restoredShot = false,
  maintenance = null,
  maintenanceDone = null,
  onMaintenanceDoneAck,
  onStop,
  samples = [],
  xSettings,
  recentRefreshKey = 0,
  canStartBrew,
  onRepeatShot,
  backflushDue = false,
  backflushDaysAgo = null,
  backflushCanRun = false,
  onBackflushRun,
  onBackflushDone,
  onBackflushSnooze,
}: DashboardProps) {
  const { t } = useTranslation();
  const opacity = resolveOpacity(connectionState, machineState);
  // Show brewing layout while shot is active OR just ended
  const isBrewing = activeShot !== null;

  // ÄW-B maintenance banner: tick once a second while a run is active so the
  // countdown updates. Only runs during maintenance (cheap, self-clearing).
  const [maintNow, setMaintNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!maintenance) return;
    setMaintNow(Date.now());
    const iv = setInterval(() => setMaintNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [maintenance]);
  const maintRemainingMs =
    maintenance && maintenance.durationMs != null
      ? Math.max(0, maintenance.startedAt + maintenance.durationMs - maintNow)
      : null;

  // Water tank: machine reports 2 = empty (1 = full). Surface a persistent
  // banner while idle so a low tank is noticed before the next brew. Hidden
  // during a brew (no point — the machine is already pulling) and gone the
  // moment the tank reads full again. Only the ~60s setpoints poll updates it.
  const waterTankEmpty = !isBrewing && setpoints?.waterTankLevel === 2;

  // The chart fills the available vertical space (flex), so no measured height.

  // Central guard from the app (machine ready + not brewing); falls back to the
  // local readiness check if the prop isn't supplied.
  const canStartShot = canStartBrew ?? canStartShotFromState(
    connectionState,
    machineState,
    frame?.machineStatus,
  );
  // The shot to display: active takes priority, otherwise the last ended one
  const displayShot = activeShot ?? lastEndedShot;

  const bg = frame?.brewGroupTempC ?? 0;
  const bb = frame?.brewBoilerTempC ?? 0;
  const sb = frame?.steamBoilerPressureBar ?? 0;

  const showColorLogic =
    machineState !== "off" && machineState !== "disconnected";

  // Setpoints stay editable in every machine state (on, off, eco, heating) —
  // only blocked when fully disconnected, since there's no machine to talk to.
  const canEditSetpoints = machineState !== "disconnected";

  const bgTarget = showColorLogic ? setpoints?.brewGroupTargetC : undefined;
  const bbTarget = showColorLogic ? setpoints?.brewBoilerTargetC : undefined;

  // ---- Elapsed timer (rAF — no React re-renders per frame) ----
  const elapsedRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isBrewing || !displayShot) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const startedAt = displayShot.startedAt;

    function tick(): void {
      if (elapsedRef.current) {
        // Math.max(0, …): guard against tablet↔LXC clock skew showing a
        // negative elapsed time in the first seconds of a brew (Bug 3).
        elapsedRef.current.textContent = formatElapsed(Math.max(0, Date.now() - startedAt));
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isBrewing, displayShot?.startedAt]);

  // ---- Stop button ----
  const [stopping, setStopping] = useState(false);

  async function handleStop(): Promise<void> {
    if (!onStop) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  }

  // Chart mode
  const chartMode: ChartMode = activeShot !== null ? "brewing" : lastEndedShot !== null ? "ended" : "idle";

  // Yield target: Cmd27 takes precedence over profile target
  const yieldTarget = displayShot?.cmd27Value ?? displayShot?.yieldTargetG ?? null;

  // Post-shot comparison: once the shot is finished, draw the past shots of the
  // same brew behind it. Not while brewing — the ghosts would have to slide
  // with the moving x-window on every frame (see ShotGhostLayer).
  const { ghosts } = useShotGhosts(
    chartMode === "ended" && (xSettings?.showGhosts ?? false) ? (displayShot?.id ?? null) : null,
    true,
    xSettings?.ghostCount ?? 20,
  );

  // Aggregate values over the full shot for post-shot review only.
  // During brewing live tiles use frame/latest-sample values and avoid O(n) work.
  const shotAggregates = useMemo(() => {
    if (chartMode !== "ended") return null;
    if (samples.length === 0) return null;
    let sumP = 0, nP = 0, sumF = 0, nF = 0, sumT = 0, nT = 0;
    for (const s of samples) {
      if (s.pressure !== null) { sumP += s.pressure; nP++; }
      if (s.flow !== null)     { sumF += s.flow;     nF++; }
      if (s.temp !== null)     { sumT += s.temp;     nT++; }
    }
    return {
      avgPressure:  nP > 0 ? sumP / nP : null,
      avgFlow:      nF > 0 ? sumF / nF : null,
      avgTemp:      nT > 0 ? sumT / nT : null,
      finalWeight:  samples[samples.length - 1].weight,
    };
  }, [samples.length, chartMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chart Y-weight max: expand if target is above default 50g
  const yWeightMax = yieldTarget !== null && yieldTarget > 50 ? Math.ceil(yieldTarget / 10) * 10 + 10 : 50;
  const weightReached =
    yieldTarget !== null && frame !== null && frame.scaleWeightG >= yieldTarget;

  // DURATION cell text. While brewing the rAF loop overwrites it live; the
  // rendered value covers the ended (final duration) and idle ("—:—") cases.
  const durationText = isBrewing
    ? "0:00"
    : displayShot?.endedAt != null
      ? formatElapsed(displayShot.endedAt - displayShot.startedAt)
      : "—:—";

  // Top favorites shown as header chips: max 3 (tablet/desktop), 2 (mobile).
  const visibleFavorites = favorites.slice(0, mobile ? 2 : 3);

  // ---- Readout values (overlay over the chart, brewing/ended only) ----
  // Brewing: live frame values. Ended: aggregates over the whole shot, so the
  // overlay matches the (now legend-less) chart's post-shot summary.
  const useAggregates = chartMode === "ended" && shotAggregates !== null;
  const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const liveFlow = lastSample?.flow ?? null;
  const dPressure = useAggregates ? shotAggregates!.avgPressure : (frame?.pumpPressureBar ?? null);
  const dFlow     = useAggregates ? shotAggregates!.avgFlow     : liveFlow;
  const dWeight   = useAggregates ? shotAggregates!.finalWeight : (frame?.scaleWeightG ?? null);
  const dTemp     = useAggregates ? shotAggregates!.avgTemp     : (frame?.brewGroupTempC ?? null);
  const bgTargetVal = setpoints?.brewGroupTargetC ?? null;
  // Same 4-step logic as Gauge.tsx resolveColor (non-steam) — keep in sync.
  const tempColor = (() => {
    if (useAggregates || dTemp === null || bgTargetVal === null) return C.txt;
    const diff = dTemp - bgTargetVal;
    if (diff > 2)    return C.red;
    if (diff >= -0.5) return C.grn;
    if (diff >= -5)   return C.org;
    return C.blu;
  })();

  // One readout cell: 3px curve-colour bar (left) + key over mono value.
  // barColor ties the cell to its chart curve; valueColor highlights state.
  const roCell = (
    key: string,
    value: string,
    unit: string,
    barColor: string,
    valueColor: string = C.txt,
  ) => (
    <div style={{ display: "flex", gap: 8 }}>
      <div style={{ width: 3, borderRadius: 2, background: barColor, alignSelf: "stretch", flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", color: C.mut, textTransform: "uppercase" }}>
          {key}
        </div>
        <div style={{ ...MONO, fontWeight: 700, fontSize: 19, lineHeight: 1, color: valueColor }}>
          {value}
          {unit ? (
            <small style={{ fontSize: 11, color: C.mut, fontWeight: 400, marginLeft: 2 }}>{unit}</small>
          ) : null}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Water-tank-low banner (idle only): persistent until refilled. */}
      {waterTankEmpty && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: 10,
            background: C.orgD,
            border: `1px solid ${C.org}`,
          }}
        >
          <Droplet size={18} color={C.org} style={{ flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.org }}>
              {t("dashboard.waterLow.title")}
            </span>
            <span style={{ fontSize: 12, color: C.txt }}>
              {t("dashboard.waterLow.message")}
            </span>
          </div>
        </div>
      )}

      {/* Rückspül-Reminder banner (idle only): due until flushed / done / snoozed. */}
      {backflushDue && !isBrewing && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            marginBottom: 12,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: 10,
            background: C.orgD,
            border: `1px solid ${C.org}`,
          }}
        >
          <Droplets size={18} color={C.org} style={{ flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.org }}>
              {t("dashboard.backflush.title")}
            </span>
            <span style={{ fontSize: 12, color: C.txt }}>
              {t("dashboard.backflush.message").replace("{n}", String(backflushDaysAgo ?? "?"))}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
            {backflushCanRun && (
              <button onClick={() => onBackflushRun?.()} style={backflushBtn(true)}>
                {t("dashboard.backflush.run")}
              </button>
            )}
            <button onClick={() => onBackflushDone?.()} style={backflushBtn(false)}>
              {t("dashboard.backflush.done")}
            </button>
            <button onClick={() => onBackflushSnooze?.()} style={backflushBtn(false)}>
              {t("dashboard.backflush.snooze")}
            </button>
          </div>
        </div>
      )}

      {/* Header row (Variante C): gauge chips left, favorites/stop right */}
      <div
        style={{
          opacity,
          transition: "opacity 0.3s",
          marginBottom: 12,
          flexShrink: 0,
          display: "flex",
          alignItems: "stretch",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Gauge
          label="BG"
          value={bg}
          unit="°C"
          target={bgTarget}
          setpoint={setpoints?.brewGroupTargetC}
          onTap={canEditSetpoints ? () => onGaugeTap?.("brewGroup") : undefined}
          mobile={mobile}
        />
        <Gauge
          label="BB"
          value={bb}
          unit="°C"
          target={bbTarget}
          setpoint={setpoints?.brewBoilerTargetC}
          onTap={canEditSetpoints ? () => onGaugeTap?.("brewBoiler") : undefined}
          mobile={mobile}
        />
        {/* Dampf: setpoint is a pressure (bar) — display only, no color logic
            (the steam thresholds in Gauge are in °C and don't apply to bar). */}
        <Gauge
          label="Dampf"
          value={sb}
          unit="bar"
          decimals={2}
          setpoint={setpoints?.steamBoilerTargetPressureBar}
          setpointDecimals={1}
          mobile={mobile}
        />

        {/* Right side: dezenter Stop (brewing) or favorite chips (idle/ended).
            Mobile (UP-4): the chip row drops to its own full-width line flush with
            the gauges (no marginLeft:auto right-push, no overflow). */}
        <div style={{ marginLeft: mobile ? 0 : "auto", flexBasis: mobile ? "100%" : "auto", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {isBrewing ? (
            // On mobile the Stop lives in the top bar — avoid a duplicate here.
            !mobile && (
            <button
              onClick={() => { void handleStop(); }}
              disabled={stopping}
              title="Bezug stoppen"
              onMouseEnter={(e) => { if (!stopping) e.currentTarget.style.background = alpha(C.red, 0.18); }}
              onMouseLeave={(e) => { e.currentTarget.style.background = alpha(C.red, 0.10); }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 16px",
                borderRadius: 10,
                background: alpha(C.red, 0.10),
                border: `1px solid ${alpha(C.red, 0.45)}`,
                color: C.red,
                fontSize: 13,
                fontWeight: 600,
                cursor: stopping ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: C.red,
                  animation: "xenia-pulse 1.4s ease-in-out infinite",
                  flexShrink: 0,
                }}
              />
              <Octagon size={15} strokeWidth={2.2} />
              {stopping ? "Stoppe…" : "Stoppen"}
            </button>
            )
          ) : (
            visibleFavorites.map((p) => (
              <ProfilePill
                key={p.id}
                profile={p}
                mobile={mobile}
                blocked={!canStartShot}
                onTap={(profile) => onPillTap?.(profile)}
              />
            ))
          )}
        </div>
      </div>

      {/* ---- Chart — fills the available vertical space (flex) on all breakpoints.
              ÄW-B: while a maintenance run is active the chart area is replaced by
              a "maintenance running" banner + countdown (no shot is recorded). ---- */}
      <div style={{ marginBottom: 12, flex: "1 1 0", minHeight: 0, position: "relative" }}>
        {maintenance ? (
          <div
            style={{
              height: "100%",
              minHeight: 140,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              textAlign: "center",
              borderRadius: 12,
              border: `1px solid ${C.org}`,
              background: alpha(C.maintWarm, 0.06),
            }}
          >
            <Droplets size={40} color={C.org} style={{ opacity: 0.9 }} />
            <div style={{ fontSize: 20, fontWeight: 800, color: C.org, letterSpacing: "0.01em" }}>
              {t("dashboard.maintenance.running")}
            </div>
            <div style={{ fontSize: 14, color: C.txt }}>{maintenance.label}</div>
            <div style={{ ...MONO, fontSize: 15, color: C.mut }}>
              {maintRemainingMs !== null && maintRemainingMs > 0
                ? t("dashboard.maintenance.remaining", { time: formatElapsed(maintRemainingMs) })
                : t("dashboard.maintenance.almostDone")}
            </div>
          </div>
        ) : maintenanceDone ? (
          <div
            style={{
              height: "100%",
              minHeight: 140,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              textAlign: "center",
              padding: "0 16px",
              borderRadius: 12,
              border: `1px solid ${C.org}`,
              background: alpha(C.maintWarm, 0.06),
            }}
          >
            <Droplets size={40} color={C.org} style={{ opacity: 0.9 }} />
            <div style={{ fontSize: 20, fontWeight: 800, color: C.org, letterSpacing: "0.01em" }}>
              {t("dashboard.maintenance.doneTitle")}
            </div>
            <div style={{ fontSize: 14, color: C.txt, maxWidth: 380, lineHeight: 1.5 }}>
              {t("dashboard.maintenance.doneMessage")}
            </div>
            <button
              onClick={() => onMaintenanceDoneAck?.()}
              style={{
                padding: "10px 28px",
                borderRadius: 8,
                background: C.orgD,
                border: `1px solid ${C.org}`,
                color: C.org,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("dashboard.maintenance.doneAck")}
            </button>
          </div>
        ) : (
        <>
        <ShotChart
          samples={samples}
          mode={chartMode}
          yieldTarget={yieldTarget}
          yWeightMax={yWeightMax}
          showTempAxis={!mobile}
          xSettings={xSettings}
          ghosts={ghosts}
          fill
          endedBadge={!restoredShot}
        />

        {/* Live readout overlay — over the top of the curve (brewing/ended only).
            Sits just below the chart's mode badge; gradient fades into the plot.
            pointer-events:none so the chart's own hover/tooltip still works. */}
        {chartMode !== "idle" && (
          <div
            style={{
              position: "absolute",
              top: 34,
              left: 14,
              right: 14,
              display: "flex",
              gap: 18,
              flexWrap: "wrap",
              alignItems: "flex-start",
              pointerEvents: "none",
              padding: "10px 8px 22px",
              background:
                `linear-gradient(180deg, ${alpha(C.bg, 0.92)}, ${alpha(C.bg, 0)})`,
            }}
          >
            {/* Dauer — no curve, neutral bar; value carries the rAF timer ref */}
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ width: 3, borderRadius: 2, background: C.dim, alignSelf: "stretch", flexShrink: 0 }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 9, letterSpacing: "0.1em", color: C.mut, textTransform: "uppercase" }}>
                  Dauer
                </div>
                <div
                  ref={elapsedRef}
                  style={{ ...MONO, fontWeight: 700, fontSize: 19, lineHeight: 1, color: isBrewing ? C.txt : C.mut }}
                >
                  {durationText}
                </div>
              </div>
            </div>

            {/* Balkenfarben = Kurvenfarben, beide aus den Messreihen-Tokens (theme.ts):
                Druck, Fluss, Gewicht, Temperatur. */}
            {roCell("Druck", dPressure !== null ? dPressure.toFixed(1) : "—", "bar", C.seriesPressure)}
            {roCell("Flow", dFlow !== null ? dFlow.toFixed(2) : "—", "g/s", C.seriesFlow)}
            {roCell(
              "Gewicht",
              dWeight !== null ? dWeight.toFixed(1) : "—",
              yieldTarget !== null ? `/ ${yieldTarget.toFixed(0)} g` : "g",
              C.seriesWeight,
              weightReached ? C.grn : C.txt,
            )}
            {roCell("Temp", dTemp !== null ? dTemp.toFixed(1) : "—", "°C", C.seriesTemp, tempColor)}
          </div>
        )}
        </>
        )}
      </div>

      {/* ---- Recent shots — Idle/Post-Brewing only; hidden during a live brew
           to save vertical space on tablet landscape (§5.9 Brewing-Modus). ---- */}
      {!isBrewing && (
        <div style={{ marginTop: 12, flexShrink: 0 }}>
          <RecentShots
            reloadKey={(lastEndedShot?.id ?? 0) + recentRefreshKey * 1_000_000}
            repeatBlocked={!canStartShot}
            onRepeat={(shot) => onRepeatShot?.(shot)}
          />
        </div>
      )}
    </div>
  );
}
