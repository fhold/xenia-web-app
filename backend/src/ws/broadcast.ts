import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import type { XeniaPoller } from "../xenia/poller.js";
import type { Logger } from "../log.js";
import type { WsMessage, LiveFrame, SetpointsFrame, Shot, MaintenanceRun, DriveStage } from "../../../shared/src/types.js";
import type { ProfileTempResetStore } from "../../../shared/src/profile-temp-reset.js";

// How often to ping clients to detect stale connections
const HEARTBEAT_INTERVAL_MS = 30_000;
// Terminate only after this many consecutive un-answered pings. One missed pong
// is normal on mobile (Android briefly freezes a backgrounded PWA's socket) —
// killing on the first miss caused heavy reconnect churn and dropped broadcasts.
const MAX_MISSED_PONGS = 2;

// Extend WebSocket to track liveness
interface TrackedWs extends WebSocket {
  // Consecutive heartbeats with no pong reply; reset to 0 on every pong.
  missedPongs: number;
}

// ---------------------------------------------------------------------------
// Send helper — serializes a WsMessage and ignores closed sockets
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: WsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------------------
// WsHub — manages all connected clients and bridges the poller
// ---------------------------------------------------------------------------

export class WsHub {
  private readonly wss: WebSocketServer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Last known state — sent immediately to newly connecting clients
  private lastFrame: LiveFrame | null = null;
  private lastSetpoints: SetpointsFrame | null = null;
  private machineOnline = false;
  // ÄW-B: the maintenance run currently in progress (or null). Replayed to newly
  // connecting clients so a reload / second device also shows the banner.
  private activeMaintenance: MaintenanceRun | null = null;
  // H-6: the shot currently being recorded (or null). Replayed on connect for the
  // same reason as the maintenance run, but it carries the Stop button: without
  // the replay a reload mid-brew left the client with no way to stop the shot.
  private activeShot: Shot | null = null;
  /** Die aktuelle Stufe eines App-Bezugs — fuer Clients, die mitten im Bezug neu verbinden. */
  private driveStage: DriveStage | null = null;

  /** Logger bound to tag "ws" (Spec §4.13). Lifecycle-only — no per-frame logs.
   *  WS logs carry no shot_id; correlate to a shot by timestamp. */
  private readonly logger: Logger;

  /** PT-2: live source of the armed profile-temp reset, overlaid onto every
   *  broadcast setpoints frame so Pre-Shot/Post-Shot need no extra poll. */
  private readonly resetStore: ProfileTempResetStore;

  constructor(logger: Logger, resetStore: ProfileTempResetStore) {
    this.wss = new WebSocketServer({ noServer: true });
    this.logger = logger.child({ tag: "ws" });
    this.resetStore = resetStore;
  }

  /** Overlay the live armed-reset value onto a machine setpoints frame. The
   *  post-shot prompt displays the previous BG setpoint (BG = the brew temp). */
  private withResetState(frame: SetpointsFrame): SetpointsFrame {
    return {
      ...frame,
      profileTempPreviousSetpointC: this.resetStore.previous()?.bgC ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Attach to Fastify's underlying http.Server and listen for WS upgrades
  // ---------------------------------------------------------------------------

  attach(app: FastifyInstance, poller: XeniaPoller): void {
    // Intercept HTTP upgrade requests at the raw Node.js server level
    app.server.on(
      "upgrade",
      (req: IncomingMessage, socket, head: Buffer) => {
        if (req.url === "/ws") {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit("connection", ws, req);
          });
        } else {
          socket.destroy();
        }
      },
    );

    this.wss.on("connection", (ws: WebSocket) => this.onConnect(ws));
    this.startHeartbeat();
    this.bindPoller(poller);
  }

  // ---------------------------------------------------------------------------
  // Client lifecycle
  // ---------------------------------------------------------------------------

  private onConnect(ws: WebSocket): void {
    const client = ws as TrackedWs;
    client.missedPongs = 0;

    this.logger.info(
      { event: "client_connect", client_count: this.wss.clients.size },
      `client connected (${this.wss.clients.size} total)`,
    );

    client.on("pong", () => {
      client.missedPongs = 0;
    });

    client.on("close", (code: number) => {
      this.logger.info(
        { event: "client_disconnect", code, client_count: this.wss.clients.size },
        `client disconnected (code=${code}, ${this.wss.clients.size} total)`,
      );
    });

    client.on("error", (err: Error) => {
      this.logger.warn(
        { event: "client_error", err_msg: err.message },
        `client error: ${err.message}`,
      );
      client.terminate();
    });

    // Send current state immediately.
    // If the machine is offline (no frame yet), tell the client explicitly
    // so it shows "OFFLINE" — not a blank "connected" state.
    if (this.machineOnline && this.lastFrame !== null) {
      send(client, { type: "live", data: this.lastFrame });
      if (this.lastSetpoints !== null) {
        send(client, { type: "setpoints", data: this.withResetState(this.lastSetpoints) });
      }
    } else {
      send(client, { type: "machineOffline" });
    }

    // ÄW-B: replay an in-progress maintenance run so a reload / second device
    // also shows the banner (not just the device that started it).
    if (this.activeMaintenance !== null) {
      send(client, { type: "maintenanceStarted", data: this.activeMaintenance });
    }

    // H-6: same for a running shot — chart context and, above all, the Stop
    // button hang off activeShot in the client.
    if (this.activeShot !== null) {
      send(client, { type: "shotStarted", data: this.activeShot });
      if (this.driveStage !== null) send(client, { type: "driveStage", data: this.driveStage });
    }
  }

  // ---------------------------------------------------------------------------
  // Broadcast to all connected clients
  // ---------------------------------------------------------------------------

  private broadcast(msg: WsMessage): void {
    this.wss.clients.forEach((ws) => send(ws, msg));
  }

  // ---------------------------------------------------------------------------
  // Poller event bindings
  // ---------------------------------------------------------------------------

  private bindPoller(poller: XeniaPoller): void {
    poller.on("frame", (frame) => {
      this.lastFrame = frame;
      this.machineOnline = true;
      this.broadcast({ type: "live", data: frame });
    });

    poller.on("setpoints", (setpoints) => {
      this.lastSetpoints = setpoints;
      this.broadcast({ type: "setpoints", data: this.withResetState(setpoints) });
    });

    poller.on("machineInfo", (info) => {
      this.broadcast({ type: "machineInfo", data: info });
    });

    poller.on("disconnected", () => {
      this.machineOnline = false;
      this.broadcast({ type: "machineOffline" });
    });

    poller.on("error", (err) => {
      // Log but don't flood clients with every poll error — 'machineOffline'
      // already handles the user-facing state change on first disconnect.
      const msg =
        err instanceof Error ? err.message : String(err);
      // Only broadcast errors that are unexpected (not routine timeout/network)
      if (
        !(err instanceof Error) ||
        !["timeout", "network"].includes((err as { code?: string }).code ?? "")
      ) {
        this.broadcast({ type: "error", message: msg });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Heartbeat — terminates dead connections every 30s
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        const client = ws as TrackedWs;
        if (client.missedPongs >= MAX_MISSED_PONGS) {
          this.logger.warn(
            { event: "client_timeout", client_count: this.wss.clients.size },
            `terminating unresponsive client`,
          );
          client.terminate();
          return;
        }
        client.missedPongs += 1;
        client.ping();
      });
    }, HEARTBEAT_INTERVAL_MS);

    // Don't keep the process alive just for the heartbeat timer
    this.heartbeatTimer.unref();
  }

  /** Returns the last received live frame — may be stale after a poll failure. */
  getLastFrame(): LiveFrame | null {
    return this.lastFrame;
  }

  /**
   * Like getLastFrame(), but null unless the frame is younger than maxAgeMs and
   * the machine is still online. Start guards must use this: a stale frame would
   * otherwise let a start through while the machine state is actually unknown.
   */
  getFreshFrame(maxAgeMs: number): LiveFrame | null {
    if (!this.machineOnline || this.lastFrame === null) return null;
    return Date.now() - this.lastFrame.timestamp <= maxAgeMs ? this.lastFrame : null;
  }

  /** Broadcast to all clients that a shot started (called from recorder event).
   *  Retained for the connect snapshot (H-6). */
  broadcastShotStarted(shot: Shot): void {
    this.activeShot = shot;
    this.broadcast({ type: "shotStarted", data: shot });
  }

  /** Broadcast to all clients that a shot ended (called from recorder event).
   *  Clears the retained shot unconditionally: whatever ends, nothing is running. */
  broadcastShotEnded(shot: Shot, samplesCount: number): void {
    this.activeShot = null;
    this.driveStage = null;
    this.broadcast({ type: "shotEnded", data: shot, samplesCount });
  }

  /** Broadcast a shot whose fields changed (e.g. a rating edit via PUT) so every
   *  connected client live-syncs instead of showing stale data / a stale review. */
  broadcastShotUpdated(shot: Shot): void {
    if (this.activeShot?.id === shot.id) this.activeShot = shot;
    this.broadcast({ type: "shotUpdated", data: shot });
  }

  /** ÄW-B: an app-initiated maintenance run started — clients show a banner
   *  instead of the chart. Retained so late-joining clients get it on connect. */
  broadcastMaintenanceStarted(run: MaintenanceRun): void {
    this.activeMaintenance = run;
    this.broadcast({ type: "maintenanceStarted", data: run });
  }

  /** ÄW-B: the maintenance run ended (machine left brewing) — clients drop the banner. */
  broadcastMaintenanceEnded(): void {
    this.activeMaintenance = null;
    this.broadcast({ type: "maintenanceEnded" });
  }

  /** The profile list changed on some client (create/update/delete/reorder) so
   *  every other connected client (e.g. the tablet at the machine) refetches
   *  instead of waiting for a manual tab focus. Payload-less — clients re-GET. */
  broadcastDriveStage(stage: DriveStage): void {
    this.driveStage = stage;
    this.broadcast({ type: "driveStage", data: stage });
  }

  broadcastProfilesChanged(): void {
    this.broadcast({ type: "profilesChanged" });
  }

  /** Number of currently connected WebSocket clients. */
  clientCount(): number {
    return this.wss.clients.size;
  }

  close(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Terminate every client socket. wss.close() alone does NOT close existing
    // connections (the server was created with noServer: true) — leaving them
    // open would make Fastify's server.close() hang waiting for them to drain.
    for (const ws of this.wss.clients) {
      ws.terminate();
    }
    this.wss.close();
  }
}
