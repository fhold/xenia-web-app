import { useCallback, useEffect, useState } from "react";
import type { Bean } from "@shared/types.js";

export interface StockAlert {
  /** Die aufgebrauchte Röstung. */
  bean: Bean;
  /** Andere Röstungen derselben Sorte, die noch etwas hergeben. */
  candidates: Bean[];
}

export interface UseStockAlertReturn {
  alert: StockAlert | null;
  /** Archivieren, optional die Reserve-Röstung als Quelle aktivieren. */
  archive: (openNextId: number | null) => Promise<void>;
  /** "Nicht jetzt" — für diese Röstung stumm, bis jemand den Bestand korrigiert. */
  dismiss: () => Promise<void>;
}

/**
 * Aufgebraucht-Hinweis für die Röstung eines Bezugs. Lädt erst, wenn eine
 * beanId anliegt (also nach einem Bezug mit Bohnenangabe) — ohne Bezug kein
 * Request. Weggeklickte Hinweise kommen nicht wieder, das entscheidet der
 * Server über stockAlertDismissedAt.
 */
export function useStockAlert(beanId: number | null): UseStockAlertReturn {
  const [alert, setAlert] = useState<StockAlert | null>(null);

  const load = useCallback(async () => {
    if (beanId === null) { setAlert(null); return; }
    try {
      const r = await fetch("/api/beans");
      if (!r.ok) return;
      const beans = (await r.json()) as Bean[];
      const bean = beans.find((b) => b.id === beanId);
      if (!bean || !bean.stockDepleted || bean.stockAlertDismissedAt !== null) {
        setAlert(null);
        return;
      }
      const candidates = beans
        .filter((b) => b.coffeeId === bean.coffeeId && b.id !== bean.id
          && b.status !== "archived" && !b.stockDepleted)
        // Ungefrorene zuerst — ein Beutel aus dem Froster ist nicht sofort nutzbar.
        .sort((a, b) => {
          const aFrozen = a.status === "frozen" ? 1 : 0;
          const bFrozen = b.status === "frozen" ? 1 : 0;
          if (aFrozen !== bFrozen) return aFrozen - bFrozen;
          return (b.roastDate ?? "").localeCompare(a.roastDate ?? "");
        });
      setAlert({ bean, candidates });
    } catch {
      // nicht kritisch — dann bleibt der Hinweis eben aus
    }
  }, [beanId]);

  useEffect(() => { void load(); }, [load]);

  const archive = useCallback(async (openNextId: number | null) => {
    if (beanId === null) return;
    await fetch(`/api/beans/${beanId}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openNextId }),
    });
    setAlert(null);
  }, [beanId]);

  const dismiss = useCallback(async () => {
    if (beanId === null) return;
    await fetch(`/api/beans/${beanId}/stock-alert/dismiss`, { method: "POST" });
    setAlert(null);
  }, [beanId]);

  return { alert, archive, dismiss };
}
