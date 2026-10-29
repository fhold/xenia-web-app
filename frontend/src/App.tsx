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
import { formatRoastDate } from "./lib/dates.js";
import { useBreakpoint } from "./hooks/useBreakpoint.js";
import { useMachineControl } from "./hooks/useMachineControl.js";
import { useProfiles } from "./hooks/useProfiles.js";
import { useBaskets, basketName } from "./hooks/useBaskets.js";
import type { ShotFilters } from "./hooks/useShots.js";
import { useNavigation, NavGuardContext } from "./hooks/useNavigation.js";
import { useBackflush } from "./hooks/useBackflush.js";
import { useScripts } from "./hooks/useScripts.js";
import { useShotExecute } from "./hooks/useShotExecute.js";
import { useShotSamples } from "./hooks/useShotSamples.js";
import { useLastBrewShot } from "./hooks/useLastBrewShot.js";
import { useChartSettings } from "./hooks/useChartSettings.js";
import { useBrewByWeightSettings } from "./hooks/useBrewByWeightSettings.js";
import { Sidebar, STATE_CONFIG, stateLabel } from "./components/Sidebar.js";
import type { ViewId } from "./components/Sidebar.js";
import { SetpointModal } from "./components/SetpointModal.js";
import { MachineErrorLine } from "./components/MachineErrorLine.js";
import { PreShotDialog } from "./components/PreShotDialog.js";
import { BackflushConfirmModal } from "./components/BackflushConfirmModal.js";
import type { PreShotInitialValues, PreShotPayload, StartChoice } from "./components/PreShotDialog.js";
import { startVariants, effectiveVariant, variantRunsInApp, variantForSlot } from "@shared/profile-slots.js";
import { RatingModal, ratingFacts } from "./components/RatingModal.js";
import { ratingValuesToPatch } from "./components/RatingScreen.js";
import { useStockAlert } from "./hooks/useStockAlert.js";
import { useTranslation } from "./i18n/index.js";
import { Dashboard } from "./views/Dashboard.js";
import { Profiles } from "./views/Profiles.js";
import { Settings } from "./views/Settings.js";
import { Beans } from "./views/Beans.js";
import { History } from "./views/History.js";
import type { DriveStage, MachineState, Profile, RecentShot, Shot } from "@shared/types";
import { installAudioUnlock, playAlertBeep, playPhaseTone } from "./tones.js";
import theme, { alpha } from './theme';
const C = theme;

// Flow-hold drive start — POSTs the profile's step sequence to the driver. The
// profile carries beanId etc. via the pre-shot payload; the yield override maps
// to yieldTargetOverrideG. Returns an error message, or null on success.
async function startDrive(
  profileId: number,
  choice: StartChoice,
  payload: PreShotPayload,
): Promise<string | null> {
  try {
    const res = await fetch("/api/drive/consistent-flow/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId,
        shotSize: choice.shotSize,
        variantId: choice.variant.id,
        basketId: choice.basketId,
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

/** "(9. Jun. 2026)" — Röstdatum im Aufgebraucht-Hinweis; leer, wenn keins gepflegt ist. */
function fmtBagDate(iso: string | null): string {
  const d = iso ? formatRoastDate(iso) : "";
  return d ? `(${d})` : "";
}

function fmtRest(g: number | null): string {
  if (g === null) return "?";
  return Number.isInteger(g) ? String(g) : g.toFixed(1);
}

export default function App() {
  const { connectionState, machineState, frame, setpoints, activeShot, lastEndedShot, lastUpdatedShot, maintenance, maintenanceDone, dismissMaintenanceDone, profilesRev, driveStage, driveStages } = useXeniaFrame();
  const { t } = useTranslation();
  const breakpoint = useBreakpoint();
  const control = useMachineControl();

  // Rueckweg: der Ort (Ansicht, offener Editor, Sorte, Historie) steht im
  // Browser-Verlauf — Zurueck fuehrt immer dorthin, wo man vorher war.
  const nav = useNavigation();
  const { loc } = nav;
  const activeView = loc.view;
  const [gaugeModal, setGaugeModal] = useState<GaugeTarget | null>(null);
  // Pre-shot dialog: opened by every start path, cleared on start/cancel.
  // initialValues is set only for the "repeat" flow (from a recent-shot card);
  // suggest for the dashboard chip (variant and sieve as with the last shot of the profile).
  const [preShot, setPreShot] = useState<{
    profile: Profile;
    /** null = die erste Variante (oder vom Chip: die zuletzt benutzte). */
    variantId: number | null;
    basketId?: number | null;
    suggest?: boolean;
    initialValues?: PreShotInitialValues;
    /** Start aus der Sorten-Ansicht: diese Roestung vorwaehlen. */
    beanId?: number | null;
  } | null>(null);
  // Backflush safety prompt: holds the pending run until the drip tray is confirmed empty.
  const [backflushConfirm, setBackflushConfirm] = useState<{
    profile: Profile;
    variantId: number | null;
  } | null>(null);
  // Post-shot review: opens automatically once when a shot ends. The ref tracks
  // which shot was already offered, so skipping/saving doesn't re-open it.
  const [reviewShot, setReviewShot] = useState<Shot | null>(null);
  const reviewedShotIdRef = useRef<number | null>(null);
  // Phasenton: nur das Geraet, das den App-Bezug gestartet hat, piept — wenn
  // eine Stufe mit Ton endet, auch die letzte am Bezugsende.
  const toneArmedRef = useRef(false);
  const toneStageRef = useRef<DriveStage | null>(null);
  // Aufgebraucht-Hinweis fuer die Roestung des gerade bewerteten Bezugs.
  const stockAlert = useStockAlert(reviewShot?.beanId ?? null);
  // F-T6: bumped after a rating save so the dashboard refetches its recent
  // shots immediately (the rating otherwise only appears after a view switch).
  const [recentRefreshKey, setRecentRefreshKey] = useState(0);
  // Spruenge zwischen den Ansichten — jeder ist ein Eintrag im Verlauf; die
  // Historie zeigt dann ihren Zurueck-Knopf.
  const openHistoryForRoasting = useCallback((beanId: number) => {
    nav.go({ view: "history", jump: true, history: { beanId } });
  }, [nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
  const openHistoryForProfile = useCallback((profileId: number) => {
    nav.go({ view: "history", jump: true, history: { profileId } });
  }, [nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
  // Schnitt 4: Spruenge aus dem Netz Profil ↔ Bohne — Historie mit Filtern, Sorte.
  const openHistoryWith = useCallback((filters: Partial<ShotFilters>) => {
    nav.go({ view: "history", jump: true, history: { filters } });
  }, [nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
  const openCoffee = useCallback((coffeeId: number) => {
    nav.go({ view: "beans", coffeeId });
  }, [nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
  const openProfile = useCallback((profileId: number, variantId: number | null = null) => {
    nav.go({ view: "profiles", editor: profileId, editorVariant: variantId });
  }, [nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hauptmenue: neuer Eintrag (bei ungespeicherten Aenderungen erst fragen).
  const handleNavigate = useCallback((v: ViewId) => {
    nav.guarded(() => nav.go({ view: v }));
  }, [nav.guarded, nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nach dem Start eines Bezugs aufs Dashboard — ohne Doppel-Eintrag.
  const toDashboard = useCallback(() => {
    if (loc.view !== "dashboard") nav.go({ view: "dashboard" });
  }, [loc.view, nav.go]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const { profiles, createProfile, updateProfile, deleteProfile, reorderProfiles, refresh: refreshProfiles } = useProfiles();
  const { baskets } = useBaskets();
  const backflush = useBackflush();
  // Rückspül-Reminder: a profile whose script is one of the "counts-as-backflush"
  // scripts → enables the one-tap "Jetzt rückspülen" in the banner.
  const backflushRunProfile = useMemo(() => {
    const ids = backflush.status?.profileIds ?? [];
    return profiles.find((p) => ids.includes(p.id)) ?? null;
  }, [backflush.status?.profileIds, profiles]);
  const { scripts, syncScripts, refreshList: refreshScriptList, refetch: refetchScripts, deleteScript, createScript, updateScript } = useScripts();
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
  const { samples, ended: endedStages } = useShotSamples({ frame, activeShot, lastEndedShot: dashboardShot });
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

  const runMaintenance = useCallback((profile: Profile, variantId: number | null) => {
    setBackflushConfirm(null);
    void shotExecute.execute({ profileId: profile.id, shotSize: "single", variantId }).then((err) => {
      if (!err) toDashboard();
    });
  }, [shotExecute, toDashboard]);

  // Picking a shot size no longer starts the brew directly — it opens the
  // pre-shot dialog, which collects bean/grinder/dose and then executes.
  const handleExecute = useCallback((profile: Profile, variantId: number | null) => {
    // ÄW-B: maintenance extracts no coffee — no yield, no review. Skip the
    // pre-shot dialog and execute directly. Schnitt 3: das sagt die Art des Profils.
    const variant = (variantId !== null ? profile.variants?.find((v) => v.id === variantId) : undefined) ?? startVariants(profile)[0];
    if (profile.kind === "maintenance") {
      // A backflush rinses several times into the drip tray — confirm it was
      // emptied first, otherwise it overflows onto the counter.
      if ((backflush.status?.profileIds ?? []).includes(profile.id)) {
        setBackflushConfirm({ profile, variantId: variant?.id ?? null });
        return;
      }
      runMaintenance(profile, variant?.id ?? null);
      return;
    }
    setPreShot({ profile, variantId: variant?.id ?? null });
  }, [backflush.status?.profileIds, runMaintenance]);

  // Flow-hold drive: a profile with brewSteps runs the app-side paddle-driven
  // flow controller instead of a Xenia script. Same pre-shot dialog collects
  // bean/grinder/dose; onStart routes to the drive API by inspecting brewSteps.
  const handleExecuteDrive = useCallback((profile: Profile, variantId: number | null) => {
    setPreShot({ profile, variantId });
  }, []);

  // The one stop the UI knows (header button and dashboard both call it). A
  // failed stop is the least acceptable silent failure in the app: the pump
  // keeps running and the user believes it was told to stop.
  const stopShot = useCallback(async (shotId: number) => {
    try {
      const res = await fetch(`/api/shots/${shotId}/stop`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        control.reportError(data.error ?? t("ui.stop.failedHttp", { status: res.status }));
      }
    } catch (err) {
      control.reportError(
        t("ui.stop.failed", { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }, [control]);

  // The drawer only exists on the mobile breakpoint — close it when the
  // viewport grows into tablet/desktop so it can't linger off-screen.
  useEffect(() => {
    if (breakpoint !== "mobile") setDrawerOpen(false);
  }, [breakpoint]);

  useEffect(() => installAudioUnlock(), []);

  useEffect(() => {
    const prev = toneStageRef.current;
    toneStageRef.current = driveStage;
    if (toneArmedRef.current && prev?.tone && driveStage?.index !== prev.index) playPhaseTone();
    if (driveStage === null) toneArmedRef.current = false;
  }, [driveStage]);

  // Auto-open the post-shot review once per newly ended shot (skippable).
  useEffect(() => {
    if (lastEndedShot && lastEndedShot.id !== reviewedShotIdRef.current) {
      reviewedShotIdRef.current = lastEndedShot.id;
      // Ein Messlauf bekommt keine Bewertung — er misst die Maschine, nicht den Kaffee.
      if (lastEndedShot.category !== "test") setReviewShot(lastEndedShot);
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
    "profileId" | "shotSize" | "variantId" | "basketId" | "beanId" | "beanLabel" | "grinderId" | "grindSetting" | "grinderRpm" | "doseG" | "yieldTargetG">) => {
    if (startBlocked !== null) { control.reportError(startBlocked); return; }
    const profile = profiles.find((p) => p.id === shot.profileId);
    if (!profile) return;
    // UP-1: carry the source shot's yield target as an override, but ONLY when it
    // differs from the CURRENT profile default for that size — so a default brew
    // doesn't get a bogus "geändert" marker, while a real override is reproduced.
    // Variante und Sieb des Quellbezugs; aeltere Bezuege ohne Variante ueber ihren 1×/2×-Platz.
    const variant = (shot.variantId != null ? profile.variants?.find((v) => v.id === shot.variantId) : undefined)
      ?? variantForSlot(profile, shot.shotSize);
    const profileDefault = variant
      ? variant.yieldG
      : shot.shotSize === "single" ? profile.yieldTargetSingleG : profile.yieldTargetDoubleG;
    const sourceTarget = shot.yieldTargetG ?? null;
    const prefillOverride =
      sourceTarget !== null && profileDefault !== null && sourceTarget !== profileDefault
        ? sourceTarget
        : null;
    setPreShot({
      profile,
      variantId: variant?.id ?? null,
      basketId: shot.basketId ?? null,
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

  // Profilliste: neue oder an der Maschine geloeschte Skripte fallen beim Oeffnen
  // auf (frueher machte das die Skriptliste). Nie waehrend eines Bezugs oder
  // einer Wartung — dann soll die Maschine keine Listen liefern muessen.
  useEffect(() => {
    if (activeView !== "profiles" || isBrewing || maintenance) return;
    void refreshScriptList().catch(() => { /* Abgleich ist Komfort, kein Muss */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);
  // Profiles start buttons use the same central guard.
  const canStartShot = canStartBrew;
  const isMachineOff =
    displayState === "off" || displayState === "disconnected";
  const navGuardCtx = useMemo(() => ({ setLeaveGuard: nav.setLeaveGuard }), [nav.setLeaveGuard]);
  const steamOn = frame?.steamBoilerStatus === 2;
  const controlDisabled = displayState === "disconnected" || control.isLoading;

  return (
    <NavGuardContext.Provider value={navGuardCtx}>
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
              title={t("ui.app.menu")}
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
                {stateLabel(displayState)}
              </span>
            </div>

            {/* Right: dezenter Stop while brewing, else Power + Steam */}
            {isBrewing ? (
              <button
                onClick={() => {
                  if (activeShot) void stopShot(activeShot.id);
                }}
                title={t("ui.stop.title")}
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
                {t("ui.stop.button")}
              </button>
            ) : (
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={() => { void control.setPower(isMachineOff); }}
                  disabled={controlDisabled && !isMachineOff}
                  title={stateLabel(displayState)}
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
                  title={steamOn ? t("ui.machine.steamHot") : t("ui.machine.steamCold")}
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
                  // Direkt in den Vorbereitungsdialog — Einzel/Doppel waehlt man
                  // dort. Wartungsprofile laufen wie bisher ohne Dialog.
                  if (p.kind === "maintenance") {
                    handleExecute(p, null);
                    return;
                  }
                  setPreShot({ profile: p, variantId: null, suggest: true });
                }}
                mobile={isMobile}
                activeShot={activeShot}
                lastEndedShot={dashboardShot}
                restoredShot={lastEndedShot === null && restoredShot !== null}
                profiles={profiles}
                driveStage={driveStage}
                driveStages={driveStages}
                endedStages={endedStages}
                maintenance={maintenance}
                maintenanceDone={
                  maintenanceDone !== null &&
                  (backflush.status?.profileIds ?? []).includes(maintenanceDone.profileId)
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
                  handleExecute(backflushRunProfile, null);
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
                profileActions={{ createProfile, updateProfile, deleteProfile, reorderProfiles }}
                onExecute={handleExecute}
                onExecuteDrive={handleExecuteDrive}
                canStartShot={canStartShot}
                onBlockedStart={() => { if (startBlocked) control.reportError(startBlocked); }}
                mobile={isMobile}
                scriptsSyncing={scriptsSyncing}
                onEditorOpen={handleEditorOpen}
                onOpenHistory={openHistoryForProfile}
                onOpenHistoryWith={openHistoryWith}
                onOpenCoffee={openCoffee}
                onDeleteScript={deleteScript}
                scriptActions={{ createScript, updateScript, deleteScript, refetch: refetchScripts }}
                editorId={loc.editor ?? null}
                editorVariantId={loc.editorVariant ?? null}
                onOpenEditor={(id) => nav.go({ view: "profiles", editor: id })}
                onCloseEditor={() => nav.back({ view: "profiles" }, { force: true })}
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
            {activeView === "beans" && (
              <Beans
                mobile={isMobile}
                onOpenHistory={openHistoryForRoasting}
                selectedId={loc.coffeeId ?? null}
                onSelectId={(id) => (id !== null ? nav.go({ view: "beans", coffeeId: id }) : nav.replace({ view: "beans" }))}
                onBack={() => nav.back({ view: "beans" })}
                network={{
                  profiles,
                  onStart: (p, variantId, basketId, beanId) => {
                    if (startBlocked) { control.reportError(startBlocked); return; }
                    setPreShot({ profile: p, variantId, basketId, beanId });
                  },
                  onOpenHistory: openHistoryWith,
                  onOpenProfile: openProfile,
                }}
              />
            )}
            {activeView === "history" && (
              <History
                mobile={isMobile}
                isBrewing={isBrewing}
                canStartBrew={canStartBrew}
                onRepeat={handleRepeat}
                initialBeanId={loc.history?.beanId ?? null}
                initialProfileId={loc.history?.profileId ?? null}
                initialFilters={loc.history?.filters ?? null}
                initialShotId={loc.history?.shotId ?? null}
                onLocationState={(st) => nav.stash({ history: st })}
                onBack={loc.jump ? () => nav.back({ view: "history" }) : undefined}
                onOpenProfile={openProfile}
              />
            )}
            {activeView !== "dashboard" &&
              activeView !== "profiles" &&
              activeView !== "settings" &&
              activeView !== "beans" &&
              activeView !== "history" && (
              <div
                style={{
                  color: C.mut,
                  fontSize: 13,
                  paddingTop: 40,
                  textAlign: "center",
                }}
              >
                {t("ui.app.comingSoon")}
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

        {/* Pre-shot dialog — collects bean/grinder/dose, then executes */}
        {preShot && (
          <PreShotDialog
            profile={preShot.profile}
            variantId={preShot.variantId}
            basketId={preShot.basketId}
            beanId={preShot.beanId}
            suggest={preShot.suggest}
            hasCmd27For={(v) =>
              scripts.find((s) => s.id === effectiveVariant(preShot.profile, v).scriptId)?.hasCmd27 ?? false
            }
            initialValues={preShot.initialValues}
            onStart={async (payload, choice) => {
              // Die Variante entscheidet: Stufen laufen im App-Antrieb, ein Skript
              // an der Maschine. Gilt fuer JEDEN Einstieg (Wiederholen, Chip, Liste).
              const inApp = variantRunsInApp(preShot.profile, choice.variant);
              toneArmedRef.current = inApp;
              const err = inApp
                ? await startDrive(preShot.profile.id, choice, payload)
                : await shotExecute.execute({
                    profileId: preShot.profile.id,
                    shotSize: choice.shotSize,
                    variantId: choice.variant.id,
                    basketId: choice.basketId,
                    ...payload,
                  });
              // On a successful start, always jump to the Dashboard so the live
              // brew is visible — regardless of which view the start came from
              // (History row-↻, History detail, Profiles 1×/2×, fav chip, …).
              if (!err) toDashboard();
              else toneArmedRef.current = false;
              return err;
            }}
            onClose={() => { setPreShot(null); }}
            liveBgTempC={frame?.brewGroupTempC ?? null}
            liveScaleG={frame?.scaleWeightG ?? null}
            currentBgSetpointC={setpoints?.brewGroupTargetC ?? null}
            currentBbSetpointC={setpoints?.brewBoilerTargetC ?? null}
            onSetFromProfile={async (targetTempC) => { await control.setSetpointsFromProfile(targetTempC); }}
          />
        )}

        {backflushConfirm && (
          <BackflushConfirmModal
            onConfirm={() => { runMaintenance(backflushConfirm.profile, backflushConfirm.variantId); }}
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
            shotId={reviewShot.id}
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
              vsPrev: reviewShot.vsPrev ?? null,
              vsPrevShotId: reviewShot.vsPrevShotId ?? null,
            }}
            facts={ratingFacts(
              reviewShot,
              profiles.find((p) => p.id === reviewShot.profileId)?.name ?? null,
              basketName(baskets, reviewShot.basketId) ?? (reviewShot.shotSize === "single" ? "1×" : "2×"),
            )}
            headerLabel={
              `${basketName(baskets, reviewShot.basketId) ?? (reviewShot.shotSize === "single" ? "1×" : "2×")}` +
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
                throw new Error(body.error ?? t("ui.app.ratingSaveFailed", { status: res.status }));
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
    </NavGuardContext.Provider>
  );
}
