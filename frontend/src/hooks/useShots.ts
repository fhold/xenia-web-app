/**
 * useShots — loads the shot history with filter, sort and infinite scroll.
 *
 * Filters reload from offset 0; loadMore() appends the next 30-shot page.
 * update() refetches the loaded range so joined bean/grinder names refresh;
 * remove() drops the shot from the local list.
 */

import { useCallback, useEffect, useState } from "react";
import type {
  ShotListItem,
  ShotListResponse,
  ShotSortKey,
  ShotUpdate,
} from "@shared/types.js";

export type ShotCategoryFilter = "brew" | "maintenance" | "test" | "all";

export interface ShotFilters {
  sort: ShotSortKey;
  category: ShotCategoryFilter;
  beanId: number | null;
  grinderId: number | null;
  profileId: number | null;
  basketId: number | null;
  /** Schnitt 4: Spruenge aus dem Netz — alle Roestungen einer Sorte, die gelaufene Variante. */
  coffeeId: number | null;
  variantId: number | null;
  /** Exact shot rating 1–5, or null for no filter. */
  rating: number | null;
  /** ISO date YYYY-MM-DD, or null. */
  startDate: string | null;
  endDate: string | null;
}

export const DEFAULT_SHOT_FILTERS: ShotFilters = {
  sort: "date_desc",
  category: "brew",
  beanId: null,
  grinderId: null,
  profileId: null,
  basketId: null,
  coffeeId: null,
  variantId: null,
  rating: null,
  startDate: null,
  endDate: null,
};

const PAGE_SIZE = 30;

function buildUrl(filters: ShotFilters, offset: number, limit: number): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  p.set("sort", filters.sort);
  p.set("category", filters.category);
  if (filters.beanId !== null) p.set("bean_id", String(filters.beanId));
  if (filters.grinderId !== null) p.set("grinder_id", String(filters.grinderId));
  if (filters.profileId !== null) p.set("profile_id", String(filters.profileId));
  if (filters.basketId !== null) p.set("basket_id", String(filters.basketId));
  if (filters.coffeeId !== null) p.set("coffee_id", String(filters.coffeeId));
  if (filters.variantId !== null) p.set("variant_id", String(filters.variantId));
  if (filters.rating !== null) p.set("rating", String(filters.rating));
  if (filters.startDate) p.set("start_date", filters.startDate);
  if (filters.endDate) p.set("end_date", filters.endDate);
  return `/api/shots?${p.toString()}`;
}

export interface UseShotsReturn {
  shots: ShotListItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  filters: ShotFilters;
  setFilters: (f: ShotFilters) => void;
  resetFilters: () => void;
  loadMore: () => void;
  update: (id: number, patch: ShotUpdate) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export function useShots(): UseShotsReturn {
  const [filters, setFiltersState] = useState<ShotFilters>(DEFAULT_SHOT_FILTERS);
  const [shots, setShots] = useState<ShotListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load + reload whenever the filters change.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(buildUrl(filters, 0, PAGE_SIZE), { signal: controller.signal })
      .then((r) => r.json() as Promise<ShotListResponse>)
      .then((res) => {
        setShots(res.shots);
        setTotal(res.total);
        setHasMore(res.hasMore);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { controller.abort(); };
  }, [filters]);

  const loadMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    fetch(buildUrl(filters, shots.length, PAGE_SIZE))
      .then((r) => r.json() as Promise<ShotListResponse>)
      .then((res) => {
        setShots((prev) => [...prev, ...res.shots]);
        setTotal(res.total);
        setHasMore(res.hasMore);
        setLoadingMore(false);
      })
      .catch(() => { setLoadingMore(false); });
  }, [filters, shots.length, hasMore, loadingMore, loading]);

  // Refetch the currently-loaded range so an edit's joined names refresh.
  const reloadLoaded = useCallback(async () => {
    const res = (await fetch(
      buildUrl(filters, 0, Math.max(shots.length, PAGE_SIZE)),
    ).then((r) => r.json())) as ShotListResponse;
    setShots(res.shots);
    setTotal(res.total);
    setHasMore(res.hasMore);
  }, [filters, shots.length]);

  const update = useCallback(
    async (id: number, patch: ShotUpdate): Promise<void> => {
      const res = await fetch(`/api/shots/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await reloadLoaded();
    },
    [reloadLoaded],
  );

  const remove = useCallback(async (id: number): Promise<void> => {
    const res = await fetch(`/api/shots/${id}`, { method: "DELETE" });
    // 404 is fine — the shot is gone either way (idempotent delete).
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status}`);
    }
    setShots((prev) => prev.filter((s) => s.id !== id));
    setTotal((t) => Math.max(0, t - 1));
  }, []);

  const setFilters = useCallback((f: ShotFilters) => { setFiltersState(f); }, []);
  const resetFilters = useCallback(() => { setFiltersState(DEFAULT_SHOT_FILTERS); }, []);

  return {
    shots, total, hasMore, loading, loadingMore, error,
    filters, setFilters, resetFilters, loadMore, update, remove,
  };
}
