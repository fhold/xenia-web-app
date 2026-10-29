/**
 * HTTP client for the Xenia DBL API.
 *
 * Two quirks to keep in mind (Handoff 2.3):
 *   1. POST Content-Type is `application/x-www-form-urlencoded` but the body
 *      is a plain JSON string — NOT a URL-encoded form. The ESP32 parser
 *      expects exactly this format.
 *   2. POST responses carry no meaningful status — verify state changes via
 *      a subsequent GET.
 */

import type { Logger } from "../log.js";
import { L } from "../../../shared/src/shared-lang.js";

const DEFAULT_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class XeniaError extends Error {
  constructor(
    message: string,
    public readonly code: "timeout" | "http" | "network",
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "XeniaError";
  }
}

// ---------------------------------------------------------------------------
// Raw response shapes (only what we use — not exhaustive)
// ---------------------------------------------------------------------------

export interface RawOverview {
  MA_STATUS: number;
  MA_EXTRACTIONS: number;
  MA_OPERATING_HOURS: number;
  MA_CLOCK: number;
  MA_CUR_PWR: number;
  MA_MAX_PWR: number;
  MA_ENERGY_TOTAL_KWH: number;
  MA_LAST_EXTRACTION_ML: string;
  BG_SENS_TEMP_A: number;
  BG_LEVEL_PW_CONTROL: number;
  BB_SENS_TEMP_A: number;
  BB_LEVEL_PW_CONTROL: number;
  PU_SENS_PRESS: number;
  PU_LEVEL_PW_CONTROL: number;
  PU_SET_LEVEL_PW_CONTROL: number;
  // FW 4.133 flow/scale sensor fields. The old PU_SENS_FLOW_METER_ML is gone
  // (reads 0 since 4.133) — replaced by the explicit rate/volume fields below.
  /** Flow meter instantaneous rate (ml/s). */
  PU_SENS_FLOW_METER_FLOWRATE: number;
  /** Flow meter cumulative volume since brew start (ml). */
  PU_SENS_FLOW_METER_VOLUME: number;
  /** Scale-derived flow rate (g/s) — our productive flow source. */
  PU_SENS_SCALE_RATE: number;
  /** Scale-derived cumulative volume (g/ml). */
  PU_SENS_SCALE_VOLUME: number;
  SB_SENS_PRESS: number;
  SB_STATUS: number;
  SCALE_WEIGHT: number;
  /** Dropped from /overview in FW 4.133 — optional. */
  CPU_LOAD?: number;
}

export interface RawOverviewSingle {
  BG_SET_TEMP: number;
  BB_SET_TEMP: number;
  PU_SET_PRESS: number;
  SB_SET_PRESS: number;
  PU_SENS_WATER_TANK_LEVEL: number;
  MA_MAC: string;
  MA_EXTRACTIONS_START: number;
  PSP?: number;
  POP_UP?: number | null;
}

export interface RawMachine {
  MA_TYPE: number;
  FW_VERSION_MAJOR: number;
  FW_VERSION_MINOR: number;
  ESP_FW_MAJOR: number;
  ESP_FW_MINOR: number;
}

// GET /api/v2/scale — the BT scale pairing state the machine's own dashboard
// reads. When a scale is connected, DEVICE_NAME/ADDRESS/SIGNAL are populated
// and the `connected_device` field appears; disconnected they are empty arrays
// and `connected_device` is absent. NOTE: BLE and SC_AUTOCONNECT are NOT
// connection flags — BLE stays 0 and SC_AUTOCONNECT is just the auto-connect
// setting, both verified live 2026-07-12.
export interface RawScale {
  DEVICE_NAME: string[];
  ADDRESS: string[];
  SIGNAL: number[];
  connected_device?: string;
  SC_AUTOCONNECT: number;
  BLE: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class XeniaClient {
  private baseUrl: string;
  private currentHost: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(host: string, logger: Logger, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.currentHost = host;
    this.baseUrl = `http://${host}`;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  /** Address the client talks to (IP or hostname, optional :port). */
  get host(): string {
    return this.currentHost;
  }

  /**
   * Switch to another machine address. Poller, recorder and driver share this
   * one client, so the next request of each goes to the new address. Callers
   * must not switch while a brew runs (the address route refuses that).
   */
  setHost(host: string): void {
    this.currentHost = host;
    this.baseUrl = `http://${host}`;
  }

  // ---------------------------------------------------------------------------
  // Per-request logging — JSON via pino (§4.13). Default level for the xenia
  // logger is "error"; set DEBUG_XENIA=1 to surface request/response lines.
  // ---------------------------------------------------------------------------

  private logOut(method: string, path: string, body?: unknown): void {
    this.logger.info(
      body !== undefined
        ? { event: "request", method, path, body }
        : { event: "request", method, path },
      body !== undefined
        ? `${method} ${path} body=${JSON.stringify(body)}`
        : `${method} ${path}`,
    );
  }

  private logIn(status: number, startMs: number): void {
    const duration_ms = Date.now() - startMs;
    this.logger.info(
      { event: "response", status, duration_ms },
      `<- ${status} in ${duration_ms}ms`,
    );
  }

  private logErr(label: string, startMs: number, err: unknown): void {
    const duration_ms = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    this.logger.error(
      { event: "request_error", label, duration_ms, err_msg: errMsg },
      `!! ${label} after ${duration_ms}ms — ${errMsg}`,
    );
  }

  private async get<T>(path: string, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    this.logOut("GET", path);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
      });
      this.logIn(res.status, t0);
      if (!res.ok) {
        throw new XeniaError(
          L(`Die Maschine antwortet mit HTTP ${res.status} auf GET ${path}`, `HTTP ${res.status} from GET ${path}`),
          "http",
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof XeniaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        this.logErr("TIMEOUT GET " + path, t0, err);
        throw new XeniaError(
          L(`Die Maschine antwortet nicht (nach ${timeoutMs} ms): GET ${path}`, `Request timed out after ${timeoutMs}ms: GET ${path}`),
          "timeout",
        );
      }
      this.logErr("NETWORK GET " + path, t0, err);
      throw new XeniaError(
        L(`Maschine nicht erreichbar (GET ${path}): ${(err as Error).message}`, `Network error on GET ${path}: ${(err as Error).message}`),
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // POST-Format Quirk (Handoff 2.3):
  // Content-Type: application/x-www-form-urlencoded — but the body is a raw
  // JSON string, not URL-encoded key=value pairs. The ESP32 ignores the
  // Content-Type and just parses the body as JSON.
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = Date.now();
    this.logOut("POST", path, body);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      this.logIn(res.status, t0);
      if (!res.ok) {
        throw new XeniaError(
          L(`Die Maschine antwortet mit HTTP ${res.status} auf POST ${path}`, `HTTP ${res.status} from POST ${path}`),
          "http",
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof XeniaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        this.logErr("TIMEOUT POST " + path, t0, err);
        throw new XeniaError(
          L(`Die Maschine antwortet nicht (nach ${this.timeoutMs} ms): POST ${path}`, `Request timed out after ${this.timeoutMs}ms: POST ${path}`),
          "timeout",
        );
      }
      this.logErr("NETWORK POST " + path, t0, err);
      throw new XeniaError(
        L(`Maschine nicht erreichbar (POST ${path}): ${(err as Error).message}`, `Network error on POST ${path}: ${(err as Error).message}`),
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST for machine control endpoints that return an empty body (Content-Length: 0).
   * Uses res.text() to drain the response without JSON parsing — res.json()
   * hangs on zero-length bodies with Connection: close (Xenia ESP32 quirk).
   */
  private async postControl(
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = Date.now();
    this.logOut("POST", path, body);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Drain body regardless of content (may be empty — Content-Length: 0)
      await res.text();
      this.logIn(res.status, t0);
      if (!res.ok) {
        throw new XeniaError(
          L(`Die Maschine antwortet mit HTTP ${res.status} auf POST ${path}`, `HTTP ${res.status} from POST ${path}`),
          "http",
          res.status,
        );
      }
    } catch (err) {
      if (err instanceof XeniaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        this.logErr("TIMEOUT POST " + path, t0, err);
        throw new XeniaError(
          L(`Die Maschine antwortet nicht (nach ${this.timeoutMs} ms): POST ${path}`, `Request timed out after ${this.timeoutMs}ms: POST ${path}`),
          "timeout",
        );
      }
      this.logErr("NETWORK POST " + path, t0, err);
      throw new XeniaError(
        L(`Maschine nicht erreichbar (POST ${path}): ${(err as Error).message}`, `Network error on POST ${path}: ${(err as Error).message}`),
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Script endpoints
  // ---------------------------------------------------------------------------

  scriptsList(): Promise<{ index_list: number[]; title_list: string[] }> {
    return this.get<{ index_list: number[]; title_list: string[] }>(
      "/api/v2/scripts/list",
    );
  }

  /**
   * Fetch a single script by ID.
   * FILE_NAME must be zero-padded to 3 digits (ID 10 → "010") — Handoff 2.4.
   * Uses post<T>() because the response has a JSON body (unlike control endpoints).
   */
  scriptRead(id: number): Promise<{ Content: string; Title: string }> {
    const fileName = id.toString().padStart(3, "0");
    return this.post<{ Content: string; Title: string }>(
      "/api/v2/scripts/read",
      { FILE_NAME: fileName },
    );
  }

  /**
   * Write a script to the machine's flash (SE-2, verified live 2026-08-02).
   *
   * scriptId === null → the machine picks a free slot and returns nothing about
   * it; the caller must diff scripts/list to learn the new ID. A number means
   * in-place overwrite of that slot (no new entry).
   *
   * The payload follows the machine's own modeler.js: the unused fields are
   * EMPTY STRINGS, not null/"Disabled" (the third-party doc is wrong here).
   * Response is `{}` with a JSON content-type ⇒ post<T>(), not postControl().
   * HTTP 403 = no free slot left.
   */
  scriptCreate(args: {
    scriptId: number | null;
    name: string;
    instruction: string;
  }): Promise<Record<string, never>> {
    const edit = args.scriptId === null ? "" : "Enabled";
    return this.post<Record<string, never>>("/api/v2/scripts/create", {
      Edit: edit,
      script_id: args.scriptId === null ? "" : args.scriptId,
      switch: "",
      script: "modeler",
      name: args.name,
      instruction: args.instruction,
    });
  }

  /**
   * Delete a script from flash. Both the script (.S) and the title (.T) file
   * must be named, zero-padded to 3 digits — SE-2, verified live 2026-08-02.
   */
  scriptDelete(id: number): Promise<Record<string, never>> {
    const pad = id.toString().padStart(3, "0");
    return this.post<Record<string, never>>("/api/v2/scripts/delete", {
      scr_file_name: `${pad}.S`,
      title_file_name: `${pad}.T`,
    });
  }

  overview(): Promise<RawOverview> {
    return this.get<RawOverview>("/api/v2/overview");
  }

  overviewSingle(): Promise<RawOverviewSingle> {
    return this.get<RawOverviewSingle>("/api/v2/overview_single");
  }

  status(): Promise<{ MA_STATUS: number }> {
    return this.get<{ MA_STATUS: number }>("/api/v2/status");
  }

  // /api/v2/scale is inherently slow (~2s live — it does a BLE lookup), so it
  // needs a longer timeout than the 1500ms default or the pre-brew check would
  // always time out and fail-open to no warning.
  scale(): Promise<RawScale> {
    return this.get<RawScale>("/api/v2/scale", 3000);
  }

  machine(): Promise<RawMachine> {
    return this.get<RawMachine>("/api/v2/machine");
  }

  // ---------------------------------------------------------------------------
  // Machine control (Handoff 2.2)
  // ---------------------------------------------------------------------------

  /**
   * Send a machine/control action. action is a string: "0"–"5".
   * Xenia returns HTTP 200 with empty body (Content-Length: 0).
   */
  machineControl(action: string): Promise<void> {
    return this.postControl("/api/v2/machine/control", { action });
  }

  /**
   * Toggle the steam boiler.
   *
   * FW 4.133: the "modern" `/api/v2/toggle_sb {TOGGLE:bool}` endpoint is DEAD —
   * it answers HTTP 200 but the firmware ignores it (SB_STATUS never changes;
   * verified live 2026-06-22 with the machine ON). We fall back to the dedicated
   * legacy steam actions on /machine/control, which only touch the steam boiler
   * (NOT power/ECO): action "4" = steam on, "3" = steam off (Handoff 2.2).
   */
  toggleSteamBoiler(on: boolean): Promise<void> {
    return this.machineControl(on ? "4" : "3");
  }

  /**
   * Execute a script by ID.
   * ID MUST be an integer — NOT a string (API quirk, Handoff 2.5).
   * Uses postControl() because Xenia returns HTTP 200 with empty body.
   * POST-format quirk (Content-Type: x-www-form-urlencoded + JSON body)
   * is handled by postControl() — required or the request silently fails.
   */
  executeScript(id: number): Promise<void> {
    return this.postControl("/api/v2/scripts/execute", { ID: id });
  }

  /**
   * Flow-hold drive: set the paddle pump power (POST /api/v2/paddle/pumppower
   * { PU_SET_LEVEL_PW_CONTROL: 0..100 }). Above the pump threshold (~n≥50 vs a
   * blind basket) this opens the group valve and runs the pump (MA_STATUS=5),
   * building real pressure; n=0 idles the pump. Empty/non-JSON body → postControl.
   * Diagnosis: project_xenia_drive_api_findings — pumppower is a real brew command.
   */
  paddlePumppower(level: number): Promise<void> {
    return this.postControl("/api/v2/paddle/pumppower", {
      PU_SET_LEVEL_PW_CONTROL: level,
    });
  }

  /**
   * Flow-hold normal exit: GET /api/v2/paddle/stop. Per Block-1 diagnosis this is
   * the effective paddle exit AND performs the firmware-internal drain (pressure
   * dumped in <2 s); the official HAR order fires this FIRST (pump still running),
   * then pumppower=0. Mirrors scriptStop(): drains a possibly empty/non-JSON body
   * and returns the acknowledged HTTP status. NOTE: scripts/stop is NOT a paddle
   * exit (it leaves MA=5 and runs its own drain+flush) — use this endpoint.
   */
  async paddleStop(): Promise<number> {
    const path = "/api/v2/paddle/stop";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = Date.now();
    this.logOut("GET", path);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
      });
      this.logIn(res.status, t0);
      if (!res.ok) {
        throw new XeniaError(
          L(`Die Maschine antwortet mit HTTP ${res.status} auf GET ${path}`, `HTTP ${res.status} from GET ${path}`),
          "http",
          res.status,
        );
      }
      await res.text(); // drain body without JSON parsing (empty/non-JSON)
      return res.status;
    } catch (err) {
      if (err instanceof XeniaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        this.logErr("TIMEOUT GET " + path, t0, err);
        throw new XeniaError(
          L(`Die Maschine antwortet nicht (nach ${this.timeoutMs} ms): GET ${path}`, `Request timed out after ${this.timeoutMs}ms: GET ${path}`),
          "timeout",
        );
      }
      this.logErr("NETWORK GET " + path, t0, err);
      throw new XeniaError(
        L(`Maschine nicht erreichbar (GET ${path}): ${(err as Error).message}`, `Network error on GET ${path}: ${(err as Error).message}`),
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Set temperature setpoints via /inc_dec.
   * Values must be strings (e.g. "93.0") — Xenia API quirk (Handoff 2.1).
   * Xenia returns HTTP 200 with empty body.
   */
  setTemperatures(params: {
    BG_SET_TEMP?: string;
    BB_SET_TEMP?: string;
  }): Promise<void> {
    return this.postControl("/api/v2/inc_dec", params);
  }

  /**
   * Stop the currently running script cleanly. Returns the HTTP status the
   * machine acknowledged with (200 in practice) so callers can log the
   * machine's acknowledgement EXPLICITLY — key evidence for the intermittent
   * "machine keeps brewing after an accepted stop" diagnosis (BBW-stop-latency
   * / Xenia-Support handoff): the report then shows "accepted HTTP 200" right next to
   * the MA_STATUS=3 still-brewing lines.
   *
   * Self-contained (mirrors get()) rather than going through get<T>() because
   * get() resolves with the parsed body, not the status, and parses JSON. This
   * endpoint answers 200 with an empty/non-JSON body, so it drains with
   * res.text() to avoid a spurious parse error and returns res.status instead.
   *
   * Handoff 2.2 + Tech-Spike S7: GET /api/v2/scripts/stop — confirmed reliable.
   * (Not a POST — ignore section 4.12 which lists POST erroneously.)
   */
  async scriptStop(): Promise<number> {
    const path = "/api/v2/scripts/stop";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = Date.now();
    this.logOut("GET", path);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
      });
      this.logIn(res.status, t0);
      if (!res.ok) {
        throw new XeniaError(
          L(`Die Maschine antwortet mit HTTP ${res.status} auf GET ${path}`, `HTTP ${res.status} from GET ${path}`),
          "http",
          res.status,
        );
      }
      await res.text(); // drain body without JSON parsing (empty/non-JSON)
      return res.status;
    } catch (err) {
      if (err instanceof XeniaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        this.logErr("TIMEOUT GET " + path, t0, err);
        throw new XeniaError(
          L(`Die Maschine antwortet nicht (nach ${this.timeoutMs} ms): GET ${path}`, `Request timed out after ${this.timeoutMs}ms: GET ${path}`),
          "timeout",
        );
      }
      this.logErr("NETWORK GET " + path, t0, err);
      throw new XeniaError(
        L(`Maschine nicht erreichbar (GET ${path}): ${(err as Error).message}`, `Network error on GET ${path}: ${(err as Error).message}`),
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
