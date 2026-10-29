/**
 * ShotDetailModal — full detail view for one recorded shot.
 *
 * Shows the reconstructed chart (from shot_sample rows), a stats grid,
 * bean/grinder cards, notes and rating. Edit and delete are delegated
 * to the History view via callbacks.
 */

import { useMemo, useState } from "react";
import { X, Pencil, Trash2, Repeat, Maximize, Minimize, ArrowLeftRight } from "lucide-react";
import { ShotChart } from "./ShotChart.js";
import { useShotGhosts } from "../hooks/useShotGhosts.js";
import { RatingDots } from "./RatingDots.js";
import { RatingModal, ratingFacts } from "./RatingModal.js";
import { ratingValuesToPatch } from "./RatingScreen.js";
import { hasRating, extractionMarks } from "@shared/shot-rating.js";
import type { ShotRatingValues } from "./RatingScreen.js";
import { stopModeLabel } from "../lib/stopMode.js";
import { formatDay } from "../lib/dates.js";
import { useShotDetail } from "../hooks/useShotDetail.js";
import { useChartSettings } from "../hooks/useChartSettings.js";
import { buildScriptOverlay } from "@shared/script-overlay.js";
import { flowStageStrip, scriptStageStrip, flowPreinfusionEndS, firstDropS } from "@shared/stage-strip.js";
import { brewEndSeconds, liveSollCurve, recordedStageEntries } from "@shared/live-stage.js";
import { useBreakpoint } from "../hooks/useBreakpoint.js";
import { useBaskets, basketName } from "../hooks/useBaskets.js";
import { HoverTip } from "./HoverTip.js";
import { useTranslation } from "../i18n/index.js";
import type { ChartSample } from "../hooks/useShotSamples.js";
import type { ShotChartStageOverlay } from "./ShotChart.js";
import type { BrewProfile, ShotListItem, ShotUpdate } from "@shared/types.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

/** Bezugsdatum mit Uhrzeit — Jahr nur, wenn nicht das laufende (lib/dates). */
function formatDateTime(ms: number, locale: string): string {
  return formatDay(ms, { time: true, locale });
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

/** Grams without a trailing ".0" (e.g. 36 → "36", 23.9 → "23.9"). */
function fmtG(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Target flows (g/s) of the planned flow steps after the last one that ran. */
function ghostFlowTargets(steps: BrewProfile["steps"], ranCount: number): number[] {
  const out: number[] = [];
  for (const s of steps.slice(ranCount)) {
    if (s.kind === "flow" && !out.includes(s.targetFlowGs)) out.push(s.targetFlowGs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function StatCell({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: React.ReactNode;
  /** Override the value colour — used to flag a failed app-stop in red. */
  valueColor?: string;
}) {
  return (
    <div
      style={{
        background: C.bg,
        border: `1px solid ${valueColor ?? C.bdr}`,
        borderRadius: 8,
        padding: "10px 8px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 9, color: C.mut, letterSpacing: "0.08em", marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ ...MONO, fontSize: 16, fontWeight: 700, color: valueColor ?? C.txt }}>{value}</div>
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: C.bg,
        border: `1px solid ${C.bdr}`,
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 10, color: C.mut, fontWeight: 600, letterSpacing: "0.06em", marginBottom: 4 }}>
        {title.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface ShotDetailModalProps {
  shot: ShotListItem;
  mobile: boolean;
  onClose: () => void;
  onEdit: (shot: ShotListItem) => void;
  onDelete: (shot: ShotListItem) => void;
  /** Persist a rating change (wired to useShots.update → refetches the list). */
  onUpdate: (patch: ShotUpdate) => Promise<void>;
  /** F-H5: repeat this shot (same flow as Recent-Cards / row ↻). */
  onRepeat?: (shot: ShotListItem) => void;
  /** Disable repeat (e.g. while a brew is running). */
  repeatBlocked?: boolean;
  /** Klick auf den Profilnamen: dieses Profil im Editor öffnen — in der Variante des Bezugs. */
  onOpenProfile?: (profileId: number, variantId: number | null) => void;
  /** Bezuege vergleichen: diesen als A nehmen, den zweiten in der Historie waehlen. */
  onCompare?: (shot: ShotListItem) => void;
}

export function ShotDetailModal({ shot, mobile, onClose, onEdit, onDelete, onUpdate, onRepeat, repeatBlocked, onOpenProfile, onCompare }: ShotDetailModalProps) {
  const { t, lang } = useTranslation();
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === "desktop";
  const { samples, scriptContent, stages, brewSteps, brewDef, loading } = useShotDetail(shot.id);
  const { settings: chartSettings } = useChartSettings();

  // Pre-infusion → extraction transition (seconds). Flow-Bezug: Beginn der ersten
  // Flussstufe, so wie der Treiber tatsaechlich umgeschaltet hat. Sonst (Skript,
  // oder Profil ohne Preinfusions-Stufe) der gemessene Uebergang: erstes
  // 'extraction'-Sample. null when nothing was recorded (legacy/empty).
  const preinfusionByStage = flowPreinfusionEndS(stages) !== null;
  const preinfusionEndS = useMemo(() => {
    const byStage = flowPreinfusionEndS(stages);
    if (byStage !== null) return byStage;
    const first = samples.find((s) => s.phase === "extraction");
    return first ? first.elapsedMs / 1000 : null;
  }, [samples, stages]);

  // SO-1 visibility: persisted default on open, overridable transiently per view.
  // The modal remounts per shot-open → userToggled resets → follows the default again.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const showOverlay = userToggled ?? chartSettings.showScriptOverlay;

  // Same transient-override pattern for the measured pump-power curve.
  const [pumpToggled, setPumpToggled] = useState<boolean | null>(null);
  const showPump = pumpToggled ?? chartSettings.showPumpCurve;
  const hasPumpData = useMemo(() => samples.some((s) => s.pumpPwm !== null), [samples]);

  // Flow-Hold stage overlay — same transient-override pattern. Only offered for
  // shots that actually ran flow-hold stages (drive shots).
  const [stageToggled, setStageToggled] = useState<boolean | null>(null);
  const showStages = stageToggled ?? chartSettings.showStageMarkers;
  const hasStageData = stages.length > 0;

  // Ghosts of past shots — same transient-override pattern. Always offered:
  // whether there ARE past shots of this brew is only known after the fetch,
  // and hiding the button until then would make it flicker into existence.
  // Fullscreen chart — the modal is cramped once ghosts, Soll and stages are on.
  const [fullscreen, setFullscreen] = useState(false);
  const [ghostToggled, setGhostToggled] = useState<boolean | null>(null);
  const showGhosts = ghostToggled ?? chartSettings.showGhosts;
  const { ghosts } = useShotGhosts(shot.id, showGhosts, chartSettings.ghostCount);

  // Build the commanded Soll overlay (only when shown + a script resolved).
  const overlay = useMemo(() => {
    if (!showOverlay || !scriptContent) return null;
    const durMs = shot.endedAt !== null ? shot.endedAt - shot.startedAt : 0;
    const o = buildScriptOverlay(scriptContent, durMs);
    if (!o) return null;
    const toS = (pts: { t: number; v: number }[]) => pts.map((p) => ({ t: p.t / 1000, v: p.v }));
    const markers: { t: number; label: string }[] = [];
    if (o.determinismEndMs !== null) markers.push({ t: o.determinismEndMs / 1000, label: t("history.detailModal.overlayDeterminismEnd") });
    markers.push({ t: o.stopMs / 1000, label: t("history.detailModal.overlayStop") });
    return {
      barSolid: toS(o.barSolid), barHeld: toS(o.barHeld),
      flowSolid: toS(o.flowSolid), flowHeld: toS(o.flowHeld),
      markers, endT: o.clipEndMs / 1000,
    };
  }, [showOverlay, scriptContent, shot.endedAt, shot.startedAt, t]);

  // Local rating copy so the read-only display updates immediately after a
  // re-rate (the parent's `shot` prop is a snapshot from when it was opened).
  const [rv, setRv] = useState<ShotRatingValues>({
    rating: shot.rating,
    acidity: shot.acidity,
    bitterness: shot.bitterness,
    extractionUnder: shot.extractionUnder,
    extractionOver: shot.extractionOver,
    channeling: shot.channeling,
    channelingSeverity: shot.channelingSeverity ?? null,
    tasteTags: shot.tasteTags ?? [],
    grindNote: shot.grindNote,
    notes: shot.notes ?? "",
    vsPrev: shot.vsPrev ?? null,
    vsPrevShotId: shot.vsPrevShotId ?? null,
  });
  const [ratingOpen, setRatingOpen] = useState(false);
  const [editHover, setEditHover] = useState(false);
  const [nameHover, setNameHover] = useState(false);
  // Local copy so the star reflects the toggle immediately (the `shot` prop is
  // a snapshot from when the modal opened; the list refetch lands after close).
  const isRated = hasRating(rv);
  // Extraktion: nur zeigen, was tatsaechlich markiert ist. Hier stand frueher
  // "ausgewogen", sobald under/over leer waren — Channeling war ausgenommen,
  // also galt ein als Channeling markierter Bezug als ausgewogen. Keine Marke
  // heisst "nicht beurteilt", und dafuer gibt es keine Zeile.
  const MARK_STYLE: Record<string, { key: string; color: string }> = {
    under:      { key: "shotRating.under",      color: C.org },
    over:       { key: "shotRating.over",       color: C.org },
    channeling: { key: "shotRating.channeling", color: C.red },
  };
  const marks = extractionMarks(rv).map((m) => ({
    id: m,
    label: m === "channeling" && rv.channelingSeverity
      ? `${t(MARK_STYLE[m]!.key)} · ${t(rv.channelingSeverity === "strong" ? "shotRating.channelingStrong" : "shotRating.channelingLight")}`
      : t(MARK_STYLE[m]!.key),
    color: MARK_STYLE[m]!.color,
  }));
  const grindLabelKey =
    rv.grindNote === "finer" ? "shotRating.grindFiner"
      : rv.grindNote === "ok" ? "shotRating.grindOk"
      : "shotRating.grindCoarser";

  // Responsive sizing (T5): use more width + a taller chart on bigger screens.
  const modalWidth = mobile
    ? "100%"
    : isDesktop
      ? "min(1100px, 90vw)"
      : "min(880px, 94vw)";
  const detailChartHeight = mobile ? 200 : isDesktop ? 360 : 300;

  const chartSamples = useMemo<ChartSample[]>(
    () =>
      samples.map((s) => ({
        t: parseFloat((s.elapsedMs / 1000).toFixed(2)),
        pressure: s.pressureBar,
        flow: s.flowMlS,
        temp: s.tempBgC,
        weight: s.weightG,
        pumpPwm: s.pumpPwm,
      })),
    [samples],
  );

  // Target weight that ends the shot: the snapshot's weight exit wins over the
  // profile-level yield target it was derived from.
  const masterStopG = useMemo(() => {
    for (const s of brewSteps?.steps ?? []) {
      if (s.exit.weightG != null) return s.exit.weightG;
    }
    return shot.yieldTargetG;
  }, [brewSteps, shot.yieldTargetG]);

  // Ende des Bruehens — fuer Soll-Kurve und Stufenleiste.
  const brewEndS = useMemo(() => brewEndSeconds(samples), [samples]);

  // Flow-Hold Soll-Kurve (History): the pressure and flow stages that ACTUALLY ran,
  // computed exactly like the live chart (shared/live-stage) from the persisted
  // stage transitions + the brew_steps snapshot, so it reflects what this shot ran,
  // not today's profile. Ramps start at the measured value, the pre-infusion has no
  // Soll, the last stage ends at the pump stop. Plus faint ghost refs for planned
  // flow stages that never ran and vertical markers at the real stage entries.
  const stageOverlay = useMemo<ShotChartStageOverlay | null>(() => {
    if (stages.length === 0) return null;
    const durS =
      shot.endedAt !== null
        ? (shot.endedAt - shot.startedAt) / 1000
        : chartSamples.length > 0
          ? chartSamples[chartSamples.length - 1].t
          : 0;

    const snapSteps = brewSteps?.steps ?? [];
    const markers: { t: number; label: string }[] = [];

    stages.forEach((st, i) => {
      // Vertical marker at every real phase change (skip the t=0 start).
      if (i === 0) return;
      const startS = Math.max(0, st.enteredMs / 1000);
      const named = snapSteps[st.stageIndex]?.name?.trim() || null;
      const label =
        named ??
        (st.stepKind === "flow" && st.targetFlowGs !== null
          ? `${st.targetFlowGs.toFixed(1)} g/s`
          : st.stepKind === "pressure" && st.targetPressureBar !== null
            ? `${st.targetPressureBar.toFixed(0)} bar`
            : st.stepKind === "power" && st.targetPower !== null
              ? `${st.targetPower.toFixed(0)} %`
              : "");
      markers.push({ t: startS, label: `▸ ${label} · ${Math.round(startS)}s` });
    });

    const soll = liveSollCurve(recordedStageEntries(stages, snapSteps, chartSamples), brewEndS);
    const lastSollV = soll.flow.length > 0 ? soll.flow[soll.flow.length - 1]!.v : null;

    // Planned flow stages that never ran → a faint continuation staircase into
    // the tail the ended-mode X domain adds past the last sample (durS → +2s).
    const ghostSoll: { t: number; v: number }[] = [];
    const ghostTargets = ghostFlowTargets(snapSteps, stages.length);
    if (ghostTargets.length > 0 && lastSollV !== null) {
      const tailEnd = Math.ceil(durS) + 2;
      const slice = (tailEnd - durS) / ghostTargets.length;
      ghostSoll.push({ t: parseFloat(durS.toFixed(2)), v: lastSollV });
      ghostTargets.forEach((v, i) => {
        ghostSoll.push({ t: parseFloat((durS + i * slice).toFixed(2)), v });
        ghostSoll.push({ t: parseFloat((durS + (i + 1) * slice).toFixed(2)), v });
      });
    }

    // Weight master stop — only when the target weight actually ended the shot.
    const masterStop =
      masterStopG !== null && (shot.stopMode === "cmd27" || shot.stopMode === "app")
        ? { t: parseFloat(durS.toFixed(2)), label: `${fmtG(masterStopG)} g · ~${Math.round(durS)}s` }
        : null;

    if (soll.flow.length === 0 && soll.bar.length === 0 && markers.length === 0 && ghostSoll.length === 0) return null;
    return { flowSoll: soll.flow, barSoll: soll.bar, ghostSoll, markers, masterStop };
  }, [stages, brewSteps, chartSamples, brewEndS, shot.endedAt, shot.startedAt, shot.stopMode, masterStopG]);

  // Stufenleiste unter dem Diagramm: welche Stufe wann lief, was sie beendet hat,
  // was nicht mehr drankam — Flow-Bezug aus den echten Stufenwechseln, Skript-
  // Bezug aus dem Skript. Endpunkt ist das Ende des Bruehens, nicht das Ende der
  // Aufzeichnung (der Nachlauf laeuft noch bis zu 15 s weiter).
  const stageStrip = useMemo(() => {
    const weightStop = shot.stopMode === "cmd27" || shot.stopMode === "app" || shot.stopMode === "flowhold";
    const stop = { mode: shot.stopMode, weightG: weightStop ? shot.yieldTargetG : null };
    const strip =
      stages.length > 0
        ? flowStageStrip(stages, brewSteps?.steps ?? [], brewEndS, stop)
        : scriptContent
          ? scriptStageStrip(scriptContent, brewEndS, stop)
          : null;
    // Nachlauf: nach dem Pumpenstopp laeuft die Aufzeichnung weiter, es tropft nach.
    const lastT = chartSamples.length > 0 ? chartSamples[chartSamples.length - 1].t : brewEndS;
    const wAt = (tS: number) => { let w: number | null = null; for (const c of chartSamples) if (c.t <= tS && c.weight !== null) w = c.weight; return w; };
    const wEnd = wAt(brewEndS), wLast = wAt(lastT);
    const tail = lastT > brewEndS ? { endS: lastT, gainG: wEnd !== null && wLast !== null ? wLast - wEnd : null } : null;
    return strip ? { strip, firstDropS: firstDropS(chartSamples), tail } : null;
  }, [brewEndS, chartSamples, stages, brewSteps, scriptContent, shot.stopMode, shot.yieldTargetG]);

  // Averages + peak weight across the recorded samples.
  const agg = useMemo(() => {
    let sumP = 0, nP = 0, sumT = 0, nT = 0, maxW = 0;
    for (const s of samples) {
      if (s.pressureBar !== null) { sumP += s.pressureBar; nP++; }
      if (s.tempBgC !== null) { sumT += s.tempBgC; nT++; }
      if (s.weightG !== null && s.weightG > maxW) maxW = s.weightG;
    }
    return {
      avgPressure: nP > 0 ? sumP / nP : null,
      avgTemp: nT > 0 ? sumT / nT : null,
      maxWeight: maxW,
    };
  }, [samples]);

  const yWeightMax =
    agg.maxWeight > 50 ? Math.ceil(agg.maxWeight / 10) * 10 + 10 : 50;

  const ratio =
    shot.doseG !== null && shot.doseG > 0 && shot.yieldActualG !== null
      ? `1:${(shot.yieldActualG / shot.doseG).toFixed(1)}`
      : "—";
  const duration =
    shot.endedAt !== null ? formatDuration(shot.endedAt - shot.startedAt) : "—";
  const { baskets } = useBaskets();
  // Schnitt 3e: das benutzte Sieb; aeltere Bezuege ohne Sieb wie bisher 1×/2×.
  const sizeLabel = basketName(baskets, shot.basketId) ?? (shot.shotSize === "single" ? "1×" : "2×");
  const locale = lang === "de" ? "de-DE" : "en-US";

  const hasNotes = shot.notes !== null && shot.notes.trim() !== "";

  // Umschalter der Kurven — im Fenster und im Vollbild dieselben (Flavio 22.10.).
  const toggles = (
    <>
                  <button
                    onClick={() => setGhostToggled(!showGhosts)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit",
                      fontSize: 11, fontWeight: 600,
                      background: showGhosts ? C.accG2 : "transparent",
                      border: `1px solid ${showGhosts ? C.accB : C.bdr2}`,
                      color: showGhosts ? C.acc : C.mut,
                    }}
                  >
                    <span style={{ width: 12, height: 0, borderTop: `2px solid ${showGhosts ? C.acc : C.mut}`, opacity: 0.5 }} />
                    {t("history.detailModal.ghostToggle")}
                  </button>
                  {hasStageData && (
                    <button
                      onClick={() => setStageToggled(!showStages)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit",
                        fontSize: 11, fontWeight: 600,
                        background: showStages ? alpha(C.seriesTarget, 0.14) : "transparent",
                        border: `1px solid ${showStages ? alpha(C.seriesTarget, 0.4) : C.bdr2}`,
                        color: showStages ? C.seriesTarget : C.mut,
                      }}
                    >
                      <span style={{ width: 12, height: 0, borderTop: `2px dashed ${showStages ? C.seriesTarget : C.mut}` }} />
                      {t("history.detailModal.stageToggle")}
                    </button>
                  )}
                  {hasPumpData && (
                    <button
                      onClick={() => setPumpToggled(!showPump)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit",
                        fontSize: 11, fontWeight: 600,
                        background: showPump ? C.orgD : "transparent",
                        border: `1px solid ${showPump ? alpha(C.seriesPower, 0.4) : C.bdr2}`,
                        color: showPump ? C.seriesPower : C.mut,
                      }}
                    >
                      <span style={{ width: 12, height: 0, borderTop: `2px solid ${showPump ? C.seriesPower : C.mut}` }} />
                      {t("history.detailModal.pumpToggle")}
                    </button>
                  )}
                  {scriptContent !== null && (
                    <button
                      onClick={() => setUserToggled(!showOverlay)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit",
                        fontSize: 11, fontWeight: 600,
                        background: showOverlay ? C.accG2 : "transparent",
                        border: `1px solid ${showOverlay ? C.accB : C.bdr2}`,
                        color: showOverlay ? C.acc : C.mut,
                      }}
                    >
                      <span style={{ width: 12, height: 0, borderTop: `2px dashed ${showOverlay ? C.acc : C.mut}` }} />
                      {t("history.detailModal.overlayToggle")}
                    </button>
                  )}
    </>
  );

  // One chart definition for both places — inline in the modal and fullscreen.
  const renderChart = (full: boolean) => (
    <ShotChart
      samples={chartSamples}
      mode="ended"
      yWeightMax={yWeightMax}
      showTempAxis={full || !mobile}
      chartHeight={detailChartHeight}
      fill={full}
      endedBadge={false}
      overlay={overlay}
      preinfusionEndS={preinfusionEndS}
      showPump={showPump}
      stageOverlay={showStages ? stageOverlay : null}
      ghosts={showGhosts ? ghosts : null}
      stageStrip={stageStrip}
    />
  );

  // Both captions belong to the chart and now share one baseline: what this shot
  // ran (left) against what it is compared with (right). A ghost cloud that does
  // not name its basis claims a precision it may not have.
  const captionRow =
    brewDef || (showGhosts && ghosts !== null) ? (
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          fontSize: 10,
          lineHeight: 1.4,
          marginTop: 4,
        }}
      >
        <span style={{ color: brewDef && brewDef.isCurrent === false ? C.org : C.mut }}>
          {brewDef
            ? t(
                brewDef.isCurrent === null
                  ? "history.detailModal.brewDefUnknown"
                  : brewDef.isCurrent
                    ? "history.detailModal.brewDefCurrent"
                    : "history.detailModal.brewDefOutdated",
                { hash: brewDef.hash.slice(0, 8) },
              )
            : ""}
        </span>
        {showGhosts && ghosts !== null && (
          <span style={{ color: C.mut, textAlign: "right" }}>
            {ghosts.shots.length === 0
              ? t("history.detailModal.ghostNone")
              : `${ghosts.shots.length} ${t("history.detailModal.ghostCaption")} · ${
                  ghosts.basis === "brewdef"
                    ? t("history.detailModal.ghostBasisBrewdef")
                    : t("history.detailModal.ghostBasisProfile")
                }`}
          </span>
        )}
      </div>
    ) : null;

  return (
    <>
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: C.overlay,
        backdropFilter: "blur(4px)",
        zIndex: 100,
        display: "flex",
        alignItems: mobile ? "stretch" : "center",
        justifyContent: "center",
        padding: mobile ? 0 : 16,
      }}
    >
      <div
        onClick={(e) => { e.stopPropagation(); }}
        style={{
          background: C.cardElev,
          border: mobile ? "none" : `1px solid ${C.bdrL}`,
          borderRadius: mobile ? 0 : 14,
          padding: mobile ? `calc(18px + ${C.safeTop}) 20px 22px` : "18px 20px 22px",
          width: modalWidth,
          maxHeight: mobile ? "100%" : "92vh",
          overflowY: "auto",
          boxShadow: mobile ? "none" : `0 8px 40px ${alpha(C.black, 0.5)}`,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              {onOpenProfile && shot.profileId !== null ? (
                <button
                  onClick={() => { if (shot.profileId !== null) onOpenProfile(shot.profileId, shot.variantId ?? null); }}
                  onMouseEnter={() => setNameHover(true)}
                  onMouseLeave={() => setNameHover(false)}
                  title={t("history.detailModal.openProfile")}
                  style={{
                    padding: 0, border: "none", background: "none", cursor: "pointer",
                    fontFamily: "inherit", fontSize: 16, fontWeight: 600, color: C.txt, textAlign: "left",
                    textDecoration: nameHover ? "underline" : "none", textUnderlineOffset: 3,
                  }}
                >
                  {shot.profileName}
                </button>
              ) : (
                <span style={{ fontSize: 16, fontWeight: 600, color: C.txt }}>
                  {shot.profileName}
                </span>
              )}
              <span style={{ ...MONO, fontSize: 13, color: C.acc }}>{sizeLabel}</span>
            </div>
            <div style={{ fontSize: 11, color: C.mut, marginTop: 2 }}>
              <span style={{ ...MONO }}>#{shot.id}</span> · {formatDateTime(shot.startedAt, locale)}
            </div>
          </div>
          {onRepeat && (
            <button
              onClick={() => onRepeat(shot)}
              title={t("history.repeat")}
              style={{ ...iconBtn, opacity: repeatBlocked ? 0.35 : 1 }}
            >
              <Repeat size={16} />
            </button>
          )}
          {onCompare && (
            <button onClick={() => onCompare(shot)} title={t("history.compare.action")} style={iconBtn}>
              <ArrowLeftRight size={16} />
            </button>
          )}
          <button
            onClick={() => onEdit(shot)}
            title={t("history.edit")}
            style={iconBtn}
          >
            <Pencil size={16} />
          </button>
          <button
            onClick={() => onDelete(shot)}
            title={t("history.delete")}
            style={iconBtn}
          >
            <Trash2 size={16} />
          </button>
          <button onClick={onClose} title="" style={iconBtn}>
            <X size={18} />
          </button>
        </div>

        {/* Chart */}
        <div style={{ marginBottom: 14 }}>
          {loading ? (
            <div style={{ color: C.mut, fontSize: 12, textAlign: "center", padding: "40px 0" }}>
              …
            </div>
          ) : chartSamples.length === 0 ? (
            <div style={{ color: C.mut, fontSize: 12, textAlign: "center", padding: "40px 0" }}>
              {t("history.detailModal.noChart")}
            </div>
          ) : (
            <>
              {/* Transient chart-curve toggles (override only this view, no setting
                  write): measured pump-power curve + SO-1 commanded Soll overlay.
                  Each shown only when its data is available. */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 4 }}>
                  {toggles}
                  <button
                    onClick={() => setFullscreen(true)}
                    title={t("history.detailModal.fullscreen")}
                    style={{
                      display: "inline-flex", alignItems: "center",
                      padding: "4px 8px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit",
                      background: "transparent", border: `1px solid ${C.bdr2}`, color: C.mut,
                    }}
                  >
                    <Maximize size={13} />
                  </button>
                </div>
              {renderChart(false)}
              {captionRow}
              {overlay && (
                <div style={{ fontSize: 10, color: C.mut, marginTop: 4, lineHeight: 1.4 }}>
                  {t("history.detailModal.overlayNote")}
                </div>
              )}
            </>
          )}
        </div>

        {/* Stats grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${mobile ? 3 : 4}, 1fr)`,
            gap: 8,
            marginBottom: 14,
          }}
        >
          <StatCell label={t("history.detailModal.dose")} value={shot.doseG !== null ? `${shot.doseG.toFixed(1)} g` : "—"} />
          <StatCell
            label={t("history.detailModal.yield")}
            value={
              // Actual prominent + target muted, side by side: "23.9 / 36 g".
              // The target is shown whenever it exists; a missing actual renders
              // as "—" so the target still appears ("— / 36 g").
              shot.yieldActualG === null && shot.yieldTargetG === null ? (
                "—"
              ) : (
                <>
                  {shot.yieldActualG !== null ? shot.yieldActualG.toFixed(1) : "—"}
                  {shot.yieldTargetG !== null
                    ? <span style={{ color: C.mut, fontWeight: 400 }}>{` / ${fmtG(shot.yieldTargetG)} g`}</span>
                    : " g"}
                </>
              )
            }
          />
          <StatCell label={t("history.detailModal.ratio")} value={ratio} />
          <StatCell label={t("history.detailModal.time")} value={duration} />
          <HoverTip content={t(`history.detailModal.tip.${preinfusionByStage ? "preinfusionStage" : "preinfusionMeasured"}`)}>
            <StatCell label={t("history.detailModal.preinfusion")} value={preinfusionEndS !== null ? `${preinfusionEndS.toFixed(1)} s` : "—"} />
          </HoverTip>
          <StatCell label={t("history.detailModal.avgPressure")} value={agg.avgPressure !== null ? `${agg.avgPressure.toFixed(1)} bar` : "—"} />
          <StatCell label={t("history.detailModal.avgTemp")} value={agg.avgTemp !== null ? `${agg.avgTemp.toFixed(1)} °C` : "—"} />
          <StatCell label={t("history.detailModal.setTemp")} value={shot.profileSetTempC !== null ? `${shot.profileSetTempC.toFixed(1)} °C` : "—"} />
          <StatCell
            label={t("history.detailModal.stopMode")}
            value={stopModeLabel(t, shot.stopMode)}
            valueColor={
              shot.stopMode === "app_failed"
                ? C.red
                : shot.stopMode === "watchdog"
                  ? C.org
                  : undefined
            }
          />
        </div>

        {/* Bean / grinder cards */}
        {(shot.beanId !== null || shot.grinderId !== null) && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: mobile ? "1fr" : "1fr 1fr",
              gap: 8,
              marginBottom: 14,
            }}
          >
            {shot.beanId === null && shot.beanLabel && (
              <InfoCard title={t("history.detailModal.bean")}>
                <div style={{ fontSize: 13, color: C.txt }}>{shot.beanLabel}</div>
                <div style={{ fontSize: 11, color: C.mut, marginTop: 3 }}>
                  {t("history.detailModal.beanExternal")}
                </div>
              </InfoCard>
            )}
            {shot.beanId !== null && (
              <InfoCard title={t("history.detailModal.bean")}>
                <div style={{ fontSize: 13, color: C.txt, fontWeight: 600 }}>
                  {shot.beanName ?? "—"}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                  {shot.beanRoaster && (
                    <span style={{ fontSize: 11, color: C.txtS }}>{shot.beanRoaster}</span>
                  )}
                  {shot.beanBrewType && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: "1px 6px",
                        borderRadius: 9,
                        border: `1px solid ${C.bdr}`,
                        color: C.mut,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {t(`beans.brewType.${shot.beanBrewType}`)}
                    </span>
                  )}
                </div>
              </InfoCard>
            )}
            {shot.grinderId !== null && (
              <InfoCard title={t("history.detailModal.grinder")}>
                <div style={{ fontSize: 13, color: C.txt, fontWeight: 600 }}>
                  {shot.grinderName ?? "—"}
                </div>
                <div style={{ ...MONO, fontSize: 11, color: C.txtS, marginTop: 3 }}>
                  {[
                    shot.grindSetting !== null ? String(shot.grindSetting) : null,
                    shot.grinderRpm !== null ? `${shot.grinderRpm} RPM` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </div>
              </InfoCard>
            )}
          </div>
        )}

        {/* Rating card — own module, flush with the bean/grinder cards */}
        <div
          style={{
            background: C.bg,
            border: `1px solid ${C.bdr}`,
            borderRadius: 8,
            padding: "12px 14px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginBottom: hasNotes ? 12 : 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: isRated ? 7 : 3 }}>
            <div style={{ fontSize: 11, color: C.mut, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {t("shotRating.title")}
            </div>

            {isRated ? (
              <>
                {rv.rating !== null && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <RatingDots rating={rv.rating} size={9} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: C.acc }}>
                      {t(`shotRating.noteWords.${rv.rating}`)}
                    </span>
                  </div>
                )}
                {marks.map((m) => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: m.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: C.txtS }}>{m.label}</span>
                  </div>
                ))}
                {(rv.acidity !== null || rv.bitterness !== null) && (
                  <div style={{ ...MONO, fontSize: 12, color: C.mut }}>
                    {[
                      rv.acidity !== null ? `${t("shotRating.acidity")} ${rv.acidity}/5` : null,
                      rv.bitterness !== null ? `${t("shotRating.bitterness")} ${rv.bitterness}/5` : null,
                    ].filter(Boolean).join("  ·  ")}
                  </div>
                )}
                {rv.grindNote !== null && (
                  <div style={{ fontSize: 12, color: rv.grindNote === "ok" ? C.grn : C.txtS }}>
                    {t("shotRating.grind")}: {t(grindLabelKey)}
                  </div>
                )}
                {rv.vsPrev !== null && (
                  <div style={{ fontSize: 12, color: rv.vsPrev === "better" ? C.grn : rv.vsPrev === "worse" ? C.org : C.txtS }}>
                    {t("shotRating.vsPrev.detail")}: {t(`shotRating.vsPrev.${rv.vsPrev}`)}
                  </div>
                )}
                {rv.tasteTags.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 1 }}>
                    {rv.tasteTags.map((tg) => (
                      <span
                        key={tg}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: C.acc,
                          background: C.accG,
                          border: `1px solid ${C.accB}`,
                          borderRadius: 10,
                          padding: "1px 8px",
                        }}
                      >
                        {t(`shotRating.tags.${tg}`)}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12, color: C.mut }}>{t("shotRating.notRated")}</div>
            )}
          </div>

          {/* Secondary edit/rate button — inside the module, vertically centered */}
          <button
            onClick={() => { setRatingOpen(true); }}
            onMouseEnter={() => { setEditHover(true); }}
            onMouseLeave={() => { setEditHover(false); }}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: `1px solid ${editHover ? C.acc : C.bdr2}`,
              color: editHover ? C.acc : C.txtS,
              borderRadius: 8,
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
              transition: "border-color 0.12s, color 0.12s",
            }}
          >
            <Pencil size={13} />
            {isRated ? t("shotRating.edit") : t("shotRating.rate")}
          </button>
        </div>

        {/* Notes (separate) */}
        {hasNotes && (
          <div
            style={{
              background: C.bg,
              border: `1px solid ${C.bdr}`,
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 12,
              color: C.txtS,
              whiteSpace: "pre-wrap",
            }}
          >
            {shot.notes}
          </div>
        )}
      </div>
    </div>

    {/* Fullscreen chart. z 150: above the modal (100), still below the
          machine-error line (200) — an error must never end up hidden. */}
      {fullscreen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: C.bg,
            zIndex: 150,
            display: "flex",
            flexDirection: "column",
            padding: `calc(10px + ${C.safeTop}) 14px 14px`,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.txt }}>{shot.profileName}</span>
            <span style={{ ...MONO, fontSize: 12, color: C.acc }}>{sizeLabel}</span>
            <span style={{ fontSize: 11, color: C.mut, flex: 1 }}>
              {formatDateTime(shot.startedAt, locale)}
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", alignSelf: "center" }}>{toggles}</div>
            <button
              onClick={() => { setFullscreen(false); }}
              title={t("history.detailModal.fullscreenExit")}
              style={{ ...iconBtn, color: C.txtS }}
            >
              <Minimize size={18} />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>{renderChart(true)}</div>
          {captionRow}
        </div>
      )}

    {ratingOpen && (
      <RatingModal
        shotId={shot.id}
        initial={rv}
        headerLabel={sizeLabel}
        facts={ratingFacts(shot, shot.profileName, sizeLabel)}
        mobile={mobile}
        cancelLabel={t("shotRating.cancel")}
        onSave={async (v) => { await onUpdate(ratingValuesToPatch(v)); setRv(v); }}
        onClose={() => { setRatingOpen(false); }}
      />
    )}
    </>
  );
}

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: C.mut,
  display: "flex",
  padding: 2,
  flexShrink: 0,
};
