/**
 * useShotDetail — loads the sample rows for one shot, on demand.
 *
 * Shot metadata is not re-fetched: the History view already holds the
 * ShotListItem, so only the samples (for the chart) are loaded here.
 */

import { useEffect, useState } from "react";
import type { Sample, ShotStage, BrewProfile, BrewDefInfo } from "@shared/types.js";

export function useShotDetail(shotId: number): {
  samples: Sample[];
  /** SO-1: script body for the commanded overlay — the frozen one this shot
   *  ran when known, else the script as it reads today. */
  scriptContent: string | null;
  /** Flow-Hold stages this shot ran (empty for script/execute shots). */
  stages: ShotStage[];
  /** BrewProfile steps snapshot at brew time (null for non-drive shots). */
  brewSteps: BrewProfile | null;
  /** Frozen brew definition (null for shots recorded before snapshotting). */
  brewDef: BrewDefInfo | null;
  loading: boolean;
} {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [scriptContent, setScriptContent] = useState<string | null>(null);
  const [stages, setStages] = useState<ShotStage[]>([]);
  const [brewSteps, setBrewSteps] = useState<BrewProfile | null>(null);
  const [brewDef, setBrewDef] = useState<BrewDefInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/shots/${shotId}/samples`, { signal: controller.signal })
      .then(
        (r) =>
          r.json() as Promise<{
            samples: Sample[];
            scriptContent?: string | null;
            stages?: ShotStage[];
            brewSteps?: BrewProfile | null;
            brewDef?: BrewDefInfo | null;
          }>,
      )
      .then((res) => {
        setSamples(res.samples);
        setScriptContent(res.scriptContent ?? null);
        setStages(res.stages ?? []);
        setBrewSteps(res.brewSteps ?? null);
        setBrewDef(res.brewDef ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
      });
    return () => { controller.abort(); };
  }, [shotId]);

  return { samples, scriptContent, stages, brewSteps, brewDef, loading };
}
