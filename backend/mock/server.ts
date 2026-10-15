/**
 * Xenia DBL Mock Server — Phase 1 Step 6.5.
 *
 * Standalone Fastify process that mimics the Xenia HTTP API well enough for
 * frontend development and structural BbW testing without the real machine.
 *
 * Endpoints implemented:
 *   GET  /api/v2/overview         — heartbeat frame (polled by backend)
 *   GET  /api/v2/overview_single  — setpoints
 *   GET  /api/v2/machine          — FW info (hardcoded)
 *   GET  /api/v2/scripts/list     — list of mock scripts
 *   POST /api/v2/scripts/read     — read script content by FILE_NAME
 *   POST /api/v2/machine/control  — power on/off/eco
 *   POST /api/v2/toggle_sb        — steam boiler toggle
 *   POST /api/v2/inc_dec          — setpoint update
 *   POST /api/v2/scripts/execute  — start brewing simulation
 *   POST /api/v2/scripts/script-stop — stop brewing
 *
 * NOT simulated:
 *   - Realistic pressure curve (pump held at a fixed ~9 bar during extraction)
 *   - ECO-mode temperature reduction (returns same setpoints, just different MA_STATUS)
 *   - MA_EXTRACTIONS counter increment
 *   - MA_LAST_EXTRACTION_ML
 */

import Fastify from "fastify";

const PORT = 3099;

// ---------------------------------------------------------------------------
// Mock script definitions
// ---------------------------------------------------------------------------

interface MockScript {
  id: number;
  title: string;
  content: string;
  durationMs: number;
  hasCmd27: boolean;
  cmd27TargetG: number | null;
}

const MOCK_SCRIPTS: MockScript[] = [
  {
    id: 1,
    title: "Mock Espresso 1x",
    // Cmd 1=start, 13=track scale, 4 6000 2000=pre-infuse, 12 25000=brew 25s, 17=flush, 7=stop
    content: "1\n13\n4 6000 2000\n12 25000\n17\n7\n",
    durationMs: 33_000, // 6s pre-infuse + 25s brew + 2s flush
    hasCmd27: false,
    cmd27TargetG: null,
  },
  {
    id: 2,
    title: "Mock Spülen",
    content: "1\n12 10000\n7\n",
    durationMs: 10_000,
    hasCmd27: false,
    cmd27TargetG: null,
  },
  {
    id: 3,
    title: "Mock mit Cmd27",
    // Cmd 27 20 = stop pump when scale reaches 20g
    content: "1\n13\n4 4000 1500\n27 20\n12 30000\n17\n7\n",
    durationMs: 35_000,
    hasCmd27: true,
    cmd27TargetG: 20,
  },
];

const SCRIPT_MAP = new Map(MOCK_SCRIPTS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Machine state
// ---------------------------------------------------------------------------

type MachinePhase = "off" | "on" | "eco" | "brewing" | "draining";

interface SetpointState {
  bgTemp: number;  // brew group target °C
  bbTemp: number;  // brew boiler target °C
  sbPress: number; // steam boiler target bar
}

interface ActiveBrew {
  startedAt: number;
  script: MockScript;
  /** Flow rate in g/s during steady state (varies per shot for realism) */
  targetFlowGPerS: number;
}

const SETPOINTS: SetpointState = { bgTemp: 93.0, bbTemp: 95.0, sbPress: 1.3 };

let phase: MachinePhase = "off";
let steamBoilerOn = false;

// Temperatures start cold — warm up as machine turns on
let brewGroupTemp = 22.0;
let brewBoilerTemp = 22.0;
let steamBoilerPress = 0.0;

let pumpPressure = 0.0;
let flowMeterMl = 0.0;
let scaleWeightG = 0.0;
let activeBrew: ActiveBrew | null = null;

// MA_STATUS mapping
function maStatus(): number {
  switch (phase) {
    case "off":      return 0;
    case "on":       return 1;
    case "eco":      return 2;
    case "brewing":  return 3;
    case "draining": return 4;
  }
}

// ---------------------------------------------------------------------------
// Physics simulation — runs every 250ms (independent of brewing tick)
//
// Heat-up uses asymptotic approach: new = current + (target - current) * α
// This naturally prevents overshoot and produces a realistic S-curve.
// ---------------------------------------------------------------------------

/** Asymptotic heat-up factor per 250ms tick when machine is on. */
const HEAT_ALPHA = 0.05;

function simulateTick(): void {
  const isActive = phase === "on" || phase === "brewing" || phase === "draining";

  if (isActive) {
    // Asymptotic warm-up — no overshoot possible
    brewGroupTemp  += (SETPOINTS.bgTemp - brewGroupTemp)  * HEAT_ALPHA;
    brewBoilerTemp += (SETPOINTS.bbTemp - brewBoilerTemp) * HEAT_ALPHA;

    // Steam boiler pressure builds when SB is on
    if (steamBoilerOn) {
      steamBoilerPress += (SETPOINTS.sbPress - steamBoilerPress) * HEAT_ALPHA;
    } else {
      steamBoilerPress = Math.max(0, steamBoilerPress - 0.003);
    }
  } else if (phase === "eco") {
    // ECO: temps drift toward 85°C (energy-saving plateau)
    brewGroupTemp  += (85.0 - brewGroupTemp)  * HEAT_ALPHA;
    brewBoilerTemp += (85.0 - brewBoilerTemp) * HEAT_ALPHA;
    steamBoilerPress = Math.max(0, steamBoilerPress - 0.002);
  } else {
    // Off: cool down asymptotically toward 22°C ambient
    brewGroupTemp  += (22.0 - brewGroupTemp)  * 0.005;
    brewBoilerTemp += (22.0 - brewBoilerTemp) * 0.005;
    steamBoilerPress = Math.max(0, steamBoilerPress - 0.005);
  }
}

// ---------------------------------------------------------------------------
// Brewing simulation — runs every 100ms
// ---------------------------------------------------------------------------

let drainTimer: ReturnType<typeof setTimeout> | null = null;

function startDraining(afterMs = 2000): void {
  phase = "draining";
  pumpPressure = 0;
  flowMeterMl = 0;
  activeBrew = null;
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    phase = "on";
    drainTimer = null;
    console.info("[mock] Draining done → on");
  }, afterMs);
}

const BREW_TICK_MS = 100;
let brewInterval: ReturnType<typeof setInterval> | null = null;

function stopBrewInterval(): void {
  if (brewInterval !== null) {
    clearInterval(brewInterval);
    brewInterval = null;
  }
}

function startBrewSimulation(brew: ActiveBrew): void {
  stopBrewInterval();

  brewInterval = setInterval(() => {
    if (phase !== "brewing" || activeBrew === null) {
      stopBrewInterval();
      return;
    }

    const elapsedMs = Date.now() - brew.startedAt;
    const elapsedS = elapsedMs / 1000;
    const RAMP_S = 3.0;

    // Flow: ramp up over first 3s, then steady with ±5% noise
    let flowNow: number;
    if (elapsedS < RAMP_S) {
      // Linear ramp from 0 to targetFlowGPerS
      flowNow = brew.targetFlowGPerS * (elapsedS / RAMP_S);
    } else {
      const noise = 1 + (Math.random() - 0.5) * 0.1; // ±5%
      flowNow = brew.targetFlowGPerS * noise;
    }

    // Pump pressure: follows flow (0 during ramp-up, peaks at 9 bar)
    const pressureRatio = elapsedS < RAMP_S ? elapsedS / RAMP_S : 1.0;
    pumpPressure = pressureRatio * 9.0 + (Math.random() - 0.5) * 0.3;

    // Weight accumulates (g ≈ ml for water)
    const deltaG = flowNow * (BREW_TICK_MS / 1000);
    scaleWeightG += deltaG;
    // flowMeterMl holds the instantaneous flow rate (~ml/s ≈ g/s) — emitted as
    // PU_SENS_SCALE_RATE / PU_SENS_FLOW_METER_FLOWRATE below (FW 4.133 fields).
    flowMeterMl = flowNow;

    // Cmd 27 check: stop if target weight reached
    if (brew.script.hasCmd27 && brew.script.cmd27TargetG !== null) {
      if (scaleWeightG >= brew.script.cmd27TargetG) {
        console.info(
          `[mock] Cmd27 threshold reached (${scaleWeightG.toFixed(1)}g >= ` +
          `${brew.script.cmd27TargetG}g) — draining`,
        );
        stopBrewInterval();
        startDraining();
        return;
      }
    }

    // Script duration exceeded → end normally
    if (elapsedMs >= brew.script.durationMs) {
      console.info(
        `[mock] Script #${brew.script.id} duration elapsed ` +
        `(${elapsedMs}ms >= ${brew.script.durationMs}ms) — draining`,
      );
      stopBrewInterval();
      startDraining();
    }
  }, BREW_TICK_MS);
}

// Start physics tick
setInterval(simulateTick, 250);

// ---------------------------------------------------------------------------
// Fastify server
// ---------------------------------------------------------------------------

const app = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    },
  },
});

// ---------------------------------------------------------------------------
// Content-type parser: the Xenia client (and therefore the backend hitting
// this mock) sends POST requests with Content-Type: application/x-www-form-urlencoded
// but a raw JSON body. This is the Xenia POST-format quirk (Handoff 2.3).
// We register a custom parser that treats the body as JSON.
// ---------------------------------------------------------------------------

app.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v2/overview
// ---------------------------------------------------------------------------

app.get("/api/v2/overview", async () => {
  return {
    MA_STATUS: maStatus(),
    MA_EXTRACTIONS: 42,
    MA_OPERATING_HOURS: 120,
    MA_CLOCK: Math.floor(Date.now() / 1000),
    MA_CUR_PWR: phase === "off" ? 0 : 1200,
    MA_MAX_PWR: 1800,
    MA_ENERGY_TOTAL_KWH: 45.2,
    MA_LAST_EXTRACTION_ML: "36",
    BG_SENS_TEMP_A: parseFloat(brewGroupTemp.toFixed(1)),
    BG_LEVEL_PW_CONTROL: 0,
    BB_SENS_TEMP_A: parseFloat(brewBoilerTemp.toFixed(1)),
    BB_LEVEL_PW_CONTROL: 0,
    PU_SENS_PRESS: parseFloat(pumpPressure.toFixed(2)),
    PU_LEVEL_PW_CONTROL: 0,
    PU_SET_LEVEL_PW_CONTROL: 0,
    // FW 4.133 flow/scale fields (replaced the old PU_SENS_FLOW_METER_ML).
    PU_SENS_FLOW_METER_FLOWRATE: parseFloat(flowMeterMl.toFixed(1)), // instantaneous ml/s
    PU_SENS_FLOW_METER_VOLUME: parseFloat(scaleWeightG.toFixed(1)),  // cumulative ml ≈ weight
    PU_SENS_SCALE_RATE: parseFloat(flowMeterMl.toFixed(1)),          // g/s — productive flow source
    PU_SENS_SCALE_VOLUME: parseFloat(scaleWeightG.toFixed(1)),
    SB_SENS_PRESS: parseFloat(steamBoilerPress.toFixed(2)),
    SB_STATUS: steamBoilerOn ? 2 : 1, // real machine: 1=off, 2=on (frontend checks ===2)
    SCALE_WEIGHT: parseFloat(scaleWeightG.toFixed(1)),
    CPU_LOAD: 35,
  };
});

// ---------------------------------------------------------------------------
// GET /api/v2/overview_single
// ---------------------------------------------------------------------------

app.get("/api/v2/overview_single", async () => {
  return {
    BG_SET_TEMP: SETPOINTS.bgTemp,
    BB_SET_TEMP: SETPOINTS.bbTemp,
    PU_SET_PRESS: 9.0,
    SB_SET_PRESS: SETPOINTS.sbPress,
    PU_SENS_WATER_TANK_LEVEL: 1,
    MA_MAC: "AA:BB:CC:DD:EE:FF",
    MA_EXTRACTIONS_START: 0,
    PSP: null,
    POP_UP: null,
  };
});

// ---------------------------------------------------------------------------
// GET /api/v2/machine
// ---------------------------------------------------------------------------

app.get("/api/v2/machine", async () => {
  return {
    MA_TYPE: 4,          // Dual Boiler Lever
    FW_VERSION_MAJOR: 4,
    FW_VERSION_MINOR: 25,
    ESP_FW_MAJOR: 3,
    ESP_FW_MINOR: 22,
  };
});

// ---------------------------------------------------------------------------
// GET /api/v2/scripts/list
// ---------------------------------------------------------------------------

app.get("/api/v2/scripts/list", async () => {
  return {
    index_list: MOCK_SCRIPTS.map((s) => s.id),
    title_list: MOCK_SCRIPTS.map((s) => s.title),
  };
});

// ---------------------------------------------------------------------------
// POST /api/v2/scripts/read
// ---------------------------------------------------------------------------

app.post<{ Body: { FILE_NAME?: string } }>(
  "/api/v2/scripts/read",
  async (req, reply) => {
    const fileName = req.body?.FILE_NAME;
    if (!fileName) {
      return reply.status(400).send({ error: "Missing FILE_NAME" });
    }
    // FILE_NAME is zero-padded (e.g. "001"). Strip leading zeros for lookup.
    const id = parseInt(fileName, 10);
    const script = SCRIPT_MAP.get(id);
    if (!script) {
      return reply.status(404).send({ error: `Script ${fileName} not found` });
    }
    return { Content: script.content, Title: script.title };
  },
);

// ---------------------------------------------------------------------------
// POST /api/v2/machine/control
// ---------------------------------------------------------------------------

app.post<{ Body: { action?: string } }>(
  "/api/v2/machine/control",
  async (req, reply) => {
    const action = req.body?.action;
    switch (action) {
      case "0":
        phase = "off";
        pumpPressure = 0;
        stopBrewInterval();
        activeBrew = null;
        console.info("[mock] Machine → off");
        break;
      case "1":
        // On with steam
        phase = "on";
        steamBoilerOn = true;
        console.info("[mock] Machine → on (steam on)");
        break;
      case "2":
        phase = "eco";
        console.info("[mock] Machine → eco");
        break;
      case "5":
        // On without steam
        phase = "on";
        steamBoilerOn = false;
        console.info("[mock] Machine → on (steam off)");
        break;
      case "4":
        // Steam boiler ON (dedicated legacy steam action — the app uses this
        // since FW 4.133 killed /toggle_sb). Touches only the steam boiler.
        steamBoilerOn = true;
        console.info("[mock] Steam boiler → on (action 4)");
        break;
      case "3":
        // Steam boiler OFF (dedicated legacy steam action).
        steamBoilerOn = false;
        console.info("[mock] Steam boiler → off (action 3)");
        break;
      default:
        return reply.status(404).send({ error: `Unknown action: ${action}` });
    }
    reply.status(200);
    return "";
  },
);

// ---------------------------------------------------------------------------
// POST /api/v2/toggle_sb
// ---------------------------------------------------------------------------

app.post<{ Body: { TOGGLE?: boolean } }>(
  "/api/v2/toggle_sb",
  async (req, reply) => {
    if (req.body?.TOGGLE !== undefined) {
      steamBoilerOn = req.body.TOGGLE;
    } else {
      steamBoilerOn = !steamBoilerOn;
    }
    console.info(`[mock] Steam boiler → ${steamBoilerOn ? "on" : "off"}`);
    reply.status(200);
    return "";
  },
);

// ---------------------------------------------------------------------------
// POST /api/v2/inc_dec  (setpoints)
// ---------------------------------------------------------------------------

app.post<{ Body: Record<string, string> }>(
  "/api/v2/inc_dec",
  async (req, reply) => {
    const body = req.body ?? {};
    if (body["BG_SET_TEMP"]) {
      SETPOINTS.bgTemp = parseFloat(body["BG_SET_TEMP"]);
      console.info(`[mock] BG setpoint → ${SETPOINTS.bgTemp}°C`);
    }
    if (body["BB_SET_TEMP"]) {
      SETPOINTS.bbTemp = parseFloat(body["BB_SET_TEMP"]);
      console.info(`[mock] BB setpoint → ${SETPOINTS.bbTemp}°C`);
    }
    reply.status(200);
    return "";
  },
);

// ---------------------------------------------------------------------------
// POST /api/v2/scripts/execute
// ---------------------------------------------------------------------------

app.post<{ Body: { ID?: number } }>(
  "/api/v2/scripts/execute",
  async (req, reply) => {
    const id = req.body?.ID;
    if (id === undefined || id === null) {
      return reply.status(400).send({ error: "Missing ID" });
    }
    const script = SCRIPT_MAP.get(id);
    if (!script) {
      return reply.status(404).send({ error: `Script ${id} not found` });
    }
    if (phase !== "on" && phase !== "eco") {
      return reply.status(409).send({ error: `Cannot start brew in state: ${phase}` });
    }

    // Reset per-shot counters so each brew is independent
    scaleWeightG = 0;
    flowMeterMl = 0;

    // Slight flow rate variation per shot for realism (1.3–1.8 g/s)
    const targetFlowGPerS = 1.3 + Math.random() * 0.5;

    const brew: ActiveBrew = {
      startedAt: Date.now(),
      script,
      targetFlowGPerS,
    };
    activeBrew = brew;
    phase = "brewing";

    console.info(
      `[mock] Script #${id} "${script.title}" executing — ` +
      `duration=${script.durationMs}ms, flow=${targetFlowGPerS.toFixed(2)}g/s`,
    );

    startBrewSimulation(brew);

    reply.status(200);
    return "";
  },
);

// ---------------------------------------------------------------------------
// POST /api/v2/scripts/script-stop
// ---------------------------------------------------------------------------

app.post("/api/v2/scripts/script-stop", async (req, reply) => {
  if (phase !== "brewing") {
    // Idempotent — not an error if already stopped
    reply.status(200);
    return "";
  }
  console.info(
    `[mock] script-stop received — weight=${scaleWeightG.toFixed(1)}g`,
  );
  stopBrewInterval();
  startDraining();
  reply.status(200);
  return "";
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen({ port: PORT, host: "127.0.0.1" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.info(`[mock] Xenia mock server running at ${address}`);
  console.info(`[mock] To use: UPDATE settings SET value='localhost:${PORT}' WHERE key='machine_ip';`);
  console.info(`[mock] Scripts: ${MOCK_SCRIPTS.map((s) => `#${s.id} "${s.title}"`).join(", ")}`);
});
