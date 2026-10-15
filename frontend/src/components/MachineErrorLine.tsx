/**
 * MachineErrorLine — the one place a refused command says so.
 *
 * Machine commands used to fail into console.error: a toggle did not move, a
 * dialog closed as if it had saved. This line is fed by every entry point
 * (useMachineControl, the Stop button, …) and sits above the modal layer, so it
 * is also visible while a dialog stays open on the failure.
 */

import { useEffect } from "react";
import { X, AlertTriangle } from "lucide-react";
import theme from "../theme.js";

const C = theme;

/** Long enough to read, short enough not to linger over the next action. */
const AUTO_HIDE_MS = 6000;

interface MachineErrorLineProps {
  message: string | null;
  onDismiss: () => void;
}

export function MachineErrorLine({ message, onDismiss }: MachineErrorLineProps) {
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(onDismiss, AUTO_HIDE_MS);
    return () => { clearTimeout(timer); };
  }, [message, onDismiss]);

  if (message === null) return null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        top: `calc(${C.safeTop} + 8px)`,
        left: "50%",
        transform: "translateX(-50%)",
        // Above the modal layer (z 110) — a dialog that stays open on the error
        // must not cover the reason it stayed open.
        zIndex: 200,
        maxWidth: "min(560px, calc(100vw - 24px))",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 10,
        background: C.redD,
        border: `1px solid ${C.red}`,
        backdropFilter: "blur(8px)",
        color: C.txt,
        fontSize: 12.5,
        lineHeight: 1.45,
      }}
    >
      <AlertTriangle size={15} strokeWidth={2.2} color={C.red} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button
        onClick={onDismiss}
        aria-label="Meldung schließen"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: C.mut,
          display: "flex",
          flexShrink: 0,
        }}
      >
        <X size={14} strokeWidth={2.2} />
      </button>
    </div>
  );
}
