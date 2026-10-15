import { EventEmitter } from "node:events";
import { XeniaClient, XeniaError } from "./client.js";
import {
  normalizeOverview,
  normalizeOverviewSingle,
  normalizeMachine,
} from "./normalize.js";
import type { LiveFrame, SetpointsFrame, MachineInfo } from "../../../shared/src/types.js";
// SetpointsFrame is used for the lastSetpoints cache (passed to normalizeOverview)
import { getDb } from "../db/index.js";

// ---------------------------------------------------------------------------
// Typed event map for XeniaPoller
// ---------------------------------------------------------------------------

interface PollerEvents {
  frame: [frame: LiveFrame];
  setpoints: [setpoints: SetpointsFrame];
  machineInfo: [info: MachineInfo];
  connected: [];
  disconnected: [];
  error: [err: unknown];
}

// ---------------------------------------------------------------------------
// Backoff / polling constants
// ---------------------------------------------------------------------------

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const SETPOINTS_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// XeniaPoller
// ---------------------------------------------------------------------------

export class XeniaPoller extends EventEmitter<PollerEvents> {
  private readonly client: XeniaClient;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Error tracking for exponential backoff
  private consecutiveErrors = 0;

  // Connection state (refers to the machine, not the WS connection)
  private machineOnline = false;

  // Setpoints: cached to pass into normalizeOverview for machineState derivation
  private lastSetpoints: SetpointsFrame | null = null;

  // Setpoints: track last fetch time to avoid hammering every 60s
  private lastSetpointsFetchMs = 0;

  /** Optional callback — returns true to extend brew-rate polling beyond
   *  MA_STATUS=3 (e.g., while the recorder is in Post-Brew-Tracking, §4.12). */
  private readonly shouldExtendBrewRate?: () => boolean;

  constructor(client: XeniaClient, shouldExtendBrewRate?: () => boolean) {
    super();
    this.client = client;
    this.shouldExtendBrewRate = shouldExtendBrewRate;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;

    // Fetch machine info once — FW compatibility check, logged, not polled
    void this.fetchMachineInfo();

    // Kick off the adaptive polling loop
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Force an immediate setpoints refetch — used right after a setpoint change
   * so the UI reflects the new SOLL value without waiting for the next 60s
   * poll. Emits 'setpoints' on success, exactly like the periodic fetch.
   */
  refreshSetpoints(): Promise<void> {
    return this.fetchSetpoints();
  }

  /**
   * Last known setpoints frame (cached from /overview_single), or null before
   * the first fetch. PT-2: machine routes read brewGroupTargetC from here to
   * remember the pre-set BG setpoint before a profile-temp set.
   */
  getLastSetpoints(): SetpointsFrame | null {
    return this.lastSetpoints;
  }

  // ---------------------------------------------------------------------------
  // Polling loop
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const raw = await this.client.overview();
      // Pass cached setpoints so deriveMachineState can compare temps to targets
      const frame = normalizeOverview(raw, this.lastSetpoints);

      // Transition: offline → online
      if (!this.machineOnline) {
        this.machineOnline = true;
        this.consecutiveErrors = 0;
        this.emit("connected");
      }

      this.emit("frame", frame);

      // Fetch setpoints every 60s (they change rarely)
      if (Date.now() - this.lastSetpointsFetchMs > SETPOINTS_INTERVAL_MS) {
        void this.fetchSetpoints();
      }

      const interval = this.resolveInterval(frame);
      this.timer = setTimeout(() => void this.poll(), interval);
    } catch (err) {
      this.consecutiveErrors++;

      // Transition: online → offline
      if (this.machineOnline) {
        this.machineOnline = false;
        this.emit("disconnected");
      }

      this.emit("error", err);

      const backoff = this.backoffMs();
      this.timer = setTimeout(() => void this.poll(), backoff);
    }
  }

  // ---------------------------------------------------------------------------
  // Interval calculation
  // ---------------------------------------------------------------------------

  private resolveInterval(frame: LiveFrame): number {
    const { idleMs, brewMs } = this.loadPollingSettings();

    // Adaptive: brew-rate polling during active extraction OR while the recorder
    // is still capturing (e.g., Post-Brew-Tracking after MA_STATUS leaves 3).
    const extend = this.shouldExtendBrewRate?.() ?? false;
    const base = (frame.machineStatus === 3 || extend) ? brewMs : idleMs;

    // CPU_LOAD > 80%: double the interval to reduce pressure on the ESP32
    return frame.cpuLoadPercent > 80 ? base * 2 : base;
  }

  private loadPollingSettings(): { idleMs: number; brewMs: number } {
    try {
      const db = getDb();
      const rows = db
        .prepare(
          "SELECT key, value FROM settings WHERE key IN ('polling_idle_ms', 'polling_brew_ms')",
        )
        .all() as { key: string; value: string }[];
      const map = new Map(rows.map((r) => [r.key, r.value]));
      return {
        idleMs: parseInt(map.get("polling_idle_ms") ?? "1000", 10),
        brewMs: parseInt(map.get("polling_brew_ms") ?? "250", 10),
      };
    } catch {
      // DB unavailable — fall back to hardcoded defaults
      return { idleMs: 1000, brewMs: 250 };
    }
  }

  // ---------------------------------------------------------------------------
  // Backoff
  // ---------------------------------------------------------------------------

  private backoffMs(): number {
    // Exponential: 2s → 4s → 8s → 16s → 30s (capped)
    return Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.consecutiveErrors - 1),
      BACKOFF_MAX_MS,
    );
  }

  // ---------------------------------------------------------------------------
  // One-shot fetches
  // ---------------------------------------------------------------------------

  private async fetchMachineInfo(): Promise<void> {
    try {
      const raw = await this.client.machine();
      const info = normalizeMachine(raw);
      this.emit("machineInfo", info);
    } catch (err) {
      // Non-fatal: just report, don't affect polling
      this.emit("error", err);
    }
  }

  private async fetchSetpoints(): Promise<void> {
    // Mark the fetch time up front so both the 60s timer and an out-of-band
    // refreshSetpoints() call reset the interval consistently.
    this.lastSetpointsFetchMs = Date.now();
    try {
      const raw = await this.client.overviewSingle();
      const setpoints = normalizeOverviewSingle(raw);
      // Cache for machineState derivation in subsequent poll() calls
      this.lastSetpoints = setpoints;
      this.emit("setpoints", setpoints);
    } catch (err) {
      this.emit("error", err);
    }
  }
}
