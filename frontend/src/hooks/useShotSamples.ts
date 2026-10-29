/**
 * useShotSamples — Phase 1 Step 7.
 *
 * Collects chart samples from live WebSocket frames during brewing,
 * then replaces them with DB-authoritative samples when the shot ends.
 *
 * Lives in App.tsx (not Dashboard) so samples survive view switches.
 */

import { useEffect, useRef, useState } from "react";
import type { BrewStep, LiveFrame, Shot, ShotDetail, ShotStage } from "@shared/types";
import { brewEndSeconds } from "@shared/live-stage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChartSample {
  /** Elapsed time in seconds from shot start. */
  t: number;
  /** Pump pressure in bar. */
  pressure: number | null;
  /** Flow rate in ml/s (≈ g/s) — PU_SENS_FLOW_METER_ML, already instantaneous. */
  flow: number | null;
  /** Brew group temperature in °C. */
  temp: number | null;
  /** Scale weight in grams. */
  weight: number | null;
  /** Pump power level % (PU_LEVEL_PW_CONTROL); null before pump logging. */
  pumpPwm: number | null;
}

/** Gespeicherte Stufen des beendeten Bezugs — die Soll-Kurve danach (auch nach
 *  dem Neuladen) kommt wie in der Historie aus der DB. */
export interface EndedShotStages {
  shotId: number;
  stages: ShotStage[];
  /** Profil-Schnappschuss des Bezugs (leer bei Skript-Bezügen). */
  steps: BrewStep[];
  /** Ende des Brühens in Sekunden (Pumpenstopp). */
  brewEndS: number;
}

interface UseShotSamplesArgs {
  frame: LiveFrame | null;
  activeShot: Shot | null;
  lastEndedShot: Shot | null;
}

/** Ab so viel ms nach Bezugsbeginn gilt ein Bezug als „mitten drin“ betreten. */
const JOIN_LATE_MS = 2_000;

function toChartSamples(detail: ShotDetail): ChartSample[] {
  return detail.samples.map((s) => ({
    t: parseFloat((s.elapsedMs / 1000).toFixed(2)),
    pressure: s.pressureBar,
    flow: s.flowMlS,
    temp: s.tempBgC,
    weight: s.weightG,
    pumpPwm: s.pumpPwm,
  }));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useShotSamples({
  frame,
  activeShot,
  lastEndedShot,
}: UseShotSamplesArgs): { samples: ChartSample[]; ended: EndedShotStages | null } {
  const [samples, setSamples] = useState<ChartSample[]>([]);
  const [ended, setEnded] = useState<EndedShotStages | null>(null);

  // Which shot ID we last cleared/started for
  const activeShotIdRef = useRef<number | null>(null);

  // Which shot we already fetched from DB (avoids double-fetch on re-render)
  const fetchedShotIdRef = useRef<number | null>(null);

  // ---- Clear samples when a new shot starts ----
  useEffect(() => {
    if (activeShot === null) return;
    if (activeShot.id === activeShotIdRef.current) return; // same shot, already cleared

    activeShotIdRef.current = activeShot.id;
    setSamples([]);

    // Mitten im Bezug dazugekommen (Neuladen, zweites Gerät): die bisherigen
    // Messpunkte schreibt der Recorder laufend in die DB — nachladen, die schon
    // live angekommenen dahinter behalten.
    if (Date.now() - activeShot.startedAt < JOIN_LATE_MS) return;
    const id = activeShot.id;
    fetch(`/api/shots/${id}`)
      .then((r) => r.json() as Promise<ShotDetail>)
      .then((detail) => {
        if (activeShotIdRef.current !== id) return;
        const past = toChartSamples(detail);
        const lastT = past.length > 0 ? past[past.length - 1]!.t : -1;
        setSamples((live) => [...past, ...live.filter((s) => s.t > lastT)]);
      })
      .catch((err: unknown) => {
        console.warn("[useShotSamples] Failed to fetch running shot:", err);
      });
  }, [activeShot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Accumulate live samples from each incoming frame ----
  useEffect(() => {
    if (!activeShot || !frame) return;

    const now = Date.now();
    const elapsedMs = now - activeShot.startedAt;
    const t = parseFloat((elapsedMs / 1000).toFixed(2));

    // Live flow rate (g/s ≈ ml/s) from the scale (PU_SENS_SCALE_RATE) since
    // FW 4.133 — already a rate, do NOT differentiate it.
    const flow = parseFloat(frame.flowRateGPerS.toFixed(3));

    const sample: ChartSample = {
      t,
      pressure: frame.pumpPressureBar,
      flow,
      temp: frame.brewGroupTempC,
      weight: frame.scaleWeightG,
      pumpPwm: frame.pumpPwm ?? null,
    };

    setSamples((prev) => {
      // Deduplicate: if last sample is within 50ms, replace rather than append.
      // Handles the case where two frames arrive in rapid succession.
      if (prev.length > 0 && Math.abs(prev[prev.length - 1].t - t) < 0.05) {
        return [...prev.slice(0, -1), sample];
      }
      return [...prev, sample];
    });
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Replace live samples with DB-authoritative data when shot ends ----
  //
  // IMPORTANT: we never call setSamples([]) here.
  // Live samples stay in state during the fetch so there is no blank-chart flash.
  // Only when the DB response arrives do we atomically replace the array.
  // If the fetch fails, live samples are kept as fallback.
  useEffect(() => {
    if (!lastEndedShot) return;
    if (activeShot !== null) return; // shot still running — wait
    if (fetchedShotIdRef.current === lastEndedShot.id) return; // already fetched

    fetchedShotIdRef.current = lastEndedShot.id;

    fetch(`/api/shots/${lastEndedShot.id}`)
      .then((r) => r.json() as Promise<ShotDetail>)
      .then((detail) => {
        // Atomic replace — no intermediate clear, no blank-chart flash
        setSamples(toChartSamples(detail));
        setEnded({
          shotId: detail.shot.id,
          stages: detail.stages,
          steps: detail.brewSteps?.steps ?? [],
          brewEndS: brewEndSeconds(detail.samples),
        });
      })
      .catch((err: unknown) => {
        // Keep live samples — better a slightly imprecise chart than an empty one
        console.warn("[useShotSamples] Failed to fetch shot detail:", err);
      });
  }, [lastEndedShot?.id, activeShot]); // eslint-disable-line react-hooks/exhaustive-deps

  return { samples, ended };
}
