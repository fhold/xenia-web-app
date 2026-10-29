/**
 * Normalized types shared between backend and frontend.
 *
 * Rules:
 *   - No Node.js or browser-specific imports here.
 *   - Raw Xenia API field names (MA_STATUS, BG_SENS_TEMP_A, etc.) must
 *     never leak into these types — normalization happens in backend/xenia/normalize.ts.
 */

// ---------------------------------------------------------------------------
// Machine state
// ---------------------------------------------------------------------------

/**
 * Raw MA_STATUS values from the Xenia API.
 * 0=OFF, 1=ON (heating/ready), 2=ECO, 3=BREWING, 4=DRAINING, 5=PADDLE.
 * 5 is the paddle/manual-pump mode the app-side flow-hold drive runs in
 * (POST /api/v2/paddle/pumppower); the machine reports MA_STATUS=5 throughout.
 */
export type MachineStatus = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Human-readable machine state derived from MA_STATUS, temps, and setpoints.
 * 'disconnected' is a frontend-only fallback when no frame has been received.
 */
export type MachineState =
  | "disconnected"
  | "off"
  | "heating"
  | "ready"
  | "eco"
  | "brewing"
  | "draining";

// ---------------------------------------------------------------------------
// Steam boiler status
// ---------------------------------------------------------------------------

/**
 * SB_STATUS: 0=unknown, 1=steam off (user choice), 2=steam on.
 */
export type SteamBoilerStatus = 0 | 1 | 2;

// ---------------------------------------------------------------------------
// Live frame (from /overview, normalized)
// ---------------------------------------------------------------------------

export interface LiveFrame {
  /** Raw MA_STATUS — kept for polling interval decisions (machineStatus===3 → brew rate). */
  machineStatus: MachineStatus;
  /** Derived human-readable state (see deriveMachineState in normalize.ts). */
  machineState: MachineState;

  extractionCount: number;
  operatingHours: number;
  clockSeconds: number;

  currentPowerAmps: number;
  maxPowerAmps: number;
  energyTotalKwh: number;
  /** null when the machine reports no value (FW 4.133 sends "" → null). */
  lastExtractionMl: number | null;

  /** Brew group temperature in °C (BG_SENS_TEMP_A). */
  brewGroupTempC: number;
  /** Brew group PWM level (0–100). */
  brewGroupPwm: number;

  /** Brew boiler temperature in °C (BB_SENS_TEMP_A). */
  brewBoilerTempC: number;
  /** Brew boiler PWM level (0–100). */
  brewBoilerPwm: number;

  /** Pump pressure in bar (PU_SENS_PRESS). */
  pumpPressureBar: number;
  pumpPwm: number;
  pumpTargetPwm: number;
  /**
   * Live flow rate (g/s ≈ ml/s), sourced from the scale (PU_SENS_SCALE_RATE)
   * since FW 4.133. This is the value shown as "Flow" and recorded per sample.
   */
  flowRateGPerS: number;
  /** Cumulative flow-meter volume since brew start (ml, PU_SENS_FLOW_METER_VOLUME). */
  flowMeterVolumeMl: number;

  /**
   * Steam boiler pressure in bar (SB_SENS_PRESS).
   * Note: no steam boiler temperature sensor exists in the API.
   * The dashboard shows this value as the "Dampf" gauge with unit "bar".
   */
  steamBoilerPressureBar: number;
  steamBoilerStatus: SteamBoilerStatus;

  /** Scale weight in grams (SCALE_WEIGHT). From integrated Bookoo Themis Ultra. */
  scaleWeightG: number;

  /** ESP32 CPU load in percent. Used to throttle polling when > 80%. */
  cpuLoadPercent: number;

  /** Unix timestamp (ms) when this frame was built by the backend. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Setpoints frame (from /overview_single, normalized)
// ---------------------------------------------------------------------------

export interface SetpointsFrame {
  brewGroupTargetC: number;
  brewBoilerTargetC: number;
  pumpTargetPressureBar: number;
  steamBoilerTargetPressureBar: number;
  /** Machine API PU_SENS_WATER_TANK_LEVEL: 1 = full, 2 = empty. */
  waterTankLevel: 1 | 2;
  macAddress: string;
  extractionCountStart: number;
  timestamp: number;
  /**
   * PT-2: BG setpoint that was active before a profile-temp set armed a reset,
   * or null when no profile-temp reset is armed. Display value for the post-shot
   * reset prompt (the reset itself restores BOTH BG and BB from the backend
   * store). The machine frame never carries this — normalizeOverviewSingle sets
   * null and the WsHub overlays the live backend store value on every broadcast.
   */
  profileTempPreviousSetpointC: number | null;
}

// ---------------------------------------------------------------------------
// Machine info (from /api/v2/machine, fetched once at startup)
// ---------------------------------------------------------------------------

export interface MachineInfo {
  machineType: number;
  fwMajor: number;
  fwMinor: number;
  espFwMajor: number;
  espFwMinor: number;
}

// ---------------------------------------------------------------------------
// WebSocket message union
// ---------------------------------------------------------------------------

export type WsMessage =
  | { type: "live"; data: LiveFrame }
  | { type: "setpoints"; data: SetpointsFrame }
  | { type: "machineInfo"; data: MachineInfo }
  | { type: "machineOffline" }
  | { type: "error"; message: string }
  | { type: "shotStarted"; data: Shot }
  | { type: "shotEnded"; data: Shot; samplesCount: number }
  | { type: "shotUpdated"; data: Shot }
  | { type: "maintenanceStarted"; data: MaintenanceRun }
  | { type: "maintenanceEnded" }
  | { type: "profilesChanged" }
  | { type: "driveStage"; data: DriveStage };

/** Die Stufe, in die ein App-Bezug (Flow-Hold) gerade gewechselt ist — fuer die
 *  Zeile ueber dem Diagramm. Skript-Bezuege melden keine Stufe: die Maschine
 *  verraet nicht, welchen Skriptschritt sie faehrt. */
export interface DriveStage {
  index: number;
  kind: BrewStep["kind"];
  /** Name der Stufe im Profil; null = keiner vergeben. */
  name: string | null;
  /** Am Ende der Stufe einen Ton spielen (BrewStep.tone). */
  tone: boolean;
  /** Eintritt, Wanduhr in ms wie `Shot.startedAt` (Stufe 0 liegt kurz davor). */
  enteredAt: number;
  /** Womit der Treiber die Stufe fährt (Druck bar, Fluss g/s, Leistung %): Rampe
   *  von `from` nach `to` über `rampMs`; `adopted` = Ziel vom Puck übernommen.
   *  null bei der Preinfusion — sie ist keine Reglerstufe. */
  setpoint: { from: number; to: number; rampMs: number; adopted: boolean } | null;
}

/** ÄW-B: an app-initiated maintenance run in progress (e.g. a backflush script).
 *  These extract no coffee and are never recorded as a shot — the dashboard shows
 *  a "maintenance running" banner instead of the chart while one is active. Driven
 *  by the SAME backend detection as the shot-suppression (effectiveCategory ===
 *  "maintenance", respecting category_override). */
export interface MaintenanceRun {
  scriptId: number;
  profileId: number;
  /** Display label (the profile name). */
  label: string;
  /** Unix ms when the machine entered brewing (MA_STATUS 1→3). */
  startedAt: number;
  /** Nominal script duration (scriptToTimeline totalMs) for the countdown, or
   *  null if the script has no parsed commands. */
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Machine control API — shared between backend routes and frontend hook
// ---------------------------------------------------------------------------

/** POST /api/machine/power. Backend determines withSteam from last known SB_STATUS. */
export type PowerRequest = { on: boolean };

/** POST /api/machine/steam */
export type SteamRequest = { on: boolean };

/** POST /api/machine/eco */
export type EcoRequest = { on: boolean };

/**
 * POST /api/machine/setpoints.
 * Only brew group and brew boiler supported.
 * Steam boiler pressure setpoint is omitted — API support unclear (Handoff 2.1).
 */
export type SetpointsUpdateRequest = {
  brewGroupTargetC?: number;
  brewBoilerTargetC?: number;
};

/**
 * POST /api/machine/setpoints/from-profile (PT-2).
 * Sets the brew-group setpoint to a profile's target temp. Sets ONLY BG (the
 * BG→BB coupling is deliberately bypassed — Fork 7) and arms a one-shot
 * post-brew reset to the setpoint that was active before (Fork 5 / M3).
 */
export type SetFromProfileRequest = {
  targetTempC: number;
};

/**
 * POST /api/machine/setpoints/reset-profile-temp (PT-2).
 * apply=true → restore the remembered previous BG setpoint, then clear the
 * armed state. apply=false → just clear (dismiss), no machine interaction.
 * No-op (200) when nothing is armed.
 */
export type ResetProfileTempRequest = {
  apply: boolean;
};

/** Standard JSON response for all machine control endpoints. */
export type ApiResponse = { ok: true } | { ok: false; error: string };

/** BT scale connection state (GET /api/scale) — one-off check before a brew. */
export interface ScaleStatus {
  ok: true;
  connected: boolean;
  deviceName: string | null;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** Art eines Profils (Schnitt 3): Bezug oder Wartung (Rueckspuelen, Flush). */
/** "test" = Messlauf-Profil: Laeufe werden als Messlauf aufgezeichnet (siehe ShotCategory). */
export type ProfileKind = "brew" | "maintenance" | "test";

/** Einordnung eines Profils: Espresso fuer dunkle bzw. helle Roestungen, Filter. */
export const PROFILE_FITS = ["dark", "light", "filter"] as const;
export type ProfileFit = (typeof PROFILE_FITS)[number];

/** Gueltige Einordnung: Liste ohne Doppel aus PROFILE_FITS. */
export function isProfileFitList(v: unknown): v is ProfileFit[] {
  return Array.isArray(v) && v.every((x) => (PROFILE_FITS as readonly unknown[]).includes(x)) && new Set(v).size === v.length;
}

export interface Profile {
  id: number;
  name: string;
  description: string | null;
  /**
   * Bezug oder Wartung. Wartung startet ohne „Bezug vorbereiten“, wird nicht
   * aufgezeichnet und schaltet den Stopp nach Gewicht nie scharf.
   */
  kind: ProfileKind;
  /** Versuch: nur zum Ausprobieren — der Kolben in Liste und Editor. Nur Anzeige. */
  isTrial: boolean;
  /** Einordnung: wofuer das Profil gedacht ist (mehrere moeglich, leer = nicht eingeordnet). Nur Filter in der Liste. */
  fit: ProfileFit[];
  /** Archiviert: nicht in der Liste und nicht Favorit, bleibt fuer Historie und Skripte. Umkehrbar. */
  isArchived: boolean;
  // no icon field — name alone identifies a profile
  // null = flow-driven profile (brewSteps), no Xenia script.
  scriptIdSingle: number | null;
  scriptIdDouble: number | null;
  yieldTargetSingleG: number | null;
  yieldTargetDoubleG: number | null;
  isFavorite: boolean;
  /** Position within favorites list (lower = earlier). null = unordered. */
  favoriteOrder: number | null;
  /** Free-text note (description, temp recommendation, …). null = none. */
  notes: string | null;
  /**
   * Optional absolute brew setpoint in °C (PT-1). null = no profile target →
   * today's behaviour. Stage 1 stores/shows it only; no machine interaction.
   */
  targetTempC: number | null;
  /**
   * Step-based flow/pressure/script definition (Decent-style). null = classic
   * script-only profile (started via the Xenia script). When present the profile
   * can be started as an app-driven flow-hold shot. See BrewProfile.
   */
  brewSteps: BrewProfile | null;
  /**
   * Optional 2×-slot flow sequence. null = the 2× shot reuses the 1× sequence
   * (brewSteps) with its own yieldTargetDoubleG. Only meaningful for flow-driven
   * profiles (brewSteps present); mirrors scriptIdDouble for script profiles.
   */
  brewStepsDouble: BrewProfile | null;
  /** Schnitt 3: die Varianten des Profils, nach Reihenfolge (bis 3c aus den Spalten oben gespiegelt). */
  variants?: ProfileVariant[];
  createdAt: string;
  updatedAt: string;
}

/** Frei benanntes Teilrezept eines Profils mit Vorgabe-Sieb (Schnitt 3). */
export interface ProfileVariant {
  id: number;
  name: string;
  sortOrder: number;
  defaultBasketId: number | null;
  yieldG: number | null;
  /** Skript-Variante; null bei App-Variante oder „wie Variante X“. */
  scriptId: number | null;
  /** App-Variante; null bei Skript-Variante oder „wie Variante X“. */
  brewSteps: BrewProfile | null;
  /** „wie Variante X“: diese Variante faehrt die Kurve von X. */
  sameAsId: number | null;
  /** Skript-Variante: Phasennamen je Phasen-Index (die Maschine kennt keine); null = keine. */
  phaseNames: (string | null)[] | null;
  /** Platz aus der 1×/2×-Welt: seit 3c die ersten beiden Varianten (Einzel = erste, Doppel = zweite). */
  legacySlot: "single" | "double" | null;
}

/**
 * Eine Variante beim Speichern (Schnitt 3c). Ohne `id` wird sie angelegt, nicht
 * mehr genannte werden geloescht. `sameAs` ist der Index der Variante in
 * derselben Liste, deren Kurve sie faehrt („wie Variante X“).
 */
export interface ProfileVariantInput {
  id?: number | null;
  name: string;
  defaultBasketId: number | null;
  yieldG: number | null;
  scriptId: number | null;
  brewSteps: BrewProfile | null;
  sameAs?: number | null;
  /** Nur bei eigenem Skript: Phasennamen je Phasen-Index. */
  phaseNames?: (string | null)[] | null;
}

/** Body for POST /api/profiles. description is always null in V1. */
export type ProfileCreate = {
  name: string;
  /** Fehlt sie beim Anlegen, ist es ein Bezug. */
  kind?: ProfileKind;
  /** Versuch (Kolben); fehlt es beim Anlegen, ist es keiner. */
  isTrial?: boolean;
  /** Einordnung; fehlt sie beim Anlegen, ist das Profil nicht eingeordnet. */
  fit?: ProfileFit[];
  /** Archiviert; fehlt es beim Anlegen, ist es das nicht. */
  isArchived?: boolean;
  /** null = flow-driven profile (brewSteps present), no Xenia script. */
  scriptIdSingle: number | null;
  scriptIdDouble?: number | null;
  yieldTargetSingleG?: number | null;
  yieldTargetDoubleG?: number | null;
  isFavorite?: boolean;
  favoriteOrder?: number | null;
  notes?: string | null;
  /** Absolute brew setpoint °C, or null for no target (PT-1). */
  targetTempC?: number | null;
  /** Step-based definition, or null for a classic script-only profile. */
  brewSteps?: BrewProfile | null;
  /** Optional 2×-slot sequence, or null to reuse brewSteps for the 2× shot. */
  brewStepsDouble?: BrewProfile | null;
  /** Schnitt 3c: die Varianten fuehren — die Kurven-Felder oben leiten sich dann daraus ab. */
  variants?: ProfileVariantInput[];
};

/** Body for PUT /api/profiles/:id — all fields optional. */
export type ProfileUpdate = Partial<ProfileCreate>;

export type ShotSize = "single" | "double";

export interface ExecuteRequest {
  profileId: number;
  shotSize: ShotSize;
  /** Schnitt 3d: die gestartete Variante. Fehlt sie, gilt der Platz aus shotSize (wie bisher). */
  variantId?: number | null;
  /** Schnitt 3d: das benutzte Sieb; fehlt es, gilt das Vorgabe-Sieb der Variante. */
  basketId?: number | null;
  // Step 9 — optional pre-shot data, carried into the resulting shot record.
  // Omitted fields are not persisted; explicit null clears the field.
  beanId?: number | null;
  /** Freitext-Bohne fuer Fremdbohnen, die hier nicht gepflegt werden (z. B. Turbo
   *  mit Filterbohne). Schliesst sich mit beanId nicht aus, ist aber als Ersatz
   *  gedacht: entweder gepflegte Bohne ODER Name, sonst keins von beiden. */
  beanLabel?: string | null;
  grinderId?: number | null;
  grindSetting?: number | null;
  grinderRpm?: number | null;
  doseG?: number | null;
  notes?: string | null;
  // Per-shot yield override. When set, replaces the profile's yield target for
  // THIS shot only (recording + BbW stop threshold). null/omitted = use profile.
  yieldTargetOverrideG?: number | null;
}

export interface ExecuteResult {
  ok: true;
  scriptId: number;
  hasCmd27: boolean;
  cmd27Value: number | null;
  /** How this shot will be stopped:
   *  'cmd27' = Xenia stops via Cmd 27 (weight-based, machine-native)
   *  'app'   = App will stop via /scripts/stop (brew-by-weight active + yield target set)
   *  'none'  = Script runs to end or user stops manually */
  stopMode: "cmd27" | "app" | "none";
}

// ---------------------------------------------------------------------------
// Flow-hold drive (Consistent-Flow, Phase 1)
// ---------------------------------------------------------------------------

/**
 * Tunable flow-hold parameters. All optional overrides for a single built-in
 * Consistent-Flow config (defaults live in the backend driver). Live tuning
 * happens through these during Block 4 — the API surface is deliberately flat.
 */
export interface FlowHoldOverrides {
  /** Target scale-flow to hold (g/s). */
  targetFlowGs?: number;
  /** Output floor (%) — the dead-zone / minimum pump power that still pumps. */
  powerFloor?: number;
  /** Initial open-loop pump power (%) used to seed the flow/pressure controller
   *  of step 0. Pre-infusion is otherwise an explicit PowerStep, not a ramp. */
  rampStartPower?: number;
  /** PI proportional gain. */
  kp?: number;
  /** PI integral gain. */
  ki?: number;
  /** EMA smoothing factor for the flow measurement (0..1). */
  emaAlpha?: number;
  /** Asymmetric output slew limit (pump-% per second): how fast the PI may raise
   *  (`slewUpPerS`) vs lower (`slewDownPerS`) power. Tight-up/loose-down is the
   *  anti-gush tuning for soft (spent) pucks. */
  slewUpPerS?: number;
  slewDownPerS?: number;
  /** Last-resort ceiling on accumulated pump-ON time (ms) → hard stop. Paddle has
   *  no firmware pump-limit, so this is the flow-hold analogue of that safety net.
   *  Counts pumping time only, so a bloom pause does not consume it. */
  maxBrewMs?: number;
  /** Which flow controller regulates the pump: adaptive plant-inversion (Phase B,
   *  default) or the fixed-gain PI (Phase A fallback). */
  controller?: FlowControllerKind;
  /** Resolved step sequence for the drive (from the profile's BrewProfile).
   *  Cut 1 executes flow-only steps; other kinds/limiters are rejected at start. */
  steps?: BrewStep[];
}

// ---------------------------------------------------------------------------
// Unified step-based brew profile (Decent-style)
//
// A profile is an ordered sequence of typed steps. Each step commands the pump
// (paddle mode) toward a primary quantity — flow, pressure, or raw power — with
// an optional limiter on the other quantity, and exits on the first met
// condition. The whole brew stays in one paddle run (the app is the controller);
// there is no script hand-off. A PowerStep is the open-loop power curve that a
// Xenia script segment used to provide.
//
// CUT 2 SCOPE: FlowStep, PressureStep and PowerStep all execute live via the
// step sequencer. Exits: seconds / weightG / pressureBar / flowGs.
// ---------------------------------------------------------------------------

export type FlowControllerKind = "adaptive" | "pi";

/** Advance to the next step on the FIRST condition met. At least one required. */
export interface StepExit {
  /** Seconds elapsed within this step. */
  seconds?: number;
  /** Scale weight (g) reached. */
  weightG?: number;
  /** Pressure (bar) reached — advances when measured pressure ≥ this. */
  pressureBar?: number;
  /** Flow (g/s) fallen to — advances when measured flow ≤ this (decline exit). */
  flowGs?: number;
  /**
   * Pressure (bar) fallen back to — advances when measured pressure ≤ this.
   *
   * Das Gegenstueck zu `pressureBar`: es beendet eine Stufe, wenn der Druck
   * wieder ABGEBAUT ist (Meticulous' "Dynamic Bloom" — der Puck hat genug
   * aufgenommen, statt nach geratener Zeit weiterzugehen).
   *
   * ⚠ Scharf erst, nachdem der Druck in DIESER Stufe einmal ueber dem Wert
   * lag. Sonst feuert das Kriterium im ersten Frame, wenn die Stufe ohnehin
   * unterhalb startet. Kann es dadurch nie feuern, laeuft die Stufe weiter —
   * ein `seconds`-Ausstieg als Netz gehoert dazu.
   */
  pressureBelowBar?: number;
  /**
   * Flow (g/s) risen to — advances when measured cup flow ≥ this (Decent
   * `flow_over`). Fires at once, like `pressureBar`; no arming.
   */
  flowAboveGs?: number;
}

/** Hold a target flow (g/s). Optional pressure cap (limiter). */
export interface FlowStep {
  kind: "flow";
  /** Optional freetext phase name; the UI falls back to a derived label. */
  name?: string;
  /** Ton am Ende der Stufe, auf dem Geraet, das den Bezug gestartet hat. */
  tone?: boolean;
  targetFlowGs: number;
  maxPressureBar?: number;
  controller?: FlowControllerKind;
  /** Linear setpoint ramp: interpolate from the entry flow to `targetFlowGs`
   *  over `rampMs`, then hold. Omitted/0 = jump straight to target. */
  rampMs?: number;
  /** Gagne: Ziel ist der Tassenfluss beim Eintritt (Mittel der letzten ~1 s),
   *  nicht `targetFlowGs` — die Stufe haelt den Fluss, den der Puck an der
   *  Druckspitze davor von selbst liefert. `targetFlowGs` bleibt der erwartete
   *  Wert (Kurve) und gilt, wenn beim Eintritt noch kein Fluss da ist — in
   *  der ersten Stufe also immer. */
  adoptFlow?: boolean;
  exit: StepExit;
}

/** Hold a target pressure (bar). Optional flow cap (limiter). */
export interface PressureStep {
  kind: "pressure";
  /** Optional freetext phase name; the UI falls back to a derived label. */
  name?: string;
  /** Ton am Ende der Stufe, auf dem Geraet, das den Bezug gestartet hat. */
  tone?: boolean;
  targetPressureBar: number;
  maxFlowGs?: number;
  /** Linear setpoint ramp: interpolate from the entry pressure to
   *  `targetPressureBar` over `rampMs`, then hold. Omitted/0 = jump to target. */
  rampMs?: number;
  /** Decent HOLD-P: Ziel ist der Druck beim Eintritt, nicht `targetPressureBar`
   *  — die Stufe haelt, was der Puck gerade aufbaut. `targetPressureBar` bleibt
   *  der erwartete Wert (Kurve) und gilt, wenn beim Eintritt noch kein Druck
   *  da ist (unter 0,5 bar). Gegenstueck zu FlowStep.adoptFlow. */
  adoptPressure?: boolean;
  exit: StepExit;
}

/** Open-loop pump-power segment (the app-side equivalent of a script segment).
 *  Holds `power` (%). Optional linear ramp: interpolate from the entry power
 *  (the previous power step's value, or 0 for step 0) to `power` over `rampMs`,
 *  then hold — same "one target + Übergang" model as FlowStep/PressureStep.
 *  Omitted/0 = jump straight to `power`. Optional pressure AND flow caps: both
 *  quantities are unregulated here, so either may be capped. */
export interface PowerStep {
  kind: "power";
  /** Optional freetext phase name; the UI falls back to a derived label. */
  name?: string;
  /** Ton am Ende der Stufe, auf dem Geraet, das den Bezug gestartet hat. */
  tone?: boolean;
  power: number;
  maxPressureBar?: number;
  maxFlowGs?: number;
  rampMs?: number;
  exit: StepExit;
}

/** Wie zuegig die Preinfusion den Puck saettigt, sobald er Gegendruck aufbaut;
 *  "none" bremst nicht und fuellt bis zum Ausstieg weiter (wie die Decent). */
export type PreinfusionGentleness = "gentle" | "normal" | "brisk" | "none";

/** Wie schnell die Preinfusion den leeren Raum ueber dem Kaffee fuellt, bis der
 *  erste Gegendruck kommt: "normal" mit 3,5 ml/s, "fast" mit voller Pumpe. */
export type PreinfusionFill = "normal" | "fast";

/** Preinfusion ueber den rechnerischen Zulauf (shared/pump-curve.ts): fuellen mit
 *  festem Zulauf, ab ~1 bar Gegendruck sanfter saettigen, und sobald der Kaffee
 *  in der Tasse ankommt (Fluss ≥ 90 % des Startflusses der naechsten Flussstufe)
 *  uebernimmt diese — am Arbeitspunkt statt mit dem Schwung einer festen Leistung.
 *  `exit` sind die Schutzgrenzen (Zeit, Druck), falls der Kaffee nicht ankommt. */
export interface PreinfusionStep {
  kind: "preinfusion";
  /** Optional freetext phase name; the UI falls back to a derived label. */
  name?: string;
  /** Ton am Ende der Stufe, auf dem Geraet, das den Bezug gestartet hat. */
  tone?: boolean;
  /** Omitted = "normal". */
  gentleness?: PreinfusionGentleness;
  /** Omitted = "normal" — so bleibt der Hash bestehender Profile gleich. */
  fill?: PreinfusionFill;
  /** Sanfter Anlauf der Pumpe (ms). Omitted = 3000. */
  rampMs?: number;
  exit: StepExit;
}

export type BrewStep = FlowStep | PressureStep | PowerStep | PreinfusionStep;

/** The step-based definition persisted on a profile (profile.brew_steps JSON).
 *  The drive starts directly at step 0 — pre-infusion is an explicit PowerStep,
 *  not a dedicated ramp phase. */
export interface BrewProfile {
  version: 1;
  steps: BrewStep[];
}

export interface DriveStartRequest {
  profileId: number;
  shotSize: ShotSize;
  /** Schnitt 3d: die gestartete Variante (siehe ExecuteRequest). */
  variantId?: number | null;
  /** Schnitt 3d: das benutzte Sieb. */
  basketId?: number | null;
  /** Per-drive yield override (g); null/omitted = profile default. */
  yieldTargetOverrideG?: number | null;
  // Pre-shot data carried into the resulting shot record (as with execute).
  beanId?: number | null;
  /** Freitext-Bohne fuer Fremdbohnen, die hier nicht gepflegt werden (z. B. Turbo
   *  mit Filterbohne). Schliesst sich mit beanId nicht aus, ist aber als Ersatz
   *  gedacht: entweder gepflegte Bohne ODER Name, sonst keins von beiden. */
  beanLabel?: string | null;
  grinderId?: number | null;
  grindSetting?: number | null;
  grinderRpm?: number | null;
  doseG?: number | null;
  notes?: string | null;
  /** Optional live-tuning overrides for the built-in Consistent-Flow config. */
  overrides?: FlowHoldOverrides;
}

export interface DriveStartResult {
  ok: true;
  /** null for step-based profiles that carry no Xenia script. */
  scriptId: number | null;
  /** null = kein Ziel, die letzte Stufe beendet den Bezug. */
  yieldTargetG: number | null;
  targetFlowGs: number;
}

// ---------------------------------------------------------------------------
// Script parser types
// ---------------------------------------------------------------------------

/** A single parsed command from a Xenia script token. */
export interface ParsedCmd {
  cmd: number;
  args: (number | string)[];
  /** German label from CMD_DICTIONARY, or "UNKNOWN" for unrecognized Cmd IDs. */
  meaning: string;
  /** Named arg labels from CMD_DICTIONARY (e.g. ["pressure_mbar", "duration_ms"]). */
  argLabels: string[];
}

/** Result of parseScript(). Always defined — never throws. */
export interface ParsedScript {
  commands: ParsedCmd[];
  /** Cmd IDs not found in CMD_DICTIONARY (forward-compat for new firmware). */
  unknownCmds: number[];
  /** Set when input is empty or non-string. commands will be []. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Xenia script (cached from machine, stored in xenia_script table)
// ---------------------------------------------------------------------------

export interface XeniaScript {
  /** Xenia script ID (from /scripts/list index_list). */
  id: number;
  title: string;
  /** Raw semicolon-separated token string from /scripts/read. */
  content: string;
  /** Parsed command list. null if not yet parsed. */
  parsedCmds: ParsedScript | null;
  /** True if the script contains at least one Cmd 27 (weight-based stop). */
  hasCmd27: boolean;
  /** Last Cmd 27 target value in grams, or null if no Cmd 27. */
  cmd27Value: number | null;
  /** Auto-detected category based on title keywords and command content. */
  categoryAuto: "brew" | "maintenance" | "unknown" | null;
  /**
   * SE-2: manual category override (local app metadata, never on the machine).
   * null = use categoryAuto. Feeds effectiveCategory() at the BBW arming gate.
   */
  categoryOverride: "brew" | "maintenance" | null;
  /** Unix timestamp (ms) when this script was last fetched from the machine. */
  fetchedAt: number;
  /** Unix timestamp (ms) when marked orphaned, or null if still on machine. */
  orphanedAt: number | null;
}

// ---------------------------------------------------------------------------
// Script sync result
// ---------------------------------------------------------------------------

export interface SyncResult {
  added: number;
  updated: number;
  orphaned: number;
  errors: Array<{ id: number; error: string }>;
}

// ---------------------------------------------------------------------------
// Bean — Phase 1 Step 8
// ---------------------------------------------------------------------------

/**
 * Physical status of a roasting (Röstung) — §3.4b/3g. This is the *physical*
 * axis only; whether a roasting is the "active source" for new shots is a
 * separate, free flag (`Bean.isActive`). `active` was removed in 3g (it
 * conflated the two axes) — migrated rows became `thawed` + `is_active=1`.
 */
export type BeanStatus = "stock" | "frozen" | "thawed" | "archived";
export type BeanRating = "thumbs_down" | "meh" | "thumbs_up";
export type RoastLevel = "light" | "light-medium" | "medium" | "medium-dark" | "dark";
/** Intended brewing method for a bean. */
export type BrewType = "espresso" | "filter" | "omni";

// ---------------------------------------------------------------------------
// Coffee (Sorte) — §3.4b "Klammer". Canonical master data + favourite + rating
// that stay constant across re-purchases. A Bean (below) is now a *Röstung*
// (charge/bag) that points at exactly one Coffee via coffeeId.
// ---------------------------------------------------------------------------

export interface Coffee {
  id: number;
  name: string;
  roaster: string | null;
  country: string | null;
  region: string | null;
  farm: string | null;
  variety: string | null;
  processing: string | null;
  altitudeMin: number | null;
  altitudeMax: number | null;
  roastLevel: RoastLevel | null;
  brewType: BrewType | null;
  /** Stored as JSON in DB, exposed as string array. */
  flavorNotes: string[];
  notes: string | null;
  favourite: boolean;
  /** Canonical rating ("do I like this coffee"). The normal thing the user sets. */
  rating: BeanRating | null;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. */
  updatedAt: number;
  /** Derived (API only): when the photo of this Sorte was last stored, or null
   *  when there is none. The image itself comes from /api/coffees/:id/image;
   *  this timestamp says whether one exists AND busts the browser cache after
   *  a replacement (the image response is served immutable). */
  imageUpdatedAt?: number | null;
  /** Derived (API only): number of roastings (beans) under this coffee. */
  roastingCount?: number;
  /** Derived (API only): total shots across all roastings of this coffee. */
  shotCount?: number;
  /** Derived (API only): unix ms of the newest brew shot; null = nie bezogen. */
  lastShotAt?: number | null;
}

export interface CoffeeCreate {
  name: string;
  roaster?: string | null;
  country?: string | null;
  region?: string | null;
  farm?: string | null;
  variety?: string | null;
  processing?: string | null;
  altitudeMin?: number | null;
  altitudeMax?: number | null;
  roastLevel?: RoastLevel | null;
  brewType?: BrewType | null;
  flavorNotes?: string[];
  notes?: string | null;
  favourite?: boolean;
  rating?: BeanRating | null;
}

export type CoffeeUpdate = Partial<CoffeeCreate>;

/**
 * Optional first roasting created atomically alongside a new Coffee
 * (§3.4b / §3i). Keys are the exact `BeanCreate` field names — importable via
 * the nested `firstRoasting` block. `remainingG` is intentionally NOT part of
 * this payload: the combined create always sets `remaining = bagSizeG` (full
 * bag), exactly like "Nachkaufen". `frozenDate`/`thawDate` are derived
 * server-side from `status` (mirrors `setStatus`), never sent by the client.
 */
export interface CoffeeFirstRoasting {
  roastDate?: string | null;
  bagSizeG?: number | null;
  pricePerBagEur?: number | null;
  /** Physical status; defaults to `stock` when omitted (like "Nachkaufen"). */
  status?: BeanStatus;
  /** Active-source flag; defaults to `true` for a first roasting. */
  isActive?: boolean;
}

/**
 * Payload for `POST /api/coffees`. The master-data fields are `CoffeeCreate`;
 * the optional `firstRoasting` block triggers the atomic combined create
 * (Sorte + erste Röstung in einer Transaktion). Backward-compatible: omitting
 * `firstRoasting` is the legacy Sorte-only create.
 */
export type CoffeeCreatePayload = CoffeeCreate & {
  firstRoasting?: CoffeeFirstRoasting | null;
};

/** Result of the shared coffee-matching component (migration/import/merge). */
export type MatchVerdict = "sicher" | "unklar" | "kein-treffer";

export interface MatchCandidate {
  coffeeId: number;
  name: string;
  roaster: string | null;
  verdict: MatchVerdict;
  /** Combined 0..1 similarity (higher = more similar). */
  score: number;
}

export interface Bean {
  id: number;
  /** §3.4b: the Coffee (Sorte) this roasting belongs to. */
  coffeeId: number;
  name: string;
  roaster: string | null;
  country: string | null;
  region: string | null;
  farm: string | null;
  variety: string | null;
  processing: string | null;
  altitudeMin: number | null;
  altitudeMax: number | null;
  /** ISO 8601 date (YYYY-MM-DD). */
  roastDate: string | null;
  roastLevel: RoastLevel | null;
  /** Intended brewing method — null if not specified. */
  brewType: BrewType | null;
  bagSizeG: number | null;
  /**
   * Abgeleitet: Anker minus Dosis aller Brueh-Bezuege danach. Anker ist die
   * Beutelgroesse, bis jemand "Verbleibend" von Hand setzt. Kann negativ sein
   * (mehr bezogen als der Beutel hergibt); null, wenn es keinen Anker gibt.
   */
  remainingG: number | null;
  /** Abgeleitet: Rest reicht nicht mehr fuer einen weiteren Bezug. */
  stockDepleted: boolean;
  /** Wann der Aufgebraucht-Hinweis weggeklickt wurde (unix ms); null = offen. */
  stockAlertDismissedAt: number | null;
  pricePerBagEur: number | null;
  /** Stored as JSON in DB, exposed as string array. */
  flavorNotes: string[];
  notes: string | null;
  status: BeanStatus;
  /**
   * §3g: "active source" flag — independent of the physical `status`. Any
   * number of roastings can be active at once. The Pre-Shot picker shows only
   * `isActive` roastings; the Beans top-group is coffees with ≥1 active roasting.
   */
  isActive: boolean;
  /** ISO 8601 date — set when status changes to 'frozen'. */
  frozenDate: string | null;
  /** ISO 8601 date — set when status changes to 'thawed'. */
  thawDate: string | null;
  /**
   * §3.4b: charge-level rating OVERRIDE. null = inherit from coffee.rating.
   * Use `effectiveRating` for display.
   */
  rating: BeanRating | null;
  /** Mirror of coffee.favourite (favourite lives on the Coffee). */
  favourite: boolean;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. */
  updatedAt: number;
  // --- Derived/joined fields (API responses only) ---
  // §3.4b: the master-data fields above (name, roaster, country, region, farm,
  // variety, processing, altitudeMin/Max, roastLevel, brewType, flavorNotes,
  // notes, favourite) are sourced from the parent Coffee and are read-only on a
  // Bean — edit them on the Coffee. They remain on the Bean response for
  // backward compatibility with the current UI.
  /** Effective age in days = days since roastDate − frozen duration. null if no roastDate. */
  effectiveAgeDays?: number | null;
  /** bean.rating ?? coffee.rating. */
  effectiveRating?: BeanRating | null;
  /** SD-2: number of shots recorded against this roasting (API responses). */
  shotCount?: number;
  /** Derived (API only): unix ms of the newest brew shot; null = nie bezogen. */
  lastShotAt?: number | null;
}

export interface BeanCreate {
  name: string;
  /**
   * §3.4b: attach this roasting to an existing Coffee. When omitted, the
   * create endpoint resolves/creates a Coffee from name+roaster (matching
   * component) — keeps the legacy flat create working.
   */
  coffeeId?: number;
  roaster?: string | null;
  country?: string | null;
  region?: string | null;
  farm?: string | null;
  variety?: string | null;
  processing?: string | null;
  altitudeMin?: number | null;
  altitudeMax?: number | null;
  roastDate?: string | null;
  roastLevel?: RoastLevel | null;
  brewType?: BrewType | null;
  bagSizeG?: number | null;
  remainingG?: number | null;
  pricePerBagEur?: number | null;
  flavorNotes?: string[];
  notes?: string | null;
  status?: BeanStatus;
  /** §3g: active-source flag (default false for new roastings). */
  isActive?: boolean;
  frozenDate?: string | null;
  thawDate?: string | null;
  rating?: BeanRating | null;
  favourite?: boolean;
}

export type BeanUpdate = Partial<BeanCreate>;

// ---------------------------------------------------------------------------
// Grinder — Phase 1 Step 8
// ---------------------------------------------------------------------------

export interface Grinder {
  id: number;
  name: string;
  supportsRpm: boolean;
  rpmMin: number | null;
  rpmMax: number | null;
  notes: string | null;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. */
  updatedAt: number;
}

export interface GrinderCreate {
  name: string;
  supportsRpm?: boolean;
  rpmMin?: number | null;
  rpmMax?: number | null;
  notes?: string | null;
}

export type GrinderUpdate = Partial<GrinderCreate>;

// ---------------------------------------------------------------------------
// Sieb — Ausruestung wie die Muehle (vereinter Editor, Schnitt 3b). Kurzer
// Name („IMS 1er“), freie Beschreibung, Nenndosis. Das Sieb selbst ist die
// Einheit (Vorbelegung, Geisterkurven, Hinweis im Start-Dialog); der Typ
// bleibt nur fuer die alte 1×/2×-Zuordnung (shot_size) und wird nicht mehr
// abgefragt — ein 3er-Sieb ist einfach ein weiteres Sieb.
// ---------------------------------------------------------------------------

export type BasketType = "single" | "double" | "he";
export const BASKET_TYPES: BasketType[] = ["single", "double", "he"];

export interface Basket {
  id: number;
  name: string;
  type: BasketType;
  /** Frei, z. B. „HE-Basket Mischief, 18 Löcher“; null = keine. */
  description: string | null;
  /** Dosis-Vorschlag (g), solange es mit dem Sieb keinen Bezug gibt; null = keiner. */
  nominalDoseG: number | null;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. */
  updatedAt: number;
}

export interface BasketCreate {
  name: string;
  /** Fehlt er, gilt „single“ — nur noch fuer die alte 1×/2×-Zuordnung. */
  type?: BasketType;
  description?: string | null;
  nominalDoseG?: number | null;
}

export type BasketUpdate = Partial<BasketCreate>;

// ---------------------------------------------------------------------------
// Shot recording — Phase 1 Step 5
// ---------------------------------------------------------------------------

/**
 * How the shot was stopped.
 *  - 'app'        — brew-by-weight stop sent AND accepted by the machine (HTTP 200).
 *  - 'app_failed' — brew-by-weight stop was attempted but every send (incl. retries)
 *                   failed; the shot is NOT booked as a successful app stop and is
 *                   excluded from residual-lag auto-calibration.
 *  - 'watchdog'   — the BBW safety watchdog (§4.12) had to intervene: the normal
 *                   BBW stop did not halt the machine within the stop-lag bound,
 *                   or the yield overshot its bound, so the watchdog re-fired the
 *                   stop. Takes precedence over every other mode so the
 *                   intervention stays visible; excluded from auto-calibration.
 *  - 'flowhold'           — the app-side flow-hold drive stopped the shot at its
 *                   BBW-style projected yield (normal paddle exit). Never touches
 *                   BBW residual-lag auto-calibration.
 *  - 'flowhold_watchdog'  — the flow-hold safety watchdog had to hard-stop the
 *                   drive (machine/control action 0) — overshoot, stop-lag, or the
 *                   last-resort brew-time ceiling. Excluded from auto-calibration.
 */
export type StopMode =
  | "cmd27"
  | "app"
  | "app_failed"
  | "manual"
  | "script_end"
  | "watchdog"
  | "flowhold"
  | "flowhold_watchdog";

/** Category derived from the script at execution time. */
/** "test" = Messlauf: aufgezeichnet, zaehlt aber nirgends (nur ueber den Historien-Filter sichtbar). */
export type ShotCategory = "brew" | "maintenance" | "test";

/** A completed or in-progress shot stored in the `shot` table. */
/** Post-shot grind note (one tap). */
export type GrindNote = "finer" | "ok" | "coarser";

/**
 * Woher der vorbelegte Mahlgrad im Start-Dialog kommt (Schnitt 3e): die Stufe
 * der Kaskade und der Quellbezug samt seinem Mahlgrad-Hinweis.
 */
export interface GrindSource {
  /** „roast“: gleiches Profil + Sieb + Muehle mit einer Sorte gleichen Roestgrads — Startpunkt fuer neue Bohnen. */
  stage: "profileBasket" | "bean" | "coffee" | "roast" | "grinder";
  shotId: number;
  startedAt: number;
  grindNote: GrindNote | null;
}

/**
 * Staerke des Channelings. null bei gesetztem `channeling` heisst "unbekannt" —
 * so stehen alle Markierungen von vor der Einfuehrung (2026-09-26); sie werden
 * bewusst nicht nachtraeglich als "leicht" oder "stark" ausgegeben.
 */
export type ChannelingSeverity = "light" | "strong";
/** Geschmack gegenueber dem letzten Bezug derselben Sorte (Einstellung rating_compare_prev). */
export type VsPrev = "worse" | "same" | "better";

/** GET /api/shots/:id/compare — womit die Bewertung vergleicht. */
export interface ShotCompare {
  /** Einstellung rating_compare_prev. */
  enabled: boolean;
  /** Letzter beendeter Bezug derselben Sorte vor diesem; null = keiner (oder ohne Sorte). */
  previous: { id: number; startedAt: number; profileName: string | null; grindSetting: number | null } | null;
}

/** GET /api/shots/:id/compare-suggestions — Vorschlaege fuer „Bezuege vergleichen“. */
export interface CompareSuggestions {
  /** Letzter beendeter Bezug derselben Sorte davor. */
  previous: ShotListItem | null;
}

/**
 * Canonical taste-tag keys for the shot rating. UI labels come from i18n
 * (`shotRating.tags.*`). Stored as a JSON string array on `Shot.tasteTags`.
 * The list can be extended/changed without a schema migration.
 */
export const TASTE_TAGS = [
  "sweet",
  "fruity",
  "chocolate",
  "nutty",
  "floral",
  "caramel",
  "spicy",
] as const;
export type TasteTag = (typeof TASTE_TAGS)[number];

export interface Shot {
  id: number;
  /** null if the profile was deleted after the shot (ON DELETE SET NULL). */
  profileId: number | null;
  /** Schnitt 3: gelaufene Variante und benutztes Sieb (null = unbekannt). */
  variantId?: number | null;
  basketId?: number | null;
  /** null for app-driven step-based brews (Cut-2), which run no Xenia script. */
  scriptId: number | null;
  shotSize: ShotSize;
  category: ShotCategory;
  /** Unix ms when the first MA_STATUS=3 frame was seen. */
  startedAt: number;
  /** Unix ms when shot ended. null while still in progress. */
  endedAt: number | null;
  /** null while shot is in progress. */
  stopMode: StopMode | null;
  /** Yield target (g) copied from profile at execution time. */
  yieldTargetG: number | null;
  /** Last SCALE_WEIGHT value observed when shot ended. */
  yieldActualG: number | null;
  hasCmd27: boolean;
  cmd27Value: number | null;
  /** Free-text note added in post-shot review. */
  notes: string | null;
  // Step 8 extensions — all null until Step 9/10 populate them
  beanId: number | null;
  /** Freitext-Bohne (Fremdbohne ohne gepflegte Sorte), sonst null. */
  beanLabel: string | null;
  grinderId: number | null;
  grindSetting: number | null;
  grinderRpm: number | null;
  doseG: number | null;
  tdsPercent: number | null;
  /** Overall shot rating, 1–5 (5 = best). null = not rated. */
  rating: number | null;
  /** Acidity intensity, 1–5 (1 = none … 5 = intense). null = not set. */
  acidity: number | null;
  /** Bitterness intensity, 1–5 (1 = none … 5 = intense). null = not set. */
  bitterness: number | null;
  /** Extraction toggle — under-extracted (independent of over/channeling). */
  extractionUnder: boolean;
  /** Extraction toggle — over-extracted. */
  extractionOver: boolean;
  /** Extraction defect — channeling / uneven flow. Own marker (ÄW-A). */
  channeling: boolean;
  /** Staerke, nur bei channeling=true; null = unbekannt (Altbestand). */
  channelingSeverity: ChannelingSeverity | null;
  /** Geschmack gegenueber dem letzten Bezug derselben Sorte; null = nicht verglichen. */
  vsPrev?: VsPrev | null;
  /** Der Bezug, gegen den verglichen wurde (bleibt, auch wenn spaeter einer dazwischenkommt). */
  vsPrevShotId?: number | null;
  /** True when the machine reported a frozen/constant implausible weight the
   *  whole brew (scale glitch) → yield is null and the tablet alerts. */
  scaleFrozen: boolean;
  /** True when the scale dropped out DURING the brew (weight and rate died
   *  together while the pump was pushing — see scale-stall.ts) → the recorded
   *  yield is unverifiable, so it is null and the tablet alerts. */
  scaleLost: boolean;
  /** Selected taste tags. null = not rated. */
  tasteTags: TasteTag[] | null;
  /** Grind adjustment note. */
  grindNote: GrindNote | null;
  /** Content hash of the brew definition this shot ran (`brew_def.hash`).
   *  null for shots recorded before the column — their brew-time definition is
   *  irrecoverable and was NOT backfilled. */
  brewDefHash: string | null;
}

/** Input for ShotRepo.createShot() — fields known at shot start. */
export interface NewShot {
  profileId: number;
  /** Schnitt 3: gelaufene Variante und benutztes Sieb (null = unbekannt). */
  variantId?: number | null;
  basketId?: number | null;
  /** null for app-driven step-based brews (Cut-2), which run no Xenia script. */
  scriptId: number | null;
  shotSize: ShotSize;
  category: ShotCategory;
  startedAt: number;
  yieldTargetG: number | null;
  hasCmd27: boolean;
  cmd27Value: number | null;
  /** §3.4 T5: snapshot of the profile name at brew time. */
  profileName?: string | null;
  /** H4: snapshot of the BG set temperature (°C) at brew time. */
  profileSetTempC?: number | null;
  // Step 9 — pre-shot data from the pre-shot dialog
  beanId?: number | null;
  /** Freitext-Bohne fuer Fremdbohnen, die hier nicht gepflegt werden (z. B. Turbo
   *  mit Filterbohne). Schliesst sich mit beanId nicht aus, ist aber als Ersatz
   *  gedacht: entweder gepflegte Bohne ODER Name, sonst keins von beiden. */
  beanLabel?: string | null;
  grinderId?: number | null;
  grindSetting?: number | null;
  grinderRpm?: number | null;
  doseG?: number | null;
  notes?: string | null;
  /** Snapshot of the BrewProfile steps in effect at brew time (flow-hold drives
   *  only). null for script/execute shots. Frozen so the History Soll-Kurve
   *  reflects what THIS shot ran, not the profile as edited later. */
  brewSteps?: BrewProfile | null;
  /** Content hash of the brew definition this shot ran (→ `brew_def.hash`):
   *  the script token string, or the step JSON of a flow-hold drive. Both
   *  sources are mutable, so the hash is what makes two shots comparable. */
  brewDefHash?: string | null;
}

/** One Flow-Hold stage the driver actually entered (from `shot_stage`). Lets the
 *  History draw which target plateaus really ran (flow 1.1→1.0→0.8→0.7) and which
 *  planned ones never did. NOT derivable from Sample.phase. */
export interface ShotStage {
  /** 0-based step index into the shot's brewSteps snapshot. */
  stageIndex: number;
  stepKind: "flow" | "pressure" | "power";
  targetFlowGs: number | null;
  targetPressureBar: number | null;
  targetPower: number | null;
  /** Which StepExit branch fired to LEAVE this stage; null for the final stage
   *  (ended by the master yield stop / manual / watchdog). */
  exitReason: "seconds" | "weightG" | "pressureBar" | "pressureBelowBar" | "flowGs" | "flowAboveGs" | "arrived" | null;
  /** ms since shot.startedAt when this stage was entered. */
  enteredMs: number;
}

/** One sample row from `shot_sample`. */
export interface Sample {
  id: number;
  shotId: number;
  elapsedMs: number;
  pressureBar: number | null;
  /** Live flow rate (g/s ≈ ml/s) from the scale (PU_SENS_SCALE_RATE). */
  flowMlS: number | null;
  /** Cumulative flow-meter volume (ml, PU_SENS_FLOW_METER_VOLUME) — for Visualizer export. */
  flowMeterMl: number | null;
  tempBgC: number | null;
  tempBbC: number | null;
  weightG: number | null;
  /** Pump power level % (PU_LEVEL_PW_CONTROL). null on samples recorded before
   *  pump logging started (2026-06-23). */
  pumpPwm: number | null;
  /** Brew sub-phase: 'preinfusion' / 'extraction' / 'post_brew'. Legacy rows
   *  recorded before the split (and never backfilled) read 'brewing'. */
  phase: "preinfusion" | "extraction" | "post_brew" | "brewing";
}

/** Shot detail response: shot + all samples combined. */
export interface ShotDetail {
  shot: Shot;
  samples: Sample[];
  /** Flow-Hold stages this shot actually ran (empty for script/execute shots). */
  stages: ShotStage[];
  /** Snapshot of the BrewProfile steps in effect at brew time (null for
   *  script/execute shots or shots recorded before snapshotting). */
  brewSteps: BrewProfile | null;
  /** The frozen brew definition this shot ran (null for shots recorded before
   *  the snapshot existed). */
  brewDef: BrewDefInfo | null;
}

/** The brew definition a shot actually ran, as frozen at brew time. */
export interface BrewDefInfo {
  /** Content hash — two shots ran the same definition iff this is equal. */
  hash: string;
  /** 'script' = raw Xenia token string, 'steps' = BrewProfile JSON. */
  kind: "script" | "steps";
  /** The definition text as it ran. */
  content: string;
  /**
   * false = the profile/script has been edited since this shot. null = the
   * current definition could not be resolved (script orphaned, profile
   * deleted), so no statement is made.
   */
  isCurrent: boolean | null;
}

/**
 * A recent brew shot with joined profile/bean/grinder names — for the
 * dashboard's "recent shots" section (Step 11). Bean/grinder fields are
 * null when none was selected or the record was deleted afterwards.
 */
export interface RecentShot {
  id: number;
  profileId: number | null;
  profileName: string;
  shotSize: ShotSize;
  /** Schnitt 3: gelaufene Variante und benutztes Sieb — Wiederholen nimmt beide. */
  variantId?: number | null;
  basketId?: number | null;
  beanId: number | null;
  /** Freitext-Bohne (Fremdbohne ohne gepflegte Sorte), sonst null. */
  beanLabel: string | null;
  beanName: string | null;
  beanRoaster: string | null;
  grinderId: number | null;
  grinderName: string | null;
  grindSetting: number | null;
  grinderRpm: number | null;
  doseG: number | null;
  /** Target yield (g) from the profile/override at brew time. UP-1: carried into a repeat. */
  yieldTargetG: number | null;
  yieldActualG: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Overall shot rating, 1–5 (5 = best). null = not rated. */
  rating: number | null;
}

// ---------------------------------------------------------------------------
// Shot history — Phase 1 Step 11.5
// ---------------------------------------------------------------------------

/**
 * A shot row for the history list: shot data plus joined profile/bean/grinder
 * names. Bean/grinder fields are null when none was selected (or the record
 * was deleted afterwards via ON DELETE SET NULL).
 */
export interface ShotListItem {
  id: number;
  profileId: number | null;
  profileName: string;
  shotSize: ShotSize;
  /** Schnitt 3: gelaufene Variante und benutztes Sieb. */
  variantId?: number | null;
  basketId?: number | null;
  category: ShotCategory;
  startedAt: number;
  endedAt: number | null;
  /** Target yield (g) from the profile/override at brew time. null = none. */
  yieldTargetG: number | null;
  yieldActualG: number | null;
  stopMode: StopMode | null;
  /** Overall shot rating, 1–5 (5 = best). null = not rated. */
  rating: number | null;
  acidity: number | null;
  bitterness: number | null;
  extractionUnder: boolean;
  extractionOver: boolean;
  channeling: boolean;
  channelingSeverity: ChannelingSeverity | null;
  vsPrev?: VsPrev | null;
  vsPrevShotId?: number | null;
  tasteTags: TasteTag[] | null;
  grindNote: GrindNote | null;
  notes: string | null;
  beanId: number | null;
  /** Freitext-Bohne (Fremdbohne ohne gepflegte Sorte), sonst null. */
  beanLabel: string | null;
  beanName: string | null;
  beanRoaster: string | null;
  beanBrewType: BrewType | null;
  grinderId: number | null;
  grinderName: string | null;
  grindSetting: number | null;
  grinderRpm: number | null;
  doseG: number | null;
  tdsPercent: number | null;
  /** H4: BG set temperature (°C) snapshot at brew time. null if not recorded. */
  profileSetTempC: number | null;
}

/** Sort options for the history list. */
export type ShotSortKey = "date_desc" | "date_asc" | "rating" | "bean";

/** Response of GET /api/shots (history list, filtered + paginated). */
export interface ShotListResponse {
  shots: ShotListItem[];
  total: number;
  hasMore: boolean;
}

/** Body for PUT /api/shots/:id — only these fields may be edited. */
export interface ShotUpdate {
  /** Schnitt 3e: das benutzte Sieb korrigieren; shot_size folgt seinem Typ. */
  basketId?: number;
  beanId?: number | null;
  beanLabel?: string | null;
  grinderId?: number | null;
  grindSetting?: number | null;
  grinderRpm?: number | null;
  doseG?: number | null;
  tdsPercent?: number | null;
  /** Overall shot rating 1–5 (5 = best). null clears it. */
  rating?: number | null;
  acidity?: number | null;
  bitterness?: number | null;
  extractionUnder?: boolean;
  extractionOver?: boolean;
  channeling?: boolean;
  /** Gesetzt → channeling wird true; channeling=false → Staerke wird geleert. */
  channelingSeverity?: ChannelingSeverity | null;
  /** Vergleich mit dem letzten Bezug; null loescht ihn (samt vsPrevShotId). */
  vsPrev?: VsPrev | null;
  vsPrevShotId?: number | null;
  tasteTags?: TasteTag[] | null;
  grindNote?: GrindNote | null;
  notes?: string | null;
}
