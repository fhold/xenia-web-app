import { useState, useEffect, useCallback } from "react";
import type { Bean, BeanCreate, BeanUpdate, BeanStatus } from "@shared/types.js";

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseBeansReturn {
  beans: Bean[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (data: BeanCreate) => Promise<void>;
  update: (id: number, patch: BeanUpdate) => Promise<void>;
  remove: (id: number) => Promise<void>;
  setStatus: (id: number, status: BeanStatus, date?: string) => Promise<void>;
  toggleFavourite: (bean: Bean) => Promise<void>;
  /** Sends raw import JSON to POST /api/beans/import. Returns { id, name }. */
  importJson: (json: unknown) => Promise<{ id: number; name: string }>;
}

export function useBeans(): UseBeansReturn {
  const [beans, setBeans] = useState<Bean[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Bean[]>("/api/beans");
      setBeans(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (data: BeanCreate): Promise<void> => {
    await apiFetch<{ id: number; name: string }>("/api/beans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await refresh();
  }, [refresh]);

  const update = useCallback(async (id: number, patch: BeanUpdate): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/beans/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: number): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/beans/${id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const setStatus = useCallback(
    async (id: number, status: BeanStatus, date?: string): Promise<void> => {
      await apiFetch<{ ok: true }>(`/api/beans/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, date }),
      });
      await refresh();
    },
    [refresh],
  );

  const toggleFavourite = useCallback(async (bean: Bean): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/beans/${bean.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favourite: !bean.favourite }),
    });
    await refresh();
  }, [refresh]);

  const importJson = useCallback(async (json: unknown): Promise<{ id: number; name: string }> => {
    const result = await apiFetch<{ id: number; name: string }>("/api/beans/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    });
    await refresh();
    return result;
  }, [refresh]);

  return {
    beans,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    setStatus,
    toggleFavourite,
    importJson,
  };
}
