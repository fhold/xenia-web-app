/**
 * useLastBrewShot — der letzte abgeschlossene Bezug aus der Datenbank.
 *
 * Das Dashboard zeigt nach einem Bezug dessen Kurve. Nach dem Neuladen der App
 * (oder morgens auf dem Tablet) gab es aber keinen "eben beendeten" Bezug mehr,
 * und die Diagrammflaeche blieb leer. Dieser Hook liefert dafuer einmalig beim
 * Laden den letzten Bezug nach. Nur zur Anzeige: die Bewertung nach dem Bezug
 * haengt weiter am Live-Ereignis, nicht hieran.
 */

import { useEffect, useState } from "react";
import type { Shot, ShotDetail } from "@shared/types.js";

export function useLastBrewShot(): Shot | null {
  const [shot, setShot] = useState<Shot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = (await (await fetch("/api/shots?limit=1")).json()) as { shots?: { id: number; endedAt: number | null }[] };
        const last = list.shots?.[0];
        if (!last || last.endedAt === null) return; // laeuft noch: das zeigt der Live-Pfad
        const detail = (await (await fetch(`/api/shots/${last.id}`)).json()) as ShotDetail;
        if (!cancelled) setShot(detail.shot);
      } catch {
        // Komfort, kein Muss — dann bleibt die Flaeche eben leer wie bisher
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return shot;
}
