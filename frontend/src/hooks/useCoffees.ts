import { useState, useEffect, useCallback } from "react";
import type {
  Bean,
  BeanRating,
  BeanStatus,
  BeanUpdate,
  Coffee,
  CoffeeCreatePayload,
  CoffeeUpdate,
  MatchCandidate,
} from "@shared/types.js";

// ---------------------------------------------------------------------------
// §3.4b coffee/roasting data layer. Assembles the two backend lists
// (/api/coffees + /api/beans) into a per-coffee view with the derived
// "active roasting", effective age, frozen flag and reserve count the
// Sorte/Röstung UI needs.
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** A coffee plus its roastings and derived display fields. */
export interface CoffeeView extends Coffee {
  roastings: Bean[]; // newest first
  /**
   * §3g: the active-source roasting (`isActive`), newest first; else null.
   * Drives the Beans top-group + active marker — independent of physical status.
   */
  activeRoasting: Bean | null;
  /** Effective age of the active roasting (or the most relevant one). */
  effectiveAgeDays: number | null;
  /** True if any roasting is currently frozen (reserve in the freezer). */
  hasFrozen: boolean;
  /** Non-archived roastings beyond the primary one (extra bags). */
  reserveCount: number;
  /** Rest über alle nicht archivierten Beutel; null = nirgends eine Menge gepflegt. */
  stockG: number | null;
}

function byRoastDesc(a: Bean, b: Bean): number {
  const ad = a.roastDate ?? "";
  const bd = b.roastDate ?? "";
  if (ad !== bd) return ad < bd ? 1 : -1;
  return b.createdAt - a.createdAt;
}

function assemble(coffees: Coffee[], beans: Bean[]): CoffeeView[] {
  const byCoffee = new Map<number, Bean[]>();
  for (const b of beans) {
    const list = byCoffee.get(b.coffeeId) ?? [];
    list.push(b);
    byCoffee.set(b.coffeeId, list);
  }
  return coffees.map((c) => {
    const roastings = (byCoffee.get(c.id) ?? []).slice().sort(byRoastDesc);
    const active = roastings.filter((b) => b.isActive);
    const nonArchived = roastings.filter((b) => b.status !== "archived");
    // Age/primary: prefer an active roasting, else the newest non-archived bag.
    const primary = active[0] ?? nonArchived[0] ?? null;
    const withStock = nonArchived.filter((b) => b.remainingG !== null);
    return {
      ...c,
      roastings,
      activeRoasting: active[0] ?? null,
      effectiveAgeDays: primary?.effectiveAgeDays ?? null,
      hasFrozen: roastings.some((b) => b.status === "frozen"),
      reserveCount: Math.max(0, nonArchived.length - (primary ? 1 : 0)),
      stockG: withStock.length === 0
        ? null
        : Math.round(withStock.reduce((sum, b) => sum + (b.remainingG ?? 0), 0) * 10) / 10,
    };
  });
}

export interface UseCoffeesReturn {
  coffees: CoffeeView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  // coffee (Sorte)
  createCoffee: (data: CoffeeCreatePayload) => Promise<{ id: number }>;
  updateCoffee: (id: number, patch: CoffeeUpdate) => Promise<void>;
  deleteCoffee: (id: number) => Promise<void>;
  toggleFavourite: (c: Coffee) => Promise<void>;
  setCoffeeRating: (id: number, rating: BeanRating | null) => Promise<void>;
  mergeCoffee: (sourceId: number, targetId: number) => Promise<void>;
  match: (name: string, roaster: string | null) => Promise<MatchCandidate[]>;
  // roasting (Röstung)
  createRoasting: (
    coffeeId: number,
    data: { roastDate?: string | null; bagSizeG?: number | null; pricePerBagEur?: number | null; remainingG?: number | null },
  ) => Promise<void>;
  updateRoasting: (id: number, patch: BeanUpdate) => Promise<void>;
  deleteRoasting: (id: number) => Promise<void>;
  setRoastingStatus: (id: number, status: BeanStatus, date?: string) => Promise<void>;
  /** §3g: toggle the active-source flag (independent of physical status). */
  setRoastingActive: (id: number, isActive: boolean) => Promise<void>;
  moveRoasting: (id: number, coffeeId: number) => Promise<void>;
  setRatingOverride: (id: number, rating: BeanRating | null) => Promise<void>;
}

export function useCoffees(): UseCoffeesReturn {
  const [coffees, setCoffees] = useState<CoffeeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [coffeeList, beanList] = await Promise.all([
        apiFetch<Coffee[]>("/api/coffees"),
        apiFetch<Bean[]>("/api/beans"),
      ]);
      setCoffees(assemble(coffeeList, beanList));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // --- coffee ---
  const createCoffee = useCallback(async (data: CoffeeCreatePayload) => {
    const res = await apiFetch<{ id: number }>("/api/coffees", jsonInit("POST", data));
    await refresh();
    return res;
  }, [refresh]);

  const updateCoffee = useCallback(async (id: number, patch: CoffeeUpdate) => {
    await apiFetch(`/api/coffees/${id}`, jsonInit("PUT", patch));
    await refresh();
  }, [refresh]);

  const deleteCoffee = useCallback(async (id: number) => {
    await apiFetch(`/api/coffees/${id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const toggleFavourite = useCallback(async (c: Coffee) => {
    await apiFetch(`/api/coffees/${c.id}`, jsonInit("PUT", { favourite: !c.favourite }));
    await refresh();
  }, [refresh]);

  const setCoffeeRating = useCallback(async (id: number, rating: BeanRating | null) => {
    await apiFetch(`/api/coffees/${id}`, jsonInit("PUT", { rating }));
    await refresh();
  }, [refresh]);

  const mergeCoffee = useCallback(async (sourceId: number, targetId: number) => {
    await apiFetch(`/api/coffees/${sourceId}/merge`, jsonInit("POST", { targetId }));
    await refresh();
  }, [refresh]);

  const match = useCallback(async (name: string, roaster: string | null) => {
    const qs = new URLSearchParams({ name });
    if (roaster) qs.set("roaster", roaster);
    return apiFetch<MatchCandidate[]>(`/api/coffees/match?${qs.toString()}`);
  }, []);

  // --- roasting ---
  const createRoasting = useCallback(async (
    coffeeId: number,
    data: { roastDate?: string | null; bagSizeG?: number | null; pricePerBagEur?: number | null; remainingG?: number | null },
  ) => {
    await apiFetch(`/api/coffees/${coffeeId}/roastings`, jsonInit("POST", data));
    await refresh();
  }, [refresh]);

  const updateRoasting = useCallback(async (id: number, patch: BeanUpdate) => {
    await apiFetch(`/api/beans/${id}`, jsonInit("PUT", patch));
    await refresh();
  }, [refresh]);

  const deleteRoasting = useCallback(async (id: number) => {
    await apiFetch(`/api/beans/${id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const setRoastingStatus = useCallback(async (id: number, status: BeanStatus, date?: string) => {
    await apiFetch(`/api/beans/${id}/status`, jsonInit("POST", { status, date }));
    await refresh();
  }, [refresh]);

  const setRoastingActive = useCallback(async (id: number, isActive: boolean) => {
    await apiFetch(`/api/beans/${id}/active`, jsonInit("POST", { isActive }));
    await refresh();
  }, [refresh]);

  const moveRoasting = useCallback(async (id: number, coffeeId: number) => {
    await apiFetch(`/api/beans/${id}/move`, jsonInit("POST", { coffeeId }));
    await refresh();
  }, [refresh]);

  const setRatingOverride = useCallback(async (id: number, rating: BeanRating | null) => {
    await apiFetch(`/api/beans/${id}/rating-override`, jsonInit("POST", { rating }));
    await refresh();
  }, [refresh]);

  return {
    coffees, loading, error, refresh,
    createCoffee, updateCoffee, deleteCoffee, toggleFavourite, setCoffeeRating, mergeCoffee, match,
    createRoasting, updateRoasting, deleteRoasting, setRoastingStatus, setRoastingActive, moveRoasting, setRatingOverride,
  };
}
