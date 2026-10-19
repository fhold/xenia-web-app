import { useState, useEffect, useCallback } from "react";
import type { XeniaScript, SyncResult } from "@shared/types.js";

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // Mit Status: der Editor bietet bei 507 (kein freier Platz) Aufraeumen an.
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseScriptsReturn {
  scripts: XeniaScript[];
  loading: boolean;
  error: string | null;
  /** Triggers a full sync from Xenia and refreshes the list. */
  syncScripts: () => Promise<SyncResult>;
  /** Re-fetch the script list from the local DB (no machine sync). */
  refetch: () => Promise<void>;
  /** SE-2b: shallow sync (ids + titles) from the machine, then refetch the list. */
  refreshList: () => Promise<void>;
  /** Editor: neues Skript auf dem kleinsten freien, sichtbaren Platz anlegen. */
  createScript: (title: string, content: string) => Promise<XeniaScript>;
  /** Editor: an Ort und Stelle ueberschreiben — nur, wenn die Maschine noch
   *  `expectedContent` hat; sonst wirft es ScriptConflict. */
  updateScript: (id: number, title: string, content: string, expectedContent: string) => Promise<XeniaScript>;
  deleteScript: (id: number) => Promise<void>;
}

/** Das Skript wurde an der Maschine geaendert, seit der Editor es geladen hat. */
export class ScriptConflict extends Error {
  constructor(message: string, readonly machineContent: string) {
    super(message);
  }
}

export function useScripts(): UseScriptsReturn {
  const [scripts, setScripts] = useState<XeniaScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchScripts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<XeniaScript[]>("/api/scripts");
      setScripts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchScripts();
  }, [fetchScripts]);

  const syncScripts = useCallback(async (): Promise<SyncResult> => {
    const result = await apiFetch<SyncResult>("/api/scripts/refresh", { method: "POST" });
    await fetchScripts();
    return result;
  }, [fetchScripts]);

  const refreshList = useCallback(async (): Promise<void> => {
    await apiFetch("/api/scripts/refresh-list", { method: "POST" });
    await fetchScripts();
  }, [fetchScripts]);

  const createScript = useCallback(async (title: string, content: string): Promise<XeniaScript> => {
    const script = await apiFetch<XeniaScript>("/api/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    await fetchScripts();
    return script;
  }, [fetchScripts]);

  const updateScript = useCallback(
    async (id: number, title: string, content: string, expectedContent: string): Promise<XeniaScript> => {
      const res = await fetch(`/api/scripts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, expectedContent }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { error?: string; conflict?: boolean; machineContent?: string } & Partial<XeniaScript>;
      if (res.status === 409 && body.conflict) {
        throw new ScriptConflict(body.error ?? "Konflikt", body.machineContent ?? "");
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await fetchScripts();
      return body as XeniaScript;
    },
    [fetchScripts],
  );

  const deleteScript = useCallback(async (id: number): Promise<void> => {
    await apiFetch(`/api/scripts/${id}`, { method: "DELETE" });
    await fetchScripts();
  }, [fetchScripts]);

  return {
    scripts, loading, error, syncScripts, refetch: fetchScripts, refreshList,
    createScript, updateScript, deleteScript,
  };
}
