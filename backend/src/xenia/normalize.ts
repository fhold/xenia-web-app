/**
 * Maps raw Xenia API field names to normalized camelCase shapes.
 * The frontend never sees raw field names like MA_STATUS or BG_SENS_TEMP_A.
 *
 * Note on SB (Steam Boiler): the API exposes SB_SENS_PRESS (pressure in bar)
 * but NO steam boiler temperature. The Gauge in the dashboard therefore shows
 * steam pressure, not temperature — this is a deliberate deviation from the
 * Handoff 5.8.1 description which says "SB-Temp". Unit is "bar".
 */

import type {
  LiveFrame,
  MachineState,
  MachineStatus,
  SteamBoilerStatus,
  SetpointsFrame,
  MachineInfo,
} from "../../../shared/src/types.js";
import type { RawOverview, RawOverviewSingle, RawMachine } from "./client.js";

// ---------------------------------------------------------------------------
// Derived machine state (Handoff 5.7 tolerance thresholds)
// ---------------------------------------------------------------------------

/**
 * Derives the human-readable machine state from raw status + temps vs setpoints.
 *
 * For MA_STATUS=1 ('on'), we compare temps against setpoints:
 *   BG/BB: within 0.5°C of target → ready
 *   SB (no temp sensor — use pressure as proxy):
 *     SB_STATUS=1 (steam off by user choice): not blocking 'ready'
 *     SB_STATUS=2 (steam on): within 0.15 bar of target pressure → ready
 *
 * If setpoints haven't arrived yet (first 60s after backend start),
 * we default to 'heating' — safe and not misleading.
 */
function deriveMachineState(
  raw: RawOverview,
  setpoints: SetpointsFrame | null,
): MachineState {
  switch (raw.MA_STATUS) {
    case 0: return "off";
    case 2: return "eco";
    case 3: return "brewing";
    case 5: return "brewing"; // paddle/manual-pump mode — flow-hold drive is extracting
    case 4: return "draining";
    case 1: {
      if (setpoints === null) {
        // Setpoints not yet received — don't claim 'ready' prematurely
        return "heating";
      }

      const bgReady = raw.BG_SENS_TEMP_A >= setpoints.brewGroupTargetC - 0.5;
      const bbReady = raw.BB_SENS_TEMP_A >= setpoints.brewBoilerTargetC - 0.5;

      // SB has no temperature sensor. Use pressure as proxy:
      // within 0.15 bar of target counts as ready.
      // If steam is off (SB_STATUS=1), the user chose to run without steam —
      // don't block 'ready' on a boiler that's intentionally idle.
      const sbReady =
        raw.SB_STATUS === 1
          ? true
          : raw.SB_SENS_PRESS >= setpoints.steamBoilerTargetPressureBar - 0.15;

      return bgReady && bbReady && sbReady ? "ready" : "heating";
    }
    default:
      return "heating"; // unknown status, safe default
  }
}

// ---------------------------------------------------------------------------
// Public normalizers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw /overview response into a LiveFrame.
 *
 * @param setpoints - Last known setpoints, used to derive machineState.
 *   Pass null if setpoints haven't arrived yet (first 60s after startup).
 */
export function normalizeOverview(
  raw: RawOverview,
  setpoints: SetpointsFrame | null,
): LiveFrame {
  return {
    machineStatus: raw.MA_STATUS as MachineStatus,
    machineState: deriveMachineState(raw, setpoints),

    extractionCount: raw.MA_EXTRACTIONS,
    operatingHours: raw.MA_OPERATING_HOURS,
    clockSeconds: raw.MA_CLOCK,

    currentPowerAmps: raw.MA_CUR_PWR,
    maxPowerAmps: raw.MA_MAX_PWR,
    energyTotalKwh: raw.MA_ENERGY_TOTAL_KWH,
    // FW 4.133: MA_LAST_EXTRACTION_ML can be "" → parseFloat = NaN. Guard to null.
    lastExtractionMl: (() => {
      const v = parseFloat(raw.MA_LAST_EXTRACTION_ML);
      return Number.isFinite(v) ? v : null;
    })(),

    brewGroupTempC: raw.BG_SENS_TEMP_A,
    brewGroupPwm: raw.BG_LEVEL_PW_CONTROL,

    brewBoilerTempC: raw.BB_SENS_TEMP_A,
    brewBoilerPwm: raw.BB_LEVEL_PW_CONTROL,

    pumpPressureBar: raw.PU_SENS_PRESS,
    pumpPwm: raw.PU_LEVEL_PW_CONTROL,
    pumpTargetPwm: raw.PU_SET_LEVEL_PW_CONTROL,
    // FW 4.133: PU_SENS_FLOW_METER_ML reads 0 — use the scale rate as the live
    // flow, plus the flow-meter cumulative volume for export.
    flowRateGPerS: raw.PU_SENS_SCALE_RATE,
    flowMeterVolumeMl: raw.PU_SENS_FLOW_METER_VOLUME,

    steamBoilerPressureBar: raw.SB_SENS_PRESS,
    steamBoilerStatus: raw.SB_STATUS as SteamBoilerStatus,

    scaleWeightG: raw.SCALE_WEIGHT,
    // FW 4.133 dropped CPU_LOAD from /overview → default to 0 (no NaN; the
    // poller's >80% backoff simply never triggers without the field).
    cpuLoadPercent: raw.CPU_LOAD ?? 0,

    timestamp: Date.now(),
  };
}

export function normalizeOverviewSingle(raw: RawOverviewSingle): SetpointsFrame {
  return {
    brewGroupTargetC: raw.BG_SET_TEMP,
    brewBoilerTargetC: raw.BB_SET_TEMP,
    pumpTargetPressureBar: raw.PU_SET_PRESS,
    steamBoilerTargetPressureBar: raw.SB_SET_PRESS,
    waterTankLevel: raw.PU_SENS_WATER_TANK_LEVEL as 1 | 2,
    macAddress: raw.MA_MAC,
    extractionCountStart: raw.MA_EXTRACTIONS_START,
    timestamp: Date.now(),
    // PT-2: the machine frame carries no reset state; the WsHub overlays the
    // live backend store value on broadcast. Default null = no reset armed.
    profileTempPreviousSetpointC: null,
  };
}

export function normalizeMachine(raw: RawMachine): MachineInfo {
  return {
    machineType: raw.MA_TYPE,
    fwMajor: raw.FW_VERSION_MAJOR,
    fwMinor: raw.FW_VERSION_MINOR,
    espFwMajor: raw.ESP_FW_MAJOR,
    espFwMinor: raw.ESP_FW_MINOR,
  };
}
