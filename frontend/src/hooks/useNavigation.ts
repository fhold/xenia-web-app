/**
 * Rueckweg app-weit: jeder Ortswechsel ist ein Eintrag im Browser-Verlauf
 * (`history.pushState`). Zurueck — der Knopf in der App, die Browser-/Android-
 * Taste oder die Wischgeste — fuehrt deshalb immer dorthin, wo man vorher war,
 * auch ueber mehrere Spruenge. Die App fuehrt keine eigenen Adressen; der Ort
 * steht im `state` des Eintrags.
 *
 *  - `go`      neuer Eintrag (Spruenge, Hauptmenue, Detail oeffnen)
 *  - `replace` aktuellen Eintrag ersetzen (z. B. Sorte geloescht)
 *  - `stash`   Zustand am aktuellen Eintrag merken, ohne neu zu rendern
 *              (Historien-Filter, offener Bezug) — wirkt erst bei der Rueckkehr
 *  - `back`    zurueck; ohne Eintrag davor der `fallback`
 *
 * Ein Wachter (Editor mit ungespeicherten Aenderungen) faengt Zurueck per
 * Browser/Geste ab: der Ort wird wieder hergestellt und der Wachter fragt;
 * sein `proceed` geht dann doch zurueck. Eigene Knoepfe, die selbst schon
 * gefragt haben, gehen mit `force` vorbei.
 */

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { ViewId } from "../components/Sidebar.js";
import type { ShotFilters } from "./useShots.js";

export interface NavLocation {
  view: ViewId;
  /** Profil-Editor offen (Profil-Id oder neues Profil). */
  editor?: number | "new" | null;
  /** In dieser Variante oeffnet der Editor (Sprung aus einem Bezug). */
  editorVariant?: number | null;
  /** Sorte im Detail. */
  coffeeId?: number | null;
  /** Historie: Sprungziel bzw. gemerkter Zustand. */
  history?: {
    beanId?: number | null;
    profileId?: number | null;
    filters?: Partial<ShotFilters> | null;
    shotId?: number | null;
  } | null;
  /** Per Sprung erreicht — die Historie zeigt dann ihren Zurueck-Knopf. */
  jump?: boolean;
}

interface Entry { idx: number; loc: NavLocation }

type Guard = (proceed: () => void) => void;

/** Fuer Ansichten mit ungespeicherten Aenderungen (Profil-Editor). */
export const NavGuardContext = createContext<{ setLeaveGuard: (g: Guard | null) => void } | null>(null);

const HOME: NavLocation = { view: "dashboard" };

function readEntry(state: unknown): Entry | null {
  const e = (state as { xenia?: Entry } | null)?.xenia;
  return e && typeof e.idx === "number" && e.loc && typeof e.loc.view === "string" ? e : null;
}

export function useNavigation() {
  const initial = useRef<Entry | null>(null);
  if (initial.current === null) {
    initial.current = readEntry(window.history.state) ?? { idx: 0, loc: HOME };
  }
  const [loc, setLoc] = useState<NavLocation>(initial.current.loc);
  const cur = useRef<Entry>(initial.current);
  const guard = useRef<Guard | null>(null);
  const skipGuard = useRef(false);

  const write = (entry: Entry, push: boolean) => {
    cur.current = entry;
    if (push) window.history.pushState({ xenia: entry }, "");
    else window.history.replaceState({ xenia: entry }, "");
  };

  useEffect(() => {
    // Erster Eintrag (oder nach dem Neuladen der wiederhergestellte) traegt den Ort.
    write(cur.current, false);
    const onPop = (e: PopStateEvent) => {
      const entry = readEntry(e.state);
      if (!entry) return;
      if (skipGuard.current) {
        skipGuard.current = false;
      } else if (guard.current) {
        // Ort wieder herstellen, dann fragen; „Verwerfen“ geht doch zurueck.
        const g = guard.current;
        write({ ...cur.current, idx: entry.idx + 1 }, true);
        g(() => { guard.current = null; skipGuard.current = true; window.history.back(); });
        return;
      }
      cur.current = entry;
      setLoc(entry.loc);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((next: NavLocation) => {
    write({ idx: cur.current.idx + 1, loc: next }, true);
    setLoc(next);
  }, []);

  const replace = useCallback((next: NavLocation) => {
    write({ idx: cur.current.idx, loc: next }, false);
    setLoc(next);
  }, []);

  const stash = useCallback((patch: Partial<NavLocation>) => {
    write({ idx: cur.current.idx, loc: { ...cur.current.loc, ...patch } }, false);
  }, []);

  const back = useCallback((fallback: NavLocation, opts: { force?: boolean } = {}) => {
    if (cur.current.idx > 0) {
      if (opts.force) skipGuard.current = true;
      window.history.back();
    } else {
      write({ idx: 0, loc: fallback }, false);
      setLoc(fallback);
    }
  }, []);

  /** Hauptmenue: bei ungespeicherten Aenderungen erst fragen. */
  const guarded = useCallback((action: () => void) => {
    const g = guard.current;
    if (g) g(() => { guard.current = null; action(); });
    else action();
  }, []);

  const setLeaveGuard = useCallback((g: Guard | null) => { guard.current = g; }, []);

  // Wischgeste vom linken Rand — nur in der iOS-Home-Bildschirm-App: dort hat
  // iOS keine eigene; Safari und Android haben eine, die als popstate ankommt.
  useEffect(() => {
    if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return;
    let sx = 0;
    let sy = 0;
    let tracking = false;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      tracking = e.touches.length === 1 && !!t && t.clientX < 24;
      if (t) { sx = t.clientX; sy = t.clientY; }
    };
    const move = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientY - sy) > 40) { tracking = false; return; }
      if (t.clientX - sx > 70) {
        tracking = false;
        if (cur.current.idx > 0) window.history.back();
      }
    };
    const end = () => { tracking = false; };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", end, { passive: true });
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
    };
  }, []);

  return { loc, go, replace, stash, back, guarded, setLeaveGuard };
}
