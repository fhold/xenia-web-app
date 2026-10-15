/**
 * Toggle — iOS-style boolean switch.
 * Reusable across Settings, ProfileEditor, and future views.
 */

import theme from "../theme.js";

const C = theme;

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Accessible label — forwarded as aria-label if provided. */
  label?: string;
}

export function Toggle({ checked, onChange, disabled = false, label }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => { if (!disabled) onChange(!checked); }}
      disabled={disabled}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        background: checked ? C.acc : C.bdr,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        position: "relative",
        transition: "background 0.2s ease",
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        padding: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "white",
          transition: "left 0.2s ease",
          pointerEvents: "none",
        }}
      />
    </button>
  );
}
