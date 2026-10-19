import { useState, useEffect, useCallback } from "react";
import type { Basket, BasketCreate, BasketUpdate } from "@shared/types.js";

// Wie useGrinders — Siebe sind Ausruestung wie die Muehlen.

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Name des Siebs eines Bezugs; null, wenn keins erfasst ist (Wartung). */
export function basketName(baskets: Basket[], id: number | null | undefined): string | null {
  return id == null ? null : (baskets.find((b) => b.id === id)?.name ?? null);
}

export interface UseBasketsReturn {
  baskets: Basket[];
  /** Die Liste kam (oder der Abruf ist gescheitert) — der Profil-Editor wartet darauf. */
  loaded: boolean;
  refresh: () => Promise<void>;
  create: (data: BasketCreate) => Promise<void>;
  update: (id: number, patch: BasketUpdate) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export function useBaskets(): UseBasketsReturn {
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setBaskets(await apiFetch<Basket[]>("/api/baskets"));
  }, []);

  useEffect(() => { void refresh().catch(() => undefined).finally(() => setLoaded(true)); }, [refresh]);

  const create = useCallback(async (data: BasketCreate): Promise<void> => {
    await apiFetch<{ id: number }>("/api/baskets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await refresh();
  }, [refresh]);

  const update = useCallback(async (id: number, patch: BasketUpdate): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/baskets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: number): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/baskets/${id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  return { baskets, loaded, refresh, create, update, remove };
}
