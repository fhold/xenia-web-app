/**
 * StageStrip — Stufenleiste unter dem Diagramm der History-Detailansicht: je
 * Stufe ein Abschnitt auf derselben Zeitachse wie die Kurven, mit dem, was die
 * Stufe tat (links), und dem Ausstieg, der sie beendet hat (rechts). Darunter
 * der erste Tropfen und was nicht mehr drankam. Die Rechnung steht getestet in
 * shared/stage-strip.ts; hier wird nur gesetzt und beschriftet.
 */

import { Timer, Scale, Droplet, CircleStop, Thermometer, TriangleAlert } from "lucide-react";
import type { StageStrip as StageStripData, StripExit, StripWhat, StripSegment } from "@shared/stage-strip.js";
import { stopModeLabel } from "../lib/stopMode.js";
import { HoverTip } from "./HoverTip.js";
import { useTranslation } from "../i18n/index.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

interface StageStripProps {
  strip: StageStripData;
  firstDropS: number | null;
  /** Nachlauf nach dem Pumpenstopp bis zum Ende der Aufzeichnung — sonst endet die
   *  Leiste scheinbar zu frueh, weil das Diagramm weiterzeichnet (Flavio 22.10.). */
  tail?: { endS: number; gainG: number | null } | null;
  /** Sichtbarer Zeitbereich des Diagramms (s) — die Leiste teilt die x-Achse. */
  xMin: number;
  xMax: number;
  /** Abstand der Plotflaeche zum Kartenrand links/rechts (Y-Achsen), px. */
  padLeft: number;
  padRight: number;
}

function tint(what: StripWhat): string {
  if (what.kind === "preinfusion") return C.seriesPower;
  if (what.value === 0) return C.dim;
  return what.kind === "flow" ? C.seriesFlow : what.kind === "pressure" ? C.seriesPressure : C.seriesPower;
}

export function StageStrip({ strip, firstDropS, tail = null, xMin, xMax, padLeft, padRight }: StageStripProps) {
  const { t, lang } = useTranslation();
  const locale = lang === "de" ? "de-DE" : "en-US";
  const span = Math.max(xMax - xMin, 0.001);
  const pct = (s: number) => `${(Math.min(Math.max(s, xMin), xMax) - xMin) / span * 100}%`;
  const n = (v: number, digits = 1) => v.toLocaleString(locale, { maximumFractionDigits: digits });

  const whatText = (w: StripWhat): string => {
    if (w.kind === "preinfusion") return t("history.detailModal.stripPreinfusion");
    if (w.value === 0) return t("history.detailModal.stripPause");
    if (w.kind === "flow") return `${w.value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 })} g/s`;
    if (w.kind === "pressure") return `${n(w.value)} bar`;
    return `${n(w.value, 0)} %`;
  };

  const exitParts = (e: StripExit): { icon: React.ReactNode; text: string; warn: boolean } => {
    const ic = { size: 10, strokeWidth: 2.2 };
    switch (e.kind) {
      case "seconds": return { icon: <Timer {...ic} />, text: `${n(e.value)} s`, warn: false };
      case "weight": return { icon: <Scale {...ic} />, text: `${n(e.value)} g`, warn: false };
      case "pressureAbove": return { icon: null, text: `≥ ${n(e.value)} bar`, warn: false };
      case "pressureBelow": return { icon: null, text: `≤ ${n(e.value)} bar`, warn: false };
      case "flowBelow": return { icon: null, text: `≤ ${n(e.value, 2)} g/s`, warn: false };
      case "flowAbove": return { icon: null, text: `≥ ${n(e.value, 2)} g/s`, warn: false };
      case "arrived": return { icon: <Droplet {...ic} />, text: t("history.detailModal.stripArrived"), warn: false };
      case "waitWeight": return { icon: <Scale {...ic} />, text: `${n(e.value)} g`, warn: false };
      case "waitTemp": return { icon: <Thermometer {...ic} />, text: `${n(e.value)} °C`, warn: false };
      case "waitPressure": return { icon: null, text: `≥ ${n(e.value)} bar`, warn: false };
      case "stop": {
        const warn = e.mode === "watchdog" || e.mode === "flowhold_watchdog" || e.mode === "app_failed";
        const text = e.weightG !== null && !warn ? `${n(e.weightG)} g` : stopModeLabel(t, e.mode);
        return { icon: warn ? <TriangleAlert {...ic} /> : <CircleStop {...ic} />, text, warn };
      }
    }
  };

  const tip = (key: string, params?: Record<string, string | number>) =>
    t(`history.detailModal.tip.${key}`, params);

  /** Kopfzeile: die Vorgabe der Stufe. */
  const whatTip = (w: StripWhat): string => {
    if (w.kind === "preinfusion") return tip("preinfusion");
    if (w.value === 0) return tip("pause");
    if (w.kind === "flow") return tip("flow", { v: w.value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 }) });
    if (w.kind === "pressure") return tip("pressure", { v: n(w.value) });
    return tip("power", { v: n(w.value, 0) });
  };

  /** Wodurch die Stufe endete. */
  const exitTip = (e: StripExit): string => {
    switch (e.kind) {
      case "seconds": return tip("exitSeconds", { v: n(e.value) });
      case "weight": return tip("exitWeight", { v: n(e.value) });
      case "pressureAbove": return tip("exitPressureAbove", { v: n(e.value) });
      case "pressureBelow": return tip("exitPressureBelow", { v: n(e.value) });
      case "flowBelow": return tip("exitFlowBelow", { v: n(e.value, 2) });
      case "flowAbove": return tip("exitFlowAbove", { v: n(e.value, 2) });
      case "arrived": return tip("exitArrived");
      case "waitWeight": return tip("exitWaitWeight", { v: n(e.value) });
      case "waitTemp": return tip("exitWaitTemp", { v: n(e.value) });
      case "waitPressure": return tip("exitWaitPressure", { v: n(e.value) });
      case "stop": {
        const ex = exitParts(e);
        return e.weightG !== null && !ex.warn
          ? tip("exitStopWeight", { v: n(e.weightG) })
          : tip("exitStop", { how: stopModeLabel(t, e.mode) });
      }
    }
  };

  const segTip = (g: StripSegment, color: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ color, fontWeight: 600 }}>{g.name ? `${g.name} · ${whatTip(g.what)}` : whatTip(g.what)}</span>
        <span style={{ ...MONO, color: C.mut, whiteSpace: "nowrap" }}>{n(g.startS)}–{n(g.endS)} s</span>
      </div>
      {g.rampS > 0 && <div>{tip("ramp", { s: n(g.rampS) })}</div>}
      {g.exit && <div>{exitTip(g.exit)}</div>}
      {g.uncertain && <div style={{ color: C.mut }}>{t("history.detailModal.stripUncertain")}</div>}
    </div>
  );

  return (
    <div style={{ marginLeft: padLeft, marginRight: padRight, marginTop: 6 }}>
      {/* Zwei Zeilen je Stufe — oben was sie tat, darunter was sie beendet hat —
          damit auch eine kurze Stufe (3 s von 40) beides lesbar zeigt. */}
      <div style={{ position: "relative", height: 32 }}>
        {strip.segments.map((g, i) => {
          const color = tint(g.what);
          const ex = g.exit ? exitParts(g.exit) : null;
          const line: React.CSSProperties = { ...MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: "13px" };
          return (
            <HoverTip
              key={i}
              content={segTip(g, color)}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: pct(g.startS),
                width: `calc(${pct(g.endS)} - ${pct(g.startS)})`,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: "0 4px",
                overflow: "hidden",
                fontSize: 10,
                background: alpha(color, 0.13),
                borderLeft: `2px solid ${alpha(color, 0.7)}`,
                borderRadius: 3,
                opacity: g.uncertain ? 0.55 : 1,
                outline: g.uncertain ? `1px dashed ${alpha(color, 0.5)}` : undefined,
                outlineOffset: -1,
              }}
            >
              <span style={{ ...line, color, fontWeight: 600 }}>{g.name ?? whatText(g.what)}</span>
              {ex && (
                <span style={{ ...line, display: "flex", alignItems: "center", gap: 3, color: ex.warn ? C.org : C.mut }}>
                  <span style={{ display: "inline-flex", flexShrink: 0 }}>{ex.icon}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{ex.text}</span>
                </span>
              )}
            </HoverTip>
          );
        })}
        {(() => {
          // Nachlauf: grau, vom Ende der letzten Stufe bis zum Ende der Aufzeichnung.
          const from = strip.segments.length > 0 ? strip.segments[strip.segments.length - 1]!.endS : null;
          if (!tail || from === null || tail.endS - from < 0.3) return null;
          const gain = tail.gainG !== null && tail.gainG >= 0.05 ? `+${n(tail.gainG)} g` : null;
          const line: React.CSSProperties = { ...MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: "13px", color: C.mut };
          return (
            <HoverTip
              content={
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span style={{ fontWeight: 600 }}>{t("history.detailModal.stripTail")}</span>
                    <span style={{ ...MONO, color: C.mut, whiteSpace: "nowrap" }}>{n(from)}–{n(tail.endS)} s</span>
                  </div>
                  <div>{t("history.detailModal.tip.tail")}{gain ? ` · ${gain}` : ""}</div>
                </div>
              }
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: pct(from),
                width: `calc(${pct(tail.endS)} - ${pct(from)})`,
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: "0 4px",
                overflow: "hidden",
                fontSize: 10,
                background: alpha(C.mut, 0.08),
                borderLeft: `2px solid ${alpha(C.mut, 0.45)}`,
                borderRadius: 3,
              }}
            >
              <span style={{ ...line, fontWeight: 600 }}>{t("history.detailModal.stripTail")}</span>
              {gain && <span style={line}>{gain}</span>}
            </HoverTip>
          );
        })()}
      </div>
      {(firstDropS !== null || strip.notReached.length > 0) && (
        <div style={{ position: "relative", height: 14, marginTop: 2, fontSize: 9.5, color: C.mut }}>
          {firstDropS !== null && (
            <HoverTip
              content={tip("firstDrop", { s: n(firstDropS) })}
              style={{
                ...MONO,
                position: "absolute",
                left: pct(firstDropS),
                transform: "translateX(-5px)",
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                whiteSpace: "nowrap",
              }}
            >
              <Droplet size={9} strokeWidth={2.2} color={C.seriesFlow} />
              {n(firstDropS)} s
            </HoverTip>
          )}
          {strip.notReached.length > 0 && (
            <HoverTip content={tip("notReached")} style={{ position: "absolute", right: 0, whiteSpace: "nowrap" }}>
              {t("history.detailModal.stripNotReached")}{" "}
              <span style={MONO}>{strip.notReached.map(whatText).join(" → ")}</span>
            </HoverTip>
          )}
        </div>
      )}
    </div>
  );
}
