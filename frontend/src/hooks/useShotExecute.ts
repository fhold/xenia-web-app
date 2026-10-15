import { useState, useCallback } from "react";
import type { ExecuteRequest, ExecuteResult } from "@shared/types.js";

// ---------------------------------------------------------------------------
// Hook — executes a profile script and tracks the active shot session
// ---------------------------------------------------------------------------

export type ShotPhase =
  | "idle"
  | "executing"   // waiting for /scripts/execute response
  | "brewing"     // execution confirmed, shot in progress
  | "error";

export interface ActiveShot {
  profileId: number;
  shotSize: ExecuteRequest["shotSize"];
  result: ExecuteResult;
  startedAt: number; // Date.now() when execute confirmed
}

export interface UseShotExecuteReturn {
  phase: ShotPhase;
  activeShot: ActiveShot | null;
  error: string | null;
  /** Resolves to an error message on failure, or null on success. */
  execute: (req: ExecuteRequest) => Promise<string | null>;
  /** Called by parent when the machine transitions out of BREWING state. */
  clearShot: () => void;
}

export function useShotExecute(): UseShotExecuteReturn {
  const [phase, setPhase] = useState<ShotPhase>("idle");
  const [activeShot, setActiveShot] = useState<ActiveShot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (req: ExecuteRequest): Promise<string | null> => {
    setPhase("executing");
    setError(null);

    try {
      const res = await fetch("/api/scripts/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });

      const body = (await res.json()) as ExecuteResult | { ok: false; error: string };

      if (!res.ok || !body.ok) {
        const msg = "error" in body ? body.error : `HTTP ${res.status}`;
        setError(msg);
        setPhase("error");
        return msg;
      }

      setActiveShot({
        profileId: req.profileId,
        shotSize: req.shotSize,
        result: body,
        startedAt: Date.now(),
      });
      setPhase("brewing");
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
      return msg;
    }
  }, []);

  const clearShot = useCallback(() => {
    setPhase("idle");
    setActiveShot(null);
    setError(null);
  }, []);

  return { phase, activeShot, error, execute, clearShot };
}
