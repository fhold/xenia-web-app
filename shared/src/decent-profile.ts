/**
 * Decent-Profil → Xenia-Profil (2026-10-20). Feste Regeln, kein Raten.
 *
 * Gelesen werden die `.tcl`-Profile der de1app und das v2-JSON (de1app,
 * visualizer.coffee). Uebernommen wird die FORM des Profils, nicht jede Zahl:
 * was an der Decent haengt, wird nach unseren gemessenen Xenia-Regeln
 * umgesetzt (Spec „Fremdprofile übersetzen“) und im Bericht begruendet.
 *
 * Quelle der Decent-Semantik: de1app `profile.tcl` (legacy_profile_to_v2,
 * pressure_/flow_to_advanced_list, mode_for_step) und `binary.tcl`
 * (seconds = Hoechstdauer, volume = Hoechstmenge, exit_if 0 = keine Bedingung).
 */

import type { BrewProfile, BrewStep, PressureStep, PreinfusionStep, ProfileFit, StepExit } from "./types.js";
import type { ProfileFileProfile } from "./profile-file.js";
import { L } from "./shared-lang.js";

/** Eine Zeile der Gegenueberstellung im Import-Dialog. */
export interface TranslationRow {
  /** „step“ = ein (oder mehrere zusammengefasste) Decent-Schritte, „profile“ = Temperatur/Ziel. */
  group: "step" | "profile";
  /** Name des Decent-Schritts bzw. „Temperatur“ / „Ziel“. */
  name: string;
  /** Was Decent tut — eine kurze Zeile. */
  decent: string;
  /** Was die Xenia tut; null = entfällt. */
  xenia: string | null;
  /** gleich / angepasst / Annäherung / entfällt. */
  status: "same" | "changed" | "approx" | "dropped";
  /** Warum (Tooltip); null = nichts zu erklären. */
  why: string | null;
}

/** „Bitte prüfen“ — gilt nicht für eine einzelne Zeile oder will ausdrücklich angesehen werden. */
export interface TranslationHint {
  text: string;
  why: string;
}

export type DecentResult =
  | { ok: true; profile: ProfileFileProfile; rows: TranslationRow[]; hints: TranslationHint[]; title: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tcl-Listen (nur was die Profile brauchen: Woerter, {…}, "…", \-Escapes)
// ---------------------------------------------------------------------------

export function parseTclList(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i]!)) i++;
    if (i >= n) break;
    if (s[i] === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (s[j] === "\\") j++;
        else if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      out.push(s.slice(i + 1, j - 1));
      i = j;
    } else if (s[i] === '"') {
      let j = i + 1;
      let w = "";
      while (j < n && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < n) { w += s[j + 1]; j += 2; } else { w += s[j]; j++; }
      }
      out.push(w);
      i = j + 1;
    } else {
      let j = i;
      let w = "";
      while (j < n && !/\s/.test(s[j]!)) {
        if (s[j] === "\\" && j + 1 < n) { w += s[j + 1]; j += 2; } else { w += s[j]; j++; }
      }
      out.push(w);
      i = j;
    }
  }
  return out;
}

const dictOf = (s: string): Record<string, string> => {
  const w = parseTclList(s);
  const d: Record<string, string> = {};
  for (let k = 0; k + 1 < w.length; k += 2) d[w[k]!] = w[k + 1]!;
  return d;
};

// ---------------------------------------------------------------------------
// Ein Decent-Schritt, gleich ob aus Tcl oder JSON
// ---------------------------------------------------------------------------

interface DStep {
  name: string;
  pump: string;          // pressure | flow | power | lever
  transition: string;    // fast | smooth | hold
  pressure: number;
  flow: number;
  temperature: number | null;
  seconds: number;
  volume: number;
  weight: number;
  exit: { type: string; condition: string; value: number } | null;
  limiter: number;       // max_flow_or_pressure, 0 = keiner
  modeCap: number | null;
}

/**
 * Pumpe und Uebergang wie die de1app (mode_for_step): ein ausdrueckliches
 * pump_mode gewinnt (legacy/power/lever/HOLD-P/-F/-W bzw. 0–5), sonst pump +
 * transition.
 */
function modeOf(pumpMode: unknown, pump: unknown, transition: unknown): { pump: string; transition: string } {
  const base = { pump: String(pump ?? "pressure").toLowerCase(), transition: String(transition ?? "fast").toLowerCase() };
  if (pumpMode === undefined || pumpMode === null || String(pumpMode).trim() === "") return base;
  const key = String(pumpMode).trim().toUpperCase().replace(/[_ ]/g, "-");
  switch (key) {
    case "1": case "POWER": return { pump: "power", transition: base.transition };
    case "2": case "LEVER": return { pump: "lever", transition: base.transition };
    case "3": case "HOLD-P": case "HOLD-PRESSURE": return { pump: "pressure", transition: "hold" };
    case "4": case "HOLD-F": case "HOLD-FLOW": return { pump: "flow", transition: "hold" };
    case "5": case "HOLD-W": case "HOLD-POWER": return { pump: "power", transition: "hold" };
    default: return base; // 0 / LEGACY
  }
}

const num = (v: unknown, d = 0): number => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : d;
};

function stepFromTcl(p: Record<string, string>): DStep {
  let exit: DStep["exit"] = null;
  if (num(p.exit_if) === 1) {
    const t = p.exit_type ?? "";
    const m = /^(pressure|flow|power)_(over|under)$/.exec(t);
    if (m) exit = { type: m[1]!, condition: m[2]!, value: num(p[`exit_${t}`]) };
  }
  return {
    name: p.name ?? "",
    ...modeOf(p.pump_mode ?? p.PumpMode ?? p.Mode, p.pump, p.transition),
    pressure: num(p.pressure),
    flow: num(p.flow),
    temperature: p.temperature !== undefined ? num(p.temperature, NaN) : null,
    seconds: num(p.seconds),
    volume: num(p.volume),
    weight: num(p.weight),
    exit,
    limiter: num(p.max_flow_or_pressure),
    modeCap: p.mode_max_pressure !== undefined ? num(p.mode_max_pressure) : null,
  };
}

function stepFromJson(s: Record<string, unknown>): DStep {
  const e = s.exit as Record<string, unknown> | undefined;
  const lim = s.limiter as Record<string, unknown> | undefined;
  return {
    name: typeof s.name === "string" ? s.name : "",
    ...modeOf(s.pump_mode, s.pump, s.transition),
    pressure: num(s.pressure),
    flow: num(s.flow),
    temperature: s.temperature !== undefined ? num(s.temperature, NaN) : null,
    seconds: num(s.seconds),
    volume: num(s.volume),
    weight: num(s.weight),
    exit: e && typeof e.type === "string" && typeof e.condition === "string"
      ? { type: e.type, condition: e.condition, value: num(e.value) } : null,
    limiter: lim ? num(lim.value) : 0,
    modeCap: s.mode_max_pressure !== undefined ? num(s.mode_max_pressure) : null,
  };
}

// ---------------------------------------------------------------------------
// Einfache Decent-Profile (settings_2a Druck / 2b Fluss): die de1app erzeugt
// die Schritte beim Laden aus den Einstellungen — hier dieselbe Rechnung
// (profile.tcl pressure_to_advanced_list / flow_to_advanced_list).
// ---------------------------------------------------------------------------

function basicSteps(d: Record<string, string>, flowProfile: boolean): DStep[] {
  const v = (k: string, def = 0) => num(d[k], def);
  const tempSteps = v("espresso_temperature_steps_enabled") === 1;
  const t = tempSteps
    ? [0, 1, 2, 3].map((k) => v(`espresso_temperature_${k}`, v("espresso_temperature", 90)))
    : [0, 1, 2, 3].map(() => v("espresso_temperature", 90));
  const bump = tempSteps ? v("temp_bump_time_seconds", 2) : 0;
  const first = bump;
  const second = Math.max(0, v("preinfusion_time") - bump);
  const base = (over: Partial<DStep>): DStep => ({
    name: "", pump: "pressure", transition: "fast", pressure: 0, flow: 0, temperature: null,
    seconds: 0, volume: 0, weight: 0, exit: null, limiter: 0, modeCap: null, ...over,
  });
  const fill = (name: string, seconds: number, temp: number) => base({
    name, pump: "flow", flow: v("preinfusion_flow_rate"), pressure: 1, seconds, temperature: temp,
    exit: { type: "pressure", condition: "over", value: v("preinfusion_stop_pressure") },
  });
  const out: DStep[] = [];
  if (first > 0) out.push(fill(flowProfile ? "preinfusion boost" : "preinfusion temp boost", first, t[0]!));
  if (second > 0) out.push(fill("preinfusion", second, t[1]!));

  let hold = v("espresso_hold_time");
  let decline = v("espresso_decline_time");
  if (flowProfile) {
    const cap = v("maximum_pressure");
    if (hold > 0) {
      out.push(base({ name: "hold", pump: "flow", flow: v("flow_profile_hold"), seconds: hold, temperature: t[2]!, limiter: cap }));
      // wie die de1app: der Abstieg haengt an der Haltezeit
      out.push(base({ name: "decline", pump: "flow", transition: "smooth", flow: v("flow_profile_decline"), seconds: decline, temperature: t[3]!, limiter: cap }));
    }
    return out;
  }
  const cap = v("maximum_flow");
  const p = v("espresso_pressure");
  if (hold > 0) {
    if (hold > 3) {
      out.push(base({ name: "forced rise", pressure: p, seconds: 3, temperature: t[2]!, limiter: cap }));
      hold -= 3;
    }
    out.push(base({ name: "rise and hold", pressure: p, seconds: hold, temperature: t[2]!, limiter: cap }));
  }
  if (decline > 0) {
    if (hold < 3 && decline > 3) {
      out.push(base({ name: "forced rise", pressure: p, seconds: 3, temperature: t[3]!, limiter: cap }));
      decline -= 3;
    }
    out.push(base({ name: "decline", transition: "smooth", pressure: v("pressure_end"), seconds: decline, temperature: t[3]!, limiter: cap }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

interface DProfile { title: string; author: string; notes: string; beverage: string; targetWeight: number; targetVolume: number; steps: DStep[] }

const notDecent = () => L(
  "Die Datei ist weder ein Decent-Profil noch eine Profil-Datei der Xenia App.",
  "The file is neither a Decent profile nor a profile file of the Xenia app.",
);

function readDecent(text: string): { ok: true; p: DProfile } | { ok: false; error: string } {
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(text) as Record<string, unknown>; } catch { /* kein JSON → Tcl */ }
  if (j !== null && typeof j === "object") {
    // visualizer.coffee: der Bezug traegt das Profil unter „profile“
    const p = (Array.isArray(j.steps) || !j.profile ? j : j.profile) as Record<string, unknown>;
    if (!Array.isArray(p.steps)) {
      return { ok: false, error: Array.isArray(p.phases)
        ? L("Das ist ein Gaggiuino-Profil — dafür gibt es noch keinen Übersetzer.", "This is a Gaggiuino profile — there is no translator for it yet.")
        : notDecent() };
    }
    return { ok: true, p: {
      title: String(p.title ?? "").trim(), author: String(p.author ?? "").trim(), notes: String(p.notes ?? "").trim(),
      beverage: String(p.beverage_type ?? "espresso"), targetWeight: num(p.target_weight), targetVolume: num(p.target_volume),
      steps: (p.steps as Record<string, unknown>[]).map(stepFromJson),
    } };
  }
  const d = dictOf(text);
  if (d.advanced_shot === undefined && d.settings_profile_type === undefined) {
    return { ok: false, error: notDecent() };
  }
  const type = d.settings_profile_type ?? "settings_2c";
  const steps = type === "settings_2a" ? basicSteps(d, false)
    : type === "settings_2b" ? basicSteps(d, true)
    : parseTclList(d.advanced_shot ?? "").map((s) => stepFromTcl(dictOf(s)));
  const basic = type === "settings_2a" || type === "settings_2b";
  return { ok: true, p: {
    title: (d.profile_title ?? "").trim(), author: (d.author ?? "").trim(), notes: (d.profile_notes ?? "").trim(), beverage: d.beverage_type ?? "espresso",
    targetWeight: num(basic ? d.final_desired_shot_weight : d.final_desired_shot_weight_advanced),
    targetVolume: num(basic ? d.final_desired_shot_volume : d.final_desired_shot_volume_advanced),
    steps,
  } };
}

// ---------------------------------------------------------------------------
// Uebersetzen
// ---------------------------------------------------------------------------

/** Gemessene Pumpendecke der Xenia bei offenem Puck (g/s). */
const PUMP_CEILING_GS = 5.6;
/** Schutz-Deckel der Preinfusion: die Xenia braucht 6–9 s bis 3,8 bar. */
const PREINFUSION_MIN_SECONDS = 25;
/**
 * Kleinster Fluss, den der Uebersetzer noch als Flussstufe nimmt. Mit kleinster Leistung
 * (25 %) foerdert die Pumpe bei 2,8 bar ~0,8 g/s (#286), mit mehr Puckdruck laut Kennlinie
 * weniger — 0,5 ml/s („last resort“ bei dichtem Puck) geht also. Darunter steht bei Decent
 * 0,1 ml/s zum Bloomen oder Nachlaufen, ohne Gegendruck: das foerdert sie nicht.
 */
const MIN_FLOW_GS = 0.5;
/** „Gleitend auf 0“ erst ab dieser Dauer eine Rampe — kuerzer ist es ein Kniff am Ende
 *  (EspressoForge: 1 s „reset temperature“), dann wie bisher Pumpe aus. */
const DECLINE_MIN_SECONDS = 5;
/** Langsamer fuellt Decent „langsam“ — unsere Preinfusion fuellt mit 3,5 ml/s. */
const SLOW_FILL_MLS = 3;
/** Ende einer Druckrampe „gleitend auf 0“ — der Treiber braucht ein positives Ziel. */
const DECLINE_END_BAR = 0.1;

const r1 = (x: number) => Math.round(x * 10) / 10;
const fmt = (x: number) => String(r1(x)).replace(".", L(",", "."));
const label = (s: DStep, i: number) => s.name.trim() || L(`Schritt ${i + 1}`, `Step ${i + 1}`);

/** Pumpe aus: Decent schreibt das als Druck- oder Flussziel 0. */
const isPause = (s: DStep) => s.transition !== "hold"
  && ((s.pump === "flow" && s.flow <= 0) || (s.pump === "pressure" && s.pressure <= 0));

/**
 * Druck-Fuellung: Ziel ueber dem eigenen Druck-Ausstieg („6 bar bis 3 bar“). de1app setzt
 * auf jeden Schritt IgnoreLimit — die Decent faehrt hier volle Pumpe bis zum Ausstieg.
 * Als App-Druckstufe drehte die Regelung auf dem leeren Puck hoch (#158/#159).
 */
const pressureFill = (s: DStep) => s.pump === "pressure" && s.transition !== "hold"
  && s.exit?.type === "pressure" && s.exit.condition === "over" && s.pressure > s.exit.value;

/**
 * Fuellschritte am Anfang — Fluss-Schritte oder Druck-Fuellungen, in der Tasse kommt noch nichts an:
 * bis einschliesslich des ersten mit „Druck über“ (Espresso-Fuellen), oder nach
 * der Uhr direkt vor einer Pause (Benetzen + Bloom: V60, Cold Brew, Hebel).
 */
function fillBlock(steps: DStep[]): { n: number; byPressure: boolean } {
  const untilPressure = (s: DStep) => s.exit?.type === "pressure" && s.exit.condition === "over";
  // Vorlauf einer Druck-Fuellung: gleiches Ziel, ohne Ausstieg (de1app: Temperatur-Boost, LRv3 „Fill start“).
  const lead = (i: number) => {
    const s = steps[i]!;
    const next = steps[i + 1];
    return s.pump === "pressure" && s.transition !== "hold" && !s.exit
      && next !== undefined && pressureFill(next) && next.pressure === s.pressure;
  };
  const fills = (i: number) => {
    const s = steps[i]!;
    return (s.pump === "flow" && s.transition !== "hold" && s.flow > 0) || pressureFill(s) || lead(i);
  };
  let n = 0;
  while (n < steps.length && fills(n) && (!steps[n]!.exit || untilPressure(steps[n]!))) {
    if (untilPressure(steps[n]!)) {
      // weitere Fuellschritte mit „Druck über“ gehoeren dazu (de1app: Temperatur-Boost + Preinfusion)
      n++;
      while (n < steps.length && fills(n) && untilPressure(steps[n]!)) n++;
      return { n, byPressure: true };
    }
    n++;
  }
  return n > 0 && steps[n] !== undefined && isPause(steps[n]!) ? { n, byPressure: false } : { n: 0, byPressure: false };
}

// ---------------------------------------------------------------------------
// Beschreibungen fuer die Gegenueberstellung
// ---------------------------------------------------------------------------

function decentExitWords(type: string, condition: string, v: number): string {
  const over = condition === "over";
  if (type === "pressure") return over ? L(`bis ${fmt(v)} bar`, `until ${fmt(v)} bar`) : L(`bis unter ${fmt(v)} bar`, `until below ${fmt(v)} bar`);
  if (type === "flow") return over ? L(`bis Fluss über ${fmt(v)} ml/s`, `until flow above ${fmt(v)} ml/s`) : L(`bis Fluss unter ${fmt(v)} ml/s`, `until flow below ${fmt(v)} ml/s`);
  return L(`bis Leistung ${over ? "über" : "unter"} ${fmt(v)} W`, `until power ${over ? "above" : "below"} ${fmt(v)} W`);
}

/** Was ein Decent-Schritt tut, kurz. */
function describeDecent(s: DStep): string {
  const smooth = s.transition === "smooth";
  const parts: string[] = [];
  if (isPause(s)) parts.push(smooth ? L("gleitend auf 0 (Pumpe aus)", "smooth to 0 (pump off)") : L("Pumpe aus", "Pump off"));
  else if (s.pump === "flow") {
    parts.push(s.transition === "hold" ? L("Fluss beim Eintritt halten", "Hold flow on entry")
      : L(`Fluss ${smooth ? "gleitend auf " : ""}${fmt(s.flow)} ml/s`, `Flow ${smooth ? "smooth to " : ""}${fmt(s.flow)} ml/s`));
  } else if (s.pump === "pressure") {
    parts.push(s.transition === "hold" ? L("Druck beim Eintritt halten", "Hold pressure on entry")
      : L(`Druck ${smooth ? "gleitend auf " : ""}${fmt(s.pressure)} bar`, `Pressure ${smooth ? "smooth to " : ""}${fmt(s.pressure)} bar`));
  } else if (s.pump === "lever") parts.push(L(`Hebel ab ${fmt(s.pressure)} bar`, `Lever from ${fmt(s.pressure)} bar`));
  else parts.push(L("Leistungsregelung", "Power control"));
  if (s.exit) parts.push(decentExitWords(s.exit.type, s.exit.condition, s.exit.value));
  if (s.weight > 0) parts.push(L(`bis ${fmt(s.weight)} g`, `until ${fmt(s.weight)} g`));
  if (s.seconds > 0) parts.push(s.exit || s.weight > 0 ? L(`höchstens ${fmt(s.seconds)} s`, `at most ${fmt(s.seconds)} s`) : `${fmt(s.seconds)} s`);
  if (s.volume > 0 && s.volume < 100) parts.push(L(`höchstens ${fmt(s.volume)} ml`, `at most ${fmt(s.volume)} ml`));
  if (s.limiter > 0) parts.push(L(`Deckel ${fmt(s.limiter)} ${s.pump === "flow" ? "bar" : "ml/s"}`, `Cap ${fmt(s.limiter)} ${s.pump === "flow" ? "bar" : "ml/s"}`));
  return parts.join(" · ");
}

function xeniaExitWords(e: StepExit): string[] {
  const out: string[] = [];
  if (e.pressureBar !== undefined) out.push(L(`bis ${fmt(e.pressureBar)} bar`, `until ${fmt(e.pressureBar)} bar`));
  if (e.pressureBelowBar !== undefined) out.push(L(`bis unter ${fmt(e.pressureBelowBar)} bar`, `until below ${fmt(e.pressureBelowBar)} bar`));
  if (e.flowGs !== undefined) out.push(L(`bis Fluss unter ${fmt(e.flowGs)} g/s`, `until flow below ${fmt(e.flowGs)} g/s`));
  if (e.flowAboveGs !== undefined) out.push(L(`bis Fluss über ${fmt(e.flowAboveGs)} g/s`, `until flow above ${fmt(e.flowAboveGs)} g/s`));
  if (e.weightG !== undefined) out.push(L(`bis ${fmt(e.weightG)} g`, `until ${fmt(e.weightG)} g`));
  if (e.seconds !== undefined) out.push(out.length ? L(`höchstens ${fmt(e.seconds)} s`, `at most ${fmt(e.seconds)} s`) : `${fmt(e.seconds)} s`);
  return out;
}

/** Was eine Xenia-Stufe tut, kurz. `fullRamp` = Rampe ueber die ganze Stufe („gleitend“). */
function describeXenia(st: BrewStep, fullRamp: boolean, endsByWeight: number | null): string {
  const parts: string[] = [];
  const ramp = st.kind !== "preinfusion" && st.rampMs ? st.rampMs : 0;
  if (st.kind === "preinfusion") {
    parts.push("Preinfusion");
    if (st.fill === "fast") parts.push(L("schnell füllen", "fill fast"));
    if (st.gentleness === "gentle") parts.push(L("sanft tränken", "soak gently"));
    if (st.gentleness === "brisk") parts.push(L("zügig tränken", "soak briskly"));
  }
  else if (st.kind === "power") parts.push(st.power === 0 ? L("Pause (Pumpe aus)", "Pause (pump off)") : L(`Leistung ${fmt(st.power)} %`, `Power ${fmt(st.power)} %`));
  else if (st.kind === "flow") {
    parts.push(st.adoptFlow ? L("Fluss vom Puck übernehmen", "Adopt flow from puck")
      : L(`Fluss ${fullRamp ? "gleitend auf " : ""}${fmt(st.targetFlowGs)} g/s`, `Flow ${fullRamp ? "smooth to " : ""}${fmt(st.targetFlowGs)} g/s`));
  } else {
    parts.push(st.adoptPressure ? L("Druck vom Puck übernehmen", "Adopt pressure from puck")
      : L(`Druck ${fullRamp ? "gleitend auf " : ""}${fmt(st.targetPressureBar)} bar`, `Pressure ${fullRamp ? "smooth to " : ""}${fmt(st.targetPressureBar)} bar`));
  }
  if (ramp > 0 && !fullRamp) parts.push(L(`Rampe ${fmt(ramp / 1000)} s`, `Ramp ${fmt(ramp / 1000)} s`));
  if (endsByWeight !== null) parts.push(L(`bis ${fmt(endsByWeight)} g`, `until ${fmt(endsByWeight)} g`));
  else parts.push(...xeniaExitWords(st.exit));
  if ((st.kind === "flow" || st.kind === "power") && st.maxPressureBar) parts.push(L(`Deckel ${fmt(st.maxPressureBar)} bar`, `Cap ${fmt(st.maxPressureBar)} bar`));
  if ((st.kind === "pressure" || st.kind === "power") && st.maxFlowGs) parts.push(L(`Deckel ${fmt(st.maxFlowGs)} g/s`, `Cap ${fmt(st.maxFlowGs)} g/s`));
  return parts.join(" · ");
}

/** Die Ausstiege eines Schritts; was nicht geht, als Begruendung. */
function exitOf(s: DStep): { exit: StepExit; whys: string[]; changed: boolean } {
  const e: StepExit = {};
  const whys: string[] = [];
  let changed = false;
  if (s.seconds > 0) e.seconds = r1(s.seconds);
  if (s.weight > 0) e.weightG = r1(s.weight);
  if (s.exit) {
    const { type, condition, value } = s.exit;
    if (type === "pressure" && condition === "over") e.pressureBar = value;
    else if (type === "pressure" && condition === "under") {
      e.pressureBelowBar = value;
      changed = true;
      whys.push(L(
        `„Bis unter ${fmt(value)} bar“ greift bei uns erst, nachdem der Druck in der Stufe einmal darüber lag — sonst endete sie sofort.`,
        `“Until below ${fmt(value)} bar” only applies here once the pressure in the stage has been above it — otherwise the stage would end at once.`,
      ));
    } else if (type === "flow" && condition === "under") e.flowGs = value;
    else if (type === "flow" && condition === "over") e.flowAboveGs = value;
    else {
      changed = true;
      whys.push(L("Den Ausstieg über die Leistung gibt es nicht — die Xenia misst keine hydraulische Leistung.",
        "There is no exit on power — the Xenia does not measure hydraulic power."));
    }
  }
  if (s.volume > 0 && s.volume < 100) {
    changed = true;
    whys.push(L(`Die Grenze von ${fmt(s.volume)} ml entfällt — die Xenia hat keinen nutzbaren Durchflussmesser.`,
      `The ${fmt(s.volume)} ml limit is dropped — the Xenia has no usable flow meter.`));
  }
  return { exit: e, whys, changed };
}

/**
 * Einordnung vorbelegen, soweit das Profil es hergibt: Decents Getraenkeart fuer
 * Filter, sonst „light“/„dark“ im Namen (A-Flow default-dark, EspressoForge_Light,
 * „Adaptive for Light Roast“). Nichts davon → leer; der Nutzer ordnet im Editor ein.
 */
export function decentFit(beverage: string, title: string): ProfileFit[] {
  if (beverage === "filter" || beverage === "pourover") return ["filter"];
  const fit: ProfileFit[] = [];
  // Wortanfang auch nach „_“ oder „-“ (EspressoForge_Light), aber nicht mitten im Wort (Highlights).
  if (/(^|[^a-z])(dark|dunkel)/i.test(title)) fit.push("dark");
  if (/(^|[^a-z])(light|hell)([^a-z]|$)/i.test(title)) fit.push("light");
  return fit;
}

export function translateDecent(text: string): DecentResult {
  const read = readDecent(text);
  if (!read.ok) return read;
  const d = read.p;
  if (["cleaning", "calibrate", "manual"].includes(d.beverage)) {
    return { ok: false, error: L(
      `„${d.title || "Profil"}“ ist ein Reinigungs-/Kalibrierprofil der Decent — auf der Xenia nicht sinnvoll.`,
      `“${d.title || "Profile"}” is a Decent cleaning/calibration profile — not useful on the Xenia.`,
    ) };
  }

  // Zeilen in Schrittfolge (at = Index im Decent-Profil), Hinweise ohne Doppel.
  const rows: (TranslationRow & { at: number })[] = [];
  const hints: TranslationHint[] = [];
  const hint = (h: TranslationHint) => { if (!hints.some((x) => x.text === h.text)) hints.push(h); };

  const src: DStep[] = [];
  const at = new Map<DStep, number>();
  const extra = new Map<DStep, string>();
  d.steps.forEach((s0, i) => {
    const s = { ...s0 };
    // Ausstieg bei 0: „über 0“ trifft sofort zu, „unter 0“ nie.
    if (s.exit && s.exit.value <= 0) {
      if (s.exit.condition === "over") {
        const next = d.steps[i + 1];
        rows.push({ at: i, group: "step", name: label(s, i), decent: describeDecent(s), xenia: null, status: "dropped",
          why: L("Der Schritt endet an der Decent sofort.", "On the Decent the step ends at once.") + (next?.transition === "smooth"
            ? L(" Dort setzt er nur den Startwert der folgenden Rampe — bei uns beginnt eine Rampe ohnehin am gemessenen Wert.",
              " There it only sets the start value of the following ramp — here a ramp starts at the measured value anyway.") : "") });
        return;
      }
      const flow = s.exit.type === "flow";
      extra.set(s, L(`Der Ausstieg „${flow ? "Fluss" : "Druck"} unter 0“ greift nie und entfällt.`,
        `The exit “${flow ? "flow" : "pressure"} below 0” never applies and is dropped.`));
      s.exit = null;
    }
    // Ohne Dauer, Ausstieg und Gewicht endet ein Schritt an der Decent sofort.
    if (s.seconds <= 0 && !s.exit && s.weight <= 0) {
      if (d.steps.length > 1) rows.push({ at: i, group: "step", name: label(s, i), decent: describeDecent(s), xenia: null, status: "dropped",
        why: L("Ohne Dauer und Ausstieg endet der Schritt an der Decent sofort.", "Without duration and exit the step ends at once on the Decent.") });
      return;
    }
    at.set(s, i);
    src.push(s);
  });
  if (src.length === 0) return { ok: false, error: L("Das Decent-Profil hat keine Schritte.", "The Decent profile has no steps.") };

  const steps: BrewStep[] = [];

  // Ziel — App-Bezuege stoppen ueber die Waage. Decents Pourover-Profile enden
  // nach der Uhr und nennen die Menge im Titel („V60 15g in, 250g out“). Fluss ×
  // Zeit taugt nicht: das ist Wasser in den Kaffee, nicht was in der Tasse ankommt.
  // Ohne jede Angabe bleibt das Ziel leer: dann beendet die letzte Stufe den Bezug.
  const fromTitle = /(\d+(?:[.,]\d+)?)\s*(?:g|ml)\s+out\b/i.exec(d.title);
  let yieldG: number | null = null;
  let targetRow: Omit<TranslationRow, "group" | "name"> | null = null;
  if (d.targetWeight > 0) {
    yieldG = r1(d.targetWeight);
    targetRow = { decent: `${fmt(yieldG)} g`, xenia: `${fmt(yieldG)} g`, status: "same", why: null };
  } else if (d.targetVolume > 0) {
    yieldG = r1(d.targetVolume);
    targetRow = { decent: L(`${fmt(d.targetVolume)} ml (Menge)`, `${fmt(d.targetVolume)} ml (volume)`), xenia: `${fmt(yieldG)} g`, status: "changed",
      why: L("Das Profil hat kein Zielgewicht, nur eine Menge — App-Bezüge stoppen über die Waage.",
        "The profile has no target weight, only a volume — app brews stop by the scale.") };
  } else if (fromTitle) {
    yieldG = r1(Number(fromTitle[1]!.replace(",", ".")));
    targetRow = { decent: L(`keins (im Titel „${fromTitle[0]}“)`, `none (in the title “${fromTitle[0]}”)`), xenia: `${fmt(yieldG)} g`, status: "changed",
      why: L("Das Profil endet an der Decent nach der Uhr; App-Bezüge stoppen über die Waage. Schafft die Pumpe die Pulse nicht ganz, läuft der letzte Schritt bis zum Ziel weiter.",
        "On the Decent the profile ends by the clock; app brews stop by the scale. If the pump does not quite manage the pulses, the last step runs on until the target.") };
  }

  // 1) Fuellen → Preinfusion ueber den Zulauf
  const { n: nFill, byPressure } = fillBlock(src);
  if (nFill > 0) {
    const fill = src.slice(0, nFill);
    const secs = r1(fill.reduce((a, s) => a + s.seconds, 0));
    const weights = fill.map((s) => s.weight).filter((w) => w > 0);
    const byPump = fill.some(pressureFill);
    const maxFill = Math.max(0, ...fill.filter((s) => s.pump === "flow").map((s) => s.flow));
    const slow = !byPump && maxFill < SLOW_FILL_MLS;
    const ceiling = !byPump && maxFill > PUMP_CEILING_GS
      ? L(` ${fmt(maxFill)} ml/s schafft die Pumpe ohnehin nicht (~${fmt(PUMP_CEILING_GS)} g/s).`,
        ` The pump cannot deliver ${fmt(maxFill)} ml/s anyway (~${fmt(PUMP_CEILING_GS)} g/s).`)
      : "";
    let exit: StepExit;
    let why: string;
    let decent: string;
    if (byPump) {
      const stop = fill[nFill - 1]!.exit!.value;
      const cap = Math.max(secs, PREINFUSION_MIN_SECONDS);
      const p = Math.max(...fill.filter(pressureFill).map((s) => s.pressure));
      exit = { pressureBar: stop, seconds: cap, ...(weights.length ? { weightG: Math.min(...weights) } : {}) };
      // Vorlauf-Schritte (gleiches Ziel, ohne Ausstieg) nicht einzeln zeigen.
      decent = fill.filter((s) => !(s.pump === "pressure" && !s.exit)).map(describeDecent).join(" → ");
      why = L(`Das Ziel ${fmt(p)} bar liegt über dem Ausstieg ${fmt(stop)} bar: die Decent füllt hier mit voller Pumpe. Als Druckstufe drehte die Regelung bei uns auf dem leeren Puck hoch und schoss über (#158/#159) — daher Preinfusion: schnell füllen bis zum ersten Gegendruck, dann zügig bis ${fmt(stop)} bar.`,
        `The target ${fmt(p)} bar is above the exit ${fmt(stop)} bar: the Decent fills at full pump here. As a pressure stage our control wound up on the empty puck and overshot (#158/#159) — hence preinfusion: fill fast until first back pressure, then briskly until ${fmt(stop)} bar.`)
        + (cap > secs ? L(` Decents ${fmt(secs)} s wären hier zu knapp, sie bleiben nur Grenze.`, ` Decent's ${fmt(secs)} s would be too short here; they only remain a limit.`) : "");
    } else if (byPressure) {
      const stop = fill[nFill - 1]!.exit!.value;
      const cap = Math.max(secs, PREINFUSION_MIN_SECONDS);
      exit = { pressureBar: stop, seconds: cap, ...(weights.length ? { weightG: Math.min(...weights) } : {}) };
      decent = L(`Fluss ${fmt(maxFill)} ml/s bis ${fmt(stop)} bar · höchstens ${fmt(secs)} s`, `Flow ${fmt(maxFill)} ml/s until ${fmt(stop)} bar · at most ${fmt(secs)} s`);
      why = L("Beim Füllen kommt in der Tasse noch nichts an — die Xenia füllt über den errechneten Zulauf und übergibt, sobald Kaffee kommt.",
        "While filling, nothing reaches the cup yet — the Xenia fills via the calculated inflow and hands over as soon as coffee arrives.")
        + (cap > secs ? L(` Decents ${fmt(secs)} s wären hier zu knapp (6–9 s bis 3,8 bar), sie bleiben nur Grenze.`,
          ` Decent's ${fmt(secs)} s would be too short here (6–9 s to 3.8 bar); they only remain a limit.`) : "") + ceiling;
    } else {
      exit = { seconds: secs, ...(weights.length ? { weightG: Math.min(...weights) } : {}) };
      decent = L(`Fluss ${fmt(maxFill)} ml/s · ${fmt(secs)} s`, `Flow ${fmt(maxFill)} ml/s · ${fmt(secs)} s`);
      why = L("Fluss in die Tasse lässt sich beim Benetzen nicht regeln — die Xenia füllt über den errechneten Zulauf, in derselben Zeit mit weniger Wasser (~3,5 ml/s).",
        "Flow into the cup cannot be controlled while wetting — the Xenia fills via the calculated inflow, in the same time with less water (~3.5 ml/s).") + ceiling;
    }
    if (slow) {
      why += L(` Decent füllt langsam (${fmt(maxFill)} ml/s). Ohne Gegendruck fördert die Pumpe darunter nicht zuverlässig (unter 25 % gar nicht, ab 25 % rund 2 ml/s) — das Füllen bleibt bei 3,5 ml/s, ab 1 bar tränkt sie sanft (1,5 ml/s).`,
        ` Decent fills slowly (${fmt(maxFill)} ml/s). Without back pressure the pump does not deliver that reliably (below 25 % not at all, from 25 % about 2 ml/s) — filling stays at 3.5 ml/s, from 1 bar it soaks gently (1.5 ml/s).`);
    }
    const st: PreinfusionStep = { kind: "preinfusion", name: label(fill[nFill - 1]!, nFill - 1),
      gentleness: byPump ? "brisk" : slow ? "gentle" : "normal", ...(byPump ? { fill: "fast" as const } : {}), exit };
    steps.push(st);
    rows.push({ at: at.get(fill[0]!)!, group: "step", name: fill.map(label).join(" + "), decent, xenia: describeXenia(st, false, null), status: "changed", why });
  }

  // 2) die uebrigen Schritte
  let flowNoted = false;
  let capNoted = false;
  let ladder = 0;
  for (let i = nFill; i < src.length; i++) {
    const s = src[i]!;
    const name = label(s, at.get(s)!);
    const last = i === src.length - 1;
    // Mit Ziel stoppt die Waage, die Ausstiege der letzten Stufe zaehlen nicht;
    // ohne Ziel beendet sie den Bezug wie an der Decent.
    const ex = last && yieldG !== null ? { exit: {}, whys: [], changed: false } : exitOf(s);
    const exit = ex.exit;
    const whys = [...(extra.has(s) ? [extra.get(s)!] : []), ...ex.whys];
    let status: TranslationRow["status"] = ex.changed || extra.has(s) ? "changed" : "same";
    const named = s.name.trim() ? { name: s.name.trim() } : {};
    const full = s.transition === "smooth" && s.seconds > 0;
    const smooth = full ? { rampMs: Math.round(s.seconds * 1000) } : {};
    // Direkt nach dem Fuellen — und nur, wenn der Druck von dort noch steigt (Sprung nach oben).
    const prev = steps[steps.length - 1];
    const afterFill = prev?.kind === "preinfusion" && s.pressure > (prev.exit.pressureBar ?? 0);
    let st: BrewStep;

    if (isPause(s) && full && s.seconds >= DECLINE_MIN_SECONDS) {
      // Gleiten auf 0: der Sollwert sinkt ueber die ganze Stufe. Pumpe aus liesse den Druck
      // in 1–3 s einbrechen (#284) — also eine Rampe, die die Pumpe nach und nach zuruecknimmt.
      status = "changed";
      if (s.pump === "pressure") {
        st = { kind: "pressure", ...named, targetPressureBar: DECLINE_END_BAR, ...smooth, exit, ...(s.limiter > 0 ? { maxFlowGs: s.limiter } : {}) };
        whys.push(L(`Bei Decent sinkt der Druck über ${fmt(s.seconds)} s auf 0. Pumpe aus ließe ihn bei uns in 1–3 s einbrechen (#284) — daher eine Druckrampe auf ${fmt(DECLINE_END_BAR)} bar, die Pumpe geht nach und nach zurück.`,
          `On the Decent the pressure falls to 0 over ${fmt(s.seconds)} s. Pump off would let it collapse here in 1–3 s (#284) — hence a pressure ramp to ${fmt(DECLINE_END_BAR)} bar, the pump backs off gradually.`));
      } else {
        st = { kind: "flow", ...named, targetFlowGs: MIN_FLOW_GS, ...smooth, exit, ...(s.limiter > 0 ? { maxPressureBar: s.limiter } : {}) };
        whys.push(L(`Bei Decent sinkt der Fluss über ${fmt(s.seconds)} s auf 0. Pumpe aus ließe den Druck in 1–3 s einbrechen (#284) — daher eine Flussrampe bis ${fmt(MIN_FLOW_GS)} g/s; viel weniger fördert die Pumpe nicht (#286).`,
          `On the Decent the flow falls to 0 over ${fmt(s.seconds)} s. Pump off would let the pressure collapse in 1–3 s (#284) — hence a flow ramp down to ${fmt(MIN_FLOW_GS)} g/s; the pump cannot deliver much less (#286).`));
      }
    } else if (isPause(s) || (s.pump === "flow" && s.transition !== "hold" && s.flow < MIN_FLOW_GS)) {
      st = { kind: "power", ...named, power: 0, exit };
      if (isPause(s) && full) {
        status = "changed";
        whys.push(L(`Gleiten auf 0 in ${fmt(s.seconds)} s — so kurz ist es ein Kniff am Bezugsende, keine Abklingphase: hier Pumpe aus.`,
          `Smooth to 0 in ${fmt(s.seconds)} s — this short it is a trick at the end of the brew, not a decline: pump off here.`));
      } else if (!isPause(s)) {
        status = "approx";
        whys.push(L(`${fmt(s.flow)} ml/s fördert die Pumpe nicht: mit kleinster Leistung bei 2,8 bar noch ~0,8 g/s (#286), ohne Gegendruck gar nicht oder ~2 ml/s. Pumpe aus kommt dem am nächsten.`,
          `The pump cannot deliver ${fmt(s.flow)} ml/s: at its lowest power still ~0.8 g/s at 2.8 bar (#286), without back pressure none or ~2 ml/s. Pump off comes closest.`));
      }
    } else if (s.pump === "flow") {
      st = { kind: "flow", ...named, targetFlowGs: r1(Math.max(s.flow, 0.1)), ...smooth, exit,
        ...(s.limiter > 0 ? { maxPressureBar: s.limiter } : {}), ...(s.transition === "hold" ? { adoptFlow: true } : {}) };
      if (s.transition === "hold") whys.push(L("Gleiche Idee wie Decents „Fluss halten“ (HOLD-F).", "Same idea as Decent's “hold flow” (HOLD-F)."));
      if (!flowNoted) {
        flowNoted = true;
        hint({ text: L("Fluss-Sollwerte sind Startwerte", "Flow setpoints are starting values"),
          why: L("Die Decent regelt den Zulauf in den Kaffee, die Xenia den Fluss in die Tasse — Druck und Mahlgrad stellt man an echten Bezügen ein.",
            "The Decent controls the inflow into the coffee, the Xenia the flow into the cup — pressure and grind are set on real brews.") });
      }
      if (s.flow > PUMP_CEILING_GS) {
        hint({ text: L(`Fluss über ${fmt(PUMP_CEILING_GS)} g/s schafft die Pumpe nicht`, `The pump cannot deliver flow above ${fmt(PUMP_CEILING_GS)} g/s`),
          why: L(`„${name}“ will ${fmt(s.flow)} g/s; bei offenem Puck schafft die Pumpe ~${fmt(PUMP_CEILING_GS)} g/s.`,
            `“${name}” wants ${fmt(s.flow)} g/s; with an open puck the pump manages ~${fmt(PUMP_CEILING_GS)} g/s.`) });
      }
      ladder = s.exit?.type === "flow" && s.exit.condition === "under" ? ladder + 1 : 0;
      if (ladder === 3) hint({ text: L("Leiter aus Flussstufen — Absicht prüfen", "Ladder of flow steps — check the intent"),
        why: L("Vermutlich ein Decent-Kniff, um den passenden Fluss zu finden (wie bei Adaptive). Auf der Xenia geht das direkt mit „Fluss vom Puck übernehmen“.",
          "Probably a Decent trick to find the right flow (as in Adaptive). On the Xenia this works directly with “Adopt flow from puck”.") });
      if (s.limiter > 0 && !capNoted) {
        capNoted = true;
        hint({ text: L(`Druckdeckel ${fmt(s.limiter)} bar ist ein Abregler`, `Pressure cap ${fmt(s.limiter)} bar is a soft limiter`),
          why: L("Keine harte Kappe: im Begrenzerbetrieb gemessen ~0,4 bar darüber im Mittel.", "Not a hard cap: measured ~0.4 bar above it on average in limiter mode.") });
      }
    } else if (s.pump === "pressure") {
      ladder = 0;
      const ramp = full ? smooth : afterFill ? { rampMs: 3000 } : {};
      st = { kind: "pressure", ...named, targetPressureBar: r1(s.pressure), ...ramp, exit,
        ...(s.limiter > 0 ? { maxFlowGs: s.limiter } : {}), ...(s.transition === "hold" ? { adoptPressure: true } : {}) };
      if (s.transition === "hold") whys.push(L("Gleiche Idee wie Decents „Druck halten“ (HOLD-P).", "Same idea as Decent's “hold pressure” (HOLD-P)."));
      else if (afterFill && !full) {
        status = "changed";
        whys.push(L("Rampe 3 s statt Sprung: direkt nach dem Füllen schoss ein Drucksprung bei uns über (Gagné #253).",
          "Ramp 3 s instead of a jump: right after filling, a pressure jump overshot here (Gagné #253)."));
      }
    } else {
      // power / lever / HOLD-Leistung: Regelgesetz der Decent nicht nachgebaut
      ladder = 0;
      const target = s.pump === "lever" ? s.pressure : (s.modeCap ?? (s.limiter > 0 ? s.limiter : 9));
      st = { kind: "pressure", ...named, targetPressureBar: r1(target), ...smooth, exit } satisfies PressureStep;
      status = "approx";
      whys.push(s.pump === "lever"
        ? L("Die Decent ahmt hier eine Federhebel-Maschine nach; die Formel dafür ist nicht nachgebaut — Druckstufe am Startdruck.",
          "Here the Decent imitates a spring-lever machine; its formula is not rebuilt — pressure stage at the start pressure.")
        : L("Die Decent regelt hier auf hydraulische Leistung (Druck × Fluss); nachgebaut ist nur der Druckdeckel.",
          "Here the Decent controls to hydraulic power (pressure × flow); only the pressure cap is rebuilt."));
    }
    steps.push(st);
    rows.push({ at: at.get(s)!, group: "step", name, decent: describeDecent(s),
      xenia: describeXenia(st, full, last ? yieldG : null), status, why: whys.length ? whys.join(" ") : null });
  }

  if (yieldG === null) {
    const end = steps[steps.length - 1]!.exit;
    if (Object.keys(end).length > 0) {
      targetRow = { decent: L("keins (endet nach dem letzten Schritt)", "none (ends after the last step)"),
        xenia: L("keins — endet mit der letzten Stufe", "none — ends with the last stage"), status: "same",
        why: L("Wie an der Decent: ein Profil ohne Zielgewicht endet, wenn sein letzter Schritt vorbei ist. Ein Ziel pro Bezug geht im Start-Dialog.",
          "As on the Decent: a profile without a target weight ends when its last step is over. A target per brew can be set in the start dialog.") };
    } else {
      // Die letzte Stufe hat nichts, was sie beendet — dann doch ueber die Waage.
      yieldG = 36;
      targetRow = { decent: L("keins", "none"), xenia: "36 g", status: "changed",
        why: L("Ohne Ziel beendet die letzte Stufe den Bezug — hier hat sie aber keinen Ausstieg.", "Without a target the last stage ends the brew — but here it has no exit.") };
      hint({ text: L("Ziel 36 g gesetzt — bitte anpassen", "Target set to 36 g — please adjust"),
        why: L("Das Profil hat kein Ziel, und sein letzter Schritt endet nicht von selbst.", "The profile has no target, and its last step does not end by itself.") });
    }
  }

  // 3) Temperatur: eine fuer das Profil — die der ersten Stufe nach dem Fuellen (keine Pause)
  const temps = src.map((s) => s.temperature).filter((t): t is number => t !== null && Number.isFinite(t));
  const tempStep = src.slice(nFill).find((s) => !isPause(s) && s.temperature !== null && Number.isFinite(s.temperature));
  const tempFrom = tempStep?.temperature ?? temps[0] ?? null;
  const tempC = tempFrom !== null && Number.isFinite(tempFrom) && tempFrom >= 70 && tempFrom <= 110 ? r1(tempFrom) : null;
  const course = temps.map(r1).filter((t, k, a) => k === 0 || t !== a[k - 1]);
  const varies = new Set(course).size > 1;
  const tempRow: Omit<TranslationRow, "group" | "name"> = {
    decent: temps.length ? `${course.map(fmt).join(" → ")} °C` : "–",
    xenia: tempC !== null
      ? `${fmt(tempC)} °C${varies && tempStep ? L(` (aus „${label(tempStep, at.get(tempStep)!)}“)`, ` (from “${label(tempStep, at.get(tempStep)!)}”)`) : ""}`
      : L("keine", "none"),
    status: varies ? "changed" : "same",
    why: varies
      ? L("Die Xenia hält eine Temperatur pro Bezug. Übernommen ist die der ersten Stufe nach dem Füllen (keine Pause), nicht die des Füllens — das dauert nur Sekunden.",
        "The Xenia holds one temperature per brew. It takes that of the first stage after filling (not a pause), not that of the filling — which only lasts seconds.")
      : null,
  };

  rows.sort((a, b) => a.at - b.at);
  const title = d.title || L("Decent-Profil", "Decent profile");
  const brewSteps: BrewProfile = { version: 1, steps };
  return {
    ok: true,
    title,
    rows: [
      ...rows.map(({ at: _at, ...r }) => r),
      { group: "profile", name: L("Temperatur", "Temperature"), ...tempRow },
      { group: "profile", name: L("Ziel", "Target"), ...targetRow! },
    ],
    hints,
    profile: {
      name: title,
      kind: "brew",
      isTrial: true,
      fit: decentFit(d.beverage, title),
      targetTempC: tempC,
      // Titel (oft mit Dosis und Menge, „V60 15g in, 250g out“) und Decents Beschreibung im Original.
      notes: L(`Aus Decent „${title}“`, `From Decent “${title}”`) + `${d.author ? ` (${d.author})` : ""}${d.notes ? `\n\n${d.notes}` : ""}`,
      variants: [{ name: "Einzel", basket: null, yieldG, sameAs: null, script: null, phaseNames: null, brewSteps }],
    },
  };
}
