/**
 * App root — Phase 1 Step 3.
 *
 * Layout:
 *   Desktop/Tablet: [Sidebar 200/64px] | [Content flex:1]
 *   Mobile:         [TopBar sticky] / [Content flex:1]
 *
 * The Sidebar handles navigation, status dot, and machine controls.
 * The TopBar (mobile only) is a minimal strip with a Hamburger placeholder,
 * status dot, and Power/Steam icon-buttons. Full drawer comes in Step 11.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu, Power, Octagon } from "lucide-react";
import { SteamIcon } from "./components/icons/SteamIcon.js";
import { useXeniaFrame } from "./hooks/useXeniaFrame.js";
import { canStartShotNow, startBlockedReason } from "./lib/shotReadiness.js";
import { useBreakpoint } from "./hooks/useBreakpoint.js";
import { useMachineControl } from "./hooks/useMachineControl.js";
import { useProfiles } from "./hooks/useProfiles.js";
import { useBackflush } from "./hooks/useBackflush.js";
import { useScripts } from "./hooks/useScripts.js";
import { useShotExecute } from "./hooks/useShotExecute.js";
import { useShotSamples } from "./hooks/useShotSamples.js";
import { useLastBrewShot } from "./hooks/useLastBrewShot.js";
import { useChartSettings } from "./hooks/useChartSettings.js";
import { useBrewByWeightSettings } from "./hooks/useBrewByWeightSettings.js";
import { Sidebar, STATE_CONFIG } from "./components/Sidebar.js";
import type { ViewId } from "./components/Sidebar.js";
import { SetpointModal } from "./components/SetpointModal.js";
import { MachineErrorLine } from "./components/MachineErrorLine.js";
import { ShotSizePicker } from "./components/ShotSizePicker.js";
import { PreShotDialog } from "./components/PreShotDialog.js";
import { BackflushConfirmModal } from "./components/BackflushConfirmModal.js";
import type { PreShotInitialValues, PreShotPayload } from "./components/PreShotDialog.js";
import { RatingModal } from "./components/RatingModal.js";
import { ratingValuesToPatch } from "./components/RatingScreen.js";
import { useStockAlert } from "./hooks/useStockAlert.js";
import { useTranslation } from "./i18n/index.js";
import { Dashboard } from "./views/Dashboard.js";
import { Profiles } from "./views/Profiles.js";
import { Settings } from "./views/Settings.js";
import { Beans } from "./views/Beans.js";
import { History } from "./views/History.js";
import { Scripts } from "./views/Scripts.js";
import type { MachineState, Profile, ShotSize, RecentShot, Shot } from "@shared/types";
import { effectiveCategory } from "@shared/bbw-arming.js";
import theme, { alpha } from './theme';
const C = theme;

// Flow-hold drive start — POSTs the profile's step sequence to the driver. The
// profile carries beanId etc. via the pre-shot payload; the yield override maps
// to yieldTargetOverrideG. Returns an error message, or null on success.
async function startDrive(
  profileId: number,
  shotSize: ShotSize,
  payload: PreShotPayload,
): Promise<string | null> {
  try {
    const res = await fetch("/api/drive/consistent-flow/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId,
        shotSize,
        yieldTargetOverrideG: payload.yieldTargetOverrideG,
        beanId: payload.beanId,
        beanLabel: payload.beanLabel,
        grinderId: payload.grinderId,
        grindSetting: payload.grindSetting,
        grinderRpm: payload.grinderRpm,
        doseG: payload.doseG,
      }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || !body.ok) return body.error ?? `HTTP ${res.status}`;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

type GaugeTarget = "brewGroup" | "brewBoiler";

/** Best-effort audible alert on the tablet (two short beeps) — used when a shot
 *  ends with a frozen scale. The machine can't beep mid-brew (tone is a script
 *  command), so we alert on the web app. Silent if audio is blocked. */
function playAlertBeep(): void {
  try {
    const ctx = new AudioContext();
    const beep = (offset: number, freq: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + offset;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.2);
    };
    beep(0, 880);
    beep(0.24, 620);
    setTimeout(() => { void ctx.close(); }, 700);
  } catch {
    // Best-effort — the post-shot notice banner is the reliable signal.
  }
}

/** True once any post-shot review field carries a value, i.e. the shot has been
 *  rated on some device. Drives reconnect reconciliation: if the tablet missed
 *  the shotUpdated broadcast while its socket was asleep, we detect the already-
 *  rated state on reconnect and dismiss the stale review. */
function isReviewed(shot: Shot): boolean {
  return (
    shot.rating != null ||
    shot.acidity != null ||
    shot.bitterness != null ||
    shot.extractionUnder === true ||
    shot.extractionOver === true ||
    shot.channeling === true ||
    (shot.tasteTags?.length ?? 0) > 0 ||
    shot.grindNote != null ||
    (shot.notes != null && shot.notes.trim() !== "")
  );
}

/** "09. Jun." — Röstdatum im Aufgebraucht-Hinweis; leer, wenn keins gepflegt ist. */
function fmtBagDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `(${new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "short" }).format(d)})`;
}

function fmtRest(g: number | null): string {
  if (g === null) return "?";
  return Number.isInteger(g) ? String(g) : g.toFixed(1);
}

export default function App() {
  const { connectionState, machineState, frame, setpoints, activeShot, lastEndedShot, lastUpdatedShot, maintenance, maintenanceDone, dismissMaintenanceDone, profilesRev } = useXeniaFrame();
  const { t } = useTranslation();
  const breakpoint = useBreakpoint();
  const control = useMachineControl();

  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [gaugeModal, setGaugeModal] = useState<GaugeTarget | null>(null);
  // Sprung aus der History-Detailansicht in den Editor eines Profils.
  const [profilesInitialId, setProfilesInitialId] = useState<number | null>(null);
  const [pickerProfile, setPickerProfile] = useState<Profile | null>(null);
  // Pre-shot dialog: set after the shot size is picked, cleared on start/cancel.
  // initialValues is set only for the "repeat" flow (from a recent-shot card).
  const [preShot, setPreShot] = useState<{
    profile: Profile;
    shotSize: ShotSize;
    initialValues?: PreShotInitialValues;
  } | null>(null);
  // Backflush safety prompt: holds the pending run until the drip tray is confirmed empty.
  const [backflushConfirm, setBackflushConfirm] = useState<{
    profile: Profile;
    shotSize: ShotSize;
  } | null>(null);
  // Post-shot review: opens automatically once when a shot ends. The ref tracks
  // which shot was already offered, so skipping/saving doesn't re-open it.
  const [reviewShot, setReviewShot] = useState<Shot | null>(null);
  const reviewedShotIdRef = useRef<number | null>(null);
  // Aufgebraucht-Hinweis fuer die Roestung des gerade bewerteten Bezugs.
  const stockAlert = useStockAlert(reviewShot?.beanId ?? null);
  // F-T6: bumped after a rating save so the dashboard refetches its recent
  // shots immediately (the rating otherwise only appears after a view switch).
  const [recentRefreshKey, setRecentRefreshKey] = useState(0);
  // F-B7: a roasting (bean) id to pre-filter the History view with, set when a
  // roasting row is tapped in the Beans view (cleared by History on demand).
  const [historyInitialBeanId, setHistoryInitialBeanId] = useState<number | null>(null);
  // BB-a: a shot id to open the History detail on, set when the Best-Brew
  // reference on a Sorte card is tapped (cleared by History once applied).
  const [historyInitialShotId, setHistoryInitialShotId] = useState<number | null>(null);
  // SD-1: Beans selected-coffee is owned here so the detail survives the trip to
  // the filtered History and back. `historyFromBeans` toggles the History "back
  // to Sorte" affordance.
  const [beansSelectedId, setBeansSelectedId] = useState<number | null>(null);
  const [historyFromBeans, setHistoryFromBeans] = useState(false);
  // SE-2b: deep-link into the Scripts viewer (general list or a profile's script).
  const [scriptsInitialId, setScriptsInitialId] = useState<number | null>(null);
  const openHistoryForRoasting = useCallback((beanId: number, coffeeId: number) => {
    setHistoryInitialBeanId(beanId);
    setBeansSelectedId(coffeeId);
    setHistoryFromBeans(true);
    setActiveView("history");
  }, []);
  const openHistoryForShot = useCallback((shotId: number, coffeeId: number) => {
    setHistoryInitialShotId(shotId);
    setBeansSelectedId(coffeeId);
    setHistoryFromBeans(true);
    setActiveView("history");
  }, []);
  const openScript = useCallback((scriptId?: number) => {
    setScriptsInitialId(scriptId ?? null);
    setHistoryFromBeans(false);
    setActiveView("scripts");
  }, []);
  const openProfile = useCallback((profileId: number) => {
    setProfilesInitialId(profileId);
    setHistoryFromBeans(false);
    setActiveView("profiles");
  }, []);
  // Manual nav (sidebar/drawer): clear the Beans→History back affordance.
  const handleNavigate = useCallback((v: ViewId) => {
    setHistoryFromBeans(false);
    setActiveView(v);
  }, []);
  // Mobile navigation drawer (mobile breakpoint only — tablet/desktop show the
  // sidebar permanently).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Sidebar collapsed state (tablet/desktop). Persisted in localStorage; when
  // no choice has been stored yet, the default follows the breakpoint at mount
  // — tablet starts collapsed (64px), desktop expanded (200px).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("sidebar_collapsed");
      if (stored !== null) return stored === "true";
    } catch {
      // localStorage unavailable — fall through to the breakpoint default
    }
    return breakpoint === "tablet";
  });

  const { profiles, createProfile, updateProfile, deleteProfile, reorderFavorites, refresh: refreshProfiles } = useProfiles();
  const backflush = useBackflush();
  // Rückspül-Reminder: a profile whose script is one of the "counts-as-backflush"
  // scripts → enables the one-tap "Jetzt rückspülen" in the banner.
  const backflushRunProfile = useMemo(() => {
    const ids = backflush.status?.scriptIds ?? [];
    if (ids.length === 0) return null;
    return (
      profiles.find(
        (p) =>
          (p.scriptIdSingle !== null && ids.includes(p.scriptIdSingle)) ||
          (p.scriptIdDouble !== null && ids.includes(p.scriptIdDouble)),
      ) ?? null
    );
  }, [backflush.status?.scriptIds, profiles]);
  const { scripts, syncScripts } = useScripts();
  const [scriptsSyncing, setScriptsSyncing] = useState(false);
  const handleEditorOpen = useCallback(() => {
    setScriptsSyncing(true);
    void syncScripts().finally(() => setScriptsSyncing(false));
  }, [syncScripts]);
  const shotExecute = useShotExecute();
  // Im Leerlauf (nach dem Neuladen) zeigt das Dashboard den letzten Bezug aus
  // der DB statt einer leeren Flaeche. Nur Anzeige — die Bewertung haengt weiter
  // an lastEndedShot aus dem Live-Ereignis.
  const restoredShot = useLastBrewShot();
  const dashboardShot = lastEndedShot ?? restoredShot;
  const { samples } = useShotSamples({ frame, activeShot, lastEndedShot: dashboardShot });
  const { settings: chartXSettings, refetch: refetchChart } = useChartSettings();
  const { refetch: refetchBrew } = useBrewByWeightSettings();

  const favorites = useMemo(
    () =>
      profiles
        .filter((p) => p.isFavorite)
        .sort((a, b) => {
          const ao = a.favoriteOrder ?? Infinity;
          const bo = b.favoriteOrder ?? Infinity;
          if (ao !== bo) return ao - bo;
          return a.name.localeCompare(b.name);
        }),
    [profiles],
  );

  const runMaintenance = useCallback((profile: Profile, shotSize: ShotSize) => {
    setBackflushConfirm(null);
    void shotExecute.execute({ profileId: profile.id, shotSize }).then((err) => {
      if (!err) handleNavigate("dashboard");
    });
  }, [shotExecute, handleNavigate]);

  // Picking a shot size no longer starts the brew directly — it opens the
  // pre-shot dialog, which collects bean/grinder/dose and then executes.
  const handleExecute = useCallback((profile: Profile, shotSize: ShotSize) => {
    setPickerProfile(null);
    // ÄW-B: maintenance scripts extract no coffee — no yield, no review. Skip the
    // pre-shot dialog and execute directly. Category from the script's
    // effectiveCategory (respects category_override); brew is unchanged.
    const scriptId = shotSize === "single" ? profile.scriptIdSingle : profile.scriptIdDouble;
    const script = scriptId != null ? scripts.find((s) => s.id === scriptId) : undefined;
    const isMaintenance =
      script != null &&
      effectiveCategory({ categoryAuto: script.categoryAuto, categoryOverride: script.categoryOverride }) ===
        "maintenance";
    if (isMaintenance) {
      // A backflush rinses several times into the drip tray — confirm it was
      // emptied first, otherwise it overflows onto the counter.
      if (scriptId !== null && (backflush.status?.scriptIds ?? []).includes(scriptId)) {
        setBackflushConfirm({ profile, shotSize });
        return;
      }
      runMaintenance(profile, shotSize);
      return;
    }
    setPreShot({ profile, shotSize });
  }, [scripts, backflush.status?.scriptIds, runMaintenance]);

  // Flow-hold drive: a profile with brewSteps runs the app-side paddle-driven
  // flow controller instead of a Xenia script. Same pre-shot dialog collects
  // bean/grinder/dose; onStart routes to the drive API by inspecting brewSteps.
  const handleExecuteDrive = useCallback((profile: Profile, shotSize: ShotSize) => {
    setPickerProfile(null);
    setPreShot({ profile, shotSize });
  }, []);

  // The one stop the UI knows (header button and dashboard both call it). A
  // failed stop is the least acceptable silent failure in the app: the pump
  // keeps running and the user believes it was told to stop.
  const stopShot = useCallback(async (shotId: number) => {
    try {
      const res = await fetch(`/api/shots/${shotId}/stop`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        control.reportError(data.error ?? `Bezug nicht gestoppt (HTTP ${res.status})`);
      }
    } catch (err) {
      control.reportError(
        `Bezug nicht gestoppt: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [control]);

  // The drawer only exists on the mobile breakpoint — close it when the
  // viewport grows into tablet/desktop so it can't linger off-screen.
  useEffect(() => {
    if (breakpoint !== "mobile") setDrawerOpen(false);
  }, [breakpoint]);

  // Auto-open the post-shot review once per newly ended shot (skippable).
  useEffect(() => {
    if (lastEndedShot && lastEndedShot.id !== reviewedShotIdRef.current) {
      reviewedShotIdRef.current = lastEndedShot.id;
      setReviewShot(lastEndedShot);
      // Frozen-scale: audible tablet alert (best-effort) alongside the post-shot
      // notice banner — the machine can't beep during a brew.
      if (lastEndedShot.scaleFrozen || lastEndedShot.scaleLost) playAlertBeep();
    }
  }, [lastEndedShot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live cross-client sync: a rating edit on ANY client broadcasts shotUpdated.
  // Refetch the recent shots and dismiss our post-shot review if it is open for
  // the very shot another client just rated (so the tablet no longer shows a
  // stale review / stale rating without a manual reload).
  useEffect(() => {
    if (!lastUpdatedShot) return;
    setRecentRefreshKey((k) => k + 1);
    setReviewShot((rs) => (rs && rs.id === lastUpdatedShot.id ? null : rs));
  }, [lastUpdatedShot]);

  // A profile was created/edited/deleted/reordered on another client — refetch
  // so this client (e.g. the tablet at the machine) shows it without a manual
  // tab focus. Skip the initial 0 (useProfiles already fetches on mount).
  useEffect(() => {
    if (profilesRev > 0) void refreshProfiles();
  }, [profilesRev, refreshProfiles]);

  // Live cross-client sync — reconnect reconciliation. WS broadcasts are
  // fire-and-forget: if the tablet's socket was asleep or killed (Android
  // backgrounding, heartbeat timeout) while another device rated the shot, the
  // shotUpdated event is lost and never replayed on reconnect. So whenever the
  // socket (re)connects with a post-shot review still open, re-fetch that shot
  // and dismiss the review if it has meanwhile been rated elsewhere.
  useEffect(() => {
    if (connectionState !== "connected" || !reviewShot) return;
    const shotId = reviewShot.id;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/shots/${shotId}`);
        if (!res.ok) return;
        const detail = (await res.json()) as { shot?: Shot };
        if (cancelled || !detail.shot) return;
        if (isReviewed(detail.shot)) {
          setReviewShot((rs) => (rs && rs.id === shotId ? null : rs));
          setRecentRefreshKey((k) => k + 1);
        }
      } catch {
        // Network hiccup — the next reconnect retries the reconciliation.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionState, reviewShot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle the sidebar between full (200px) and collapsed (64px), persisting
  // the choice so it survives reloads.
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("sidebar_collapsed", String(next));
      } catch {
        // localStorage unavailable — state still updates for this session
      }
      return next;
    });
  }, []);

  // Central start-readiness guard (canStartBrew, V2): connected + machine ready
  // (MA_STATUS=1 / "ready") AND no shot in progress. Single source for ALL start
  // paths (fav chip, recent repeat, Profiles 1×/2×, History row-↻, History detail).
  const canStartBrew = canStartShotNow({
    connectionState,
    machineState,
    machineStatus: frame?.machineStatus,
    activeShot,
  });
  // Warum gesperrt — fuer die Rueckmeldung. Ein Knopf, der nichts tut, sieht
  // aus wie ein Absturz; genau das ist Flavio mehrfach passiert.
  const startBlocked = startBlockedReason({
    connectionState,
    machineState,
    machineStatus: frame?.machineStatus,
    activeShot,
  });

  // Repeat a shot — open the pre-shot dialog prefilled with its values (notes
  // excluded — those belonged to that specific shot, not the repeat). Accepts
  // the structural subset shared by RecentShot (dashboard) and ShotListItem
  // (history list), so both repeat entry points reuse this exact prefill path.
  const handleRepeat = useCallback((shot: Pick<RecentShot,
    "profileId" | "shotSize" | "beanId" | "beanLabel" | "grinderId" | "grindSetting" | "grinderRpm" | "doseG" | "yieldTargetG">) => {
    if (startBlocked !== null) { control.reportError(startBlocked); return; }
    const profile = profiles.find((p) => p.id === shot.profileId);
    if (!profile) return;
    // UP-1: carry the source shot's yield target as an override, but ONLY when it
    // differs from the CURRENT profile default for that size — so a default brew
    // doesn't get a bogus "geändert" marker, while a real override is reproduced.
    const profileDefault =
      shot.shotSize === "single" ? profile.yieldTargetSingleG : profile.yieldTargetDoubleG;
    const sourceTarget = shot.yieldTargetG ?? null;
    const prefillOverride =
      sourceTarget !== null && profileDefault !== null && sourceTarget !== profileDefault
        ? sourceTarget
        : null;
    setPreShot({
      profile,
      shotSize: shot.shotSize,
      initialValues: {
        beanId: shot.beanId,
        beanLabel: shot.beanLabel,
        grinderId: shot.grinderId,
        grindSetting: shot.grindSetting,
        grinderRpm: shot.grinderRpm,
        doseG: shot.doseG,
        yieldTargetOverrideG: prefillOverride,
      },
    });
  }, [profiles, startBlocked, control]);

  // Treat 'connecting' as 'disconnected' for display
  const displayState: MachineState =
    connectionState === "connecting" ? "disconnected" : machineState;
  // Dashboard needs raw machine readiness so profile pills are enabled when ready.
  const dashboardMachineState = machineState;
  const stateConf = STATE_CONFIG[displayState];

  const isMobile = breakpoint === "mobile";
  const isBrewing = activeShot !== null;
  // Profiles start buttons use the same central guard.
  const canStartShot = canStartBrew;
  const isMachineOff =
    displayState === "off" || displayState === "disconnected";
  const steamOn = frame?.steamBoilerStatus === 2;
  const controlDisabled = displayState === "disconnected" || control.isLoading;

  return (
    <>
      {/* Pulse keyframe for status dot and brewing state */}
      <style>{`
        @keyframes xenia-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.35; }
        }
        @keyframes xenia-drawer-in {
          from { transform: translateX(-100%); }
          to   { transform: translateX(0); }
        }
      `}</style>

      <MachineErrorLine message={control.error} onDismiss={control.dismissError} />

      <div
        style={{
          minHeight: "100vh",
          background: C.bg,
          color: C.txt,
          fontFamily: "'DM Sans', system-ui, sans-serif",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
        }}
      >
        {/* Mobile TopBar — env() safe-area top padding (notch / Dynamic Island,
            0 on devices without one — see theme.safeTop / index.html). */}
        {isMobile && (
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 30,
              background: C.card,
              borderBottom: `1px solid ${C.bdr}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              paddingTop: `calc(10px + ${C.safeTop})`,
            }}
          >
            {/* Hamburger — opens the navigation drawer */}
            <button
              onClick={() => { setDrawerOpen(true); }}
              title="Menü"
              style={{
                background: "transparent",
                border: `1px solid ${C.bdr}`,
                color: C.mut,
                borderRadius: 8,
                padding: "6px 8px",
                cursor: "pointer",
                display: "flex",
              }}
            >
              <Menu size={16} />
            </button>

            {/* Center: status dot + label. The LIVE badge lives only in the
                chart head (§5.8.6) — no duplicate badge here. */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: stateConf.color,
                  animation: stateConf.pulse
                    ? "xenia-pulse 1.5s ease-in-out infinite"
                    : "none",
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  color: C.mut,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                }}
              >
                {stateConf.label}
              </span>
            </div>

            {/* Right: dezenter Stop while brewing, else Power + Steam */}
            {isBrewing ? (
              <button
                onClick={() => {
                  if (activeShot) void stopShot(activeShot.id);
                }}
                title="Bezug stoppen"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: 34,
                  padding: "0 14px",
                  borderRadius: 10,
                  background: alpha(C.red, 0.10),
                  border: `1px solid ${alpha(C.red, 0.45)}`,
                  color: C.red,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
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
                <Octagon size={14} strokeWidth={2.2} />
                Stoppen
              </button>
            ) : (
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={() => { void control.setPower(isMachineOff); }}
                  disabled={controlDisabled && !isMachineOff}
                  title={stateConf.label}
                  style={{
                    background: isMachineOff ? C.dimG
                      : displayState === "heating" ? C.redD
                      : displayState === "ready"   ? C.grnD
                      : displayState === "eco"      ? C.bluD
                      : C.accG,
                    border: `1px solid ${stateConf.color}30`,
                    borderRadius: 8,
                    padding: "6px 8px",
                    cursor: "pointer",
                    display: "flex",
                  }}
                >
                  <Power size={14} color={stateConf.color} />
                </button>
                <button
                  onClick={() => { void control.setSteam(!steamOn); }}
                  disabled={controlDisabled || isMachineOff}
                  title={steamOn ? "Hot" : "Cold"}
                  style={{
                    background: steamOn ? C.redD : C.bluD,
                    border: `1px solid ${steamOn ? C.red : C.blu}30`,
                    borderRadius: 8,
                    padding: "6px 8px",
                    cursor: "pointer",
                    display: "flex",
                  }}
                >
                  <SteamIcon size={14} color={steamOn ? C.red : C.blu} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Main flex row: Sidebar + Content */}
        {/* On mobile the sidebar is not inline — it lives in the drawer below. */}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {!isMobile && (
            <Sidebar
              connectionState={connectionState}
              machineState={machineState}
              frame={frame}
              collapsed={sidebarCollapsed}
              activeView={activeView}
              onNavigate={handleNavigate}
              control={control}
              onToggleCollapse={toggleSidebar}
            />
          )}

          {/* Content area */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              padding: "16px",
              overflowY: "auto",
              scrollbarGutter: "stable",
            }}
          >
            {activeView === "dashboard" && (
              <Dashboard
                frame={frame}
                setpoints={setpoints}
                connectionState={connectionState}
                machineState={dashboardMachineState}
                onGaugeTap={setGaugeModal}
                favorites={favorites}
                onPillTap={(p) => {
                  // Einziger Startweg ohne eigenen Guard: der Chip oeffnet nur
                  // den Vorbereitungsdialog. Ohne diese Zeile wuerde er sich im
                  // Nachlauf oeffnen und erst beim Starten scheitern.
                  if (startBlocked) { control.reportError(startBlocked); return; }
                  setPickerProfile(p);
                }}
                mobile={isMobile}
                activeShot={activeShot}
                lastEndedShot={dashboardShot}
                restoredShot={lastEndedShot === null && restoredShot !== null}
                maintenance={maintenance}
                maintenanceDone={
                  maintenanceDone !== null &&
                  (backflush.status?.scriptIds ?? []).includes(maintenanceDone.scriptId)
                    ? maintenanceDone
                    : null
                }
                onMaintenanceDoneAck={dismissMaintenanceDone}
                samples={samples}
                xSettings={chartXSettings}
                recentRefreshKey={recentRefreshKey}
                canStartBrew={canStartBrew}
                onRepeatShot={handleRepeat}
                backflushDue={backflush.status?.due ?? false}
                backflushDaysAgo={backflush.status?.daysAgo ?? null}
                backflushCanRun={backflushRunProfile !== null}
                onBackflushRun={() => {
                  if (!backflushRunProfile) return;
                  handleExecute(backflushRunProfile, "single");
                  // The run logs itself at MA_STATUS 1→3; refetch shortly after.
                  setTimeout(() => { void backflush.refetch(); }, 4000);
                }}
                onBackflushDone={() => { void backflush.markDone(); }}
                onBackflushSnooze={() => { void backflush.snooze(); }}
                onStop={async () => {
                  if (activeShot) await stopShot(activeShot.id);
                }}
              />
            )}
            {activeView === "profiles" && (
              <Profiles
                profiles={profiles}
                scripts={scripts}
                profileActions={{ createProfile, updateProfile, deleteProfile, reorderFavorites }}
                onExecute={handleExecute}
                onExecuteDrive={handleExecuteDrive}
                canStartShot={canStartShot}
                onBlockedStart={() => { if (startBlocked) control.reportError(startBlocked); }}
                mobile={isMobile}
                scriptsSyncing={scriptsSyncing}
                onEditorOpen={handleEditorOpen}
                onOpenScript={openScript}
                initialProfileId={profilesInitialId}
                onInitialApplied={() => setProfilesInitialId(null)}
              />
            )}
            {activeView === "settings" && (
              <Settings
                onChartSettingsSaved={refetchChart}
                onBrewSettingsSaved={refetchBrew}
                mobile={isMobile}
                connectionState={connectionState}
              />
            )}
            {activeView === "scripts" && (
              <Scripts
                mobile={isMobile}
                initialScriptId={scriptsInitialId}
                onInitialApplied={() => setScriptsInitialId(null)}
              />
            )}
            {activeView === "beans" && (
              <Beans
                mobile={isMobile}
                onOpenHistory={openHistoryForRoasting}
                onOpenShot={openHistoryForShot}
                selectedId={beansSelectedId}
                onSelectId={setBeansSelectedId}
              />
            )}
            {activeView === "history" && (
              <History
                mobile={isMobile}
                isBrewing={isBrewing}
                canStartBrew={canStartBrew}
                onRepeat={handleRepeat}
                initialBeanId={historyInitialBeanId}
                onInitialBeanApplied={() => setHistoryInitialBeanId(null)}
                initialShotId={historyInitialShotId}
                onInitialShotApplied={() => setHistoryInitialShotId(null)}
                onBack={historyFromBeans ? () => setActiveView("beans") : undefined}
                onOpenProfile={openProfile}
              />
            )}
            {activeView !== "dashboard" &&
              activeView !== "profiles" &&
              activeView !== "settings" &&
              activeView !== "beans" &&
              activeView !== "history" &&
              activeView !== "scripts" && (
              <div
                style={{
                  color: C.mut,
                  fontSize: 13,
                  paddingTop: 40,
                  textAlign: "center",
                }}
              >
                Coming soon
              </div>
            )}
          </div>
        </div>

        {/* Mobile navigation drawer — sidebar as an overlay (mobile only) */}
        {isMobile && drawerOpen && (
          <>
            <div
              onClick={() => { setDrawerOpen(false); }}
              style={{
                position: "fixed",
                inset: 0,
                background: C.overlay,
                zIndex: 90,
              }}
            />
            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                bottom: 0,
                zIndex: 91,
                animation: "xenia-drawer-in 0.2s ease-out",
              }}
            >
              <Sidebar
                connectionState={connectionState}
                machineState={machineState}
                frame={frame}
                collapsed={false}
                activeView={activeView}
                onNavigate={(view) => {
                  handleNavigate(view);
                  setDrawerOpen(false);
                }}
                control={control}
                onClose={() => { setDrawerOpen(false); }}
              />
            </div>
          </>
        )}

        {/* Shot size picker overlay (from Dashboard pill tap) */}
        {pickerProfile && (
          <ShotSizePicker
            profile={pickerProfile}
            onExecute={handleExecute}
            onClose={() => setPickerProfile(null)}
          />
        )}

        {/* Pre-shot dialog — collects bean/grinder/dose, then executes */}
        {preShot && (
          <PreShotDialog
            profile={preShot.profile}
            shotSize={preShot.shotSize}
            hasCmd27={
              scripts.find(
                (s) =>
                  s.id ===
                  (preShot.shotSize === "single"
                    ? preShot.profile.scriptIdSingle
                    : preShot.profile.scriptIdDouble),
              )?.hasCmd27 ?? false
            }
            initialValues={preShot.initialValues}
            onStart={async (payload) => {
              // A profile carrying a step sequence (brewSteps) runs the app-side
              // flow-hold drive; everything else runs its Xenia script. Keyed on
              // the profile so EVERY entry (repeat, fav chip, picker, Flow button)
              // routes correctly — not just the dedicated Flow button.
              const err = preShot.profile.brewSteps != null
                ? await startDrive(preShot.profile.id, preShot.shotSize, payload)
                : await shotExecute.execute({
                    profileId: preShot.profile.id,
                    shotSize: preShot.shotSize,
                    ...payload,
                  });
              // On a successful start, always jump to the Dashboard so the live
              // brew is visible — regardless of which view the start came from
              // (History row-↻, History detail, Profiles 1×/2×, fav chip, …).
              if (!err) handleNavigate("dashboard");
              return err;
            }}
            onClose={() => { setPreShot(null); }}
            liveBgTempC={frame?.brewGroupTempC ?? null}
            currentBgSetpointC={setpoints?.brewGroupTargetC ?? null}
            currentBbSetpointC={setpoints?.brewBoilerTargetC ?? null}
            onSetFromProfile={async (targetTempC) => { await control.setSetpointsFromProfile(targetTempC); }}
          />
        )}

        {backflushConfirm && (
          <BackflushConfirmModal
            onConfirm={() => { runMaintenance(backflushConfirm.profile, backflushConfirm.shotSize); }}
            onClose={() => { setBackflushConfirm(null); }}
          />
        )}

        {/* Setpoint modal */}
        {gaugeModal && (
          <SetpointModal
            gauge={gaugeModal}
            currentValue={
              gaugeModal === "brewGroup"
                ? (frame?.brewGroupTempC ?? 0)
                : (frame?.brewBoilerTempC ?? 0)
            }
            setpoint={
              gaugeModal === "brewGroup"
                ? setpoints?.brewGroupTargetC
                : setpoints?.brewBoilerTargetC
            }
            onSave={async (params) => {
              // Only close when the machine actually took the setpoint — a
              // closing dialog is the user's confirmation that it did.
              if (await control.setSetpoints(params) === null) setGaugeModal(null);
            }}
            onClose={() => { setGaugeModal(null); }}
          />
        )}

        {/* Post-shot review — auto-opens once per ended shot, fully skippable */}
        {reviewShot && (
          <RatingModal
            initial={{
              rating: reviewShot.rating ?? null,
              acidity: reviewShot.acidity ?? null,
              bitterness: reviewShot.bitterness ?? null,
              extractionUnder: reviewShot.extractionUnder ?? false,
              extractionOver: reviewShot.extractionOver ?? false,
              channeling: reviewShot.channeling ?? false,
              channelingSeverity: reviewShot.channelingSeverity ?? null,
              tasteTags: reviewShot.tasteTags ?? [],
              grindNote: reviewShot.grindNote ?? null,
              notes: reviewShot.notes ?? "",
            }}
            headerLabel={
              `${reviewShot.shotSize === "single" ? "1×" : "2×"}` +
              (reviewShot.yieldActualG !== null ? ` · ${reviewShot.yieldActualG.toFixed(1)} g` : "") +
              // UP-2: target yield in parentheses (history-mono format), when present.
              (reviewShot.yieldTargetG !== null
                ? ` (${Number.isInteger(reviewShot.yieldTargetG) ? reviewShot.yieldTargetG : reviewShot.yieldTargetG.toFixed(1)} g)`
                : "")
            }
            mobile={isMobile}
            notice={
              reviewShot.scaleFrozen
                ? t("history.scaleFrozen.postShotNotice")
                : reviewShot.scaleLost
                  ? t("history.scaleLost.postShotNotice")
                  : reviewShot.stopMode === "watchdog"
                  ? t("history.watchdog.postShotNotice")
                  : undefined
            }
            stockPrompt={
              stockAlert.alert
                ? {
                    label: `${stockAlert.alert.bean.name} ${fmtBagDate(stockAlert.alert.bean.roastDate)} ${t("stockAlert.depleted")}`
                      + ` · ${fmtRest(stockAlert.alert.bean.remainingG)} / ${fmtRest(stockAlert.alert.bean.bagSizeG)} g`,
                    candidates: stockAlert.alert.candidates.map((c) => ({
                      id: c.id,
                      label: `${fmtBagDate(c.roastDate)}${c.status === "frozen" ? " ❄" : ""}`
                        + (c.bagSizeG !== null ? ` · ${fmtRest(c.bagSizeG)} g` : ""),
                    })),
                    onArchive: (nextId) => stockAlert.archive(nextId),
                    onDismiss: () => stockAlert.dismiss(),
                  }
                : undefined
            }
            resetPrompt={
              setpoints?.profileTempPreviousSetpointC != null
                ? {
                    previousSetpointC: setpoints.profileTempPreviousSetpointC,
                    onApply: async () => { await control.resetProfileTemp(true); },
                    onDismiss: async () => { await control.resetProfileTemp(false); },
                  }
                : undefined
            }
            onSave={async (v) => {
              const res = await fetch(`/api/shots/${reviewShot.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(ratingValuesToPatch(v)),
              });
              // A rating that was not stored must not close the dialog — the
              // input is gone with it and the shot cannot be rated again.
              if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(body.error ?? `Bewertung nicht gespeichert (HTTP ${res.status})`);
              }
              // F-T6: refetch recent shots so the new rating shows immediately.
              setRecentRefreshKey((k) => k + 1);
            }}
            onClose={() => {
              // The prompt belongs to THIS shot only. Closing the review without
              // answering counts as "no" — otherwise the armed state survives and
              // re-asks after every later shot. No-op server-side when unarmed.
              if (setpoints?.profileTempPreviousSetpointC != null) {
                void control.resetProfileTemp(false);
              }
              setReviewShot(null);
            }}
          />
        )}
      </div>
    </>
  );
}
