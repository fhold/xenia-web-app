/**
 * FlowHoldDriver — app-side "Consistent-Flow" espresso drive (Phase 1).
 *
 * Drives a shot entirely from the app via the paddle API instead of running a
 * Xenia script: it commands pump power (POST /api/v2/paddle/pumppower) and a PI
 * loop regulates the scale-derived flow (g/s) toward a target. The machine reports
 * MA_STATUS=5 throughout. The ShotRecorder records the shot in driveMode (started
 * on MA=5, BBW trigger/watchdog suppressed) — this driver owns the stop.
 *
 * Lifecycle (frame-driven — one control tick per poller 'frame'):
 *   idle → hold:     start() arms the recorder and enters step 0 directly. There
 *                    is no dedicated ramp phase — pre-infusion is an explicit
 *                    PowerStep, and a flow/pressure step can ease in via rampMs
 *                    (linear setpoint interpolation from entry value to target).
 *   hold:            per-step control (flow/pressure PI loop or open-loop power);
 *                    BBW-style projection on weight decides the normal stop.
 *   hold → stopping: normal exit — paddle/stop (pump running) → pumppower=0 → SB
 *                    cleanup. Per Block-1 diagnosis paddle/stop drains internally.
 *   stopping → done: the machine leaves paddle (MA≠5). The recorder finalizes.
 *
 * Safety:
 *   - Watchdog (parity with the BBW watchdog, evaluateWatchdog): overshoot or a
 *     stuck stop-lag → HARD stop (machine/control action 0), stop_mode
 *     'flowhold_watchdog'.
 *   - Last-resort pump-runtime ceiling (maxBrewMs) → hard stop, aligned to the
 *     pump firmware ~120 s DAUERbetrieb cutoff; pump-off (bloom) time does not
 *     count against it. Redundant backstop for a dead scale (flow/weight
 *     never advancing → neither the normal stop nor overshoot ever fires); it
 *     fires only after the hardware would already have cut the pump.
 *
 * Every pump write is a real brew command (boiler/valve/pump) — see
 * project_xenia_drive_api_findings + feedback_machine_writes_not_harmless.
 */

import type {
  LiveFrame,
  StopMode,
  FlowHoldOverrides,
  BrewStep,
  StepExit,
  FlowControllerKind,
  DriveStage,
} from "../../../shared/src/types.js";
import { PIController } from "../../../shared/src/pi-controller.js";
import { AdaptiveController } from "../../../shared/src/adaptive-flow-controller.js";
import type { FlowController } from "../../../shared/src/flow-controller.js";
import { BrewByWeightController } from "../../../shared/src/brew-by-weight.js";
import { endsWithoutYield, validateBrewSteps } from "../../../shared/src/brew-steps.js";
import {
  DEFAULT_PUMP_CURVE,
  parsePumpCurve,
  preinfusionArrivalGs,
  preinfusionPower,
  pressureRampFeedForward,
  type PumpCurve,
} from "../../../shared/src/pump-curve.js";
import {
  evaluateWatchdog,
  WATCHDOG_REFIRE_INTERVAL_MS,
  WATCHDOG_ESCALATE_AFTER_MS,
  WATCHDOG_GRACE_MS,
  type WatchdogConfig,
} from "../../../shared/src/brew-watchdog.js";
import { plausibleScaleWeight } from "../../../shared/src/scale-plausibility.js";
import {
  trackScaleStall,
  initialScaleStallState,
  type ScaleStallState,
} from "../../../shared/src/scale-stall.js";
import type { XeniaClient } from "./client.js";
import type { ShotRecorder } from "../shots/recorder.js";
import type { ShotStageInput, StageTransition } from "../db/shot-repo.js";
import type { SettingsRepo } from "../db/settings-repo.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FlowHoldConfig {
  /** Target scale-flow to hold (g/s). */
  targetFlowGs: number;
  /** Yield target (g) — resolved from the profile/override before start. null =
   *  kein Ziel: keine Waagen-Abschaltung, die letzte Stufe beendet den Bezug ueber
   *  ihre Ausstiege (Decent-Profil ohne Zielgewicht). */
  yieldTargetG: number | null;
  /** Output floor (%) — dead-zone / minimum pump power that still pumps. */
  powerFloor: number;
  /** Output ceiling (%). */
  powerCeil: number;
  /** Initial open-loop pump power (%) used to seed the flow/pressure controller of
   *  step 0 (and the bumpless seed baseline for later stage hand-offs). */
  rampStartPower: number;
  /** Which controller regulates the pump: adaptive plant-inversion (Phase B,
   *  default) or the fixed-gain PI (Phase A fallback). */
  controller: FlowControllerKind;
  /** PI proportional gain (used when controller = 'pi'). */
  kp: number;
  /** PI integral gain (used when controller = 'pi'). */
  ki: number;
  /** Adaptive (Phase B) gains — see AdaptiveControllerConfig. */
  betaC: number;
  cMin: number;
  kpTrim: number;
  kiTrim: number;
  /** Adaptive derivative-on-measurement gain — damps setpoint-down overshoot. */
  kdTrim: number;
  minFlowForEst: number;
  estPowerMargin: number;
  /** EMA smoothing factor for the flow measurement (0..1). */
  emaAlpha: number;
  /** Asymmetric output slew limit (pump-% per second): max rate the PI may raise
   *  power (`slewUpPerS`) vs lower it (`slewDownPerS`). Tight-up/loose-down =
   *  anti-gush for soft pucks. undefined leaves that direction unlimited. */
  slewUpPerS?: number;
  slewDownPerS?: number;
  /** BBW-style projection window (ms) for the normal-stop decision. */
  bbwWindowMs: number;
  /** BBW-style residual lag (s) — stop lead time for the normal-stop projection. */
  bbwResidualLagS: number;
  /** Last-resort ceiling on accumulated pump-ON time (ms) → hard stop (paddle
   *  FW-limit analogue: the machine caps continuous pump run, not brew length). */
  maxBrewMs: number;
  /** Warm-up precondition: min brew-boiler temp (°C) at start, or null to skip. */
  warmupMinBrewBoilerC: number | null;
  /** Adaptive: Ĉ aus Fluss und der Leistung von vor dieser Zeit lernen (ms) —
   *  siehe AdaptiveControllerConfig.learnDelayMs. */
  learnDelayMs: number;
}

/** One built-in Consistent-Flow config. yieldTargetG is filled in per drive.
 *  kp/ki/rampStartPower are conservative starting points — tuned live in Block 4. */
export const DEFAULT_FLOW_HOLD_CONFIG: Omit<FlowHoldConfig, "yieldTargetG"> = {
  targetFlowGs: 2.0,
  powerFloor: 15,
  powerCeil: 100,
  rampStartPower: 52,
  controller: "adaptive",
  kp: 4.0,
  ki: 2.0,
  betaC: 0.2,
  cMin: 0.004,
  kpTrim: 1.5,
  kiTrim: 0.4,
  // Derivative damping (Phase C): brakes the pump when flow is rising, so a
  // setpoint-down transition (e.g. 1.0→0.7 g/s) settles instead of ringing.
  // Tuned in scripts/swing-sim.ts against a laggy-plant limit cycle.
  kdTrim: 10,
  minFlowForEst: 0.15,
  estPowerMargin: 2,
  // Input is the scale's already-smoothed rate channel (PU_SENS_SCALE_RATE), so
  // a heavy EMA here is double-smoothing = pure added lag. 0.5 trusts the clean
  // input more and roughly halves the controller-side lag. Tune live if unstable.
  emaAlpha: 0.5,
  // Anti-gush is now handled by the derivative brake (kdTrim), so the up-slew no
  // longer has to be starved to 8%/s — that starvation was what fed the recovery
  // half of the limit cycle. A moderate symmetric-ish up-rate lets the loop catch
  // an undershoot before it overshoots. Down-slew stays fast (safety cut).
  slewUpPerS: 20,
  slewDownPerS: 40,
  bbwWindowMs: 1_000,
  bbwResidualLagS: 1.0,
  maxBrewMs: 120_000,
  warmupMinBrewBoilerC: null,
  // Gemessen an #255/#256: Tassenfluss zeigt die Leistung von vor ~1–1,5 s.
  learnDelayMs: 1500,
};

// ---------------------------------------------------------------------------
// Plausibility (mirrors the recorder's heuristic — one consumer of the frame,
// not a second measuring path). Real espresso flow tops out ~5 g/s.
// ---------------------------------------------------------------------------

const MAX_PLAUSIBLE_FLOW_G_PER_S = 15;
/** „Fluss uebernehmen“ mittelt den Tassenfluss ueber dieses Fenster (ms) — die
 *  Waage rauscht einzeln um ±0,1 g/s, das Mittel von ~3 Takten nicht. */
const ADOPT_WINDOW_MS = 1_000;
/** Max scale reading (g) that still counts as "zeroed" at drive start. Above
 *  this the scale carries a residual/un-tared value — drive mode has no machine
 *  tare, so we refuse to start rather than feed the loop a false weight. */
const SCALE_ZERO_TOL_G = 3;
/** Only re-command the pump when the target power moved at least this much (%). */
const POWER_SEND_EPS = 1;
/** Nachsenden: Die Maschine bestaetigt einen Pumpenbefehl gelegentlich, ohne ihn
 *  zu uebernehmen (#271 25→20 %, #272 60→45 %). Weicht die gemeldete Leistung
 *  (PU_LEVEL_PW_CONTROL) so lange nach dem letzten Befehl noch mehr als so viele
 *  Punkte ab, geht derselbe Wert noch einmal raus — hoechstens so oft je Befehl.
 *  Die Leistung folgt dem Befehl sonst nach ~0,6 s (#254). */
const RESEND_DEVIATION_PCT = 2;
const RESEND_AFTER_MS = 1_500;
const RESEND_MAX = 3;

/** Pressure-step PI gains (power% per bar). Conservative starting points — pressure
 *  responds much faster than flow, so lower gains than the flow loop. Tuned live. */
const PRESSURE_KP = 6;
const PRESSURE_KI = 2;
/** Limiter back-off: when a step's cap (maxPressureBar / maxFlowGs) is exceeded,
 *  bleed the commanded power down by this much per tick toward the floor until the
 *  capped quantity falls back under its limit. Actively relieves an over-cap. */
const LIMITER_BACKOFF_PCT = 3;

/** After a normal exit the MA 5→1 transition re-activates steam mode
 *  (SB_STATUS→2) ~14 s later (Block-1 SB bug), after the immediate sbCleanup()
 *  already saw SB=1. Watch the frame stream this long and put steam back to the
 *  state it had before the drive (steamBefore). */
const SB_WATCH_WINDOW_MS = 30_000;

/** Min gap between repeated steam corrections (action 3/4) inside the watch window.
 *  A single action 3 loses a race with the MA 5→1 re-activation (verified live,
 *  Block-4 4a-SB): steam flips back on right after. Re-fire throttled until the
 *  window closes so the delayed/racing re-activation is caught. */
const SB_OFF_REFIRE_MS = 3_000;

export type DrivePhase = "idle" | "hold" | "stopping" | "sb_watch" | "done";

export interface DriveArmArgs {
  profileId: number;
  /** "test" = Messlauf (aufgezeichnet, zaehlt nirgends); fehlt = Bezug. */
  category?: "brew" | "test";
  /** Schnitt 3d: gelaufene Variante und benutztes Sieb (fuer die Aufzeichnung). */
  variantId?: number | null;
  basketId?: number | null;
  profileName: string | null;
  /** null for app-driven step-based brews (Cut-2). */
  scriptId: number | null;
  shotSize: "single" | "double";
  beanId: number | null;
  beanLabel?: string | null;
  grinderId: number | null;
  grindSetting: number | null;
  grinderRpm: number | null;
  doseG: number | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class FlowHoldDriver {
  private phase: DrivePhase = "idle";
  private cfg: FlowHoldConfig | null = null;

  private startedAt = 0;
  private lastTickAt = 0;
  /** Accumulated pump-ON time — the quantity `maxBrewMs` caps. */
  private pumpOnMs = 0;

  private controller: FlowController | null = null;
  private pressureController: PIController | null = null;
  /** Solldruck des letzten Takts — fuer die Vorsteuerung einer fallenden Rampe. */
  private lastPressureSoll: number | null = null;
  private bbw: BrewByWeightController | null = null;

  // Resolved step sequence + stage-machine bookkeeping. Steps run in one paddle
  // session (flow/pressure/power setpoints); the last step is terminated by the
  // BBW yield stop, earlier steps advance on their exit condition.
  private steps: BrewStep[] = [];
  private stageIndex = 0;
  private stageStartAt = 0;

  // Soll-Kurve History: one record per stage the drive actually ENTERED (stage 0
  // at start, then each advance). exitReason is filled in on the record we LEAVE
  // when advancing; the final stage keeps exitReason null (ended by the yield/
  // manual/watchdog stop). Pushed to the recorder on every change; persisted to
  // shot_stage at finalize.
  private stageTransitions: StageTransition[] = [];

  // Per-step setpoint ramp (flow/pressure rampMs): the active setpoint
  // interpolates linearly from `stageRampFrom` to `stageTarget` over
  // `stageRampMs`, then holds. Flow and pressure ramps start at the value
  // MEASURED in the last tick (bumpless after any step kind; step 0 starts
  // before the first tick, i.e. from 0); a power ramp starts at
  // lastPowerTarget, which begins at 0 so step 0 ramps up from zero.
  private stageRampFrom = 0;
  private stageTarget = 0;
  private stageRampMs = 0;
  private lastFlowTarget = 0;
  private lastPowerTarget = 0;

  private lastPlausibleWeightG: number | null = null;
  private scaleStall: ScaleStallState = initialScaleStallState();
  private lastPlausibleFlowGs = 0;
  /** Druck des letzten Takts — Startpunkt einer Druckrampe. */
  private lastPressureBar = 0;
  /** Plausibler Tassenfluss der letzten ~1 s — „Fluss uebernehmen“ mittelt darueber. */
  private recentFlow: { at: number; gs: number }[] = [];
  private lastSentPower: number | null = null;
  /** Nachsenden: wann der zuletzt bestaetigte Pumpenbefehl rausging, wann zuletzt
   *  nachgesendet wurde, wie oft schon fuer diesen Befehl, ob das Scheitern schon
   *  gemeldet ist und ob der wartende Wert ein Nachsenden ist. */
  private lastSentAt = 0;
  private lastResendAt = 0;
  private resendCount = 0;
  private resendWarned = false;
  private resendQueued = false;

  // K-2: serialized single-writer actuator pipeline. Loop pump writes coalesce to
  // the newest setpoint (at most one in flight); a stop locks the pipeline and
  // settles the in-flight write BEFORE the stop sequence, so a stale pumppower can
  // never overtake action 0/1. lastSentPower advances only on a confirmed ACK.
  private desiredPower: number | null = null;
  /** Pumpenkennlinie fuer die Preinfusion (rechnerischer Zulauf), je Bezug gelesen. */
  private pumpCurve: PumpCurve = DEFAULT_PUMP_CURVE;
  /** When the pending desiredPower was first requested — measures how long a
   *  correction waits behind the in-flight write (logged per pump write). */
  private desiredSince: number | null = null;
  private writeInFlight = false;
  private writeTail: Promise<void> = Promise.resolve();
  private actuatorLocked = false;
  // K-1: refuse new drive starts once the process is shutting down.
  private startsBlocked = false;

  // Normal-stop / watchdog bookkeeping.
  private stopRequested = false;
  private stopSentAt: number | null = null;
  private watchdogFiredAt: number | null = null;
  private watchdogLastRefireAt: number | null = null;
  private hardStopped = false;

  // Post-exit SB watch (Block-1 delayed steam re-activation).
  private sbWatchUntil = 0;
  private sbLastOffSentAt = Number.NEGATIVE_INFINITY;
  private sbLastSeen = -1;
  /** Dampf-Zustand vor dem Bezug (1 = aus, 2 = an, null = unbekannt). Nach dem
   *  Bezug wird genau dieser Zustand wiederhergestellt — vorher nahm die
   *  Bereinigung "aus" an und schaltete einen bewusst eingeschalteten Dampf
   *  fuer den Milchschaum mit ab. */
  private steamBefore: 1 | 2 | null = null;

  private shotLog: Logger | null = null;

  /** Jeder Stufenwechsel (auch Stufe 0) — index.ts reicht ihn an die Clients weiter. */
  onStage: ((stage: DriveStage) => void) | null = null;

  constructor(
    private readonly client: XeniaClient,
    private readonly recorder: ShotRecorder,
    private readonly settingsRepo: SettingsRepo,
    private readonly logger: Logger,
  ) {}

  /** True while a drive is running (hold/stopping) — gates the start route
   *  and drives brew-rate polling (poller shouldExtendBrewRate). */
  isActive(): boolean {
    return this.phase === "hold" || this.phase === "stopping";
  }

  /**
   * Start a Consistent-Flow drive. Validates the warm-up precondition, arms the
   * recorder in driveMode, then enters step 0 and sends its initial pump power
   * (a PowerStep's power, or the controller seed for a flow/pressure step 0).
   * Throws (without arming persisting) if a precondition fails or the first pump
   * write fails.
   */
  async start(
    overrides: FlowHoldOverrides | undefined,
    yieldTargetG: number | null,
    arm: DriveArmArgs,
    lastFrame: LiveFrame | null,
  ): Promise<FlowHoldConfig> {
    if (this.startsBlocked) {
      throw new Error("Server is shutting down — flow-hold drive start refused");
    }
    if (this.isActive()) {
      throw new Error("A flow-hold drive is already running");
    }

    const cfg: FlowHoldConfig = {
      ...DEFAULT_FLOW_HOLD_CONFIG,
      ...(overrides ?? {}),
      yieldTargetG,
    };

    // Warm-up precondition (optional): refuse to drive a cold brew boiler.
    if (
      cfg.warmupMinBrewBoilerC !== null &&
      lastFrame !== null &&
      lastFrame.brewBoilerTempC < cfg.warmupMinBrewBoilerC
    ) {
      throw new Error(
        `Brew boiler too cold: ${lastFrame.brewBoilerTempC.toFixed(1)}°C < ` +
          `${cfg.warmupMinBrewBoilerC}°C — warm up before a flow-hold drive`,
      );
    }

    // Scale-zero precondition (point 3): the scale must be tared before a drive.
    // Drive mode has no machine tare, so a residual/un-tared reading would feed
    // the flow loop and the BBW stop a false weight (root cause of shot #117:
    // 32.8 g residual → instant stop). Refuse to start until the scale reads ~0.
    if (
      lastFrame !== null &&
      lastFrame.scaleWeightG !== null &&
      Math.abs(lastFrame.scaleWeightG) > SCALE_ZERO_TOL_G
    ) {
      throw new Error(
        `Waage nicht genullt (${lastFrame.scaleWeightG.toFixed(1)} g) — ` +
          `bitte vor dem Flow-Bezug tarieren.`,
      );
    }

    // Resolve + validate the step sequence (from the profile's BrewProfile)
    // BEFORE mutating any driver state, so an unsupported profile throws cleanly
    // without leaving the driver half-armed or reporting active.
    const steps = this.resolveSteps(overrides?.steps, cfg.targetFlowGs, yieldTargetG);
    // Controller kind + initial flow setpoint come from the first flow step (a
    // sequence may lead with a pressure/power step, which has no flow target).
    const firstFlow = steps.find((s) => s.kind === "flow");
    if (firstFlow && firstFlow.kind === "flow") cfg.targetFlowGs = firstFlow.targetFlowGs;
    const controllerKind: FlowControllerKind =
      (firstFlow && firstFlow.kind === "flow" && firstFlow.controller) || cfg.controller;

    this.cfg = cfg;
    this.resetState();
    this.pumpCurve = parsePumpCurve(this.settingsRepo.get("pump_curve"));
    const sb = lastFrame?.steamBoilerStatus;
    this.steamBefore = sb === 1 || sb === 2 ? sb : null;
    this.startedAt = Date.now();
    this.lastTickAt = this.startedAt;
    this.phase = "hold";
    this.shotLog = this.logger.child({ tag: "flowhold" });

    this.steps = steps;
    this.stageIndex = 0;
    this.stageStartAt = this.startedAt;
    this.controller = this.makeController(controllerKind, cfg);
    this.pressureController = new PIController({
      kp: PRESSURE_KP,
      ki: PRESSURE_KI,
      setpoint: 0, // set on entry to a pressure step
      outMin: cfg.powerFloor,
      outMax: cfg.powerCeil,
      emaAlpha: cfg.emaAlpha,
      slewUpPerS: cfg.slewUpPerS,
      slewDownPerS: cfg.slewDownPerS,
    });
    this.bbw = cfg.yieldTargetG !== null ? new BrewByWeightController(cfg.yieldTargetG, cfg.bbwWindowMs, cfg.bbwResidualLagS) : null;

    // Enter step 0 directly — no ramp phase. enterStage seeds the controller and
    // records the ramp bookkeeping; it performs no machine write. The first pump
    // write below is a PowerStep's power, or the controller seed for flow/pressure.
    this.enterStage(this.steps[0], cfg.rampStartPower);
    const step0 = this.steps[0];
    // A power step 0 commands its (possibly ramped) setpoint at t=0; a
    // preinfusion starts from 0 (soft start); a flow/pressure step 0 is primed
    // with the open-loop controller seed.
    const initialPower =
      step0.kind === "power" ? this.rampedSetpoint(this.startedAt)
        : step0.kind === "preinfusion" ? 0
          : cfg.rampStartPower;

    // Arm the recorder BEFORE the first pump write, so the first MA=5 frame is
    // captured as the shot start (mirrors the execute route ordering).
    this.recorder.armForDrive({
      profileId: arm.profileId,
      variantId: arm.variantId ?? null,
      basketId: arm.basketId ?? null,
      profileName: arm.profileName,
      scriptId: arm.scriptId,
      shotSize: arm.shotSize,
      category: arm.category ?? "brew",
      hasPumpAction: true,
      hasCmd27: false,
      cmd27Value: null,
      yieldTargetG: cfg.yieldTargetG,
      beanId: arm.beanId,
      beanLabel: arm.beanLabel ?? null,
      grinderId: arm.grinderId,
      grindSetting: arm.grindSetting,
      grinderRpm: arm.grinderRpm,
      doseG: arm.doseG,
      notes: arm.notes,
      brewSteps: { version: 1, steps: this.steps },
    });

    // Record stage 0 (must run after armForDrive: setDriveStages needs driveMode).
    this.recordStageEntry(this.steps[0], 0, this.startedAt);

    this.shotLog.info(
      {
        event: "start",
        controller: controllerKind,
        target_flow_gs: cfg.targetFlowGs,
        step_count: steps.length,
        yield_target_g: cfg.yieldTargetG,
        initial_power: initialPower,
      },
      `Flow-hold start — ${controllerKind}, target=${cfg.targetFlowGs}g/s, ` +
        `steps=${steps.length}, yield=${cfg.yieldTargetG ?? "– (endet mit der letzten Stufe)"}g, initial=${initialPower}%`,
    );

    try {
      await this.commandPower(initialPower);
    } catch (err) {
      // First write failed → abandon the drive cleanly so nothing is left armed.
      this.shotLog.error(
        { event: "start_failed", err_msg: err instanceof Error ? err.message : String(err) },
        `Flow-hold start failed on first pump write — aborting`,
      );
      this.phase = "done";
      // Best-effort: make sure the pump is off and the drive-arm is dropped.
      await this.safeStop();
      this.recorder.setDriveStopMode("flowhold_watchdog");
      throw err;
    }

    return cfg;
  }

  /** Main control tick — called for every poller 'frame'. */
  onFrame(frame: LiveFrame): void {
    if (this.cfg === null || this.phase === "idle" || this.phase === "done") return;

    const now = Date.now();

    // Post-exit SB watch runs off the frame stream, past the brew ceiling below.
    if (this.phase === "sb_watch") {
      this.tickSbWatch(frame, now);
      return;
    }

    const elapsed = now - this.startedAt;

    // Watch for a mid-brew scale dropout: while the scale is mute the cup keeps
    // filling, so the reading it returns with is no plausible successor to the
    // one before. Rebase on that frame instead of latching the stale value —
    // otherwise the weight stop never arms again (#177).
    const wasStalled = this.scaleStall.stalled;
    this.scaleStall = trackScaleStall(
      {
        now,
        weightG: frame.scaleWeightG,
        flowGs: frame.flowRateGPerS,
        pumpPwm: frame.pumpPwm ?? null,
        pressureBar: frame.pumpPressureBar,
      },
      this.scaleStall,
    );
    const weight = this.plausibleWeight(
      frame.scaleWeightG,
      elapsed,
      wasStalled && !this.scaleStall.stalled,
    );

    // The ceiling stands in for the machine's pump limit (120 s DAUERbetrieb), so
    // it counts pumping time, not wall-clock: a bloom step with the pump at 0 is
    // harmless and must not use it up. Unknown power (no ACK yet) counts as
    // running — the safety net may over-count, never under-count.
    if (this.lastSentPower === null || this.lastSentPower > 0) {
      this.pumpOnMs += now - this.lastTickAt;
    }

    // Last-resort absolute ceiling — paddle has no firmware pump limit.
    if (this.pumpOnMs > this.cfg.maxBrewMs) {
      this.hardStop("max_brew_ms", now);
      this.lastTickAt = now;
      return;
    }

    switch (this.phase) {
      case "hold":
        this.tickHold(frame, weight, now, elapsed);
        break;
      case "stopping":
        this.tickStopping(frame, now, elapsed);
        break;
    }
    this.lastTickAt = now;
  }

  // --- Phase ticks --------------------------------------------------------

  private tickHold(frame: LiveFrame, weight: number | null, now: number, elapsed: number): void {
    const cfg = this.cfg!;
    const dtMs = now - this.lastTickAt;
    const flow = this.plausibleFlow(frame.flowRateGPerS);
    // Vor dem Stufenwechsel: eine Druckrampe oder ein uebernommener Fluss soll
    // diesen Takt schon sehen.
    this.lastPressureBar = frame.pumpPressureBar;
    this.recentFlow.push({ at: now, gs: flow });
    while (this.recentFlow.length && this.recentFlow[0]!.at < now - ADOPT_WINDOW_MS) this.recentFlow.shift();

    // Staged setpoint: advance to the next step when this step's exit is met.
    this.maybeAdvanceStage(frame, weight, now);
    // Ohne Ziel kann die letzte Stufe den Bezug eben beendet haben — dann keine Pumpe mehr.
    if (this.stopRequested) return;

    const active = this.steps[this.stageIndex];
    const power = this.computeStepPower(active, frame, flow, dtMs, now);
    this.enqueuePower(power);
    this.checkPumpReadback(frame, now);

    // Normal stop — BBW-style projection on the plausible weight. Suppressed
    // during the start grace (same window the recorder's primary stop uses,
    // recorder.ts): the scale can report a residual/un-tared value in the first
    // seconds, and drive mode has no machine tare — feeding that to BBW would
    // fire an instant false stop (shot #117). BBW is only fed post-grace, so it
    // projects from real extraction weight, exactly like the script path.
    if (this.bbw !== null && !this.stopRequested && weight !== null && elapsed >= WATCHDOG_GRACE_MS) {
      const res = this.bbw.addSample(now, weight);
      if (res.shouldStop) {
        this.shotLog?.info(
          {
            event: "normal_stop_triggered",
            weight_g: res.telemetry.currentWeightG,
            projected_g: res.telemetry.projectedWeightG,
            slope_g_per_s: res.telemetry.slopeGPerS,
          },
          `Normal stop — weight=${res.telemetry.currentWeightG.toFixed(2)}g ` +
            `projected=${res.telemetry.projectedWeightG.toFixed(2)}g`,
        );
        this.beginNormalStop(now, "flowhold");
        return;
      }
    }

    this.checkWatchdog(frame, weight, now, elapsed);
  }

  private tickStopping(frame: LiveFrame, now: number, elapsed: number): void {
    // The normal exit has been issued. If the machine has left paddle mode the
    // exit took effect → done (the recorder finalizes on MA≠5). Otherwise keep
    // the watchdog armed so a stuck stop-lag escalates to the hard stop.
    if (frame.machineStatus !== 5) {
      this.enterSbWatch(now, frame.machineStatus);
      return;
    }
    this.checkWatchdog(frame, this.lastPlausibleWeightG, now, elapsed);
  }

  // --- Steps + controller -------------------------------------------------

  /**
   * Resolve + validate the step sequence for this drive. With no profile steps it
   * falls back to a single implicit flow step at the flat targetFlowGs (until
   * yield) — today's behaviour. Every step runs in the one paddle session; the
   * last step is terminated by the BBW yield stop, so it needs no explicit exit.
   * Throws on any malformed step so a bad profile never starts a live brew.
   */
  private resolveSteps(
    raw: BrewStep[] | undefined,
    flatFlowGs: number,
    yieldG: number | null,
  ): BrewStep[] {
    if (!raw || raw.length === 0) {
      if (yieldG === null) throw new Error("Ohne Ziel braucht der Bezug Stufen, deren letzte einen Ausstieg hat.");
      return [{ kind: "flow", targetFlowGs: flatFlowGs, exit: { weightG: yieldG } }];
    }
    // The same rule the profile API applies on save. A sequence stored before
    // that check existed is still caught here, at the last gate before the pump.
    const check = validateBrewSteps(raw);
    if (!check.ok) throw new Error(check.error);
    // Ohne Ziel ist die letzte Stufe das Ende — ohne Ausstieg liefe die Pumpe bis zur Grenze.
    if (yieldG === null && !endsWithoutYield(raw)) {
      throw new Error("Ohne Ziel braucht die letzte Stufe einen Ausstieg (Zeit, Gewicht, Druck oder Fluss).");
    }
    return raw;
  }

  private makeController(kind: FlowControllerKind, cfg: FlowHoldConfig): FlowController {
    if (kind === "pi") {
      return new PIController({
        kp: cfg.kp,
        ki: cfg.ki,
        setpoint: cfg.targetFlowGs,
        outMin: cfg.powerFloor,
        outMax: cfg.powerCeil,
        emaAlpha: cfg.emaAlpha,
        slewUpPerS: cfg.slewUpPerS,
        slewDownPerS: cfg.slewDownPerS,
      });
    }
    return new AdaptiveController({
      setpoint: cfg.targetFlowGs,
      outMin: cfg.powerFloor,
      outMax: cfg.powerCeil,
      emaAlpha: cfg.emaAlpha,
      betaC: cfg.betaC,
      cMin: cfg.cMin,
      kpTrim: cfg.kpTrim,
      kiTrim: cfg.kiTrim,
      kdTrim: cfg.kdTrim,
      slewUpPerS: cfg.slewUpPerS,
      slewDownPerS: cfg.slewDownPerS,
      minFlowForEst: cfg.minFlowForEst,
      estPowerMargin: cfg.estPowerMargin,
      learnDelayMs: cfg.learnDelayMs,
    });
  }

  /**
   * Advance the stage machine: when the current step's exit is met (first of
   * seconds-in-step / weightG / pressureBar / flowGs), enter the next step and
   * seed its controller bumplessly from the last commanded power. The last step
   * is left to the BBW yield stop, so it is never advanced past.
   */
  private maybeAdvanceStage(frame: LiveFrame, weight: number | null, now: number): void {
    if (this.stageIndex >= this.steps.length - 1) {
      // Ohne Ziel beendet die letzte Stufe den Bezug ueber ihre Ausstiege (wie
      // bei der Decent ein Profil ohne Zielgewicht). Mit Ziel stoppt die Waage.
      if (this.cfg!.yieldTargetG === null && !this.stopRequested) {
        const last = this.steps[this.stageIndex]!;
        const end = this.stepExitMet(last.exit, now - this.stageStartAt, weight, frame.pumpPressureBar, this.lastPlausibleFlowGs);
        if (end !== null) {
          const leaving = this.stageTransitions[this.stageTransitions.length - 1];
          if (leaving) leaving.exitReason = this.exitReasonField(end);
          this.recorder.setDriveStages(this.stageTransitions);
          this.shotLog?.info(
            { event: "profile_end_stop", stage_index: this.stageIndex, by: end, weight_g: weight, elapsed_ms: now - this.startedAt },
            `Profile end — last stage exit (${end}), no yield target`,
          );
          this.beginNormalStop(now, "flowhold");
        }
      }
      return;
    }
    const step = this.steps[this.stageIndex];
    const flow = this.lastPlausibleFlowGs;
    // Preinfusion: fertig, sobald der Kaffee in der Tasse ankommt — die naechste
    // Flussstufe uebernimmt dann am Arbeitspunkt. Die Ausstiege sind ihr Netz.
    const arrivalGs = step.kind === "preinfusion" ? preinfusionArrivalGs(this.steps[this.stageIndex + 1]) : null;
    const by = arrivalGs !== null && flow >= arrivalGs
      ? "arrived"
      : this.stepExitMet(step.exit, now - this.stageStartAt, weight, frame.pumpPressureBar, flow);
    if (by === null) return;

    // Record why we LEFT the current stage before advancing off it.
    const leaving = this.stageTransitions[this.stageTransitions.length - 1];
    if (leaving) leaving.exitReason = this.exitReasonField(by);

    this.stageIndex++;
    this.stageStartAt = now;
    this.declineArmed = false;
    const next = this.steps[this.stageIndex];
    this.enterStage(next, this.lastSentPower ?? this.cfg!.rampStartPower);
    this.recordStageEntry(next, this.stageIndex, now);
    this.shotLog?.info(
      {
        event: "stage_advance",
        stage_index: this.stageIndex,
        step_kind: next.kind,
        by,
        elapsed_ms: now - this.startedAt,
      },
      `Stage → ${this.stageIndex} (${next.kind}, by ${by})`,
    );
  }

  /** Append a stage record for an entered step (exitReason filled later, on the
   *  advance that leaves it) and push the full list to the recorder. */
  private recordStageEntry(step: BrewStep, index: number, enteredAt: number): void {
    this.stageTransitions.push({
      stageIndex: index,
      // shot_stage kennt nur flow/pressure/power — die Preinfusion zaehlt als
      // Leistungsstufe; was sie war, steht im Profil-Schnappschuss des Bezugs.
      stepKind: step.kind === "preinfusion" ? "power" : step.kind,
      // Bei „Fluss uebernehmen“ der uebernommene Wert, nicht der erwartete.
      targetFlowGs: step.kind === "flow" ? this.stageTarget : null,
      // Bei „Druck uebernehmen“ ebenso der uebernommene Wert.
      targetPressureBar: step.kind === "pressure" ? this.stageTarget : null,
      targetPower: step.kind === "power" ? step.power : null,
      exitReason: null,
      enteredAt,
    });
    this.recorder.setDriveStages(this.stageTransitions);
    this.onStage?.({ index, kind: step.kind, name: step.name?.trim() || null, tone: step.tone === true });
  }

  /** Map the internal advance reason to the persisted StepExit field name. */
  private exitReasonField(
    by: "seconds" | "weight" | "pressure" | "pressure_below" | "flow" | "flow_above" | "arrived",
  ): ShotStageInput["exitReason"] {
    switch (by) {
      case "arrived":
        return "arrived";
      case "seconds":
        return "seconds";
      case "weight":
        return "weightG";
      case "pressure":
        return "pressureBar";
      case "pressure_below":
        return "pressureBelowBar";
      case "flow":
        return "flowGs";
      case "flow_above":
        return "flowAboveGs";
    }
  }

  /** First met exit condition (seconds/weightG/pressureBar/flowGs), or null. */
  /** Scharf, sobald der Druck in DIESER Stufe einmal ueber pressureBelowBar lag.
   *  Ohne das feuert ein Abfall-Kriterium im ersten Frame, wenn die Stufe
   *  ohnehin unterhalb startet. Wird bei jedem Stufenwechsel zurueckgesetzt. */
  private declineArmed = false;

  private stepExitMet(
    exit: StepExit,
    inStageMs: number,
    weight: number | null,
    pressureBar: number,
    flowGs: number,
  ): "seconds" | "weight" | "pressure" | "pressure_below" | "flow" | "flow_above" | null {
    if (exit.seconds !== undefined && inStageMs >= exit.seconds * 1000) return "seconds";
    if (exit.weightG !== undefined && weight !== null && weight >= exit.weightG) return "weight";
    if (exit.pressureBar !== undefined && pressureBar >= exit.pressureBar) return "pressure";
    if (exit.pressureBelowBar !== undefined) {
      if (pressureBar > exit.pressureBelowBar) this.declineArmed = true;
      else if (this.declineArmed) return "pressure_below";
    }
    if (exit.flowGs !== undefined && flowGs <= exit.flowGs) return "flow";
    if (exit.flowAboveGs !== undefined && flowGs >= exit.flowAboveGs) return "flow_above";
    return null;
  }

  /** Seed the entered step's controller (bumpless), record the setpoint-ramp
   *  bookkeeping (from = previous target of the same kind, to = this target), and
   *  set the initial setpoint to the ramp-from value. Power steps are open-loop
   *  and need no controller state. */
  private enterStage(step: BrewStep, seedPower: number): void {
    switch (step.kind) {
      case "flow": {
        const rampMs = step.rampMs !== undefined && step.rampMs > 0 ? step.rampMs : 0;
        // Ramp the setpoint in from where the flow actually IS, not from a stale
        // target (0 after a power/pressure pre-infusion). Starting from 0 read as
        // "far too much flow" and slammed the pump to the floor at the handoff, so
        // the flow rang back up (shots 126/127). On a flow→flow step the measured
        // flow equals the previous target anyway, so this stays bumpless there too.
        const measuredFlow = this.lastPlausibleFlowGs;
        // Gagne: das Ziel ist der Fluss, den der Puck gerade liefert — Ziel und
        // Ist sind beim Eintritt gleich, die Uebergabe ist stossfrei.
        const target = step.adoptFlow ? this.adoptedFlow(step.targetFlowGs) : step.targetFlowGs;
        this.stageRampFrom = rampMs > 0 ? measuredFlow : target;
        this.stageTarget = target;
        this.stageRampMs = rampMs;
        this.lastFlowTarget = target;
        // Seed the plant conductance from the real operating point (flow ÷ power)
        // when there is usable flow: the feed-forward then computes the right pump
        // power for ANY target, so a small and a large setpoint jump both start
        // bumplessly. With no flow yet, keep the power-only bumpless seed.
        if (measuredFlow > this.cfg!.minFlowForEst && seedPower > this.cfg!.powerFloor) {
          this.controller!.setSetpoint(measuredFlow);
        }
        this.controller!.seed(seedPower);
        this.controller!.setSetpoint(this.stageRampFrom);
        this.cfg!.targetFlowGs = target; // keep in sync for logging
        break;
      }
      case "pressure": {
        const rampMs = step.rampMs !== undefined && step.rampMs > 0 ? step.rampMs : 0;
        // Wie beim Fluss: die Rampe startet beim gemessenen Druck, nicht beim
        // letzten Druck-Sollwert. Nach einer Preinfusion waere der 0 — bei 4 bar
        // im Puck laese die Regelung „viel zu viel Druck“ und naehme die Pumpe
        // zurueck, bevor sie hochfaehrt.
        // Decent HOLD-P: das Ziel ist der Druck, den der Puck beim Eintritt hat.
        const target = step.adoptPressure ? this.adoptedPressure(step.targetPressureBar) : step.targetPressureBar;
        this.stageRampFrom = rampMs > 0 ? this.lastPressureBar : target;
        this.stageTarget = target;
        this.stageRampMs = rampMs;
        this.pressureController!.seed(seedPower);
        this.pressureController!.setSetpoint(this.stageRampFrom);
        this.lastPressureSoll = this.stageRampFrom;
        break;
      }
      case "power": {
        const rampMs = step.rampMs !== undefined && step.rampMs > 0 ? step.rampMs : 0;
        this.stageRampFrom = rampMs > 0 ? this.lastPowerTarget : step.power;
        this.stageTarget = step.power;
        this.stageRampMs = rampMs;
        this.lastPowerTarget = step.power;
        break;
      }
      case "preinfusion":
        // Keine Reglerstufe: die Leistung folgt je Tick aus Druck und Kennlinie.
        break;
    }
  }

  /** Commanded pump power (%) for the active step this tick. Flow/pressure run
   *  their PI loop with a back-off limiter on the capped quantity; power is an
   *  open-loop hold or linear ramp within the step, with the same back-off
   *  limiter on either capped quantity. */
  private computeStepPower(
    step: BrewStep,
    frame: LiveFrame,
    flow: number,
    dtMs: number,
    now: number,
  ): number {
    switch (step.kind) {
      case "flow": {
        this.controller!.setSetpoint(this.rampedSetpoint(now));
        const out = this.controller!.update(flow, dtMs).output;
        if (step.maxPressureBar !== undefined && frame.pumpPressureBar > step.maxPressureBar) {
          return this.backOff();
        }
        return out;
      }
      case "pressure": {
        const soll = this.rampedSetpoint(now);
        // Fallende Rampe: den Arbeitspunkt mitfuehren, statt dass der I-Anteil ihn ueber
        // einen bleibenden Fehler nachholt (#285: im Mittel 0,7 bar ueber dem Soll).
        // Steigende Rampen bleiben, wie sie sind — dort begrenzen Anstiegsgrenze und
        // Pumpe ohnehin (Druckspitze von Adaptive Gagné · 9 bar).
        if (this.lastPressureSoll !== null && soll < this.lastPressureSoll) {
          this.pressureController!.shift(
            pressureRampFeedForward(this.pumpCurve, soll - this.lastPressureSoll, frame.pumpPressureBar, flow),
          );
        }
        this.lastPressureSoll = soll;
        this.pressureController!.setSetpoint(soll);
        const out = this.pressureController!.update(frame.pumpPressureBar, dtMs).output;
        if (step.maxFlowGs !== undefined && flow > step.maxFlowGs) {
          return this.backOff();
        }
        return out;
      }
      case "power": {
        // Open-loop: the commanded power IS the (possibly ramped) setpoint. The
        // caps still apply — back-off works off the last commanded power, not off
        // controller state, so it needs no loop behind it.
        if (step.maxPressureBar !== undefined && frame.pumpPressureBar > step.maxPressureBar) {
          return this.backOff();
        }
        if (step.maxFlowGs !== undefined && flow > step.maxFlowGs) {
          return this.backOff();
        }
        return this.rampedSetpoint(now);
      }
      case "preinfusion":
        return preinfusionPower(
          this.pumpCurve,
          step.gentleness,
          frame.pumpPressureBar,
          now - this.stageStartAt,
          step.rampMs,
          step.fill,
        );
    }
  }

  /** Active setpoint for the current flow/pressure step: linearly interpolate
   *  from `stageRampFrom` to `stageTarget` over `stageRampMs` (elapsed within the
   *  step), then hold at the target. rampMs=0 → the target immediately. */
  private rampedSetpoint(now: number): number {
    if (this.stageRampMs <= 0) return this.stageTarget;
    const t = Math.min(1, (now - this.stageStartAt) / this.stageRampMs);
    return this.stageRampFrom + (this.stageTarget - this.stageRampFrom) * t;
  }

  /** Bleed the last commanded power down toward the floor to relieve an exceeded
   *  step limiter (over pressure / over flow). */
  private backOff(): number {
    const floor = this.cfg!.powerFloor;
    const from = this.lastSentPower ?? this.cfg!.rampStartPower;
    return Math.max(floor, from - LIMITER_BACKOFF_PCT);
  }

  // --- Stop paths ---------------------------------------------------------

  /** Public abort — a manual/UI stop request. Triggers the normal exit and books
   *  the shot as 'manual': a stop by hand must stay distinguishable from the BBW
   *  stop at the yield target, or the history can no longer answer whether a
   *  profile actually hit its target. */
  requestStop(): void {
    if (this.phase === "hold") {
      this.shotLog?.info({ event: "manual_stop" }, "Manual stop requested");
      this.beginNormalStop(Date.now(), "manual");
    }
  }

  private beginNormalStop(now: number, stopMode: StopMode): void {
    this.stopRequested = true;
    this.stopSentAt = now;
    this.phase = "stopping";
    // Tell the recorder how this shot ended BEFORE the machine leaves paddle mode
    // (the recorder finalizes on the later MA≠5 frame).
    this.recorder.setDriveStopMode(stopMode);
    void this.normalExit();
  }

  /**
   * Normal exit — paddle/stop FIRST (pump still running; drains
   * firmware-internally) → pumppower=0 → machine/control action "1" → SB
   * cleanup. Never scripts/stop (that leaves MA=5 and runs its own drain+flush).
   *
   * The action "1" is required: paddle/stop + pumppower=0 stop the pump and
   * release pressure but leave the machine in paddle mode (MA=5) indefinitely
   * (verified live, shot 102 + morning HAR probe). action "1" forces MA 5→1
   * (ON/idle, verified live), so the exit registers and the watchdog does not
   * escalate to a hard stop. action "0" would work too but leaves the machine OFF.
   */
  private async normalExit(): Promise<void> {
    await this.lockAndSettle();
    try {
      await this.client.paddleStop();
      await this.client.paddlePumppower(0);
      this.lastSentPower = 0;
      await this.client.machineControl("1");
      this.shotLog?.info({ event: "normal_exit_sent" }, "Normal exit sent (paddle/stop → pumppower=0 → idle)");
    } catch (err) {
      this.shotLog?.warn(
        { event: "normal_exit_error", err_msg: err instanceof Error ? err.message : String(err) },
        `Normal exit send failed — watchdog stop-lag will escalate to hard stop`,
      );
    }
    await this.sbCleanup();
  }

  /**
   * Watchdog hard stop — machine/control action 0 (MA 5→0 in <100 ms, no SB bug
   * per Block-1). Used for overshoot / stop-lag / max-brew ceiling.
   */
  private hardStop(reason: string, now: number): void {
    if (this.hardStopped) return;
    this.hardStopped = true;
    this.stopRequested = true;
    this.phase = "stopping";
    this.recorder.setDriveStopMode("flowhold_watchdog");
    this.shotLog?.error({ event: "hard_stop", reason, elapsed_ms: now - this.startedAt }, `HARD STOP — ${reason}`);
    void this.doHardStop();
  }

  private async doHardStop(): Promise<void> {
    await this.lockAndSettle();
    try {
      await this.client.machineControl("0");
    } catch (err) {
      this.shotLog?.error(
        { event: "hard_stop_error", err_msg: err instanceof Error ? err.message : String(err) },
        `machine/control action 0 failed`,
      );
    }
    // action 0 leaves the machine OFF (no SB bug) — still verify defensively.
    await this.sbCleanup();
    this.phase = "done";
  }

  /** Watchdog parity with BBW: reuse evaluateWatchdog (overshoot + stop-lag),
   *  but on fire do the paddle-appropriate HARD stop, not scriptStop. */
  private checkWatchdog(frame: LiveFrame, weight: number | null, now: number, elapsed: number): void {
    if (this.hardStopped) return;
    const cfg = this.loadWatchdogConfig();
    if (!cfg.enabled) return;

    const decision = evaluateWatchdog(
      {
        now,
        // The drive brews in MA=5; evaluateWatchdog keys on MA=3 → present the
        // active drive as "brewing" so its overshoot/stop-lag logic applies.
        machineStatus: 3,
        bbwArmed: true,
        bbwStopSentAt: this.stopSentAt,
        plausibleWeightG: weight,
        yieldTargetG: this.cfg!.yieldTargetG,
        brewElapsedMs: elapsed,
      },
      cfg,
      { firstFiredAt: this.watchdogFiredAt, lastRefireAt: this.watchdogLastRefireAt },
    );

    if (!decision.shouldFire) return;
    if (this.watchdogFiredAt === null) this.watchdogFiredAt = now;
    this.watchdogLastRefireAt = now;
    this.hardStop(`watchdog:${decision.reasons.join(",")}`, now);
  }

  private loadWatchdogConfig(): WatchdogConfig {
    return {
      enabled: (this.settingsRepo.get("brew_by_weight_watchdog_enabled") ?? "true") === "true",
      stopLagMs: Number(this.settingsRepo.get("brew_by_weight_watchdog_stop_lag_ms") ?? "3000"),
      overshootG: Number(this.settingsRepo.get("brew_by_weight_watchdog_overshoot_g") ?? "7"),
      refireIntervalMs: WATCHDOG_REFIRE_INTERVAL_MS,
      escalateAfterMs: WATCHDOG_ESCALATE_AFTER_MS,
      graceMs: WATCHDOG_GRACE_MS,
    };
  }

  /** SB cleanup: the MA 5→1 transition can flip SB_STATUS→2 (Block-1). Put steam
   *  back to the state it had before the drive. Best-effort. */
  private async sbCleanup(): Promise<void> {
    try {
      const ov = await this.client.overview();
      const fix = this.steamCorrection(ov.SB_STATUS);
      if (fix !== null) {
        this.shotLog?.warn(
          { event: "sb_restore", sb_status: ov.SB_STATUS, sb_before: this.steamBefore, action: fix },
          `SB_STATUS=${ov.SB_STATUS} after exit, was ${this.steamBefore} — sending action ${fix}`,
        );
        await this.client.machineControl(fix);
      }
    } catch (err) {
      this.shotLog?.warn(
        { event: "sb_cleanup_error", err_msg: err instanceof Error ? err.message : String(err) },
        `SB cleanup read/verify failed`,
      );
    }
  }

  /** Exit confirmed — the machine left paddle mode. The shot has already
   *  finalized (recorder, on MA≠5). Enter a passive SB watch: the MA 5→1
   *  transition re-activates steam mode ~14 s later (Block-1 bug), after the
   *  immediate sbCleanup() saw SB=1. Not "active" — a new drive may start. */
  private enterSbWatch(now: number, maStatus: number): void {
    this.phase = "sb_watch";
    this.sbWatchUntil = now + SB_WATCH_WINDOW_MS;
    this.sbLastOffSentAt = Number.NEGATIVE_INFINITY;
    this.sbLastSeen = -1;
    this.shotLog?.info(
      { event: "exit_confirmed", ma_status: maStatus },
      `Exit confirmed (MA=${maStatus}) — watching SB ${SB_WATCH_WINDOW_MS}ms for delayed re-activation`,
    );
  }

  /** Frame-driven SB watch: whenever steam differs from its pre-drive state,
   *  re-send the correction (throttled), until the window closes. One-shot loses
   *  a race with the MA 5→1 re-activation, so we keep firing across the window. */
  private tickSbWatch(frame: LiveFrame, now: number): void {
    // Diagnostic: log each SB transition observed inside the watch window, so a
    // window that closes without a steam-off shows whether SB=2 was ever seen.
    if (frame.steamBoilerStatus !== this.sbLastSeen) {
      this.shotLog?.info(
        { event: "sb_watch_tick", sb_status: frame.steamBoilerStatus, remaining_ms: this.sbWatchUntil - now },
        `SB watch: observed SB=${frame.steamBoilerStatus}`,
      );
      this.sbLastSeen = frame.steamBoilerStatus;
    }
    const fix = this.steamCorrection(frame.steamBoilerStatus);
    if (fix !== null && now - this.sbLastOffSentAt >= SB_OFF_REFIRE_MS) {
      this.sbLastOffSentAt = now;
      this.shotLog?.warn(
        { event: "sb_restore_delayed", sb_status: frame.steamBoilerStatus, sb_before: this.steamBefore, action: fix },
        `Steam SB=${frame.steamBoilerStatus} after exit, was ${this.steamBefore} — sending action ${fix}`,
      );
      void this.sendSteam(fix);
    }
    if (now >= this.sbWatchUntil) {
      this.phase = "done";
      this.shotLog?.info(
        { event: "sb_watch_end", final_sb: frame.steamBoilerStatus },
        `SB watch window elapsed (final SB=${frame.steamBoilerStatus})`,
      );
    }
  }

  /**
   * Welcher Befehl den Dampf wieder in den Zustand vor dem Bezug bringt, oder
   * null. Aus (1) vorher → "3", falls er an ist (der Firmware-Fehler). An (2)
   * vorher → "4", falls er aus ist — aber nie nach einem Notstopp: dann ist die
   * Maschine bewusst aus. Unbekannt vorher → nichts anfassen.
   */
  private steamCorrection(sbNow: number): "3" | "4" | null {
    if (this.steamBefore === 1 && sbNow === 2) return "3";
    if (this.steamBefore === 2 && sbNow === 1 && !this.hardStopped) return "4";
    return null;
  }

  private async sendSteam(action: "3" | "4"): Promise<void> {
    try {
      await this.client.machineControl(action);
    } catch (err) {
      this.shotLog?.warn(
        { event: "sb_restore_error", action, err_msg: err instanceof Error ? err.message : String(err) },
        `steam restore (action ${action}) failed`,
      );
    }
  }

  /** Best-effort pump-off (used on a failed start). Locks the pipeline first so a
   *  pending loop write cannot follow the pump-off. */
  private async safeStop(): Promise<void> {
    await this.lockAndSettle();
    try {
      await this.client.paddleStop();
      await this.client.paddlePumppower(0);
      this.lastSentPower = 0;
    } catch {
      /* best-effort */
    }
  }

  // --- Lifecycle (K-1): shutdown + startup recovery ----------------------

  /** Block new drive starts (process teardown), so a start racing the shutdown
   *  is refused before the actuator pipeline is torn down. */
  blockNewStarts(): void {
    this.startsBlocked = true;
  }

  /**
   * Awaited safe shutdown for process teardown. If a drive is live (hold/stopping/
   * sb_watch), lock the actuator, settle the in-flight write, and issue a
   * HARDWARE-VERIFIED hard stop (machine/control 0 → confirm MA≠5). No-op when
   * idle/done. Paddle has no firmware pump timer, so without this a drive keeps
   * pumping across a SIGTERM/restart.
   */
  async shutdown(): Promise<void> {
    this.startsBlocked = true;
    if (this.phase === "idle" || this.phase === "done") return;
    const log = this.shotLog ?? this.logger.child({ tag: "flowhold" });
    log.warn(
      { event: "shutdown_stop", phase: this.phase },
      `Shutdown during drive (phase=${this.phase}) — verified hard stop`,
    );
    this.hardStopped = true;
    this.stopRequested = true;
    this.phase = "stopping";
    await this.lockAndSettle();
    await this.verifiedHardStop(log);
    this.phase = "done";
  }

  /**
   * Startup interlock: an MA=5 seen at boot with no owning driver is an orphaned
   * paddle brew (the app restarted mid-drive). Force a verified hard stop — the
   * pump would otherwise run uncapped (no firmware paddle timer). Unlocks the
   * pipeline afterwards so a later legitimate drive can start.
   */
  async recoverOrphanedDrive(): Promise<void> {
    const log = this.logger.child({ tag: "flowhold" });
    log.error(
      { event: "orphan_recover" },
      "Orphaned paddle brew (MA=5) at startup — verified hard stop",
    );
    this.actuatorLocked = true;
    await this.verifiedHardStop(log);
    this.actuatorLocked = false;
  }

  /** Send machine/control 0, then confirm via /overview that the machine left
   *  paddle mode (MA≠5), with a few bounded retries. Logs hard if unconfirmed. */
  private async verifiedHardStop(log: Logger): Promise<void> {
    try {
      await this.client.machineControl("0");
    } catch (err) {
      log.error(
        { event: "verified_stop_error", err_msg: err instanceof Error ? err.message : String(err) },
        "verified hard stop: machine/control 0 failed",
      );
    }
    for (let i = 0; i < 5; i++) {
      try {
        const ov = await this.client.overview();
        if (ov.MA_STATUS !== 5) {
          log.info(
            { event: "verified_stop_confirmed", ma_status: ov.MA_STATUS },
            `Stop confirmed (MA=${ov.MA_STATUS})`,
          );
          return;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    log.error(
      { event: "verified_stop_unconfirmed" },
      "Stop NOT confirmed — machine may still be in paddle mode",
    );
  }

  // --- Actuation + plausibility ------------------------------------------

  /** Awaited forced pump write — the start-ramp seed only. lastSentPower is set
   *  AFTER the ACK (a failed first write must not read as "sent") and the error is
   *  propagated so start() can abort. Loop writes go through enqueuePower. */
  private async commandPower(power: number): Promise<void> {
    const rounded = Math.round(power);
    try {
      await this.client.paddlePumppower(rounded);
      this.lastSentPower = rounded;
      this.lastSentAt = Date.now();
    } catch (err) {
      this.shotLog?.warn(
        { event: "pump_write_error", power: rounded, err_msg: err instanceof Error ? err.message : String(err) },
        `pumppower=${rounded} write failed`,
      );
      throw err;
    }
  }

  /** Loop actuator write (coalesced single-writer). Records the newest desired
   *  setpoint and kicks the drain; while a write is in flight only the latest
   *  value is kept, so a slow write can never be overtaken by a stale one. Skips a
   *  redundant write (< POWER_SEND_EPS from the last sent) and is a no-op once the
   *  pipeline is locked for a stop. */
  private enqueuePower(power: number): void {
    if (this.actuatorLocked) return;
    const rounded = Math.round(power);
    if (
      this.lastSentPower !== null &&
      Math.abs(rounded - this.lastSentPower) < POWER_SEND_EPS
    ) {
      return;
    }
    this.desiredPower = rounded;
    this.resendQueued = false;
    if (this.desiredSince === null) this.desiredSince = Date.now();
    if (!this.writeInFlight) {
      this.writeTail = this.drainPumpWrites();
    }
  }

  /** Drain the coalesced setpoint: send the latest desired power, repeating while
   *  a newer value arrives, until nothing is pending or the pipeline is locked.
   *  lastSentPower advances only on a confirmed ACK; a failed write leaves it so
   *  the next tick re-sends. Exactly one drain runs at a time (writeInFlight). */
  private async drainPumpWrites(): Promise<void> {
    this.writeInFlight = true;
    try {
      while (this.desiredPower !== null && !this.actuatorLocked) {
        const p = this.desiredPower;
        const resend = this.resendQueued;
        this.resendQueued = false;
        const sentAt = Date.now();
        const waitMs = sentAt - (this.desiredSince ?? sentAt);
        this.desiredPower = null;
        this.desiredSince = null;
        try {
          await this.client.paddlePumppower(p);
          // Ein neuer Wert ist ein neuer Befehl: er darf wieder nachgesendet werden.
          if (!resend && p !== this.lastSentPower) {
            this.resendCount = 0;
            this.resendWarned = false;
          }
          this.lastSentPower = p;
          this.lastSentAt = Date.now();
          // Actuation-delay diagnosis (#252/#253): wait behind the in-flight write
          // + write round trip, to set against the pump PWM the machine reports.
          const writeMs = Date.now() - sentAt;
          if (resend) {
            this.shotLog?.info(
              { event: "pump_resend", power: p, attempt: this.resendCount, write_ms: writeMs, elapsed_ms: sentAt - this.startedAt },
              `pumppower=${p} resent (${this.resendCount}/${RESEND_MAX})`,
            );
          } else {
            this.shotLog?.info(
              { event: "pump_write", power: p, wait_ms: waitMs, write_ms: writeMs, elapsed_ms: sentAt - this.startedAt },
              `pumppower=${p} ok in ${writeMs}ms (waited ${waitMs}ms)`,
            );
          }
        } catch (err) {
          this.shotLog?.warn(
            { event: "pump_write_error", power: p, err_msg: err instanceof Error ? err.message : String(err) },
            `pumppower=${p} write failed`,
          );
          break; // don't tight-loop on a persistent error; next tick re-kicks
        }
      }
    } finally {
      this.writeInFlight = false;
    }
  }

  /** Nachsenden: steht die gemeldete Leistung RESEND_AFTER_MS nach dem letzten
   *  bestaetigten Befehl noch mehr als RESEND_DEVIATION_PCT daneben und ist kein
   *  neuerer Befehl unterwegs, denselben Wert ueber die Pipeline noch einmal senden
   *  (an POWER_SEND_EPS vorbei). Hoechstens RESEND_MAX-mal je Befehl, danach eine
   *  Warnung ins Bezugs-Log; kein Abbruch. Nie im oder nach dem Stopp. */
  private checkPumpReadback(frame: LiveFrame, now: number): void {
    const sent = this.lastSentPower;
    const reported = frame.pumpPwm ?? null;
    if (this.phase !== "hold" || this.stopRequested || this.actuatorLocked) return;
    if (sent === null || reported === null) return;
    if (this.desiredPower !== null || this.writeInFlight) return;
    if (Math.abs(reported - sent) <= RESEND_DEVIATION_PCT) return;
    if (now - Math.max(this.lastSentAt, this.lastResendAt) < RESEND_AFTER_MS) return;
    if (this.resendCount >= RESEND_MAX) {
      if (!this.resendWarned) {
        this.resendWarned = true;
        this.shotLog?.warn(
          { event: "pump_resend_failed", power: sent, reported, attempts: this.resendCount, elapsed_ms: now - this.startedAt },
          `pumppower=${sent} not taken after ${this.resendCount} resends — machine reports ${reported}`,
        );
      }
      return;
    }
    this.resendCount++;
    this.lastResendAt = now;
    this.desiredPower = sent;
    this.desiredSince = now;
    this.resendQueued = true;
    this.writeTail = this.drainPumpWrites();
  }

  /** Lock the actuator pipeline and await the in-flight write, so the stop
   *  sequence cannot be overtaken by (or race) a pending loop write. */
  private async lockAndSettle(): Promise<void> {
    this.actuatorLocked = true;
    this.desiredPower = null;
    this.desiredSince = null;
    await this.writeTail.catch(() => {});
  }

  private plausibleWeight(
    raw: number | null,
    elapsedMs: number,
    rebase: boolean,
  ): number | null {
    if (raw === null) return this.lastPlausibleWeightG;
    const w = plausibleScaleWeight(
      raw,
      rebase ? null : this.lastPlausibleWeightG,
      elapsedMs < WATCHDOG_GRACE_MS,
    );
    this.lastPlausibleWeightG = w;
    return w;
  }

  private plausibleFlow(raw: number): number {
    if (Number.isFinite(raw) && Math.abs(raw) <= MAX_PLAUSIBLE_FLOW_G_PER_S) {
      this.lastPlausibleFlowGs = raw < 0 ? 0 : raw;
    }
    return this.lastPlausibleFlowGs;
  }

  /** Ziel fuer „Fluss uebernehmen“: Mittel des Tassenflusses der letzten ~1 s.
   *  Fliesst noch nichts, der erwartete Wert der Stufe. */
  private adoptedFlow(expected: number): number {
    const n = this.recentFlow.length;
    const avg = n ? this.recentFlow.reduce((a, f) => a + f.gs, 0) / n : 0;
    return avg > this.cfg!.minFlowForEst ? Math.round(avg * 100) / 100 : expected;
  }

  /** Druck beim Eintritt (auf 0,1 bar); ohne Druck (unter 0,5 bar) der erwartete Wert. */
  private adoptedPressure(expected: number): number {
    return this.lastPressureBar >= 0.5 ? Math.round(this.lastPressureBar * 10) / 10 : expected;
  }

  private resetState(): void {
    this.lastPlausibleWeightG = null;
    this.scaleStall = initialScaleStallState();
    this.lastPlausibleFlowGs = 0;
    this.lastPressureBar = 0;
    this.recentFlow = [];
    this.lastSentPower = null;
    this.lastSentAt = 0;
    this.lastResendAt = 0;
    this.resendCount = 0;
    this.resendWarned = false;
    this.resendQueued = false;
    this.desiredPower = null;
    this.actuatorLocked = false;
    this.stageIndex = 0;
    this.stageStartAt = 0;
    this.stageTransitions = [];
    this.stageRampFrom = 0;
    this.stageTarget = 0;
    this.stageRampMs = 0;
    this.lastFlowTarget = 0;
    this.lastPowerTarget = 0;
    this.pumpOnMs = 0;
    this.stopRequested = false;
    this.stopSentAt = null;
    this.watchdogFiredAt = null;
    this.watchdogLastRefireAt = null;
    this.hardStopped = false;
    this.sbWatchUntil = 0;
    this.sbLastOffSentAt = Number.NEGATIVE_INFINITY;
    this.sbLastSeen = -1;
    this.steamBefore = null;
  }
}
