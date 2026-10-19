import { useState, useEffect, useCallback } from "react";
import type { Profile, ProfileCreate, ProfileUpdate } from "@shared/types.js";

// ---------------------------------------------------------------------------
// API helpers
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

export interface UseProfilesReturn {
  profiles: Profile[];
  loading: boolean;
  error: string | null;
  /** Re-fetches the full profile list. */
  refresh: () => Promise<void>;
  createProfile: (data: ProfileCreate) => Promise<Profile>;
  updateProfile: (id: number, patch: ProfileUpdate) => Promise<Profile>;
  deleteProfile: (id: number) => Promise<void>;
  /** Saves the list order (drag & drop): all profile IDs in display order. */
  reorderProfiles: (ids: number[]) => Promise<void>;
}

export function useProfiles(): UseProfilesReturn {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Profile[]>("/api/profiles");
      setProfiles(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // F-T4: profiles are an app-global list another device (e.g. the PC web UI)
  // can change. Revalidate when the tab regains focus / becomes visible so a
  // profile created elsewhere appears without a full browser restart. (The
  // service worker is pass-through and caches nothing — this is the real fix.)
  useEffect(() => {
    const onActive = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  }, [refresh]);

  const createProfile = useCallback(async (data: ProfileCreate): Promise<Profile> => {
    const created = await apiFetch<Profile>("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await refresh();
    return created;
  }, [refresh]);

  const updateProfile = useCallback(async (id: number, patch: ProfileUpdate): Promise<Profile> => {
    const updated = await apiFetch<Profile>(`/api/profiles/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
    return updated;
  }, [refresh]);

  const deleteProfile = useCallback(async (id: number): Promise<void> => {
    await apiFetch<{ ok: true }>(`/api/profiles/${id}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const reorderProfiles = useCallback(async (ids: number[]): Promise<void> => {
    await apiFetch<{ ok: true }>("/api/profiles/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await refresh();
  }, [refresh]);

  return { profiles, loading, error, refresh, createProfile, updateProfile, deleteProfile, reorderProfiles };
}
