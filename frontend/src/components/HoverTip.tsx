/**
 * HoverTip — erklaerender Tooltip im Stil des Diagramm-Tooltips.
 *
 * Oeffnet bei Maus-Hover, Tastaturfokus und Antippen (Tablet: Tippen schaltet,
 * Tippen daneben schliesst). Wird per Portal an <body> gehaengt und fix
 * positioniert, damit Elternteile mit overflow:hidden (Stufenleiste, Kacheln)
 * ihn nicht abschneiden. Bleibt innerhalb des Fensters.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import theme, { alpha } from "../theme.js";

const C = theme;
const GAP = 6;
const MARGIN = 8;

interface HoverTipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  /** Stil des umhuellenden Elements (es traegt Layout und Ereignisse). */
  style?: React.CSSProperties;
}

export function HoverTip({ content, children, style }: HoverTipProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position erst nach dem Rendern messen: unter dem Anker, sonst darueber;
  // waagerecht am Anker ausgerichtet und ins Fenster geklemmt.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const below = a.bottom + GAP + t.height <= window.innerHeight - MARGIN;
    const top = below ? a.bottom + GAP : Math.max(MARGIN, a.top - GAP - t.height);
    const left = Math.min(Math.max(MARGIN, a.left), window.innerWidth - MARGIN - t.width);
    setPos({ left, top });
  }, [open]);

  // Antippen daneben, Scrollen oder Escape schliessen.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && anchor.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const show = () => { setPos(null); setOpen(true); };

  return (
    <>
      <div
        ref={anchor}
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onPointerDown={(e) => { if (e.pointerType === "touch") { if (open) setOpen(false); else show(); } }}
        style={{ cursor: "help", outlineOffset: 2, ...style }}
      >
        {children}
      </div>
      {open && createPortal(
        <div
          ref={tip}
          role="tooltip"
          style={{
            position: "fixed",
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            visibility: pos ? "visible" : "hidden",
            zIndex: 1000,
            maxWidth: 300,
            background: C.cardElev,
            border: `1px solid ${C.bdr}`,
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.45,
            color: C.txt,
            boxShadow: `0 8px 24px ${alpha(C.black, 0.4)}`,
            pointerEvents: "none",
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
