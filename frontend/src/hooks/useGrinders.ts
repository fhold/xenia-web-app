import { useState, useEffect, useCallback } from "react";
import type { Grinder, GrinderCreate, GrinderUpdate } from "@shared/types.js";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface UseGrindersReturn {
  grinders: Grinder[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (data: GrinderCreate) => Promise<void>;
  update: (id: number, patch: GrinderUpdate) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export function useGrinders(): UseGrindersReturn {
  const [grinders, setGrinders] = useState<Grinder[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Grinder[]>("/api/grinders");
      setGrinders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async (data: GrinderCreate): Promise<void> => {
    await apiFetch<{ id: number }>("/api/grinders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await refresh();
  }, [refresh]);

  const update = useCallback(async (id: number, patch: GrinderUpdate): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/grinders/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: number): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/grinders/${id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  return { grinders, loading, error, refresh, create, update, remove };
}
