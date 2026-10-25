/**
 * Shared shot-start readiness logic.
 *
 * Single source of truth for "may a new shot be started right now?", reused by
 * the Dashboard favorite chips and the Profiles start buttons so the two never
 * drift apart.
 */

import type { ConnectionState } from "../hooks/useXeniaFrame.js";
import type { MachineState, MachineStatus, Shot } from "@shared/types.js";
import { t } from "../i18n/index.js";

/**
 * Whether the machine is in a state where a new shot may be started, based on
 * connection + machine state. (Does not consider an already-running shot — use
 * canStartShotNow for the combined guard.)
 */
export function canStartShotFromState(
  connectionState: ConnectionState,
  machineState: MachineState,
  machineStatus: MachineStatus | null | undefined,
): boolean {
  if (connectionState !== "connected") return false;
  return machineState === "ready" || machineStatus === 1;
}

/**
 * Combined guard: machine ready (canStartShotFromState) AND no shot currently in
 * progress. This is what start controls should gate on.
 */
export function canStartShotNow(args: {
  connectionState: ConnectionState;
  machineState: MachineState;
  machineStatus: MachineStatus | null | undefined;
  activeShot: Shot | null;
}): boolean {
  return (
    args.activeShot === null &&
    canStartShotFromState(args.connectionState, args.machineState, args.machineStatus)
  );
}

/**
 * Warum ein Start gerade gesperrt ist — oder null, wenn er erlaubt ist.
 *
 * Der boolesche Guard reicht fuer das Sperren, aber nicht fuer die Erklaerung:
 * ein Knopf, der nichts tut, sieht wie ein Absturz aus. Besonders der Fall
 * "Maschine sieht fertig aus, der Bezug wird aber noch abgeschlossen" ist von
 * aussen nicht zu erraten.
 */
export function startBlockedReason(args: {
  connectionState: ConnectionState;
  machineState: MachineState;
  machineStatus: MachineStatus | null | undefined;
  activeShot: Shot | null;
}): string | null {
  if (args.connectionState !== "connected") return t("ui.readiness.noConnection");
  if (args.activeShot !== null) {
    return t("ui.readiness.finishing");
  }
  if (!canStartShotFromState(args.connectionState, args.machineState, args.machineStatus)) {
    // Ein Satz fuer alle Faelle (aus, Nachlauf, Draining): ob sie aus ist, sieht
    // man ohnehin — "einschalten" war nach einem Bezug schlicht falsch.
    return t("ui.readiness.notReady");
  }
  return null;
}
