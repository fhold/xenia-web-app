/**
 * Start gate (Review H-1) — one rule for both start routes.
 *
 * The machine state is the authority for "may a brew start now", not the
 * recorder's in-memory state: after a restart, an externally started brew or a
 * lost recorder state, activeShotId is null while the machine is extracting.
 * A missing or stale frame is therefore fail-closed — an unknown machine state
 * must not open the gate.
 */

import type { LiveFrame } from "../../../shared/src/types.js";
import { L } from "../../../shared/src/shared-lang.js";

/** Five idle poll ticks (polling_idle_ms defaults to 1000). */
export const FRAME_MAX_AGE_MS = 5_000;

export type StartGate = { ok: true } | { ok: false; error: string };

/**
 * The frame the gate decides on.
 *
 * A fresh cached frame is authoritative. A stale one is not a reason to refuse:
 * isolated `/overview` timeouts happen several times an hour (ESP/WLAN, not our
 * load — see spec), and a start attempt that lands in the ~2 s shadow of one
 * used to be refused with "Maschinenzustand unbekannt" while the machine was
 * perfectly reachable. So when the cache is stale, ask the machine — a start is
 * a rare, user-initiated action that can afford to wait for a real answer.
 *
 * Still fail-closed: only a machine that does not answer at all yields null.
 */
export async function frameForStartGate(
  cached: LiveFrame | null,
  fetchFrame: () => Promise<LiveFrame>,
  attempts = 2,
): Promise<LiveFrame | null> {
  if (cached !== null) return cached;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchFrame();
    } catch {
      // A single timeout is exactly the case this exists for — try again.
    }
  }
  return null;
}

export function checkMachineReadyToStart(frame: LiveFrame | null): StartGate {
  if (frame === null) {
    return {
      ok: false,
      error:
        L("Maschinenzustand unbekannt — kein aktueller Status von der Maschine. Bitte Verbindung prüfen.", "Machine state unknown — no current status from the machine. Please check the connection."),
    };
  }
  switch (frame.machineStatus) {
    case 1: // on
    case 2: // eco
      return { ok: true };
    case 0:
      return { ok: false, error: L("Maschine ist aus — bitte zuerst einschalten.", "The machine is off — please switch it on first.") };
    default: // 3 brewing, 4 draining, 5 paddle
      return {
        ok: false,
        error: L("Maschine ist gerade im Betrieb (Bezug/Entleeren). Bitte zuerst beenden.", "The machine is busy (brewing/draining). Please finish that first."),
      };
  }
}
