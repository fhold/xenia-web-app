import Fastify from "fastify";
import cors from "@fastify/cors";
import { initDb, closeDb } from "./db/index.js";
import { applySchema } from "./db/schema.js";
import { seedSettings } from "./db/seed.js";
import { loadConfig } from "./config.js";
import { XeniaClient } from "./xenia/client.js";
import { XeniaPoller } from "./xenia/poller.js";
import { WsHub } from "./ws/broadcast.js";
import { ProfileTempResetStore } from "../../shared/src/profile-temp-reset.js";
import {
  PROFILE_TEMP_RESET_KEY,
  makeProfileTempResetPersistence,
  reconcileProfileTempReset,
} from "./lib/profile-temp-reset-store.js";
import { scriptToTimeline } from "../../shared/src/script-timeline.js";
import { registerMachineRoutes } from "./routes/machine.js";
import { registerMachineAddressRoute } from "./routes/machine-address.js";
import { registerScriptRoutes } from "./routes/scripts.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerProfileImportRoutes } from "./routes/profile-import.js";
import { registerShotRoutes } from "./routes/shots.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerBeanRoutes } from "./routes/beans.js";
import { registerCoffeeRoutes } from "./routes/coffees.js";
import { registerGrinderRoutes } from "./routes/grinders.js";
import { registerNetworkRoutes } from "./routes/network.js";
import { registerBasketRoutes } from "./routes/baskets.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { registerBestBrewRoutes } from "./routes/best-brew.js";
import { SqliteScriptRepo } from "./db/script-repo.js";
import { SqliteMaintenanceLogRepo } from "./db/maintenance-repo.js";
import { SqliteProfileRepo } from "./db/profile-repo.js";
import { SqliteSettingsRepo } from "./db/settings-repo.js";
import { SqliteShotRepo } from "./db/shot-repo.js";
import { SqliteBeanRepo } from "./db/bean-repo.js";
import { SqliteCoffeeRepo } from "./db/coffee-repo.js";
import { SqliteGrinderRepo } from "./db/grinder-repo.js";
import { SqliteBasketRepo } from "./db/basket-repo.js";
import { SqliteBestBrewRepo } from "./db/best-brew-repo.js";
import { ShotRecorder } from "./shots/recorder.js";
import { FlowHoldDriver } from "./xenia/flow-hold-driver.js";
import { registerDriveRoutes } from "./routes/drive.js";
import { syncAllScripts } from "./xenia/script-sync.js";
import { registerStatic } from "./static.js";
import { rootLogger, makeXeniaLogger } from "./log.js";
import { apiErrorHandler } from "./lib/api-error-handler.js";
import { frameForStartGate, FRAME_MAX_AGE_MS } from "./lib/start-gate.js";
import { normalizeOverview } from "./xenia/normalize.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = "0.0.0.0";

async function start(): Promise<void> {
  // --- Database ---
  initDb();
  applySchema();
  seedSettings();

  const config = loadConfig();

  // --- Fastify ---
  const app = Fastify({
    // Destroy all open connections on close() instead of waiting for them to
    // drain — without this, idle HTTP keep-alive sockets (e.g. from the Vite
    // dev proxy) can stall a graceful shutdown.
    forceCloseConnections: true,
    // pino-options matching log.ts (§4.13 JSON-only); `tag: "http"` injected via
    // mixin so Fastify's auto request/response logs share format with the rest.
    logger: {
      base: null,
      level: process.env["LOG_LEVEL"] ?? "info",
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ tag: "http" }),
    },
  });

  await app.register(cors, {
    origin: ["http://localhost:5173", "http://localhost:4173"],
  });

  app.setErrorHandler(apiErrorHandler);

  // A refused request has to name itself. Fastify's own logger goes to stdout,
  // which needs journald access to read, and a route cannot log its own 4xx when
  // schema validation rejects the body before the handler ever runs — so a
  // refused brew start used to leave no trace at all.
  const rejectLog = rootLogger.child({ tag: "reject" });
  app.addHook("onSend", async (req, reply, payload) => {
    if (reply.statusCode >= 400 && req.url.startsWith("/api/")) {
      rejectLog.warn(
        {
          event: "request_rejected",
          method: req.method,
          url: req.url,
          status: reply.statusCode,
          // Which device was refused. Tailscale peers arrive as 100.x, LAN
          // clients as 192.168.x — without this the "only on the tablet"
          // question cannot be answered from the log at all.
          client_ip: req.ip,
          user_agent: req.headers["user-agent"],
          body: typeof payload === "string" ? payload.slice(0, 300) : undefined,
        },
        `${reply.statusCode} ${req.method} ${req.url}`,
      );
    }
    return payload;
  });

  // --- Xenia client + poller + WS hub ---
  const client = new XeniaClient(config.machineIp, makeXeniaLogger());
  const settingsRepo = new SqliteSettingsRepo();
  // PT-2: armed-reset store shared by the WS hub (overlays it onto every
  // setpoints broadcast) and the machine routes (arm/clear it). Writes through
  // to `settings` so a restart cannot lose the pre-set values (M-5); the record
  // is reconciled against the machine below, once polling is up.
  const profileTempReset = new ProfileTempResetStore(
    makeProfileTempResetPersistence(settingsRepo),
  );
  // Hub is created before routes so machine routes can call hub.getLastFrame()
  const hub = new WsHub(rootLogger, profileTempReset);
  const scriptRepo = new SqliteScriptRepo();
  const profileRepo = new SqliteProfileRepo();
  const shotRepo = new SqliteShotRepo();
  const beanRepo = new SqliteBeanRepo();
  const coffeeRepo = new SqliteCoffeeRepo();
  const grinderRepo = new SqliteGrinderRepo();
  const basketRepo = new SqliteBasketRepo();
  const bestBrewRepo = new SqliteBestBrewRepo();
  const maintenanceLog = new SqliteMaintenanceLogRepo();
  const recorder = new ShotRecorder(shotRepo, settingsRepo, client, rootLogger);
  // Rückspül-Reminder: ÄW-B keeps maintenance runs out of the shot table, so log
  // them separately (resolving the script title here) for the backflush reminder.
  recorder.on("maintenanceRun", (scriptId, profileId) => {
    const script = scriptRepo.findById(scriptId);
    maintenanceLog.insert({
      scriptId,
      profileId,
      scriptTitle: script?.title ?? null,
      ranAt: Date.now(),
    });
    // Dashboard "maintenance running" banner: label = profile name, countdown
    // from the nominal script duration (scriptToTimeline totalMs).
    hub.broadcastMaintenanceStarted({
      scriptId,
      profileId,
      label: profileRepo.findById(profileId)?.name ?? script?.title ?? "Wartung",
      startedAt: Date.now(),
      durationMs: script?.parsedCmds ? scriptToTimeline(script.parsedCmds).totalMs : null,
    });
  });
  recorder.on("maintenanceEnded", () => hub.broadcastMaintenanceEnded());
  // Flow-hold drive (Consistent-Flow, Phase 1): app-side paddle-driven shot with a
  // PI flow loop. Shares the poller's frames with the recorder (single measuring
  // path); the driver owns its own stop.
  const flowHoldDriver = new FlowHoldDriver(client, recorder, settingsRepo, rootLogger);
  flowHoldDriver.onStage = (stage) => hub.broadcastDriveStage(stage);
  // Poller after recorder so it can extend brew-rate polling during Post-Brew-Tracking
  // (§4.12) AND while a flow-hold drive is active (MA_STATUS=5, needs the fast loop).
  const poller = new XeniaPoller(
    client,
    () => recorder.activeShotId !== null || flowHoldDriver.isActive(),
  );

  // --- Routes ---
  app.get("/health", async () => ({
    status: "ok",
    machineIp: client.host,
    pollingIdleMs: config.pollingIdleMs,
    pollingBrewMs: config.pollingBrewMs,
  }));
  // The frame a start is judged on: the cached one while it is fresh, otherwise
  // fetched straight from the machine. An isolated /overview timeout must not
  // cost the user a brew (see frameForStartGate).
  const gateFrame = () =>
    frameForStartGate(hub.getFreshFrame(FRAME_MAX_AGE_MS), async () =>
      normalizeOverview(await client.overview(), poller.getLastSetpoints()),
    );

  registerMachineRoutes(app, client, () => hub.getLastFrame(), poller, profileTempReset);
  registerMachineAddressRoute(app, {
    client,
    settings: settingsRepo,
    isBrewing: () => recorder.activeShotId !== null || flowHoldDriver.isActive(),
    log: (from, to) =>
      rootLogger.info({ tag: "machine", event: "machine_ip_changed", from, to }, `Machine IP: ${from} → ${to}`),
  });
  registerScriptRoutes(
    app,
    client,
    scriptRepo,
    profileRepo,
    settingsRepo,
    recorder,
    () => hub.getLastFrame(),
    gateFrame,
  );
  registerProfileRoutes(app, profileRepo, scriptRepo, () => hub.broadcastProfilesChanged());
  registerProfileImportRoutes(app, client, scriptRepo, profileRepo, recorder, () => hub.getLastFrame(), () => hub.broadcastProfilesChanged());
  registerShotRoutes(app, client, shotRepo, recorder, beanRepo, profileRepo, scriptRepo, bestBrewRepo, (shot) => hub.broadcastShotUpdated(shot), flowHoldDriver, settingsRepo);
  registerSettingsRoutes(app, settingsRepo);
  registerBeanRoutes(app, beanRepo, coffeeRepo, settingsRepo);
  registerCoffeeRoutes(app, coffeeRepo, beanRepo, bestBrewRepo);
  registerGrinderRoutes(app, grinderRepo);
  registerBasketRoutes(app, basketRepo);
  registerNetworkRoutes(app, shotRepo);
  registerMaintenanceRoutes(app, settingsRepo, maintenanceLog);
  registerBestBrewRoutes(app, bestBrewRepo);
  registerDriveRoutes(
    app,
    flowHoldDriver,
    recorder,
    profileRepo,
    settingsRepo,
    () => hub.getLastFrame(),
    gateFrame,
  );

  if (process.env.NODE_ENV === "production") {
    await registerStatic(app);
  }

  const machineLog = rootLogger.child({ tag: "machine" });

  poller.on("machineInfo", (info) => {
    machineLog.info(
      {
        event: "fw_info",
        fw_major: info.fwMajor,
        fw_minor: info.fwMinor,
        esp_fw_major: info.espFwMajor,
        esp_fw_minor: info.espFwMinor,
        machine_type: info.machineType,
      },
      `Xenia FW ${info.fwMajor}.${info.fwMinor}, ESP ${info.espFwMajor}.${info.espFwMinor}, type=${info.machineType}`,
    );
  });

  poller.on("connected", () => {
    machineLog.info({ event: "connected" }, "Machine connected");
    // Fresh setpoints (incl. water-tank level) right when the machine comes
    // online — power-on, reconnect, or backend boot — so the water-low banner
    // is correct immediately instead of waiting up to 60s for the next poll.
    void poller.refreshSetpoints();
  });

  poller.on("disconnected", () => {
    machineLog.warn({ event: "disconnected" }, "Machine disconnected — retrying with backoff");
  });

  poller.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    machineLog.warn({ event: "poller_error", err_msg: msg }, `Poller error: ${msg}`);
  });

  // Wire recorder to poller frames — drives the shot state machine
  poller.on("frame", (frame) => recorder.onFrame(frame));
  // Flow-hold drive control loop — one PI tick per frame (only active during a drive).
  poller.on("frame", (frame) => flowHoldDriver.onFrame(frame));
  // K-1 startup interlock: an MA=5 on the first frame with no active driver is an
  // orphaned paddle brew (the app restarted mid-drive). Paddle has no firmware
  // pump timer, so force a verified hard stop the moment we see it.
  let startupInterlockChecked = false;
  poller.on("frame", (frame) => {
    if (startupInterlockChecked) return;
    startupInterlockChecked = true;
    if (frame.machineStatus === 5 && !flowHoldDriver.isActive()) {
      void flowHoldDriver.recoverOrphanedDrive();
    }
  });
  // H4: feed setpoints to the recorder so a starting shot can snapshot BG target.
  poller.on("setpoints", (setpoints) => recorder.setSetpoints(setpoints));

  // Bridge recorder events to WebSocket broadcast
  recorder.on("shotStarted", (shot) => hub.broadcastShotStarted(shot));
  recorder.on("shotEnded", (shot, samplesCount) => {
    hub.broadcastShotEnded(shot, samplesCount);
    // Refresh the water-tank level after a brew so the banner pops the moment
    // we return to idle if the brew drained the tank (vs. up to 60s later).
    void poller.refreshSetpoints();
  });

  // Must start listening before Fastify starts (upgrade events fire on server)
  await app.listen({ port: PORT, host: HOST });

  // Attach WS hub to the now-listening server, then start polling
  hub.attach(app, poller);
  poller.start();

  const startupLog = rootLogger.child({ tag: "startup" });
  startupLog.info(
    { event: "node_version", node_version: process.version },
    `Node: ${process.version}`,
  );
  startupLog.info(
    { event: "machine_ip", machine_ip: config.machineIp },
    `Machine IP: ${config.machineIp}`,
  );

  // M-5: a profile-temp set that never got its reset now survives the restart.
  // Needs the machine's current setpoints to judge, so it runs after the first
  // refresh rather than at construction time.
  await poller.refreshSetpoints().catch(() => undefined);
  const resetOutcome = reconcileProfileTempReset(
    settingsRepo.get(PROFILE_TEMP_RESET_KEY),
    poller.getLastSetpoints(),
  );
  if (resetOutcome.action === "rearm") {
    profileTempReset.restore(resetOutcome.prev);
    startupLog.warn(
      {
        event: "profile_temp_reset_recovered",
        prev_bg_c: resetOutcome.prev.bgC,
        prev_bb_c: resetOutcome.prev.bbC,
      },
      `Machine still on a profile temp — reset to ${resetOutcome.prev.bgC}/${resetOutcome.prev.bbC} °C stays offered`,
    );
  } else if (resetOutcome.action === "drop") {
    settingsRepo.delete(PROFILE_TEMP_RESET_KEY);
    startupLog.info(
      { event: "profile_temp_reset_dropped", reason: resetOutcome.reason },
      `Stored profile-temp reset dropped: ${resetOutcome.reason}`,
    );
  } else if (resetOutcome.action === "keep") {
    startupLog.warn(
      { event: "profile_temp_reset_undecided", reason: resetOutcome.reason },
      "Profile-temp reset kept but not armed — no setpoints from the machine to check it against",
    );
  }

  // --- Script sync (fire-and-forget — no crash on failure) ---
  syncAllScripts(client, scriptRepo)
    .then((result) => {
      startupLog.info(
        {
          event: "script_sync_complete",
          added: result.added,
          updated: result.updated,
          orphaned: result.orphaned,
          errors: result.errors.length,
          error_ids: result.errors.map((e) => e.id),
        },
        `Script sync: ${result.added} added, ${result.updated} updated, ${result.orphaned} orphaned` +
          (result.errors.length > 0
            ? `, ${result.errors.length} errors: ${result.errors.map((e) => `#${e.id}`).join(", ")}`
            : ""),
      );
    })
    .catch((err: unknown) => {
      const errMsg = (err as Error).message;
      startupLog.warn(
        { event: "script_sync_failed", err_msg: errMsg },
        `Script sync failed — will retry on next refresh: ${errMsg}`,
      );
    });
  startupLog.info(
    {
      event: "polling_config",
      polling_idle_ms: config.pollingIdleMs,
      polling_brew_ms: config.pollingBrewMs,
    },
    `Polling: idle=${config.pollingIdleMs}ms, brew=${config.pollingBrewMs}ms`,
  );

  // --- Graceful shutdown ---
  // Hard timeout: if a resource refuses to close, force-exit so the process
  // never hangs in limbo. Budget includes the verified flow-hold stop (K-1):
  // machine/control 0 + a few bounded /overview confirmations.
  const SHUTDOWN_TIMEOUT_MS = 5_000;
  let shuttingDown = false;

  const shutdownLog = rootLogger.child({ tag: "shutdown" });
  const shutdown = async (signal: string): Promise<void> => {
    // Idempotent: a second Ctrl+C while shutdown is already running skips the
    // graceful path and kills the process immediately.
    if (shuttingDown) {
      shutdownLog.warn({ event: "force_exit", signal }, `${signal} again — forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;

    shutdownLog.info({ event: "signal_received", signal }, `${signal} received`);

    const hardTimeout = setTimeout(() => {
      shutdownLog.error({ event: "timeout" }, "timeout reached, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Don't let the timeout itself keep the process alive.
    hardTimeout.unref();

    try {
      // K-1: stop an active flow-hold drive FIRST (while the Xenia client is
      // still alive) with a hardware-verified stop, and block new starts — so a
      // paddle brew never keeps pumping across the teardown.
      shutdownLog.info({ event: "stop_drive" }, "stopping flow-hold drive...");
      await flowHoldDriver.shutdown();

      shutdownLog.info({ event: "stop_poller" }, "stopping poller...");
      poller.stop();

      shutdownLog.info({ event: "stop_recorder" }, "stopping shot recorder...");
      recorder.stop();

      shutdownLog.info(
        { event: "close_ws", client_count: hub.clientCount() },
        `closing websocket clients (${hub.clientCount()})...`,
      );
      hub.close();

      shutdownLog.info({ event: "close_fastify" }, "closing fastify...");
      await app.close();

      shutdownLog.info({ event: "close_db" }, "closing database...");
      closeDb();

      shutdownLog.info({ event: "done" }, "done");
      clearTimeout(hardTimeout);
      process.exit(0);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      shutdownLog.error(
        { event: "close_error", err_msg: errMsg },
        `error while closing: ${errMsg}`,
      );
      clearTimeout(hardTimeout);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((err) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  rootLogger.error(
    {
      tag: "startup",
      event: "fatal",
      err_msg: errMsg,
      stack: err instanceof Error ? err.stack : undefined,
    },
    `Fatal error during startup: ${errMsg}`,
  );
  process.exit(1);
});
