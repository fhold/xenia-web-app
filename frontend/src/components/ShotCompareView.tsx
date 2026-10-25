/**
 * ShotCompareView — zwei frei gewaehlte Bezuege uebereinander (Flavio 2026-10-20).
 *
 * A in den gewohnten Farben, B in eigener Farbfamilie und gestrichelt (theme.ts
 * series…B); die Achse reicht bis zum laengeren. Darunter bzw. daneben eine Tabelle A | B | Δ: was eingestellt war
 * (Unterschiede farbig — so sieht man, ob nur eine Groesse geaendert wurde),
 * was herauskam und wie er bewertet wurde.
 *
 * Ausrichten am ersten Tropfen schiebt den Bezug mit dem frueheren Tropfen nach
 * rechts, damit beide Extraktionen gleichzeitig beginnen — bei unterschiedlich
 * langer Preinfusion sonst nicht vergleichbar.
 */

import { useMemo, useState } from "react";
import { X, ArrowLeftRight } from "lucide-react";
import { ShotChart } from "./ShotChart.js";
import { useShotDetail } from "../hooks/useShotDetail.js";
import { useBaskets, basketName } from "../hooks/useBaskets.js";
import { shotMetrics, alignAtFirstDrop } from "@shared/shot-compare.js";
import type { ShotMetrics } from "@shared/shot-compare.js";
import { stopModeLabel } from "../lib/stopMode.js";
import { formatDay } from "../lib/dates.js";
import { useTranslation } from "../i18n/index.js";
import type { ChartSample } from "../hooks/useShotSamples.js";
import type { Sample, ShotListItem } from "@shared/types.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

interface ShotCompareViewProps {
  a: ShotListItem;
  b: ShotListItem;
  mobile: boolean;
  /** Variantenname, wenn das Profil mehrere hat (wie in der Historie). */
  variantName: (s: ShotListItem) => string | null;
  /** Tipp auf einen Bezug im Kopf: sein Detail oeffnen. */
  onOpenShot: (s: ShotListItem) => void;
  onClose: () => void;
}

/** Messpunkte fuers Diagramm, um `offS` verschoben; Temperatur zeigt der Vergleich nicht. */
function toChart(samples: Sample[], offS: number): ChartSample[] {
  return samples.map((s) => ({
    t: parseFloat((s.elapsedMs / 1000 + offS).toFixed(2)),
    pressure: s.pressureBar,
    flow: s.flowMlS,
    temp: null,
    weight: s.weightG,
    pumpPwm: null,
  }));
}

interface Side {
  shot: ShotListItem;
  samples: Sample[];
  m: ShotMetrics;
}

interface Row {
  label: string;
  a: string;
  b: string;
  /** A − B, schon formatiert; null = keine Differenz sinnvoll. */
  delta: string | null;
  /** Einstellung, die sich unterscheidet — farbig. */
  differs?: boolean;
  title?: string;
}

export function ShotCompareView({ a, b, mobile, variantName, onOpenShot, onClose }: ShotCompareViewProps) {
  const { t, lang } = useTranslation();
  const { baskets } = useBaskets();
  const da = useShotDetail(a.id);
  const db = useShotDetail(b.id);
  const [swapped, setSwapped] = useState(false);
  const [alignDrop, setAlignDrop] = useState(false);

  const sideA = useMemo<Side>(() => ({ shot: a, samples: da.samples, m: shotMetrics(da.samples) }), [a, da.samples]);
  const sideB = useMemo<Side>(() => ({ shot: b, samples: db.samples, m: shotMetrics(db.samples) }), [b, db.samples]);
  const [A, B] = swapped ? [sideB, sideA] : [sideA, sideB];
  const loading = da.loading || db.loading;

  const offsets = alignAtFirstDrop(A.m.firstDropS, B.m.firstDropS);
  const canAlign = offsets !== null;
  const offA = alignDrop && offsets ? offsets.a : 0;
  const offB = alignDrop && offsets ? offsets.b : 0;
  const chartA = useMemo(() => toChart(A.samples, offA), [A.samples, offA]);
  const chartB = useMemo(() => toChart(B.samples, offB), [B.samples, offB]);

  // Gewichtsachse wie im Detail, aber ueber beide Bezuege.
  const maxW = Math.max(0, ...A.samples.map((s) => s.weightG ?? 0), ...B.samples.map((s) => s.weightG ?? 0));
  const yWeightMax = maxW > 50 ? Math.ceil(maxW / 10) * 10 + 10 : 50;

  const num = (v: number, d: number) => (lang === "de" ? v.toFixed(d).replace(".", ",") : v.toFixed(d));
  // Gleich = leer: ein „±0“ in jeder Zeile waere nur Rauschen.
  const signed = (v: number, d: number) => {
    const r = Number(v.toFixed(d));
    return r === 0 ? null : `${r > 0 ? "+" : "−"}${num(Math.abs(r), d)}`;
  };
  const opt = (v: number | null, f: (x: number) => string) => (v === null ? "—" : f(v));
  const diff = (x: number | null, y: number | null, d: number) => (x === null || y === null ? null : signed(x - y, d));

  const rows = useMemo(() => {
    const sa = A.shot, sb = B.shot;
    const profile = (s: ShotListItem) => [s.profileName, variantName(s)].filter(Boolean).join(" · ");
    const basket = (s: ShotListItem) => basketName(baskets, s.basketId) ?? (s.shotSize === "single" ? "1×" : "2×");
    const bean = (s: ShotListItem) => s.beanName ?? s.beanLabel ?? "—";
    // Mahlgrade verschiedener Muehlen sind nicht vergleichbar: dann steht die Muehle dabei, ohne Δ.
    const sameGrinder = sa.grinderId === sb.grinderId;
    const grind = (s: ShotListItem) =>
      `${opt(s.grindSetting, (g) => String(g).replace(".", lang === "de" ? "," : "."))}${sameGrinder ? "" : ` · ${s.grinderName ?? "—"}`}`;
    const ratio = (s: ShotListItem) => (s.doseG && s.yieldActualG !== null ? s.yieldActualG / s.doseG : null);
    const durS = (s: ShotListItem) => (s.endedAt !== null ? Math.round((s.endedAt - s.startedAt) / 1000) : null);
    const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    const yieldText = (s: ShotListItem) =>
      s.yieldActualG === null ? "—" : `${num(s.yieldActualG, 1)} g${s.yieldTargetG !== null ? ` (${num(s.yieldTargetG, 0)})` : ""}`;
    const channeling = (s: ShotListItem) =>
      !s.channeling ? "—" : s.channelingSeverity ? t(s.channelingSeverity === "strong" ? "shotRating.channelingStrong" : "shotRating.channelingLight") : t("shotRating.channeling");
    const grindNote = (s: ShotListItem) =>
      s.grindNote === null ? "—" : t(s.grindNote === "finer" ? "shotRating.grindFiner" : s.grindNote === "ok" ? "shotRating.grindOk" : "shotRating.grindCoarser");
    const setting = (label: string, va: string, vb: string, delta: string | null = null): Row =>
      ({ label, a: va, b: vb, delta, differs: va !== vb });

    const settings: Row[] = [
      setting(t("history.compare.profile"), profile(sa), profile(sb)),
      setting(t("history.compare.basket"), basket(sa), basket(sb)),
      setting(t("history.detailModal.bean"), bean(sa), bean(sb)),
      setting(t("shotRating.grind"), grind(sa), grind(sb), sameGrinder ? diff(sa.grindSetting, sb.grindSetting, 1) : null),
      setting(t("history.detailModal.dose"), opt(sa.doseG, (v) => `${num(v, 1)} g`), opt(sb.doseG, (v) => `${num(v, 1)} g`), diff(sa.doseG, sb.doseG, 1)),
      setting(t("history.detailModal.setTemp"), opt(sa.profileSetTempC, (v) => `${num(v, 0)} °C`), opt(sb.profileSetTempC, (v) => `${num(v, 0)} °C`), diff(sa.profileSetTempC, sb.profileSetTempC, 0)),
    ];
    const ra = ratio(sa), rb = ratio(sb), ta = durS(sa), tb = durS(sb);
    const result: Row[] = [
      { label: t("history.detailModal.yield"), a: yieldText(sa), b: yieldText(sb), delta: diff(sa.yieldActualG, sb.yieldActualG, 1) },
      { label: t("history.detailModal.ratio"), a: opt(ra, (v) => `1:${num(v, 1)}`), b: opt(rb, (v) => `1:${num(v, 1)}`), delta: diff(ra, rb, 1) },
      { label: t("history.detailModal.time"), a: opt(ta, mmss), b: opt(tb, mmss), delta: ta !== null && tb !== null && ta !== tb ? `${signed(ta - tb, 0)} s` : null },
      { label: t("history.compare.firstDrop"), a: opt(A.m.firstDropS, (v) => `${num(v, 1)} s`), b: opt(B.m.firstDropS, (v) => `${num(v, 1)} s`), delta: diff(A.m.firstDropS, B.m.firstDropS, 1) },
      {
        label: t("history.compare.extractionFlow"), title: t("history.compare.extractionFlowTip"),
        a: opt(A.m.extractionFlowGs, (v) => `${num(v, 2)} g/s`), b: opt(B.m.extractionFlowGs, (v) => `${num(v, 2)} g/s`),
        delta: diff(A.m.extractionFlowGs, B.m.extractionFlowGs, 2),
      },
      { label: t("history.detailModal.avgPressure"), a: opt(A.m.avgPressureBar, (v) => `${num(v, 1)} bar`), b: opt(B.m.avgPressureBar, (v) => `${num(v, 1)} bar`), delta: diff(A.m.avgPressureBar, B.m.avgPressureBar, 1) },
      { label: t("history.detailModal.stopMode"), a: stopModeLabel(t, sa.stopMode), b: stopModeLabel(t, sb.stopMode), delta: null },
    ];
    const rating: Row[] = [
      { label: t("shotRating.overall"), a: opt(sa.rating, (v) => `${v}/5`), b: opt(sb.rating, (v) => `${v}/5`), delta: diff(sa.rating, sb.rating, 0) },
      {
        label: `${t("shotRating.acidity")} / ${t("shotRating.bitterness")}`,
        a: `${sa.acidity ?? "–"} / ${sa.bitterness ?? "–"}`, b: `${sb.acidity ?? "–"} / ${sb.bitterness ?? "–"}`, delta: null,
      },
      { label: t("shotRating.channeling"), a: channeling(sa), b: channeling(sb), delta: null },
      { label: t("history.compare.grindNote"), a: grindNote(sa), b: grindNote(sb), delta: null },
    ];
    return [
      { title: t("history.compare.sectionSettings"), rows: settings },
      { title: t("history.compare.sectionResult"), rows: result },
      { title: t("shotRating.title"), rows: rating },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [A, B, baskets, lang]);

  const locale = lang === "de" ? "de-DE" : "en-US";
  const head = (side: Side, dashed: boolean) => {
    const s = side.shot;
    const sub = [
      basketName(baskets, s.basketId),
      formatDay(s.startedAt, { time: true, locale }),
      s.beanName ?? s.beanLabel,
    ].filter(Boolean).join(" · ");
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {/* Farbschluessel: Druck · Fluss · Gewicht dieses Bezugs */}
        <span title={t("history.compare.legend")} style={{ display: "inline-flex", gap: 3, flexShrink: 0 }}>
          {(dashed ? [C.seriesPressureB, C.seriesFlowB, C.seriesWeightB] : [C.seriesPressure, C.seriesFlow, C.seriesWeight]).map((c) => (
            <span key={c} style={{ width: 12, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${c}` }} />
          ))}
        </span>
        <span style={{ ...MONO, fontSize: 11, color: C.mut, flexShrink: 0 }}>{dashed ? "B" : "A"}</span>
        <button
          onClick={() => onOpenShot(s)}
          title={t("history.compare.openDetail")}
          style={{
            minWidth: 0, padding: 0, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit",
            textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 13,
          }}
        >
          <span style={{ ...MONO, color: C.acc }}>#{s.id}</span>
          <span style={{ color: C.txt, fontWeight: 600 }}> {s.profileName}</span>
          {sub && <span style={{ color: C.mut, fontSize: 11.5 }}> · {sub}</span>}
        </button>
      </div>
    );
  };

  const chartHeight = mobile ? 200 : 300;
  const cell: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "2px 0" };
  const table = (
    <div style={{ display: "grid", gridTemplateColumns: mobile ? "110px 1fr 1fr 42px" : "112px 1fr 1fr 48px", columnGap: 8, fontSize: 12, lineHeight: "16px", alignContent: "start" }}>
      <span />
      <span style={{ ...cell, color: C.mut, fontSize: 10.5 }}>A #{A.shot.id}</span>
      <span style={{ ...cell, color: C.mut, fontSize: 10.5 }}>B #{B.shot.id}</span>
      <span style={{ ...cell, color: C.mut, fontSize: 10.5, textAlign: "right" }}>Δ A−B</span>
      {rows.map((sec) => (
        <div key={sec.title} style={{ display: "contents" }}>
          <div style={{ gridColumn: "1 / -1", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: C.mut, fontWeight: 600, padding: "7px 0 1px", borderBottom: `1px solid ${C.bdr}`, marginBottom: 2 }}>
            {sec.title}
          </div>
          {sec.rows.map((r) => {
            const vc = r.differs ? C.acc : C.txt;
            return (
              <div key={r.label} style={{ display: "contents" }}>
                <span style={{ ...cell, color: C.mut, textDecoration: r.title ? "underline dotted" : undefined, textUnderlineOffset: 3 }} title={r.title ?? r.label}>{r.label}</span>
                <span style={{ ...cell, color: vc, fontWeight: r.differs ? 600 : 400 }} title={r.a}>{r.a}</span>
                <span style={{ ...cell, color: vc, fontWeight: r.differs ? 600 : 400 }} title={r.b}>{r.b}</span>
                <span style={{ ...cell, ...MONO, fontSize: 11, color: C.mut, textAlign: "right" }}>{r.delta ?? ""}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  const segBtn = (active: boolean, disabled = false): React.CSSProperties => ({
    padding: "4px 10px", borderRadius: 7, fontFamily: "inherit", fontSize: 11, fontWeight: 600,
    cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1,
    background: active ? C.accG2 : "transparent",
    border: `1px solid ${active ? C.accB : C.bdr2}`,
    color: active ? C.acc : C.mut,
  });

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: C.overlay, backdropFilter: "blur(4px)", zIndex: 100,
        display: "flex", alignItems: mobile ? "stretch" : "center", justifyContent: "center", padding: mobile ? 0 : 16,
      }}
    >
      <div
        onClick={(e) => { e.stopPropagation(); }}
        style={{
          background: C.cardElev,
          border: mobile ? "none" : `1px solid ${C.bdrL}`,
          borderRadius: mobile ? 0 : 14,
          padding: mobile ? `calc(16px + ${C.safeTop}) 16px 20px` : "16px 18px 18px",
          width: mobile ? "100%" : "min(1100px, 94vw)",
          maxHeight: mobile ? "100%" : "92vh",
          overflowY: "auto",
          boxSizing: "border-box",
          boxShadow: mobile ? "none" : `0 8px 40px ${alpha(C.black, 0.5)}`,
        }}
      >
        {/* Kopf: A und B, tauschen, schliessen */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {head(A, false)}
            {head(B, true)}
          </div>
          <button onClick={() => setSwapped((v) => !v)} title={t("history.compare.swap")} style={iconBtn}>
            <ArrowLeftRight size={16} />
          </button>
          <button onClick={onClose} title="" style={iconBtn}>
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div style={{ color: C.mut, fontSize: 12, textAlign: "center", padding: "40px 0" }}>…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: mobile ? "column" : "row", gap: mobile ? 14 : 18 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: C.mut, marginRight: 2 }}>{t("history.compare.align")}</span>
                <button onClick={() => setAlignDrop(false)} style={segBtn(!alignDrop || !canAlign)}>{t("history.compare.alignStart")}</button>
                <button
                  onClick={() => { if (canAlign) setAlignDrop(true); }}
                  disabled={!canAlign}
                  title={canAlign ? undefined : t("history.compare.alignDropMissing")}
                  style={segBtn(alignDrop && canAlign, !canAlign)}
                >
                  {t("history.compare.firstDrop")}
                </button>
              </div>
              {chartA.length === 0 && chartB.length === 0 ? (
                <div style={{ color: C.mut, fontSize: 12, textAlign: "center", padding: "40px 0" }}>{t("history.detailModal.noChart")}</div>
              ) : (
                <ShotChart
                  samples={chartA}
                  mode="ended"
                  yWeightMax={yWeightMax}
                  showTempAxis={false}
                  chartHeight={chartHeight}
                  endedBadge={false}
                  compare={chartB}
                />
              )}
            </div>
            <div style={{ width: mobile ? "100%" : 400, flexShrink: 0 }}>{table}</div>
          </div>
        )}
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: C.mut,
  display: "flex",
  padding: 2,
  flexShrink: 0,
};
