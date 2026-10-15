/**
 * Modal for creating or editing a profile.
 * description is always null in V1 — no editor field.
 */

import { useState } from "react";
import { X, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import type {
  BrewProfile,
  BrewStep,
  FlowStep,
  PowerStep,
  PreinfusionStep,
  PreinfusionGentleness,
  PressureStep,
  Profile,
  ProfileCreate,
  ProfileUpdate,
  StepExit,
  XeniaScript,
} from "@shared/types.js";
import { parseTargetTempC } from "@shared/profile-temp.js";
import { ProfileSollChart, autoStepLabel, GENTLENESS_LABEL } from "./ProfileSollChart.js";

import theme, { alpha } from '../theme';
const C = theme;

// --- Step editor local model ------------------------------------------------
// Controlled inputs are strings; they serialize to a typed BrewStep on save.

type StepKind = "flow" | "pressure" | "power" | "preinfusion";

interface EditStep {
  kind: StepKind;
  /** Freetext phase name; empty = show the derived label instead. */
  name: string;
  /** targetFlowGs (flow) | targetPressureBar (pressure) | power (power). */
  primary: string;
  /** Übergang in SEKUNDEN (die Karte zeigt Sekunden, BrewStep speichert ms). */
  rampS: string;
  /** maxPressureBar — flow und power. */
  limitBar: string;
  /** maxFlowGs — pressure und power. */
  limitGs: string;
  exitSeconds: string;
  exitWeightG: string;
  exitPressureBar: string;
  exitPressureBelowBar: string;
  exitFlowGs: string;
  /** Nur Preinfusion: wie zuegig sie saettigt. */
  gentleness: PreinfusionGentleness;
}

function emptyStep(kind: StepKind = "flow"): EditStep {
  return {
    kind,
    name: "",
    primary: "",
    rampS: "",
    limitBar: "",
    limitGs: "",
    exitSeconds: "",
    exitWeightG: "",
    exitPressureBar: "",
    exitPressureBelowBar: "",
    exitFlowGs: "",
    gentleness: "normal",
  };
}

function toEditStep(s: BrewStep): EditStep {
  const e = emptyStep(s.kind);
  e.name = s.name ?? "";
  e.exitSeconds = s.exit.seconds != null ? String(s.exit.seconds) : "";
  e.exitWeightG = s.exit.weightG != null ? String(s.exit.weightG) : "";
  e.exitPressureBar = s.exit.pressureBar != null ? String(s.exit.pressureBar) : "";
  e.exitPressureBelowBar = s.exit.pressureBelowBar != null ? String(s.exit.pressureBelowBar) : "";
  e.exitFlowGs = s.exit.flowGs != null ? String(s.exit.flowGs) : "";
  e.rampS = s.rampMs != null ? String(s.rampMs / 1000) : "";
  if (s.kind === "flow") {
    e.primary = String(s.targetFlowGs);
    e.limitBar = s.maxPressureBar != null ? String(s.maxPressureBar) : "";
  } else if (s.kind === "pressure") {
    e.primary = String(s.targetPressureBar);
    e.limitGs = s.maxFlowGs != null ? String(s.maxFlowGs) : "";
  } else if (s.kind === "preinfusion") {
    e.gentleness = s.gentleness ?? "normal";
  } else {
    e.primary = String(s.power);
    e.limitBar = s.maxPressureBar != null ? String(s.maxPressureBar) : "";
    e.limitGs = s.maxFlowGs != null ? String(s.maxFlowGs) : "";
  }
  return e;
}

function buildExit(e: EditStep): StepExit {
  const exit: StepExit = {};
  if (e.exitSeconds.trim() !== "") exit.seconds = parseFloat(e.exitSeconds);
  if (e.exitWeightG.trim() !== "") exit.weightG = parseFloat(e.exitWeightG);
  if (e.exitPressureBar.trim() !== "") exit.pressureBar = parseFloat(e.exitPressureBar);
  if (e.exitPressureBelowBar.trim() !== "") exit.pressureBelowBar = parseFloat(e.exitPressureBelowBar);
  if (e.exitFlowGs.trim() !== "") exit.flowGs = parseFloat(e.exitFlowGs);
  return exit;
}

/** Serialize an edit-step to a typed BrewStep. Assumes it passed validation. */
function buildStep(e: EditStep): BrewStep {
  const exit = buildExit(e);
  const name = e.name.trim();
  if (e.kind === "flow") {
    const s: FlowStep = { kind: "flow", targetFlowGs: parseFloat(e.primary), exit };
    if (name !== "") s.name = name;
    if (e.limitBar.trim() !== "") s.maxPressureBar = parseFloat(e.limitBar);
    if (e.rampS.trim() !== "") s.rampMs = Math.round(parseFloat(e.rampS) * 1000);
    return s;
  }
  if (e.kind === "pressure") {
    const s: PressureStep = { kind: "pressure", targetPressureBar: parseFloat(e.primary), exit };
    if (name !== "") s.name = name;
    if (e.limitGs.trim() !== "") s.maxFlowGs = parseFloat(e.limitGs);
    if (e.rampS.trim() !== "") s.rampMs = Math.round(parseFloat(e.rampS) * 1000);
    return s;
  }
  if (e.kind === "preinfusion") {
    // Sanfter Anlauf bleibt beim Standard (3 s) — kein eigenes Feld.
    const s: PreinfusionStep = { kind: "preinfusion", gentleness: e.gentleness, exit };
    if (name !== "") s.name = name;
    return s;
  }
  const s: PowerStep = { kind: "power", power: parseFloat(e.primary), exit };
  if (name !== "") s.name = name;
  if (e.limitBar.trim() !== "") s.maxPressureBar = parseFloat(e.limitBar);
  if (e.limitGs.trim() !== "") s.maxFlowGs = parseFloat(e.limitGs);
  if (e.rampS.trim() !== "") s.rampMs = Math.round(parseFloat(e.rampS) * 1000);
  return s;
}

/** Best-effort serialization for the live preview: steps that are still being
 *  typed (no usable target yet) are skipped instead of throwing. */
function previewSteps(steps: EditStep[]): BrewStep[] {
  return steps.filter((e) => e.kind === "preinfusion" || Number.isFinite(parseFloat(e.primary))).map(buildStep);
}

function parseYield(v: string): number | null {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const PRIMARY_LABEL: Record<StepKind, string> = {
  flow: "Ziel-Flow (g/s)",
  pressure: "Ziel-Druck (bar)",
  power: "Power (%)",
  preinfusion: "Sanftheit",
};

/** Validate + serialize a step sequence. `label` prefixes error messages so the
 *  user can tell which sequence (1× / 2×) is at fault. Throws on any error. */
function validateAndBuild(steps: EditStep[], label: string): BrewProfile {
  if (steps.length === 0) {
    throw new Error(`${label}: mindestens eine Phase erforderlich.`);
  }
  steps.forEach((e, i) => {
    const isLast = i === steps.length - 1;
    const primary = parseFloat(e.primary);
    if (e.kind === "preinfusion") {
      // kein Zahlenwert — nur die Ausstiege pruefen (unten)
    } else if (!Number.isFinite(primary)) {
      throw new Error(`${label} Phase ${i + 1}: Wert fehlt oder ist ungültig.`);
    }
    if (e.kind === "power") {
      // 0..100 % — der Wert geht offen gesteuert an PU_SET_LEVEL_PW_CONTROL.
      if (primary < 0 || primary > 100) {
        throw new Error(`${label} Phase ${i + 1}: Power muss zwischen 0 und 100 % liegen.`);
      }
    } else if (primary <= 0) {
      throw new Error(`${label} Phase ${i + 1}: ${PRIMARY_LABEL[e.kind]} muss > 0 sein.`);
    }
    // Non-last steps must advance on an exit; the last is yield-stopped.
    const exit = buildExit(e);
    const hasExit =
      exit.seconds != null ||
      exit.weightG != null ||
      exit.pressureBar != null ||
      exit.flowGs != null;
    if (!isLast && !hasExit) {
      throw new Error(
        `${label} Phase ${i + 1} braucht eine Exit-Bedingung (Zeit / Gewicht / Druck / Flow).`,
      );
    }
  });
  return { version: 1, steps: steps.map(buildStep) };
}

// Shared field styles
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 8,
  background: C.bg,
  border: `1px solid ${C.bdr}`,
  color: C.txt,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  color: C.mut,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 1.2,
  marginBottom: 4,
};

const miniLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 9,
  color: C.mut,
  fontWeight: 600,
  marginBottom: 3,
};

const KIND_COLOR: Record<StepKind, string> = { flow: C.seriesFlow, pressure: C.seriesPressure, power: C.seriesPower, preinfusion: C.seriesPower };
const KIND_SHORT: Record<StepKind, string> = { flow: "Flow", pressure: "Druck", power: "Power", preinfusion: "Preinfusion" };
const KIND_EDGE: Record<StepKind, string> = { flow: C.seriesFlow, pressure: C.seriesPressure, power: C.seriesPower, preinfusion: C.seriesPower };
const KIND_PILL_BG: Record<StepKind, string> = {
  flow: alpha(C.seriesFlow, 0.10),
  pressure: alpha(C.seriesPressure, 0.10),
  power: alpha(C.seriesPower, 0.10),
  preinfusion: alpha(C.seriesPower, 0.10),
};
const KIND_PILL_BDR: Record<StepKind, string> = {
  flow: alpha(C.seriesFlow, 0.45),
  pressure: alpha(C.seriesPressure, 0.45),
  power: alpha(C.seriesPower, 0.45),
  preinfusion: alpha(C.seriesPower, 0.45),
};
/** Unit shown next to the big target value. */
const UNIT: Record<StepKind, string> = { flow: "g/s", pressure: "bar", power: "%", preinfusion: "" };
const GENTLENESS_ORDER: PreinfusionGentleness[] = ["gentle", "normal", "brisk"];

type ExitKey = "weightG" | "pressureBar" | "pressureBelowBar" | "flowGs" | "seconds";

const EXIT_META: Record<
  ExitKey,
  { field: keyof EditStep; prefix: string; unit: string; step: number; master?: boolean }
> = {
  weightG: { field: "exitWeightG", prefix: "→", unit: "g", step: 0.5, master: true },
  pressureBar: { field: "exitPressureBar", prefix: "P ≥", unit: "bar", step: 0.5 },
  // Gegenstueck: die Stufe endet, wenn der Druck wieder abgebaut ist.
  pressureBelowBar: { field: "exitPressureBelowBar", prefix: "P ≤", unit: "bar", step: 0.5 },
  flowGs: { field: "exitFlowGs", prefix: "F ≤", unit: "", step: 0.1 },
  seconds: { field: "exitSeconds", prefix: "", unit: "s", step: 0.5 },
};
const EXIT_ORDER: ExitKey[] = ["weightG", "pressureBar", "pressureBelowBar", "flowGs", "seconds"];
const EXIT_ADD_LABEL: Record<ExitKey, string> = {
  weightG: "Ziel-Gewicht (g)",
  pressureBar: "Druck ≥ (bar)",
  pressureBelowBar: "Druck ≤ (bar, Abfall)",
  flowGs: "Flow ≤ (g/s)",
  seconds: "Zeit (s)",
};

/** Borderless number field used inside the cards (chips, meta line, hero). */
function BareNumber({
  value,
  onChange,
  step,
  style,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  step: number;
  style?: React.CSSProperties;
  className?: string;
  placeholder?: string;
}) {
  return (
    <input
      className={className}
      type="number"
      step={step}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        minWidth: 0,
        background: "transparent",
        border: "none",
        outline: "none",
        padding: 0,
        color: "inherit",
        font: "inherit",
        ...style,
      }}
    />
  );
}

/** Shrink-wraps an input to its content width so the element that follows (unit,
 *  auto/✎ tag) sits directly next to the value instead of at the card edge.
 *  The sizer stays in normal flow and keeps `overflow: visible`, so the wrapper
 *  exports a real text baseline — an inline unit after it then sits on the digit
 *  baseline like the mock's `.hero small`. Font styles are inherited from the
 *  surrounding line so sizer and input always match. */
function Fit({
  text,
  style,
  children,
}: {
  text: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <span style={{ display: "inline-block", position: "relative", maxWidth: "100%", ...style }}>
      <span style={{ visibility: "hidden", whiteSpace: "pre" }}>{text}</span>
      <span style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", display: "flex" }}>
        {children}
      </span>
    </span>
  );
}

/** One phase card — the Soll-Kurve's editable counterpart. */
function StepCard({
  step,
  index,
  isLast,
  update,
  remove,
  move,
}: {
  step: EditStep;
  index: number;
  isLast: boolean;
  update: (patch: Partial<EditStep>) => void;
  remove: () => void;
  move: (dir: -1 | 1) => void;
}) {
  // Conditions revealed via "+" stay visible while still empty.
  const [revealed, setRevealed] = useState<ExitKey[]>([]);
  const kind = step.kind;
  const named = step.name.trim() !== "";
  const targetValid = kind === "preinfusion" || Number.isFinite(parseFloat(step.primary));
  const autoLabel = targetValid ? autoStepLabel(buildStep(step)) : KIND_SHORT[kind];

  const shown = EXIT_ORDER.filter(
    (k) => String(step[EXIT_META[k].field]).trim() !== "" || revealed.includes(k),
  );
  const missing = EXIT_ORDER.filter((k) => !shown.includes(k));

  function setExit(k: ExitKey, v: string) {
    update({ [EXIT_META[k].field]: v } as Partial<EditStep>);
  }
  function dropExit(k: ExitKey) {
    setRevealed((prev) => prev.filter((x) => x !== k));
    setExit(k, "");
  }

  const iconStyle = (disabled: boolean): React.CSSProperties => ({
    background: "transparent",
    border: "none",
    color: disabled ? C.dim : C.mut,
    cursor: disabled ? "not-allowed" : "pointer",
    padding: 2,
    display: "flex",
    alignItems: "center",
  });

  return (
    <div
      style={{
        background: C.cardElev,
        border: `1px solid ${C.bdr}`,
        borderRadius: 11,
        padding: "12px 12px 9px",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: KIND_EDGE[kind] }} />

      {/* Phase index + type pill (tap to switch) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 1, textTransform: "uppercase", color: C.mut }}>
          Phase {index + 1}
        </span>
        <span style={{ position: "relative", display: "inline-flex" }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              padding: "3px 8px 3px 9px",
              borderRadius: 6,
              border: `1px solid ${KIND_PILL_BDR[kind]}`,
              background: KIND_PILL_BG[kind],
              color: KIND_COLOR[kind],
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {KIND_SHORT[kind]}
            <span style={{ opacity: 0.75, fontSize: 11, lineHeight: 0, position: "relative", top: -2 }}>⌄</span>
          </span>
          <select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as StepKind;
              // Preinfusion: Schutzgrenzen vorbelegen (25 s, 4 bar), falls noch keine Ausstiege stehen.
              const noExits = [step.exitSeconds, step.exitWeightG, step.exitPressureBar, step.exitPressureBelowBar, step.exitFlowGs]
                .every((v) => v.trim() === "");
              update(k === "preinfusion" && noExits ? { kind: k, exitSeconds: "25", exitPressureBar: "4" } : { kind: k });
            }}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
          >
            {(Object.keys(KIND_SHORT) as StepKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_SHORT[k]}
              </option>
            ))}
          </select>
        </span>
      </div>

      {/* Name — empty = derived label (shown as placeholder, tagged "auto") */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 11,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 600,
          color: C.txt,
        }}
      >
        <Fit text={step.name || autoLabel} style={{ minWidth: 0, overflow: "hidden" }}>
          <input
            value={step.name}
            placeholder={autoLabel}
            maxLength={40}
            onChange={(e) => update({ name: e.target.value })}
            style={{
              width: "100%",
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              padding: 0,
              color: "inherit",
              font: "inherit",
            }}
          />
        </Fit>
        <span
          style={{
            fontSize: 9.5,
            color: C.mut,
            border: `1px solid ${C.bdr2}`,
            borderRadius: 5,
            padding: "1px 5px",
            flex: "0 0 auto",
          }}
        >
          {named ? "✎" : "auto"}
        </span>
      </div>

      {/* Preinfusion: statt eines Zielwerts nur, wie zuegig sie saettigt. */}
      {kind === "preinfusion" ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "inline-flex", border: `1px solid ${C.bdr2}`, borderRadius: 7, overflow: "hidden" }}>
            {GENTLENESS_ORDER.map((g) => {
              const on = step.gentleness === g;
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => update({ gentleness: g })}
                  style={{
                    padding: "6px 10px",
                    border: "none",
                    borderLeft: g === "gentle" ? "none" : `1px solid ${C.bdr2}`,
                    background: on ? alpha(C.seriesPower, 0.16) : "transparent",
                    color: on ? C.seriesPower : C.mut,
                    fontSize: 12,
                    fontWeight: on ? 600 : 400,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {GENTLENESS_LABEL[g]}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: C.mut, marginTop: 7, lineHeight: 1.4 }}>
            endet, wenn der Kaffee ankommt
          </div>
        </div>
      ) : (
      <>
      {/* Target — the hero value */}
      <div
        style={{
          marginTop: 8,
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: "-.02em",
          lineHeight: 1,
          color: C.txt,
          whiteSpace: "nowrap",
        }}
      >
        <Fit text={step.primary || "—"}>
          <BareNumber
            className="hero-num"
            value={step.primary}
            onChange={(v) => update({ primary: v })}
            step={kind === "power" ? 1 : 0.1}
            placeholder="—"
            style={{ width: "100%" }}
          />
        </Fit>
        <span style={{ fontSize: 13, fontWeight: 500, color: C.mut, marginLeft: 4 }}>{UNIT[kind]}</span>
      </div>

      {/* Limiter + transition — eine Textzeile ("≤ 9 bar · 4 s Rampe"): die Zahlen
          laufen im Inline-Fluss mit, damit die Wortabstaende normal bleiben. */}
      <div
        style={{
          fontSize: 11,
          color: C.mut,
          marginTop: 7,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {kind !== "pressure" && (
          <>
            {"≤ "}
            <Fit text={step.limitBar || "—"}>
              <BareNumber
                value={step.limitBar}
                onChange={(v) => update({ limitBar: v })}
                step={0.1}
                placeholder="—"
                style={{ width: "100%" }}
              />
            </Fit>
            {" bar · "}
          </>
        )}
        {kind !== "flow" && (
          <>
            {"≤ "}
            <Fit text={step.limitGs || "—"}>
              <BareNumber
                value={step.limitGs}
                onChange={(v) => update({ limitGs: v })}
                step={0.1}
                placeholder="—"
                style={{ width: "100%" }}
              />
            </Fit>
            {" g/s · "}
          </>
        )}
        <Fit text={step.rampS || "0"}>
          <BareNumber
            value={step.rampS}
            onChange={(v) => update({ rampS: v })}
            step={0.5}
            placeholder="0"
            style={{ width: "100%" }}
          />
        </Fit>
        {parseFloat(step.rampS) > 0 ? " s Rampe" : " s — sofort"}
      </div>
      </>
      )}

      {/* Exit conditions — first met wins */}
      <div style={{ marginTop: "auto", paddingTop: 10, borderTop: `1px solid ${C.bdr}` }}>
        <div style={{ fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: C.mut, marginBottom: 6 }}>
          Exit
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {shown.map((k, n) => {
            const meta = EXIT_META[k];
            const master = meta.master === true;
            return (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {n > 0 && <span style={{ fontSize: 10, color: C.mut }}>oder</span>}
                <span
                  style={{
                    fontSize: 11,
                    lineHeight: 1.35,
                    color: master ? C.seriesTarget : C.txtS,
                    fontWeight: master ? 600 : 400,
                    background: master ? alpha(C.seriesTarget, 0.08) : C.card,
                    border: `1px solid ${master ? alpha(C.seriesTarget, 0.4) : C.bdr2}`,
                    borderRadius: 6,
                    padding: "3px 6px 3px 7px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {meta.prefix && `${meta.prefix} `}
                  <Fit text={String(step[meta.field]) || "—"}>
                    <BareNumber
                      value={String(step[meta.field])}
                      onChange={(v) => setExit(k, v)}
                      step={meta.step}
                      placeholder="—"
                      style={{ width: "100%" }}
                    />
                  </Fit>
                  {meta.unit && ` ${meta.unit}`}
                  <button
                    onClick={() => dropExit(k)}
                    title="Bedingung entfernen"
                    style={{
                      ...iconStyle(false),
                      display: "inline-flex",
                      verticalAlign: "middle",
                      fontSize: 12,
                      lineHeight: 1,
                      padding: 0,
                      marginLeft: 4,
                    }}
                  >
                    ×
                  </button>
                </span>
              </span>
            );
          })}

          {missing.length > 0 && (
            <span style={{ position: "relative", display: "inline-flex" }}>
              <span
                style={{
                  fontSize: 11,
                  color: C.mut,
                  border: `1px dashed ${C.bdr2}`,
                  borderRadius: 6,
                  padding: "3px 8px",
                }}
              >
                +
              </span>
              <select
                value=""
                onChange={(e) => setRevealed((prev) => [...prev, e.target.value as ExitKey])}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
              >
                <option value="" disabled>
                  Bedingung…
                </option>
                {missing.map((k) => (
                  <option key={k} value={k}>
                    {EXIT_ADD_LABEL[k]}
                  </option>
                ))}
              </select>
            </span>
          )}

          {shown.length === 0 && missing.length === 4 && (
            <span style={{ fontSize: 10.5, color: C.mut }}>{isLast ? "per Yield gestoppt" : "fehlt"}</span>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 2, marginTop: 8 }}>
          <button onClick={() => move(-1)} disabled={index === 0} title="Nach vorne" style={iconStyle(index === 0)}>
            <ArrowUp size={13} />
          </button>
          <button onClick={() => move(1)} disabled={isLast} title="Nach hinten" style={iconStyle(isLast)}>
            <ArrowDown size={13} />
          </button>
          <button onClick={remove} title="Phase entfernen" style={iconStyle(false)}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Soll-Kurve + editable phase cards. Reused for the 1× and the optional 2×
 *  sequence — parameterized purely by its steps state. */
function StepList({
  steps,
  setSteps,
  yieldTargetG,
}: {
  steps: EditStep[];
  setSteps: React.Dispatch<React.SetStateAction<EditStep[]>>;
  /** Yield of this sequence — lets the preview estimate the last phase's length. */
  yieldTargetG: number | null;
}) {
  function updateStep(i: number, patch: Partial<EditStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function addStep() {
    // Neue Profile beginnen mit der Preinfusion ueber den Zulauf, nicht mit einer
    // festen Leistung: die schob bei Gagne/Lever beim ersten Kaffee noch voll nach
    // (#253 Druck 6,2 bar, #259 Fluss +39 %). Schutzgrenzen gleich vorbelegt.
    setSteps((prev) => [
      ...prev,
      prev.length === 0 ? { ...emptyStep("preinfusion"), exitSeconds: "25", exitPressureBar: "4" } : emptyStep(),
    ]);
  }
  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  const preview = previewSteps(steps);

  return (
    <div>
      {preview.length > 0 && (
        <div
          style={{
            background: C.card,
            border: `1px solid ${C.bdr}`,
            borderRadius: 14,
            padding: "12px 14px 14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <span
              style={{
                fontSize: 10.5,
                letterSpacing: 1.6,
                textTransform: "uppercase",
                color: C.acc,
                fontWeight: 600,
              }}
            >
              Soll-Kurve
            </span>
          </div>
          <div style={{ marginTop: 10 }}>
            <ProfileSollChart steps={preview} yieldTargetG={yieldTargetG} />
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(166px, 1fr))",
          gap: 11,
          marginTop: 16,
        }}
      >
        {steps.map((s, i) => (
          <StepCard
            key={i}
            step={s}
            index={i}
            isLast={i === steps.length - 1}
            update={(patch) => updateStep(i, patch)}
            remove={() => removeStep(i)}
            move={(dir) => moveStep(i, dir)}
          />
        ))}

        <button
          onClick={addStep}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            minHeight: 92,
            borderRadius: 11,
            background: C.accG,
            border: `1px dashed ${C.acc}55`,
            color: C.acc,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <Plus size={14} /> Phase
        </button>
      </div>

      <p style={{ fontSize: 11.5, color: C.mut, marginTop: 12, lineHeight: 1.6 }}>
        Typ-Pille antippen zum Umschalten. Name leer = automatisch aus Typ + Ziel. Zeitachse der
        Vorschau ist <b style={{ color: C.txtS, fontWeight: 600 }}>nominal</b> (geschätzt).
      </p>
    </div>
  );
}

/** Small pill switch matching the existing inline toggles. */
function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        onClick={onToggle}
        style={{
          width: 36,
          height: 20,
          borderRadius: 10,
          background: on ? C.acc : C.dim,
          border: "none",
          cursor: "pointer",
          position: "relative",
          flexShrink: 0,
          transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: C.white,
            transition: "left 0.15s",
          }}
        />
      </button>
      <span style={{ fontSize: 12, color: C.txtS, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

interface ProfileEditorProps {
  /** Existing profile for edit mode; undefined for create mode. */
  profile?: Profile;
  scripts: XeniaScript[];
  onSave: (data: ProfileCreate | ProfileUpdate) => Promise<void>;
  onClose: () => void;
  /** True while a background script sync is in progress. */
  scriptsSyncing?: boolean;
}

export function ProfileEditor({ profile, scripts, onSave, onClose, scriptsSyncing }: ProfileEditorProps) {
  const isEdit = profile !== undefined;

  const brewScripts = scripts.filter((s) => s.categoryAuto !== "maintenance");

  const [name, setName] = useState(profile?.name ?? "");
  const [scriptIdSingle, setScriptIdSingle] = useState<number | null>(
    profile?.scriptIdSingle ?? (brewScripts[0]?.id ?? null),
  );
  const [scriptIdDouble, setScriptIdDouble] = useState<number | null>(
    profile?.scriptIdDouble ?? null,
  );
  const [yieldSingle, setYieldSingle] = useState<string>(
    profile?.yieldTargetSingleG != null ? String(profile.yieldTargetSingleG) : "",
  );
  const [yieldDouble, setYieldDouble] = useState<string>(
    profile?.yieldTargetDoubleG != null ? String(profile.yieldTargetDoubleG) : "",
  );
  const [targetTemp, setTargetTemp] = useState<string>(
    profile?.targetTempC != null ? String(profile.targetTempC) : "",
  );
  const [isFavorite, setIsFavorite] = useState(profile?.isFavorite ?? false);
  const [notes, setNotes] = useState(profile?.notes ?? "");

  // Flow profile step sequence (BrewProfile). Enabled = app-driven paddle brew.
  const [stepsEnabled, setStepsEnabled] = useState(profile?.brewSteps != null);
  const [steps, setSteps] = useState<EditStep[]>(
    profile?.brewSteps?.steps?.map(toEditStep) ?? [],
  );

  // 2× slot for a flow profile (mirrors scriptIdDouble/yieldDouble for scripts).
  // Enabled = a second yield exists; own-sequence = a dedicated 2× step list,
  // otherwise the 2× shot reuses the 1× sequence with its own yield.
  const [doubleEnabled, setDoubleEnabled] = useState(
    profile?.brewSteps != null && profile?.yieldTargetDoubleG != null,
  );
  const [doubleStepsEnabled, setDoubleStepsEnabled] = useState(profile?.brewStepsDouble != null);
  const [steps2, setSteps2] = useState<EditStep[]>(
    profile?.brewStepsDouble?.steps?.map(toEditStep) ?? [],
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Der Dialog ist für beide Profiltypen gleich breit — einzeilige Text-/
  // Zahlenfelder bleiben auf lesbarer Spaltenbreite statt auf Dialogbreite.
  const fieldCol: React.CSSProperties = { maxWidth: 560 };

  async function handleSave() {
    if (!name.trim()) {
      setError("Name ist erforderlich.");
      return;
    }
    // A flow profile is app-driven and needs no Xenia script. A classic profile does.
    if (!stepsEnabled && !scriptIdSingle) {
      setError("Single-Skript ist erforderlich.");
      return;
    }

    // Target brew temp (PT-1) — empty = null, else 70–110 °C. Mirrors backend.
    const tempTrimmed = targetTemp.trim();
    const tempValue = tempTrimmed === "" ? null : parseFloat(tempTrimmed);
    const tempParse = parseTargetTempC(tempValue);
    if (!tempParse.ok) {
      setError("Brüh-Soll-Temperatur muss zwischen 70 und 110 °C liegen.");
      return;
    }

    let brewSteps: BrewProfile | null = null;
    let brewStepsDouble: BrewProfile | null = null;
    try {
      if (stepsEnabled) {
        // Ein Flow-Bezug wird per Gewicht gestoppt — ohne Ziel kein GBW-Stop.
        if (!(yieldSingle.trim() !== "" && parseFloat(yieldSingle) > 0)) {
          throw new Error("Yield 1× (> 0) ist für ein Flow-Profil erforderlich.");
        }
        brewSteps = validateAndBuild(steps, "1×-Sequenz");
        if (doubleEnabled) {
          // A 2× shot is weight-stopped like the 1× shot → its own yield required.
          if (!(yieldDouble.trim() !== "" && parseFloat(yieldDouble) > 0)) {
            throw new Error("Yield 2× (> 0) ist erforderlich, wenn 2× aktiviert ist.");
          }
          if (doubleStepsEnabled) {
            brewStepsDouble = validateAndBuild(steps2, "2×-Sequenz");
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setSaving(true);
    setError(null);

    const data: ProfileCreate = {
      name: name.trim(),
      // A flow profile carries no script; a classic profile keeps its script ids.
      scriptIdSingle: stepsEnabled ? null : scriptIdSingle,
      scriptIdDouble: stepsEnabled ? null : (scriptIdDouble ?? null),
      yieldTargetSingleG: yieldSingle ? parseFloat(yieldSingle) : null,
      // 2× yield: for a flow profile only when the 2× slot is enabled; for a
      // classic profile whenever a double yield was entered.
      yieldTargetDoubleG: stepsEnabled
        ? (doubleEnabled && yieldDouble ? parseFloat(yieldDouble) : null)
        : (yieldDouble ? parseFloat(yieldDouble) : null),
      targetTempC: tempParse.value,
      isFavorite,
      notes: notes.trim() ? notes.trim() : null,
      brewSteps,
      brewStepsDouble,
    };

    try {
      await onSave(data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // Flow profile section — the app-driven paddle step sequence. Rendered right
  // after Name (profile-agnostic) so the toggle gates the rest of the form.
  const flowSection = (
    <div
      style={{
        border: `1px solid ${C.bdr}`,
        borderRadius: 10,
        padding: "12px 12px 14px",
        background: C.bg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => setStepsEnabled((v) => !v)}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            background: stepsEnabled ? C.acc : C.dim,
            border: "none",
            cursor: "pointer",
            position: "relative",
            flexShrink: 0,
            transition: "background 0.15s",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: stepsEnabled ? 18 : 2,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: C.white,
              transition: "left 0.15s",
            }}
          />
        </button>
        <span style={{ fontSize: 12, color: C.txtS, fontWeight: 600 }}>Flow Profil</span>
      </div>

      {stepsEnabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
          {/* 1× sequence */}
          <div>
            <label style={{ ...miniLabelStyle, color: C.acc, letterSpacing: 1, marginBottom: 8 }}>
              1×-Sequenz
            </label>
            <StepList steps={steps} setSteps={setSteps} yieldTargetG={parseYield(yieldSingle)} />
          </div>

          {/* 2× slot — like scriptIdDouble for scripts: an own yield, optionally
              an own sequence. Off = single-only flow profile (today's default). */}
          <div style={{ borderTop: `1px solid ${C.bdr}`, paddingTop: 12 }}>
            <Toggle on={doubleEnabled} onToggle={() => setDoubleEnabled((v) => !v)} label="2× Bezug" />
          </div>

          {doubleEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={labelStyle}>Yield 2× (g)</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  max={200}
                  step={0.5}
                  value={yieldDouble}
                  onChange={(e) => setYieldDouble(e.target.value)}
                  placeholder="z.B. 40"
                />
              </div>

              <Toggle
                on={doubleStepsEnabled}
                onToggle={() => setDoubleStepsEnabled((v) => !v)}
                label="Eigene Sequenz für 2×"
              />

              {doubleStepsEnabled ? (
                <div>
                  <label style={{ ...miniLabelStyle, color: C.acc, letterSpacing: 1, marginBottom: 8 }}>
                    2×-Sequenz
                  </label>
                  <StepList steps={steps2} setSteps={setSteps2} yieldTargetG={parseYield(yieldDouble)} />
                </div>
              ) : (
                <div style={{ fontSize: 11, color: C.mut, lineHeight: 1.4 }}>
                  2× nutzt die 1×-Sequenz mit eigenem Yield.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: C.overlay,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        backdropFilter: "blur(8px)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          borderRadius: 16,
          border: `1px solid ${C.bdr}`,
          width: "100%",
          // Eine Breite für beide Profiltypen: das Flow-Layout braucht die Room
          // des Design-Mocks (5 Phasenkarten nebeneinander), und ein Dialog, der
          // beim Umschalten des Flow-Toggles die Breite wechselt, springt.
          maxWidth: 1040,
          padding: "22px 24px",
          position: "relative",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            background: "transparent",
            border: "none",
            color: C.mut,
            cursor: "pointer",
            padding: 4,
          }}
        >
          <X size={18} />
        </button>
        <div
          style={{
            fontSize: 9,
            color: C.acc,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 2,
            marginBottom: 4,
          }}
        >
          {isEdit ? "Profil bearbeiten" : "Neues Profil"}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
          {/* Name + Favoriten-Schalter in einer Zeile: beides sind Eigenschaften
              des Profils selbst, nicht der Brühparameter. */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
            <div style={{ ...fieldCol, flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>Name</label>
              <input
                style={inputStyle}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="z.B. Classic 9 bar"
                maxLength={80}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 9, flexShrink: 0 }}>
              <button
                onClick={() => setIsFavorite((v) => !v)}
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 10,
                  background: isFavorite ? C.acc : C.dim,
                  border: "none",
                  cursor: "pointer",
                  position: "relative",
                  flexShrink: 0,
                  transition: "background 0.15s",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    left: isFavorite ? 18 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: C.white,
                    transition: "left 0.15s",
                  }}
                />
              </button>
              <span style={{ fontSize: 12, color: C.txtS }}>In Favoriten</span>
            </div>
          </div>

          {/* Ziel-Menge + Temperatur stehen VOR dem Flow-Editor: der Yield ist der
              Master-Stop, den die Soll-Kurve darunter zeichnet. Zwei Spalten —
              beim klassischen Profil rutscht die Temperatur dadurch in Zeile 2. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={fieldCol}>
              <label style={labelStyle}>
                {stepsEnabled ? (doubleEnabled ? "Yield 1× (g)" : "Yield (g)") : "Yield Single (g)"}
              </label>
              <input
                style={inputStyle}
                type="number"
                min={0}
                max={200}
                step={0.5}
                value={yieldSingle}
                onChange={(e) => setYieldSingle(e.target.value)}
                placeholder="z.B. 36"
              />
            </div>
            {!stepsEnabled && (
              <div style={fieldCol}>
                <label style={labelStyle}>Yield Double (g)</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  max={200}
                  step={0.5}
                  value={yieldDouble}
                  onChange={(e) => setYieldDouble(e.target.value)}
                  placeholder="z.B. 72"
                />
              </div>
            )}
            {/* Target brew temperature (PT-1) — optional absolute setpoint °C.
                Empty = no profile target (today's behaviour). Stage 1: stored &
                shown only, no machine interaction. */}
            <div style={fieldCol}>
              <label style={labelStyle}>Brüh-Soll-Temperatur (°C)</label>
              <input
                style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                type="number"
                min={70}
                max={110}
                step={0.5}
                value={targetTemp}
                onChange={(e) => setTargetTemp(e.target.value)}
                placeholder="z.B. 93.0 — leer = keine"
              />
            </div>
          </div>

          {/* Flow-profile toggle + step editor — steht vor den Skript-Feldern, die
              es gatet (die gelten nur für ein klassisches Skript-Profil). */}
          {flowSection}

          {/* Single script — classic (script-driven) profiles only. */}
          {!stepsEnabled && (
            <div style={fieldCol}>
              <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 6 }}>
                <span>Single-Skript</span>
                {scriptsSyncing && (
                  <span style={{ fontSize: 9, color: C.mut, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                    Skripte werden aktualisiert…
                  </span>
                )}
              </label>
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={scriptIdSingle ?? ""}
                onChange={(e) => setScriptIdSingle(e.target.value === "" ? null : Number(e.target.value))}
              >
                {scripts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Double script (optional) — classic profiles only. */}
          {!stepsEnabled && (
            <div style={fieldCol}>
              <label style={labelStyle}>Double-Skript (optional)</label>
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={scriptIdDouble ?? ""}
                onChange={(e) =>
                  setScriptIdDouble(e.target.value === "" ? null : Number(e.target.value))
                }
              >
                <option value="">— keins —</option>
                {scripts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Notes (3j) — free-text description / temp recommendation / …
              Bewusst OHNE fieldCol: der 560-px-Deckel ist für einzeilige
              Zahlenfelder gedacht, Fließtext soll die volle Breite nutzen. */}
          <div>
            <label style={labelStyle}>Notizen (optional)</label>
            <textarea
              style={{ ...inputStyle, minHeight: 72, resize: "vertical", lineHeight: 1.4 }}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="z.B. Temp-Empfehlung, Beschreibung…"
            />
          </div>

          {/* Error */}
          {error && (
            <div
              style={{
                fontSize: 12,
                color: C.red,
                background: C.redD,
                border: `1px solid ${C.red}30`,
                borderRadius: 8,
                padding: "8px 12px",
              }}
            >
              {error}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 10,
                background: C.bg,
                border: `1px solid ${C.bdr}`,
                color: C.mut,
                fontSize: 13,
                cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: 500,
              }}
            >
              Abbrechen
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 10,
                background: C.accG2,
                border: `1px solid ${C.acc}40`,
                color: C.acc,
                fontSize: 13,
                cursor: saving ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                fontWeight: 600,
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "Speichern…" : "Speichern"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
