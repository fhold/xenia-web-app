import { useCallback, useState } from "react";
import type {
  ApiResponse,
  EcoRequest,
  PowerRequest,
  ResetProfileTempRequest,
  SetFromProfileRequest,
  SetpointsUpdateRequest,
  SteamRequest,
} from "@shared/types";

/** null = the machine took the command; a string = the reason it did not. */
export type MachineCallResult = Promise<string | null>;

export interface MachineControlHook {
  setPower: (on: boolean) => MachineCallResult;
  setSteam: (on: boolean) => MachineCallResult;
  setEco: (on: boolean) => MachineCallResult;
  setSetpoints: (params: SetpointsUpdateRequest) => MachineCallResult;
  /** PT-2: set BG setpoint from a profile's target temp (BG only, arms reset). */
  setSetpointsFromProfile: (targetTempC: number) => MachineCallResult;
  /** PT-2: resolve the post-shot reset prompt — apply=restore, else dismiss. */
  resetProfileTemp: (apply: boolean) => MachineCallResult;
  /** True while any control call is in-flight. Use to disable buttons. */
  isLoading: boolean;
  /** The last command the machine refused, for the app-wide error line. */
  error: string | null;
  /** Report a failure from outside the hook (stop button, shot save, …). */
  reportError: (message: string) => void;
  dismissError: () => void;
}

export function useMachineControl(): MachineControlHook {
  // Counter instead of boolean — handles rapid sequential clicks cleanly.
  // isLoading stays true until ALL in-flight calls finish.
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Stable identity: the error line auto-hides on a timer keyed to this, and
  // App re-renders with every live frame.
  const dismissError = useCallback(() => { setError(null); }, []);

  /**
   * A failed command used to end in console.error: the toggle simply did not
   * move and nothing said why. The message is both returned (so a dialog can
   * stay open instead of pretending it saved) and kept here for the app-wide
   * error line — every entry point reports the same way.
   */
  async function call(endpoint: string, body: unknown): MachineCallResult {
    setPendingCount((c) => c + 1);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as ApiResponse;
      if (data.ok) return null;
      const message = data.error ?? `HTTP ${res.status}`;
      setError(message);
      return message;
    } catch (err) {
      // Network/parse failure — the machine may or may not have acted.
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return message;
    } finally {
      setPendingCount((c) => c - 1);
    }
  }

  return {
    setPower: (on: boolean) =>
      call("/api/machine/power", { on } satisfies PowerRequest),
    setSteam: (on: boolean) =>
      call("/api/machine/steam", { on } satisfies SteamRequest),
    setEco: (on: boolean) =>
      call("/api/machine/eco", { on } satisfies EcoRequest),
    setSetpoints: (params: SetpointsUpdateRequest) =>
      call("/api/machine/setpoints", params),
    setSetpointsFromProfile: (targetTempC: number) =>
      call("/api/machine/setpoints/from-profile", { targetTempC } satisfies SetFromProfileRequest),
    resetProfileTemp: (apply: boolean) =>
      call("/api/machine/setpoints/reset-profile-temp", { apply } satisfies ResetProfileTempRequest),
    isLoading: pendingCount > 0,
    error,
    reportError: setError,
    dismissError,
  };
}
