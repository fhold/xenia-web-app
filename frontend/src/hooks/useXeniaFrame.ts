import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LiveFrame,
  MachineState,
  MaintenanceRun,
  SetpointsFrame,
  Shot,
  WsMessage,
} from "@shared/types";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface XeniaState {
  /** WebSocket connection status — can the browser reach our backend? */
  connectionState: ConnectionState;
  /**
   * Derived machine state, combining frame data with connection status.
   * 'disconnected' when no frame has been received yet or machine is offline.
   * All other values come directly from LiveFrame.machineState.
   */
  machineState: MachineState;
  /** Last live frame from the machine. null when machine is unreachable. */
  frame: LiveFrame | null;
  /** Last setpoints. null until first /overview_single poll (up to 60s). */
  setpoints: SetpointsFrame | null;
  /** Currently recording shot (from shotStarted WS event). null when idle. */
  activeShot: Shot | null;
  /** Last completed shot (from shotEnded WS event). null on first load. */
  lastEndedShot: Shot | null;
  /** Last shot changed by a PUT (rating edit) on ANY client (shotUpdated WS
   *  event). Drives live cross-client sync. null until the first update. */
  lastUpdatedShot: Shot | null;
  /** ÄW-B: app-initiated maintenance run in progress (backflush etc.), or null.
   *  Dashboard shows a "maintenance running" banner instead of the chart. */
  maintenance: MaintenanceRun | null;
  /** The maintenance run that just finished, until `dismissMaintenanceDone` is
   *  called. Lets the dashboard hold a "now empty the drip tray" reminder. */
  maintenanceDone: MaintenanceRun | null;
  dismissMaintenanceDone: () => void;
  /** Bumps whenever ANY client changed the profile list (profilesChanged WS
   *  event). Consumers refetch GET /api/profiles so a profile created on the PC
   *  appears on the tablet without a manual tab focus. 0 = no change yet. */
  profilesRev: number;
}

// Reconnect backoff: 1s → 2s → 4s → ... → 30s max
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function buildWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  // Always use window.location.host so the WS connection goes through the
  // Vite proxy (/ws → ws://localhost:3001) in dev. This also works when
  // accessed from other devices on the network (e.g. tablet via 192.168.x.x:5173).
  return `${protocol}://${window.location.host}/ws`;
}

export function useXeniaFrame(): XeniaState {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [setpoints, setSetpoints] = useState<SetpointsFrame | null>(null);
  const [activeShot, setActiveShot] = useState<Shot | null>(null);
  const [lastEndedShot, setLastEndedShot] = useState<Shot | null>(null);
  const [lastUpdatedShot, setLastUpdatedShot] = useState<Shot | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceRun | null>(null);
  // The run that just finished, kept until the user acknowledges it — a backflush
  // leaves a full drip tray, so the banner must not vanish on its own.
  const [maintenanceDone, setMaintenanceDone] = useState<MaintenanceRun | null>(null);
  const maintenanceRef = useRef<MaintenanceRun | null>(null);
  const [profilesRev, setProfilesRev] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(BACKOFF_BASE_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    function connect(): void {
      if (unmountedRef.current) return;

      setConnectionState("connecting");
      const ws = new WebSocket(buildWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current) { ws.close(); return; }
        setConnectionState("connected");
        backoffRef.current = BACKOFF_BASE_MS;
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (unmountedRef.current) return;

        let msg: WsMessage;
        try {
          msg = JSON.parse(event.data) as WsMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case "live":
            setFrame(msg.data);
            break;
          case "setpoints":
            setSetpoints(msg.data);
            break;
          case "machineOffline":
            // Clear frame so machineState falls back to 'disconnected'
            setFrame(null);
            break;
          case "shotStarted":
            setActiveShot(msg.data);
            // A live brew needs the chart back, acknowledged or not.
            setMaintenanceDone(null);
            break;
          case "shotEnded":
            setActiveShot(null);
            setLastEndedShot(msg.data);
            break;
          case "shotUpdated":
            setLastUpdatedShot(msg.data);
            break;
          case "maintenanceStarted":
            maintenanceRef.current = msg.data;
            setMaintenance(msg.data);
            setMaintenanceDone(null);
            break;
          case "maintenanceEnded":
            setMaintenanceDone(maintenanceRef.current);
            maintenanceRef.current = null;
            setMaintenance(null);
            break;
          case "profilesChanged":
            setProfilesRev((n) => n + 1);
            break;
          case "machineInfo":
          case "error":
            break;
        }
      };

      ws.onclose = () => {
        if (unmountedRef.current) return;
        setConnectionState("disconnected");
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close(); // onclose handles reconnect
      };
    }

    function scheduleReconnect(): void {
      if (unmountedRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(backoffRef.current * 2, BACKOFF_MAX_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  // Synthesize machineState: frame carries it when available,
  // otherwise fall back to 'disconnected' (covers offline machine + initial load)
  const machineState: MachineState = frame?.machineState ?? "disconnected";

  const dismissMaintenanceDone = useCallback(() => { setMaintenanceDone(null); }, []);

  return { connectionState, machineState, frame, setpoints, activeShot, lastEndedShot, lastUpdatedShot, maintenance, maintenanceDone, dismissMaintenanceDone, profilesRev };
}
