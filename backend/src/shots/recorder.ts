/**
 * ShotRecorder — Phase 1 Step 5.
 *
 * State machine:
 *   idle     → armed:     armForExecute() called from /api/scripts/execute
 *   armed    → recording: onFrame() sees MA_STATUS=3 within ARMED_TIMEOUT_MS
 *   armed    → idle:      ARMED_TIMEOUT_MS expires without MA_STATUS=3
 *   recording → idle:     onFrame() sees MA_STATUS∈{1,4} → finalizeShot()
 *
 * Events emitted (subscribe in index.ts, not here):
 *   'shotStarted'  [shot: Shot]
 *   'shotEnded'    [shot: Shot, samplesCount: number]
 *
 * Edge cases:
 *   - Backend restart with an open shot in DB: finalized on construction.
 *   - MA_STATUS=3 without armed state: ignored (hardware/web-UI start).
 *   - sample_interval_ms setting: reserved, not used for down-sampling yet.
 */

import { EventEmitter } from "node:events";
import type { LiveFrame, SetpointsFrame, BrewProfile } from "../../../shared/src/types.js";
import type { Shot, ShotCategory, ShotSize, StopMode } from "../../../shared/src/types.js";
import { extractionStarted } from "../../../shared/src/brew-phase.js";
import type { ShotRepo, StageTransition } from "../db/shot-repo.js";
import type { SettingsRepo } from "../db/settings-repo.js";
import type { XeniaClient } from "../xenia/client.js";
import type { Logger } from "../log.js";
import { BrewByWeightController } from "../../../shared/src/brew-by-weight.js";
import { nextResidualLagS } from "../../../shared/src/bbw-lag-calibration.js";
import {
  evaluateWatchdog,
  WATCHDOG_REFIRE_INTERVAL_MS,
  WATCHDOG_ESCALATE_AFTER_MS,
  WATCHDOG_GRACE_MS,
  type WatchdogConfig,
} from "../../../shared/src/brew-watchdog.js";
import { trackScaleStall, initialScaleStallState, type ScaleStallState } from "../../../shared/src/scale-stall.js";
import { plausibleScaleWeight, postBrewDisturbance } from "../../../shared/src/scale-plausibility.js";
import {
  effectiveCategory,
  categoryArmsBbw,
  type ScriptCategoryAuto,
} from "../../../shared/src/bbw-arming.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Armed state expires if no MA_STATUS=3 is seen within this window. */
const ARMED_TIMEOUT_MS = 5_000;

/** MA_STATUS values that terminate a recording session. */
const ENDING_STATUSES = new Set([1, 4]); // ON (returned to idle) or DRAINING

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArmArgs {
  profileId: number;
  /** §3.4 T5: profile name snapshot at brew time (null if no profile). */
  profileName: string | null;
  /** null for app-driven step-based brews (Cut-2). */
  scriptId: number | null;
  shotSize: ShotSize;
  /** Derived from script.categoryAuto; 'unknown' callers default to 'brew'. */
  category: ShotCategory;
  /**
   * Raw auto-detected category (pre-collapse) for the BBW arming gate (§4.12).
   * Unlike `category`, this keeps 'unknown'/null distinguishable — the gate must
   * NOT arm for maintenance/unknown, only for genuine 'brew' scripts.
   */
  categoryAuto: ScriptCategoryAuto;
  /** SE-2: manual category override from xenia_script (local). null = use auto. */
  categoryOverride: "brew" | "maintenance" | null;
  hasCmd27: boolean;
  cmd27Value: number | null;
  yieldTargetG: number | null;
  // Step 9 — pre-shot data from the pre-shot dialog, written into the shot
  // record when recording starts. Held only in the in-memory armed state;
  // discarded with it if the brew never starts.
  beanId: number | null;
  /** Freitext-Bohne (Fremdbohne ohne gepflegte Sorte), sonst null. */
  beanLabel?: string | null;
  grinderId: number | null;
  grindSetting: number | null;
  grinderRpm: number | null;
  doseG: number | null;
  notes: string | null;
  /** Flow-hold drive only: the resolved BrewProfile steps, snapshotted into
   *  shot.brew_steps at recording start. Omitted/null for script/execute shots. */
  brewSteps?: BrewProfile | null;
  /** Script drive only: the raw token string as read from the machine right
   *  before execution. Content-hashed into brew_def so the shot keeps pointing
   *  at the definition it ran, not at the script as edited later. */
  scriptContent?: string | null;
}

interface ArmedState extends ArmArgs {
  armedAt: number;
  /** Identifies this arm so a late failure can only ever drop its own arm. */
  token: number;
}

interface ActiveShot {
  id: number;
  profileId: number;
  scriptId: number | null;
  shotSize: ShotSize;
  category: ShotCategory;
  hasCmd27: boolean;
  cmd27Value: number | null;
  yieldTargetG: number | null;
  startedAt: number;
  sampleCount: number;
}

// ---------------------------------------------------------------------------
// Typed event map
// ---------------------------------------------------------------------------

interface RecorderEvents {
  shotStarted: [shot: Shot];
  shotEnded: [shot: Shot, samplesCount: number];
  /** ÄW-B maintenance run (not recorded as a shot) — for the maintenance log. */
  maintenanceRun: [scriptId: number, profileId: number];
  /** ÄW-B maintenance run ended (machine left brewing) — clears the banner. */
  maintenanceEnded: [];
}

// ---------------------------------------------------------------------------
// ShotRecorder
// ---------------------------------------------------------------------------

export class ShotRecorder extends EventEmitter<RecorderEvents> {
  private readonly repo: ShotRepo;
  private readonly settingsRepo: SettingsRepo;
  private readonly client: XeniaClient;

  private armed: ArmedState | null = null;
  private armedTimer: ReturnType<typeof setTimeout> | null = null;
  private armTokenSeq = 0;

  // ÄW-B: maintenance-bypass markers (in-memory, no schema).
  // `pendingMaintenanceRun`: the armed run is maintenance → the next 1→3 must NOT
  // create a shot row. Tied to the armed state (cleared in clearArmed / on expiry).
  // `activeMaintenanceRun`: a suppressed maintenance run is in progress (MA_STATUS=3,
  // no shot row) → the execute guard rejects a second start. Cleared when the
  // machine leaves brewing (status ≠ 3) or on restart (in-memory).
  private pendingMaintenanceRun = false;
  private activeMaintenanceRun = false;

  private current: ActiveShot | null = null;

  // Flow-hold drive (Consistent-Flow, Phase 1). When driveMode is set the shot is
  // driven app-side via the paddle API (MA_STATUS=5, not 3) and the FlowHoldDriver
  // owns the stop — so the recorder records the shot but does NOT run the BBW
  // trigger or the BBW watchdog. driveStopMode is set by the driver just before it
  // exits and becomes the shot's stop_mode at finalize.
  private driveMode = false;
  private driveStopMode: StopMode | null = null;
  /** Flow-hold stage transitions pushed by the driver during the drive; persisted
   *  to shot_stage at finalize. Reset per drive. Empty for non-drive shots. */
  private driveStages: StageTransition[] = [];

  /** Shot id whose manual stop is pending, or null. Bound to the id (not a bare
   *  flag) so a mark left behind by a failed stop request cannot book a *later*
   *  shot as 'manual'. */
  private manualStopShotId: number | null = null;
  /** Set once a BBW stop has been *accepted* by the machine (HTTP 200) → 'app'. */
  private appStopPending = false;
  /** Set the instant a BBW stop is decided — re-entry guard while the send
   *  (with retries) is in flight, so we don't fire overlapping stop sequences. */
  private appStopRequested = false;
  /** Set when every BBW stop send (incl. retries) failed → 'app_failed'. */
  private appStopFailed = false;

  /** BBW stop send retry policy (Task 2). */
  private readonly BBW_STOP_MAX_ATTEMPTS = 3; // initial try + 2 retries
  private readonly BBW_STOP_RETRY_DELAY_MS = 150;

  /** Active BBW controller — non-null only while recording with a yield target. */
  private bbwController: BrewByWeightController | null = null;
  /** Counts appendSample calls since recording started — used for debug log throttle. */
  private bbwSampleCount = 0;

  /** Updated on every frame — used as yield_actual_g when finalizing. */
  private lastWeightG: number | null = null;

  /** H4: latest known setpoints (BG target snapshot at brew start). Fed by the
   *  poller 'setpoints' event via setSetpoints(). */
  private lastSetpoints: SetpointsFrame | null = null;

  /** ③ Last weight that passed the plausibility guard — used for yield + chart. */
  private lastPlausibleWeightG: number | null = null;
  /** Plausibility ceiling for the scale flow rate (g/s). Real espresso flow tops
   *  out ~5 g/s; PU_SENS_SCALE_RATE occasionally wraps to absurd spikes (e.g.
   *  450–585 g/s, shots #1/#4/#57). Such readings are nulled so they don't
   *  pollute the recorded flow / chart / analysis. Does NOT affect the BBW stop
   *  (that projects from the sanitized WEIGHT slope, not this flow). */
  private readonly MAX_PLAUSIBLE_FLOW_G_PER_S = 15;
  /** T1: true once the scale ever reported a real weight (> threshold) during
   *  this shot. If it stays false, the scale was disconnected/dead the whole
   *  brew → finalize yield as null (not 0) so the UI can show "Waage nicht
   *  verbunden" rather than a bogus 0 g. */
  private sawRealWeight = false;
  private readonly SCALE_PRESENT_MIN_G = 1;

  /** Frozen-scale detection: min/max plausible weight across the brew. If the
   *  weight never moved (max−min < FROZEN_STATIC_DELTA_G) yet sat implausibly
   *  high (max ≥ FROZEN_MIN_WEIGHT_G), the machine froze the reading (glitch;
   *  #71/#75 ~141g) → yield null + tablet alert. A real brew's weight rises. */
  private scaleStall: ScaleStallState = initialScaleStallState();
  private weightMinG: number | null = null;
  private weightMaxG: number | null = null;
  private readonly FROZEN_STATIC_DELTA_G = 1.0;
  private readonly FROZEN_MIN_WEIGHT_G = 50;

  /** Monotonic pre-infusion → extraction latch for the current shot (see
   *  brew-phase.ts `extractionStarted`). Reset per shot. */
  private extractionLatched = false;

  /** ms timestamp when a BBW stop was sent; null otherwise. Feeds the watchdog
   *  trigger evaluation (evaluateWatchdog → sinceStopMs) and the auto-calibration
   *  stop-lag gate (bbwLeftBrewingLagMs). */
  private bbwStopSentAt: number | null = null;

  /** BBW safety watchdog (Spec §4.12 / 3m) — per-shot state.
   *  watchdogFired drives stop_mode='watchdog' (takes precedence so the
   *  intervention stays visible); the two timestamps drive re-fire throttling
   *  and the escalation log-level bump. */
  private watchdogFired = false;
  private watchdogFiredAt: number | null = null;
  private watchdogLastRefireAt: number | null = null;

  /** BBW auto-calibration (BC-parity) — captured per shot for the lag feedback loop. */
  private bbwTargetG: number | null = null;
  private bbwTriggerFlow: number | null = null;      // slope (g/s) at the stop trigger
  private bbwLeftBrewingLagMs: number | null = null;  // ms from stop sent → left BREWING

  /** Stop snapshot (Spec §4.12) — persisted to the shot row in finalizeRecording. */
  private bbwStopTriggerWeightG: number | null = null; // scale weight at stop trigger
  private bbwResidualLagSUsed: number | null = null;   // residual_lag_s in effect this shot
  private postBrewDurationMs: number | null = null;    // post-brew tracking duration
  private postBrewStopReason: "stable" | "timeout" | null = null;
  /** Nachlauf wurde durch einen Sprung beendet (Griff an die Tasse) — das
   *  Endgewicht ist dann das letzte Gewicht davor, und der Bezug darf die
   *  Lag-Kalibrierung nicht fuettern. */
  private postBrewDisturbed = false;
  /** Only auto-calibrate when the stop took effect promptly — otherwise the */
  /** failed-stop overshoot (intermittent bug) would poison the lag. Normal ~0.6s. */
  private readonly BBW_AUTOCAL_MAX_STOP_LAG_MS = 3000;

  /** Post-Brew-Tracking — Spec §4.12. After MA_STATUS leaves 3 we keep reading
   *  the scale until the weight stabilises (capturing drip), then finalise. */
  private postBrew: {
    startedAt: number;
    stableSince: number;
    stableWeight: number;
  } | null = null;

  /** Root logger (no shot context). Spec §4.13 JSON logging. */
  private readonly logger: Logger;
  /** Logger with `shot_id` binding — set in startRecording, cleared in finalize. */
  private shotLogger: Logger | null = null;

  constructor(
    repo: ShotRepo,
    settingsRepo: SettingsRepo,
    client: XeniaClient,
    logger: Logger,
  ) {
    super();
    this.repo = repo;
    this.settingsRepo = settingsRepo;
    this.client = client;
    this.logger = logger;

    // Startup reconcile: finalize EVERY shot left open (ended_at IS NULL) by a
    // previous run that crashed or was killed mid-shot. NB: "open shot" means
    // shot.ended_at IS NULL — unrelated to xenia_script.orphaned_at. Conservative:
    // sets only ended_at + stop_mode='script_end', invents no measurements. In
    // normal operation this is 0 rows; the count is always logged.
    const reconciledCount = repo.finalizeAllOpen(Date.now(), "script_end");
    if (reconciledCount > 0) {
      this.logger.warn(
        { tag: "recorder", event: "startup_reconcile", finalized_count: reconciledCount },
        `Startup reconcile: finalized ${reconciledCount} open shot(s) from a previous run as 'script_end'`,
      );
    } else {
      this.logger.info(
        { tag: "recorder", event: "startup_reconcile", finalized_count: 0 },
        "Startup reconcile: no open shots to finalize",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Called from POST /api/scripts/execute BEFORE client.executeScript().
   * Arms the recorder: the next MA_STATUS=3 frame within 5s starts recording.
   * Returns the arm token for disarmIfCurrent() when the execute call fails.
   */
  armForExecute(args: ArmArgs): number {
    // Clear any previous armed state (shouldn't happen in normal flow)
    this.clearArmed();
    this.driveMode = false; // a script execute is never a flow-hold drive
    this.driveStopMode = null;

    const token = ++this.armTokenSeq;
    this.armed = { ...args, armedAt: Date.now(), token };
    // ÄW-B: app-initiated maintenance run → suppress the next shot record.
    // Uses effectiveCategory (respects category_override), not raw categoryAuto.
    this.pendingMaintenanceRun =
      effectiveCategory({
        categoryAuto: args.categoryAuto,
        categoryOverride: args.categoryOverride,
      }) === "maintenance";
    this.logger.info(
      {
        tag: "recorder",
        event: "armed",
        profile_id: args.profileId,
        script_id: args.scriptId,
        shot_size: args.shotSize,
        maintenance: this.pendingMaintenanceRun,
      },
      `Armed for profile #${args.profileId}, script #${args.scriptId}, ${args.shotSize}` +
        (this.pendingMaintenanceRun ? " (maintenance — will not record)" : ""),
    );

    this.armedTimer = setTimeout(() => {
      if (this.armed !== null) {
        this.logger.info(
          { tag: "recorder", event: "armed_expired", timeout_ms: ARMED_TIMEOUT_MS },
          `Armed state expired — no MA_STATUS=3 within ${ARMED_TIMEOUT_MS}ms`,
        );
        this.armed = null;
        this.armedTimer = null;
        this.pendingMaintenanceRun = false; // ÄW-B: never outlive the armed state
      }
    }, ARMED_TIMEOUT_MS);

    return token;
  }

  /**
   * Drop the armed state again — for a start that failed after arming. Only
   * clears when `token` is still the active arm: a slow failing request must
   * never disarm a newer arm that has meanwhile taken over.
   */
  disarmIfCurrent(token: number): boolean {
    if (this.armed?.token !== token) return false;
    this.logger.info(
      { tag: "recorder", event: "disarmed", script_id: this.armed.scriptId },
      `Disarmed — start failed after arming (script #${this.armed.scriptId})`,
    );
    this.clearArmed();
    return true;
  }

  /**
   * Flow-hold drive arming (Phase 1). Like armForExecute but marks the run as a
   * paddle drive: recording starts on the first MA_STATUS=5 frame (not 3), and
   * the BBW trigger/watchdog are suppressed (the FlowHoldDriver owns the stop).
   * Never a maintenance run. The driver calls setDriveStopMode() before it exits.
   */
  armForDrive(args: ArmArgs): void {
    this.clearArmed();
    this.driveMode = true;
    this.driveStopMode = null;
    this.driveStages = [];
    this.armed = { ...args, armedAt: Date.now(), token: ++this.armTokenSeq };
    this.pendingMaintenanceRun = false;
    this.logger.info(
      {
        tag: "recorder",
        event: "armed_drive",
        profile_id: args.profileId,
        script_id: args.scriptId,
        shot_size: args.shotSize,
      },
      `Armed for flow-hold drive — profile #${args.profileId}, script #${args.scriptId}, ${args.shotSize}`,
    );
    this.armedTimer = setTimeout(() => {
      if (this.armed !== null) {
        this.logger.info(
          { tag: "recorder", event: "armed_drive_expired", timeout_ms: ARMED_TIMEOUT_MS },
          `Drive armed state expired — no MA_STATUS=5 within ${ARMED_TIMEOUT_MS}ms`,
        );
        this.armed = null;
        this.armedTimer = null;
        this.driveMode = false;
      }
    }, ARMED_TIMEOUT_MS);
  }

  /**
   * Set the stop_mode the FlowHoldDriver decided ('flowhold' normal exit or
   * 'flowhold_watchdog' hard-stop). Read at finalize. No-op if not in driveMode.
   */
  setDriveStopMode(mode: StopMode): void {
    if (this.driveMode) this.driveStopMode = mode;
  }

  /**
   * Replace the accumulated Flow-Hold stage transitions (the driver pushes its
   * full list whenever a stage is entered/advanced). Read at finalize and written
   * to shot_stage. No-op if not in driveMode.
   */
  setDriveStages(stages: StageTransition[]): void {
    if (this.driveMode) this.driveStages = stages;
  }

  /** H4: cache the latest setpoints (wired from the poller's 'setpoints' event)
   *  so a starting shot can snapshot the BG target temperature. */
  setSetpoints(setpoints: SetpointsFrame): void {
    this.lastSetpoints = setpoints;
  }

  /**
   * Called from POST /api/shots/:id/stop before scriptStop() is sent — the mark
   * has to exist before the send, because the machine may leave brewing (and the
   * recorder finalize) before the HTTP call returns.
   */
  markManualStop(shotId: number): void {
    this.manualStopShotId = shotId;
  }

  /**
   * The manual stop request failed — take the mark back so a later natural
   * script end is not booked as 'manual'. Drops only its own mark.
   */
  clearManualStop(shotId: number): void {
    if (this.manualStopShotId === shotId) this.manualStopShotId = null;
  }

  /**
   * Called on every poller 'frame' event.
   * Drives the state machine: armed → recording, recording → finalized.
   */
  onFrame(frame: LiveFrame): void {
    this.lastWeightG = frame.scaleWeightG;

    const status = frame.machineStatus;
    // A flow-hold drive brews in paddle mode (MA_STATUS=5); a normal script shot
    // brews in MA_STATUS=3. The recording-start + append trigger follows whichever
    // mode this run is in.
    const brewingStatus = this.driveMode ? 5 : 3;

    // ÄW-B: a suppressed maintenance run ends when the machine leaves brewing —
    // clear the guard marker so the next real start is allowed, and tell the
    // clients so they drop the "maintenance running" banner.
    if (this.activeMaintenanceRun && status !== 3) {
      this.activeMaintenanceRun = false;
      this.emit("maintenanceEnded");
    }

    // ---- Transition: armed → recording ----
    if (this.armed !== null && status === brewingStatus) {
      // ÄW-B: app-initiated maintenance run → do NOT create a shot row, do NOT
      // set activeShotId, do NOT arm BBW/post-brew. Just mark it active (for the
      // execute guard) and drop the armed state.
      if (this.pendingMaintenanceRun) {
        const armed = this.armed;
        this.clearArmed(); // also resets pendingMaintenanceRun
        this.activeMaintenanceRun = true;
        this.logger.info(
          {
            tag: "recorder",
            event: "maintenance_run_unrecorded",
            script_id: armed.scriptId,
            profile_id: armed.profileId,
            category: "maintenance",
          },
          `Maintenance run (script #${armed.scriptId}) — not recorded`,
        );
        // Rückspül-Reminder: log the run (ÄW-B keeps it out of the shot table).
        // A maintenance run is always script-driven (execute path), so scriptId
        // is never null here — the nullable case is drive-only (Cut-2 steps).
        if (armed.scriptId !== null) {
          this.emit("maintenanceRun", armed.scriptId, armed.profileId);
        }
        return;
      }
      this.startRecording(frame);
      return;
    }

    // ---- Recording: append sample or finalize ----
    if (this.current !== null) {
      if (status === brewingStatus) {
        this.appendSample(frame);
        // In driveMode the FlowHoldDriver owns the stop — the recorder only
        // records. Skip the BBW trigger + BBW watchdog (they target MA_STATUS=3
        // script shots and would otherwise fire scriptStop against a paddle run).
        if (!this.driveMode) {
          this.checkBbwTrigger(frame);
          // §4.12 / 3m — safety watchdog: re-fire the stop if it did not take effect.
          this.checkWatchdog(frame);
        }
      } else if (ENDING_STATUSES.has(status) || (this.driveMode && status === 0)) {
        // In driveMode the watchdog/max-brew hard stop is machine/control action 0,
        // which lands the machine in MA=0 (OFF) — not the script-shot idle/draining
        // exit. Treat 0 as an ending status here so the drive finalizes; a normal
        // drive never sits at MA=0 (it holds MA=5 until an explicit stop).
        // §4.12 Post-Brew-Tracking — keep reading the scale until stable or timeout,
        // then finalise. The stabilised weight is what feeds yield + auto-calibration.
        const now = Date.now();
        const firstPostBrewFrame = this.postBrew === null;
        if (this.postBrew === null) {
          // First frame after BREWING ended: enter post-brew tracking.
          if (this.bbwStopSentAt !== null) {
            // Stop→left-BREWING lag gates auto-calibration (see autoCalibrateBbwLag).
            this.bbwLeftBrewingLagMs = now - this.bbwStopSentAt;
          }
          const initWeight = this.lastPlausibleWeightG ?? frame.scaleWeightG ?? 0;
          this.postBrew = { startedAt: now, stableSince: now, stableWeight: initWeight };
          (this.shotLogger ?? this.logger).info(
            {
              tag: "postbrew",
              event: "start",
              weight_g: initWeight,
              machine_status: status,
            },
            `start — weight=${initWeight.toFixed(2)}g (status=${status})`,
          );
        }

        // Stoerung zuerst pruefen — BEVOR der Wert uebernommen wird: der normale
        // Plausibilitaetsfilter erlaubt +15 g je Schritt (fuer den laufenden
        // Bezug), und ein Griff an die Tasse (+11 g, Bezug 235) wuerde sonst zum
        // Endgewicht. Abschluss sofort, mit dem Gewicht vor dem Sprung; der
        // gestoerte Messpunkt wird nicht gespeichert.
        // Der ERSTE Nachlauf-Schritt ist ausgenommen: dort laeuft bei schnellen
        // Profilen noch echter Restkaffee nach (Filter 146: 2,2 g bei 3,6 g/s),
        // und niemand greift in den ersten ~0,4 s nach dem Stopp an die Tasse.
        // Ueber alle Nachlaeufe aendert das genau einen Bezug (146).
        const jump = firstPostBrewFrame
          ? null
          : postBrewDisturbance(frame.scaleWeightG, this.lastPlausibleWeightG);
        if (jump !== null) {
          const sinceStart = now - this.postBrew.startedAt;
          (this.shotLogger ?? this.logger).warn(
            {
              tag: "postbrew",
              event: "disturbed",
              since_start_ms: sinceStart,
              jump_g: jump,
              raw_g: frame.scaleWeightG,
              weight_g: this.lastPlausibleWeightG,
            },
            `disturbed +${sinceStart}ms — Sprung ${jump.toFixed(1)} g, Endgewicht ${(this.lastPlausibleWeightG ?? 0).toFixed(2)} g (vor dem Sprung)`,
          );
          this.postBrewDurationMs = sinceStart;
          // Die CHECK der Spalte kennt nur stable/timeout; ein eigener Wert
          // braeuchte einen Tabellen-Neuaufbau. Der Grund steht im Log.
          this.postBrewStopReason = null;
          this.postBrewDisturbed = true;
          this.postBrew = null;
          this.finalizeRecording();
          return;
        }

        // Capture this post-brew frame (plausibility-guard applies → updates lastPlausibleWeightG).
        this.appendSample(frame, "post_brew");

        const { maxMs, deltaG, windowMs } = this.loadPostBrewSettings();
        const w = this.lastPlausibleWeightG;

        if (w !== null && Math.abs(w - this.postBrew.stableWeight) >= deltaG) {
          // Weight changed beyond noise — reset the stability window.
          this.postBrew.stableWeight = w;
          this.postBrew.stableSince = now;
        }

        const sinceStart = now - this.postBrew.startedAt;
        const stableFor = now - this.postBrew.stableSince;

        if (stableFor >= windowMs) {
          (this.shotLogger ?? this.logger).info(
            {
              tag: "postbrew",
              event: "stable",
              since_start_ms: sinceStart,
              weight_g: w ?? 0,
            },
            `stable +${sinceStart}ms — weight=${(w ?? 0).toFixed(2)}g`,
          );
          this.postBrewDurationMs = sinceStart;
          this.postBrewStopReason = "stable";
          this.postBrew = null;
          this.finalizeRecording();
        } else if (sinceStart >= maxMs) {
          (this.shotLogger ?? this.logger).info(
            {
              tag: "postbrew",
              event: "timeout",
              since_start_ms: sinceStart,
              weight_g: w ?? 0,
            },
            `timeout +${sinceStart}ms — weight=${(w ?? 0).toFixed(2)}g`,
          );
          this.postBrewDurationMs = sinceStart;
          this.postBrewStopReason = "timeout";
          this.postBrew = null;
          this.finalizeRecording();
        }
      }
      // Any other status (0=OFF, 2=ECO) during recording: wait and see.
      // Shouldn't normally happen, but we don't finalize on those to avoid
      // spurious endings from momentary status glitches.
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Store what this shot actually brews, content-addressed, and return its hash.
   * One path for both drives: the flow-hold step JSON and the script token
   * string. null when neither is known (nothing to freeze).
   */
  private rememberBrewDef(armed: ArmedState): string | null {
    if (armed.brewSteps) {
      return this.repo.rememberBrewDef("steps", JSON.stringify(armed.brewSteps));
    }
    if (armed.scriptContent) {
      return this.repo.rememberBrewDef("script", armed.scriptContent);
    }
    return null;
  }

  private startRecording(frame: LiveFrame): void {
    const armed = this.armed!;
    this.clearArmed();

    // Defensive: if a previous shot is somehow still open (e.g. a second armed
    // MA_STATUS=3 cycle slipped past the execute guard), finalize it cleanly
    // instead of silently overwriting this.current — which would leave its DB
    // row dangling (ended_at IS NULL) forever.
    if (this.current !== null) {
      this.finalizeSuperseded();
    }

    const startedAt = Date.now();
    const id = this.repo.createShot({
      profileId: armed.profileId,
      profileName: armed.profileName,
      profileSetTempC: this.lastSetpoints?.brewGroupTargetC ?? null, // H4 snapshot
      scriptId: armed.scriptId,
      shotSize: armed.shotSize,
      category: armed.category,
      startedAt,
      yieldTargetG: armed.yieldTargetG,
      hasCmd27: armed.hasCmd27,
      cmd27Value: armed.cmd27Value,
      // Step 9 — pre-shot data
      beanId: armed.beanId,
      beanLabel: armed.beanLabel ?? null,
      grinderId: armed.grinderId,
      grindSetting: armed.grindSetting,
      grinderRpm: armed.grinderRpm,
      doseG: armed.doseG,
      notes: armed.notes,
      brewSteps: armed.brewSteps ?? null,
      brewDefHash: this.rememberBrewDef(armed),
    });

    this.current = {
      id,
      profileId: armed.profileId,
      scriptId: armed.scriptId,
      shotSize: armed.shotSize,
      category: armed.category,
      hasCmd27: armed.hasCmd27,
      cmd27Value: armed.cmd27Value,
      yieldTargetG: armed.yieldTargetG,
      startedAt,
      sampleCount: 0,
    };

    // Bind the shot logger — every subsequent log call in this shot's lifecycle
    // inherits `shot_id` via this child (Spec §4.13).
    this.shotLogger = this.logger.child({ shot_id: id });

    // Init BBW controller if: setting enabled + yield target set + script has no Cmd27.
    // When Cmd27 is present the machine handles the stop — we only observe.
    this.bbwController = null;
    this.bbwSampleCount = 0;
    this.appStopPending = false;
    this.appStopRequested = false;
    this.appStopFailed = false;
    this.lastPlausibleWeightG = null; // ③ reset plausibility tracker per shot
    this.sawRealWeight = false;        // T1 reset scale-present tracker per shot
    this.scaleStall = initialScaleStallState(); // mid-brew dropout detection
    this.weightMinG = null;            // frozen-scale detection reset per shot
    this.weightMaxG = null;
    this.extractionLatched = false;    // reset pre-infusion→extraction latch per shot
    this.bbwStopSentAt = null;
    this.watchdogFired = false;       // §4.12/3m watchdog reset per shot
    this.watchdogFiredAt = null;
    this.watchdogLastRefireAt = null;
    this.bbwTargetG = null;           // BBW auto-calib reset
    this.bbwTriggerFlow = null;
    this.bbwLeftBrewingLagMs = null;
    this.bbwStopTriggerWeightG = null; // stop snapshot reset
    this.bbwResidualLagSUsed = null;
    this.postBrewDurationMs = null;
    this.postBrewStopReason = null;
    this.postBrewDisturbed = false;   // nur hier zuruecksetzen: finalize liest es noch
    this.postBrew = null;             // Post-Brew-Tracking reset per shot
    // BBW arming. The settings/script conditions (no Cmd27 + yield target + BBW
    // on) decide IF a weight-stop is wanted; the category gate (§4.12) decides if
    // it MAY arm — only genuine 'brew' scripts. Maintenance/unknown are blocked
    // so a non-brew "overshoot" cannot poison residual_lag auto-calibration.
    const bbwSettingsArm =
      !this.driveMode && // flow-hold drive owns its own stop — never arm BBW here
      !armed.hasCmd27 &&
      armed.yieldTargetG !== null &&
      this.settingsRepo.get("brew_by_weight_active") === "true";
    const categoryArms = categoryArmsBbw(
      effectiveCategory({
        categoryAuto: armed.categoryAuto,
        categoryOverride: armed.categoryOverride,
      }),
    );
    if (bbwSettingsArm && categoryArms) {
      const windowMs = Number(this.settingsRepo.get("brew_by_weight_window_ms") ?? "1000");
      const residualLagS = Number(this.settingsRepo.get("brew_by_weight_residual_lag_s") ?? "1.35");
      // bbwSettingsArm already guarantees yieldTargetG !== null.
      this.bbwController = new BrewByWeightController(armed.yieldTargetG!, windowMs, residualLagS);
      this.bbwTargetG = armed.yieldTargetG; // BBW auto-calib reference
      this.bbwResidualLagSUsed = residualLagS; // stop snapshot: lag in effect this shot
      this.shotLogger.info(
        {
          tag: "recorder",
          event: "bbw_init",
          target_g: armed.yieldTargetG,
          window_ms: windowMs,
          lag_s: residualLagS,
        },
        `BBW active — target=${armed.yieldTargetG}g, window=${windowMs}ms, lag=${residualLagS}s`,
      );
    } else if (bbwSettingsArm && !categoryArms) {
      // Would have armed, but this is not a genuine brew script → block + log.
      // The brew still runs; Cmd27 / firmware cutoff / manual stop remain.
      this.shotLogger.info(
        {
          tag: "bbw",
          event: "arming_blocked_category",
          category: armed.category,
          category_auto: armed.categoryAuto,
          target_g: armed.yieldTargetG,
        },
        `BBW arming blocked — non-brew script ` +
          `(category_auto=${armed.categoryAuto ?? "null"}); app weight-stop will NOT arm`,
      );
    }

    this.shotLogger.info(
      {
        tag: "recorder",
        event: "shot_started",
        profile_id: armed.profileId,
        script_id: armed.scriptId,
        shot_size: armed.shotSize,
        category: armed.category,
      },
      `Shot #${id} started — profile #${armed.profileId}, ` +
        `script #${armed.scriptId}, ${armed.shotSize}, category=${armed.category}`,
    );

    // Append the first sample immediately so the first frame is captured
    this.appendSample(frame);

    const shot = this.repo.findById(id);
    if (shot) this.emit("shotStarted", shot);
  }

  private appendSample(frame: LiveFrame, phaseOverride?: "post_brew"): void {
    const cur = this.current!;
    const now = Date.now();
    const elapsedMs = now - cur.startedAt;

    // ① Live flow rate. FW 4.133 zeroed the old PU_SENS_FLOW_METER_ML, so we
    // source flow from the scale rate (PU_SENS_SCALE_RATE → frame.flowRateGPerS),
    // which is already a rate (g/s ≈ ml/s) — use it directly, no differentiation.
    // Sanity-clamp: implausible spikes (sensor wrap-around) are nulled so they
    // don't pollute the recorded flow / chart / analysis.
    const rawFlow = frame.flowRateGPerS;
    const flowMlS: number | null =
      rawFlow !== null && Math.abs(rawFlow) <= this.MAX_PLAUSIBLE_FLOW_G_PER_S ? rawFlow : null;

    // Mid-brew scale dropout (#158): weight and rate die in the same frame while
    // the pump keeps pushing. Detection only — the brew runs on; the yield is
    // nulled at finalize because it can no longer be verified.
    const wasStalled = this.scaleStall.stalled;
    this.scaleStall = trackScaleStall(
      {
        now,
        weightG: frame.scaleWeightG,
        flowGs: rawFlow,
        pumpPwm: frame.pumpPwm ?? null,
        pressureBar: frame.pumpPressureBar,
      },
      this.scaleStall,
    );
    if (this.scaleStall.stalled && !wasStalled) {
      (this.shotLogger ?? this.logger).warn(
        {
          tag: "recorder",
          event: "scale_lost",
          weight_g: this.scaleStall.frozenAtG,
          elapsed_ms: elapsedMs,
        },
        `Scale stopped reporting at ${this.scaleStall.frozenAtG?.toFixed(1)}g ` +
          `after ${(elapsedMs / 1000).toFixed(1)}s — yield will be nulled`,
      );
    }

    // ③ Sanitize scale weight: during a real brew the weight only rises a few g
    // between ~250ms samples. A large jump or drop is a sensor glitch — e.g. the
    // cup lifted off the scale, where the machine reports a wrapped *positive*
    // value for the real negative reading (root cause of the bogus 143.3g yield).
    // Carry the last plausible weight forward so glitches don't pollute the chart
    // or the recorded yield. NOTE: thresholds are a heuristic — review with Flavio.
    let weightG = frame.scaleWeightG;
    if (weightG !== null) {
      // Glitch-filter through the shared heuristic. During the start grace the
      // machine's post-start tare (a legitimate drop back to ~0) must NOT be
      // rejected, else an un-tared residual latches the weight high for the whole
      // brew (bogus ~140g yield — root cause of #71/#75/#77). After grace the
      // normal guard protects the final yield when the cup is lifted at the END.
      const inStartGrace = Date.now() - cur.startedAt < WATCHDOG_GRACE_MS;
      // A scale returning from a dropout has no valid predecessor: the cup kept
      // filling while it was mute, so its first reading legitimately jumps past
      // the tolerance. Carrying the stale value forward would latch it for the
      // rest of the brew (#177: 0.0 g for 48 s, no weight stop, 55 g in the cup).
      const baseline = wasStalled && !this.scaleStall.stalled ? null : this.lastPlausibleWeightG;
      weightG = plausibleScaleWeight(weightG, baseline, inStartGrace);
      this.lastPlausibleWeightG = weightG; // (re-)baseline; always during grace
      if (weightG > this.SCALE_PRESENT_MIN_G) this.sawRealWeight = true;
      // Track the plausible-weight range for frozen-scale detection at finalize.
      this.weightMinG = this.weightMinG === null ? weightG : Math.min(this.weightMinG, weightG);
      this.weightMaxG = this.weightMaxG === null ? weightG : Math.max(this.weightMaxG, weightG);
    }

    // Phase tag: post-brew tracking is passed explicitly; during the brew, split
    // pre-infusion from extraction via the shared latch (pressure ≥ threshold OR
    // first real output — see brew-phase.ts). Same logic as the historical backfill.
    let phase: "preinfusion" | "extraction" | "post_brew";
    if (phaseOverride === "post_brew") {
      phase = "post_brew";
    } else {
      this.extractionLatched = extractionStarted(this.extractionLatched, frame.pumpPressureBar, weightG);
      phase = this.extractionLatched ? "extraction" : "preinfusion";
    }

    this.repo.appendSample(cur.id, {
      elapsedMs,
      pressureBar: frame.pumpPressureBar,
      flowMlS,
      flowMeterMl: frame.flowMeterVolumeMl,
      tempBgC: frame.brewGroupTempC,
      tempBbC: frame.brewBoilerTempC,
      weightG,
      pumpPwm: frame.pumpPwm ?? null,
      phase,
    });

    cur.sampleCount++;
  }

  private finalizeRecording(): void {
    const cur = this.current!;
    this.current = null;

    const endedAt = Date.now();
    let stopMode: StopMode;
    if (this.driveMode) {
      // Flow-hold drive: the driver decided the exit. Default to 'flowhold' if it
      // finalized without an explicit mode (e.g. the machine left paddle on its
      // own). Never enters BBW auto-calibration below (that gate is stopMode==='app').
      stopMode = this.driveStopMode ?? "flowhold";
    } else if (this.watchdogFired) {
      // The safety watchdog had to re-fire the stop (the normal stop did not
      // take effect, or the yield overshot its bound). Top precedence — over
      // app/app_failed/manual — so the intervention stays visible in History.
      // Excluded from auto-calibration (only 'app' calibrates below).
      stopMode = "watchdog";
    } else if (this.appStopFailed) {
      // A BBW stop was attempted but never accepted by the machine — book it
      // honestly as 'app_failed' even if a manual stop ultimately ended the
      // brew. Excluded from auto-calibration (only 'app' calibrates below).
      stopMode = "app_failed";
    } else if (this.appStopPending) {
      stopMode = "app";
    } else if (this.manualStopShotId === cur.id) {
      stopMode = "manual";
    } else if (cur.hasCmd27) {
      stopMode = "cmd27";
    } else {
      stopMode = "script_end";
    }
    this.manualStopShotId = null;
    this.appStopPending = false;
    this.appStopRequested = false;
    this.appStopFailed = false;
    this.watchdogFired = false;
    this.watchdogFiredAt = null;
    this.watchdogLastRefireAt = null;
    this.bbwController = null;
    this.bbwStopSentAt = null;
    this.postBrew = null;      // Post-Brew-Tracking — defensive reset
    const driveStages = this.driveStages; // capture before the driveMode reset below
    this.driveMode = false;    // flow-hold drive — reset per shot
    this.driveStopMode = null;
    this.driveStages = [];

    // ③ Use the last plausible weight as yield, not the raw last frame — the
    // last frame is often post-brew noise (cup lifted → wrapped-positive glitch).
    // T1: if the scale never reported a real weight this brew (disconnected/dead),
    // record null instead of a bogus 0 — the UI surfaces "Waage nicht verbunden"
    // from a finished brew shot with null yield (no extra column needed).
    // Frozen-scale: the weight never moved yet sat implausibly high the whole
    // brew (glitch; #71/#75) → the reported weight is bogus. Null the yield and
    // flag it so the tablet alerts. The flow rate still worked (#75 integrated
    // to the real ~5g) — a rate-integral fallback is a separate step (Stufe 2).
    const scaleFrozen =
      this.weightMinG !== null &&
      this.weightMaxG !== null &&
      this.weightMaxG - this.weightMinG < this.FROZEN_STATIC_DELTA_G &&
      this.weightMaxG >= this.FROZEN_MIN_WEIGHT_G;

    // A mid-brew dropout makes the final number unverifiable either way: if the
    // scale never came back the last value is stale, and if it did the jump
    // guard suppressed the catch-up. Null beats a plausible-looking wrong yield.
    const scaleLost = this.scaleStall.everStalled;

    const yieldG =
      !scaleFrozen && !scaleLost && this.sawRealWeight
        ? (this.lastPlausibleWeightG ?? this.lastWeightG)
        : null;

    if (scaleFrozen) {
      (this.shotLogger ?? this.logger).warn(
        { tag: "recorder", event: "scale_frozen", weight_g: this.weightMaxG },
        `Scale frozen at ${this.weightMaxG?.toFixed(1)}g the whole brew — yield nulled`,
      );
    }

    this.repo.finalizeShot(cur.id, endedAt, stopMode, yieldG, {
      stopTriggerWeightG: this.bbwStopTriggerWeightG,
      flowAtTriggerGPerS: this.bbwTriggerFlow,
      residualLagSUsed: this.bbwResidualLagSUsed,
      bbwLeftBrewingLagMs: this.bbwLeftBrewingLagMs,
      postBrewDurationMs: this.postBrewDurationMs,
      postBrewStopReason: this.postBrewStopReason,
      scaleFrozen,
      scaleLost,
    });

    // Persist the Flow-Hold stage transitions (Soll-Kurve History). No-op for
    // non-drive shots (empty list). Written once, after the shot row is finalized.
    // enteredAt is wall-clock: rebase onto the sample axis (shot.startedAt).
    // Stage 0 lands negative — the driver was already pumping before the
    // machine reported brewing.
    this.repo.appendStageTransitions(
      cur.id,
      driveStages.map(({ enteredAt, ...rest }) => ({
        ...rest,
        enteredMs: enteredAt - cur.startedAt,
      })),
    );

    const shot = this.repo.findById(cur.id);
    if (shot) {
      this.emit("shotEnded", shot, cur.sampleCount);
      (this.shotLogger ?? this.logger).info(
        {
          tag: "recorder",
          event: "shot_ended",
          stop_mode: stopMode,
          sample_count: cur.sampleCount,
          yield_g: yieldG,
        },
        `Shot #${cur.id} ended — stop_mode=${stopMode}, ` +
          `${cur.sampleCount} samples, yield=${yieldG?.toFixed(1) ?? "?"}g`,
      );
    }

    // BBW auto-calibration (BC-parity): if BBW drove this stop, nudge the lag.
    if (stopMode === "app") {
      this.autoCalibrateBbwLag(cur.id, yieldG);
    }

    // Clear shot-scoped logger — subsequent (pre-shot) logs use this.logger.
    this.shotLogger = null;
  }

  /**
   * Defensive finalize for a still-open shot that is about to be superseded by a
   * new one starting. Closes the old shot honestly — ended_at + a defined stop
   * status — rather than letting startRecording() overwrite this.current and
   * orphan the row. Uses 'script_end' (existing enum value — Batch B ships no
   * schema migration) and logs a distinct 'shot_superseded' event for tracing.
   * Conservative: yield = last plausible weight if any; no invented measurements.
   * NOT to be confused with BBW auto-calibration (only runs for a real 'app' stop).
   */
  private finalizeSuperseded(): void {
    const cur = this.current!;
    this.current = null;

    const endedAt = Date.now();
    const yieldG = this.lastPlausibleWeightG ?? this.lastWeightG;
    this.repo.finalizeShot(cur.id, endedAt, "script_end", yieldG, {
      stopTriggerWeightG: this.bbwStopTriggerWeightG,
      flowAtTriggerGPerS: this.bbwTriggerFlow,
      residualLagSUsed: this.bbwResidualLagSUsed,
      bbwLeftBrewingLagMs: this.bbwLeftBrewingLagMs,
      postBrewDurationMs: this.postBrewDurationMs,
      postBrewStopReason: this.postBrewStopReason,
    });

    const shot = this.repo.findById(cur.id);
    if (shot) this.emit("shotEnded", shot, cur.sampleCount);

    (this.shotLogger ?? this.logger).warn(
      {
        tag: "recorder",
        event: "shot_superseded",
        shot_id: cur.id,
        sample_count: cur.sampleCount,
        yield_g: yieldG,
      },
      `Shot #${cur.id} superseded by a new shot — finalized as 'script_end' ` +
        `(${cur.sampleCount} samples, yield=${yieldG?.toFixed(1) ?? "?"}g)`,
    );

    // Reset per-shot stop flags so nothing bleeds into the new shot.
    // (startRecording() resets these again too — belt and suspenders.)
    this.manualStopShotId = null;
    this.appStopPending = false;
    this.appStopRequested = false;
    this.appStopFailed = false;
    this.watchdogFired = false;
    this.watchdogFiredAt = null;
    this.watchdogLastRefireAt = null;
    this.bbwController = null;
    this.bbwStopSentAt = null;
    this.postBrew = null;
    this.driveMode = false;
    this.driveStopMode = null;
    this.shotLogger = null;
  }

  /**
   * BBW lag auto-calibration — port of Beanconqueror's calculateNextResidualLagTime
   * (graphefruit/Beanconqueror, GPL-3.0). After a BBW-driven stop, nudge
   * brew_by_weight_residual_lag_s toward the value that would have hit the target:
   * convert the weight error to time via the flow at trigger. The arithmetic and
   * its bounds live in shared/src/bbw-lag-calibration.ts; this method owns the
   * gating. Skipped if inputs are missing/invalid, or if the stop didn't take
   * effect promptly (a failed/slow stop's overshoot would otherwise poison the lag).
   */
  /**
   * Load Post-Brew-Tracking settings (Spec §4.12) with fall-back defaults.
   */
  private loadPostBrewSettings(): { maxMs: number; deltaG: number; windowMs: number } {
    return {
      maxMs:    Number(this.settingsRepo.get("post_brew_max_duration_ms") ?? "5000"),
      deltaG:   Number(this.settingsRepo.get("post_brew_stable_delta_g")  ?? "0.1"),
      windowMs: Number(this.settingsRepo.get("post_brew_stable_window_ms") ?? "1000"),
    };
  }

  private autoCalibrateBbwLag(shotId: number, finalWeightG: number | null): void {
    // Toggle: brew_by_weight_auto_calibrate (Spec §4.12, Default true).
    const enabled = (this.settingsRepo.get("brew_by_weight_auto_calibrate") ?? "true") === "true";
    if (!enabled) {
      (this.shotLogger ?? this.logger).info(
        { tag: "bbw", event: "auto_calib_skipped" },
        `Auto-calibration disabled, skipping`,
      );
      return;
    }

    if (this.postBrewDisturbed) {
      (this.shotLogger ?? this.logger).info(
        { tag: "bbw", event: "auto_calib_skipped", reason: "postbrew_disturbed" },
        `Auto-calibration skipped — post-brew weight was disturbed`,
      );
      return;
    }

    if (
      this.bbwTargetG === null ||
      this.bbwTriggerFlow === null ||
      this.bbwTriggerFlow < 0.1 || // BC safety: invalid flow
      finalWeightG === null ||
      this.bbwLeftBrewingLagMs === null ||
      this.bbwLeftBrewingLagMs >= this.BBW_AUTOCAL_MAX_STOP_LAG_MS // failed/slow stop
    ) {
      return;
    }

    const currentLag = Number(
      this.settingsRepo.get("brew_by_weight_residual_lag_s") ?? "1.35",
    );
    const weightError = finalWeightG - this.bbwTargetG; // +overshoot / −undershoot
    const newLag = nextResidualLagS({
      currentLagS: currentLag,
      weightErrorG: weightError,
      flowAtTriggerGs: this.bbwTriggerFlow,
    });

    const applied = newLag !== currentLag;
    if (applied) {
      this.settingsRepo.set("brew_by_weight_residual_lag_s", String(newLag));
    }

    // Audit every gated run — including no-change (applied=0) so lag convergence
    // is observable over time (Spec §4.12, Lücke 2).
    this.repo.logAutoCalibration({
      shotId,
      createdAt: Date.now(),
      oldLagS: currentLag,
      newLagS: newLag,
      weightErrorG: weightError,
      flowAtTriggerGPerS: this.bbwTriggerFlow,
      calibrationApplied: applied,
    });

    (this.shotLogger ?? this.logger).info(
      {
        tag: "bbw",
        event: applied ? "auto_adjust_lag" : "auto_calib_nochange",
        old_lag_s: currentLag,
        new_lag_s: newLag,
        weight_error_g: weightError,
        flow_g_per_s: this.bbwTriggerFlow,
      },
      applied
        ? `Auto-adjusting Lag ${currentLag}s → ${newLag}s ` +
            `(weightError=${weightError.toFixed(2)}g, flow=${this.bbwTriggerFlow.toFixed(2)}g/s)`
        : `Lag stable at ${currentLag}s ` +
            `(weightError=${weightError.toFixed(2)}g, flow=${this.bbwTriggerFlow.toFixed(2)}g/s)`,
    );
  }

  /**
   * Called after appendSample() on every brewing frame.
   * Checks if the BBW algorithm says we should stop; if so, sends scriptStop()
   * (with retries) and records the correct stop_mode via finalizeRecording().
   */
  private checkBbwTrigger(frame: LiveFrame): void {
    // appStopRequested guards re-entry while a stop send (with retries) is in
    // flight — appStopPending is only set once the machine *accepts* the stop.
    if (this.bbwController === null || this.appStopRequested) return;

    // Start-up grace: the machine zeroes the scale shortly AFTER the brew
    // begins, so the first seconds can report stale residual/cup weight — e.g.
    // a *constant* 141.7g (shot #71) that is no scale spike and thus passes the
    // plausibility filter, firing the stop ~1s in. A real BBW target is never
    // reached this early, so suppress the primary stop during the same grace
    // the watchdog already uses (one source of truth for brew-start settle).
    const cur = this.current;
    if (cur === null) return;
    if (Date.now() - cur.startedAt < WATCHDOG_GRACE_MS) return;

    // ① Feed the BBW algorithm the plausibility-checked weight (set by the
    // preceding appendSample), NOT the raw frame. A scale spike that was already
    // filtered out (e.g. cup lifted → wrapped-positive glitch) must not trigger a
    // premature stop. Carried-forward when the raw frame was implausible.
    const checkedWeightG = this.lastPlausibleWeightG;
    if (checkedWeightG === null) return;

    const result = this.bbwController.addSample(Date.now(), checkedWeightG);

    this.bbwSampleCount++;

    // Debug logging every 2nd sample (~500ms at 250ms polling). Off by default.
    if (process.env["DEBUG_BBW"] && this.bbwSampleCount % 2 === 0 && result.telemetry) {
      const t = result.telemetry;
      (this.shotLogger ?? this.logger).debug(
        {
          tag: "bbw",
          event: "sample_telemetry",
          sample: this.bbwSampleCount,
          weight_g: t.currentWeightG,
          slope_g_per_s: t.slopeGPerS,
          projected_g: t.projectedWeightG,
        },
        `sample=${this.bbwSampleCount} weight=${t.currentWeightG.toFixed(2)}g ` +
          `slope=${t.slopeGPerS.toFixed(3)}g/s projected=${t.projectedWeightG.toFixed(2)}g`,
      );
    }

    if (!result.shouldStop) return;

    const tel = result.telemetry;
    (this.shotLogger ?? this.logger).info(
      {
        tag: "bbw",
        event: "stop_triggered",
        weight_g: tel.currentWeightG,
        projected_g: tel.projectedWeightG,
        slope_g_per_s: tel.slopeGPerS,
      },
      `Stop triggered — weight=${tel.currentWeightG.toFixed(2)}g ` +
        `projected=${tel.projectedWeightG.toFixed(2)}g slope=${tel.slopeGPerS.toFixed(3)}g/s`,
    );

    this.bbwTriggerFlow = tel.slopeGPerS; // BBW auto-calib: flow (g/s) at trigger
    this.bbwStopTriggerWeightG = tel.currentWeightG; // stop snapshot: weight at trigger
    this.appStopRequested = true; // re-entry guard; success/failure decided in attemptScriptStop()
    this.bbwStopSentAt = Date.now(); // feeds the watchdog trigger evaluation

    // Send the stop with retries. The machine transition to MA_STATUS=4 is
    // picked up normally via onFrame(); finalizeRecording() reads the
    // appStopPending / appStopFailed flags set by attemptScriptStop().
    void this.attemptScriptStop(cur.id);
  }

  /**
   * Send the brew-by-weight stop, retrying on failure (Task 2).
   * Up to BBW_STOP_MAX_ATTEMPTS sends, BBW_STOP_RETRY_DELAY_MS apart.
   *  - On the first accepted send (HTTP 200) → set appStopPending (→ 'app').
   *  - If every attempt fails → set appStopFailed (→ 'app_failed'); the shot is
   *    NOT booked as a successful app stop and is excluded from auto-calibration.
   * Self-contained error handling — never rejects, so it is safe to fire-and-forget.
   *
   * Bound to the shot it was triggered for: retries and result flags are dropped
   * as soon as that shot is no longer the active one. Otherwise a late attempt
   * would send a stop into an already-started next brew, and a late result would
   * set that brew's stop_mode.
   */
  private async attemptScriptStop(shotId: number): Promise<void> {
    for (let attempt = 1; attempt <= this.BBW_STOP_MAX_ATTEMPTS; attempt++) {
      if (this.isStaleStop(shotId, "bbw", attempt)) return;
      try {
        const ackT0 = Date.now();
        const status = await this.client.scriptStop();
        // Parity with the watchdog's stop_ack. Without it a successful stop left
        // no trace, so a late-actuating machine (#173/#175: 4.3 s / 3.9 s to
        // leave MA=3) could not be told apart from a stop that reached it late.
        // Logged before the stale check on purpose — the measurement is most
        // interesting precisely when the result gets discarded.
        (this.shotLogger ?? this.logger).info(
          {
            tag: "bbw",
            event: "stop_ack",
            status,
            duration_ms: Date.now() - ackT0,
            attempt,
          },
          `BBW STOP acknowledged — HTTP ${status} in ${Date.now() - ackT0}ms`,
        );
        if (this.isStaleStop(shotId, "bbw", attempt)) return;
        // Machine accepted the stop (HTTP 200) — only NOW is it a real app stop.
        this.appStopPending = true;
        if (attempt > 1) {
          (this.shotLogger ?? this.logger).info(
            { tag: "bbw", event: "script_stop_retry_ok", attempt },
            `scriptStop() accepted on attempt ${attempt}`,
          );
        }
        return;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        (this.shotLogger ?? this.logger).warn(
          {
            tag: "bbw",
            event: "script_stop_error",
            attempt,
            max_attempts: this.BBW_STOP_MAX_ATTEMPTS,
            err_msg: errMsg,
          },
          `scriptStop() failed (attempt ${attempt}/${this.BBW_STOP_MAX_ATTEMPTS}): ${errMsg}`,
        );
        if (attempt < this.BBW_STOP_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.BBW_STOP_RETRY_DELAY_MS),
          );
        }
      }
    }
    // Every attempt failed — do not claim a successful app stop.
    if (this.isStaleStop(shotId, "bbw", this.BBW_STOP_MAX_ATTEMPTS)) return;
    this.appStopFailed = true;
    (this.shotLogger ?? this.logger).error(
      { tag: "bbw", event: "script_stop_failed", attempts: this.BBW_STOP_MAX_ATTEMPTS },
      `scriptStop() failed after ${this.BBW_STOP_MAX_ATTEMPTS} attempts — marking shot 'app_failed'`,
    );
  }

  /**
   * True once the shot an async stop was fired for is no longer the active one —
   * the recording finalized (or a new shot took over) while the send was in
   * flight. Both the remaining retries and the result must then be dropped.
   */
  private isStaleStop(shotId: number, tag: "bbw" | "watchdog", attempt: number): boolean {
    if (this.current?.id === shotId) return false;
    (this.shotLogger ?? this.logger).warn(
      {
        tag,
        event: "stale_stop_discarded",
        shot_id: shotId,
        active_shot_id: this.current?.id ?? null,
        attempt,
      },
      `Discarding stop result for shot #${shotId} — no longer active ` +
        `(now: ${this.current?.id ?? "none"})`,
    );
    return true;
  }

  /** Load watchdog config (Spec §4.12 / 3m) from settings, with fall-back defaults. */
  private loadWatchdogConfig(): WatchdogConfig {
    return {
      enabled:    (this.settingsRepo.get("brew_by_weight_watchdog_enabled") ?? "true") === "true",
      stopLagMs:   Number(this.settingsRepo.get("brew_by_weight_watchdog_stop_lag_ms") ?? "3000"),
      overshootG:  Number(this.settingsRepo.get("brew_by_weight_watchdog_overshoot_g") ?? "7"),
      refireIntervalMs: WATCHDOG_REFIRE_INTERVAL_MS,
      escalateAfterMs:  WATCHDOG_ESCALATE_AFTER_MS,
      graceMs:          WATCHDOG_GRACE_MS,
    };
  }

  /**
   * BBW safety watchdog (Spec §4.12 / Auftrag 3m). Called on every brewing frame
   * AFTER appendSample (so lastPlausibleWeightG is current). While BBW is armed,
   * it re-fires the stop command — throttled — if a sent stop did not take effect
   * within the stop-lag bound, or the yield overshot its bound. The decision
   * logic is the pure evaluateWatchdog(); this method owns the side effects
   * (send, log, stop_mode). No machineControl / power-off, no absolute time cap —
   * the FW ~120s pump limit is the last-resort ceiling.
   */
  private checkWatchdog(frame: LiveFrame): void {
    const cur = this.current;
    // Only armed while a BBW controller is active — also avoids a per-frame
    // settings read on non-BBW shots.
    if (cur === null || this.bbwController === null) return;

    const config = this.loadWatchdogConfig();
    if (!config.enabled) return;

    const now = Date.now();
    const decision = evaluateWatchdog(
      {
        now,
        machineStatus: frame.machineStatus,
        bbwArmed: this.bbwController !== null,
        bbwStopSentAt: this.bbwStopSentAt,
        plausibleWeightG: this.lastPlausibleWeightG,
        yieldTargetG: cur.yieldTargetG,
        brewElapsedMs: now - cur.startedAt,
      },
      config,
      { firstFiredAt: this.watchdogFiredAt, lastRefireAt: this.watchdogLastRefireAt },
    );

    if (!decision.shouldFire) return;

    const firstFire = this.watchdogFiredAt === null;
    if (firstFire) this.watchdogFiredAt = now;
    this.watchdogLastRefireAt = now;
    this.watchdogFired = true; // → stop_mode='watchdog' at finalize (top precedence)

    const log = this.shotLogger ?? this.logger;
    const payload = {
      tag: "watchdog",
      event: firstFire ? "intervene" : "refire",
      reasons: decision.reasons,
      since_stop_ms: decision.sinceStopMs,
      overshoot_g: decision.overshootG,
      stop_lag_ms: config.stopLagMs,
      overshoot_threshold_g: config.overshootG,
    };
    const msg =
      `Watchdog ${firstFire ? "intervening" : "re-firing"} stop — ` +
      `reasons=[${decision.reasons.join(",")}] ` +
      `sinceStop=${decision.sinceStopMs ?? "?"}ms overshoot=${decision.overshootG?.toFixed(1) ?? "?"}g`;
    if (decision.escalate) {
      // Still brewing > escalateAfterMs after the first fire — something is
      // seriously wrong. Escalate the level but KEEP firing.
      log.error(
        { ...payload, escalated: true },
        `${msg} — STILL BREWING >${config.escalateAfterMs}ms after first watchdog fire`,
      );
    } else {
      log.warn(payload, msg);
    }

    void this.attemptWatchdogStop(cur.id);
  }

  /**
   * Single re-fire of the stop command for the watchdog. Deliberately a plain
   * scriptStop() — identical to the manual/BBW stop — NOT machineControl. One
   * attempt per call; the throttled per-frame loop provides the repetition while
   * MA_STATUS=3. Never rejects (safe to fire-and-forget); does NOT touch the app
   * stop flags (those describe the original BBW stop, not the watchdog).
   */
  private async attemptWatchdogStop(shotId: number): Promise<void> {
    if (this.isStaleStop(shotId, "watchdog", 1)) return;
    try {
      const ackT0 = Date.now();
      const status = await this.client.scriptStop();
      // Machine's acknowledgement of the watchdog re-fire (HTTP status + latency).
      (this.shotLogger ?? this.logger).info(
        {
          tag: "watchdog",
          event: "stop_ack",
          status,
          duration_ms: Date.now() - ackT0,
        },
        `Watchdog STOP acknowledged — HTTP ${status} in ${Date.now() - ackT0}ms`,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      (this.shotLogger ?? this.logger).warn(
        { tag: "watchdog", event: "stop_error", err_msg: errMsg },
        `Watchdog scriptStop() failed: ${errMsg}`,
      );
    }
  }

  private clearArmed(): void {
    if (this.armedTimer !== null) {
      clearTimeout(this.armedTimer);
      this.armedTimer = null;
    }
    this.armed = null;
    // ÄW-B: the pending-maintenance marker is tied to the armed state — never
    // outlive it (armForExecute re-sets it after this call when applicable).
    this.pendingMaintenanceRun = false;
  }

  /**
   * Clears pending timers — called during graceful shutdown so a pending
   * armed-window timeout doesn't keep the event loop alive.
   */
  stop(): void {
    this.clearArmed();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** Returns the DB ID of the currently recording shot, or null. */
  get activeShotId(): number | null {
    return this.current?.id ?? null;
  }

  /** ÄW-B: true while a suppressed app-initiated maintenance run is in progress
   *  (MA_STATUS=3, no shot row). The execute guard rejects a second start. */
  get isMaintenanceActive(): boolean {
    return this.activeMaintenanceRun;
  }
}
