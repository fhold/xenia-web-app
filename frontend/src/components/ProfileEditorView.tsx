/**
 * ProfileEditorView — der vereinte Profil-Editor (Schnitt 2b, Varianten 3c).
 *
 * Eine volle Ansicht statt eines Modals: Kopf, Varianten-Reiter, Kurve,
 * Phasenleiste, Phasenfeld und die Reiter Befehle (nur Skript), Variante und
 * Notiz. Jede Variante hat Namen, Vorgabe-Sieb, Yield und eine Kurve — eine
 * eigene oder „wie Variante X“. Wie eine Kurve laeuft (Skript oder App),
 * entscheidet sie fuer sich (shared/profile-phases.ts: planVariantSave).
 *
 * ⚠ Bei Skript-Kurven bleibt die Befehlsliste die eine Datenquelle — jede
 * Aenderung an einer Phase geht an genau die betroffenen Befehle, alles andere
 * bleibt Byte fuer Byte gleich. Braucht eine Aenderung die App (Fluss,
 * Preinfusion, zweiter Ausstieg …), wird die Kurve in App-Stufen umgewandelt —
 * nicht, wenn das Skript Befehle hat, die nur das Skript kann.
 *
 * Gespeichert wird so: erst die Skripte an die Maschine (anlegen bzw. mit
 * Rueckfrage ueberschreiben, Konflikt-Schutz ueber expectedContent), dann das
 * Profil mit seinen Varianten, zuletzt ein nicht mehr gebrauchtes Skript
 * loeschen, wenn das so gewaehlt wurde. Schlaegt etwas fehl, bleibt der Editor
 * offen.
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { NavGuardContext } from "../hooks/useNavigation.js";
import { Bell, ChevronLeft, ChevronRight, FlaskConical, HelpCircle, Plus, Redo2, Star, Trash2, Undo2 } from "lucide-react";
import { HoverTip } from "./HoverTip.js";
import type { Basket, BrewStep, ParsedCmd, PreinfusionFill, PreinfusionGentleness, Profile, ProfileFit, ProfileCreate, ProfileKind, ProfileVariantInput, XeniaScript } from "@shared/types.js";
import { PROFILE_FITS } from "@shared/types.js";
import { parseScript } from "@shared/script-parser.js";
import { serializeScript } from "@shared/script-serializer.js";
import { scriptToTimeline } from "@shared/script-timeline.js";
import { validateScript } from "@shared/script-validator.js";
import { endsWithoutYield, validateBrewSteps } from "@shared/brew-steps.js";
import { setArg, moveCmd, removeCmd, insertWithWait, editableRange, defaultInsertIndex, makeCmd, defaultArgs } from "@shared/script-edit.js";
import { SCRIPT_MODEL_HELP } from "@shared/script-help.js";
import { PREINFUSION_ARRIVAL_FRACTION } from "@shared/pump-curve.js";
import {
  projectScript, projectSteps, laufart, scriptToSteps, stepsToScript, phaseToStep, planVariantSave,
  setScriptPhaseValues, setScriptPhaseExit, setScriptPhaseKind, addScriptPhase, removeScriptPhase, moveScriptPhase,
  scriptPhaseInsertIndex, fitPhaseNames,
} from "@shared/profile-phases.js";
import type { Phase, PhaseExit, PhaseKind, ExitKind, SaveCase, Laufart, Engine } from "@shared/profile-phases.js";
import { startVariants } from "@shared/profile-slots.js";
import type { UseScriptsReturn } from "../hooks/useScripts.js";
import { ScriptConflict } from "../hooks/useScripts.js";
import { useBaskets } from "../hooks/useBaskets.js";
import type { ShotFilters } from "../hooks/useShots.js";
import { ProfileRanWith } from "./Network.js";
import { ScriptCurveEditor, CurveEditor, stepsCurveEdit } from "./ScriptCurveEditor.js";
import { ScriptCommandList } from "./ScriptCommandList.js";
import { stepsToTimeline } from "@shared/steps-curve.js";
import { InsertMenu, Modal, modalTitle, modalText } from "./ScriptInsertMenu.js";
import theme, { alpha } from "../theme.js";
import { t, useTranslation } from "../i18n/index.js";
import { dec } from "../lib/num.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

// ---------------------------------------------------------------------------
// Entwurf
// ---------------------------------------------------------------------------

/** Eine Kurve: Skript (Befehle) oder App (Stufen). */
interface CurveDraft {
  /** Skript, auf das die Kurve zeigt; null bei App-Kurve oder neuem Skript. */
  scriptId: number | null;
  /** Inhalt dieses Skripts beim Laden — fuer "geaendert?" und den Konflikt-Schutz. */
  baseContent: string | null;
  /** Skript-Kurve: die Befehle. */
  cmds: ParsedCmd[] | null;
  /** App-Kurve: die Stufen. */
  steps: BrewStep[] | null;
  /** Skriptname, wie er an der Maschine heissen soll; null = automatisch (neues Skript). */
  title: string | null;
  /** So war die Kurve beim Oeffnen (abgespalten: die, von der sie stammt) — fuer „geaendert?“. */
  start: { cmds: ParsedCmd[] | null; steps: BrewStep[] | null };
  /** Skript-Kurve: Phasennamen je Phasen-Index (die Maschine kennt keine); App-Stufen tragen ihre selbst. */
  names: (string | null)[];
  /** Das Skript (diese ID) fehlt an der Maschine — die Kurve kommt aus dem gespeicherten Stand und wird neu angelegt. */
  missing: number | null;
}

interface VariantDraft {
  /** Fester Schluessel im Entwurf: die ID der gespeicherten Variante, neue negativ. */
  key: number;
  /** null = neue Variante. */
  id: number | null;
  name: string;
  basketId: number | null;
  yieldG: number | null;
  /** „wie Variante X“: Schluessel von X, deren Kurve diese faehrt; null = eigene Kurve. */
  sameAs: number | null;
  /** Die eigene Kurve; bei „wie Variante X“ ohne Bedeutung. */
  curve: CurveDraft;
}

interface Draft {
  name: string;
  fav: boolean;
  /** Versuch: nur zum Ausprobieren (Kolben). */
  trial: boolean;
  /** Einordnung fuer die Filter der Profilliste — in der Reihenfolge von PROFILE_FITS. */
  fit: ProfileFit[];
  tempC: number | null;
  notes: string;
  variants: VariantDraft[];
  /** Bezug oder Wartung — Wartung ohne Sieb und Yield, nur mit Skript-Kurven. */
  kind: ProfileKind;
}

/** Hoechstens so viele Varianten — wie das Backend. */
const MAX_VARIANTS = 8;

const NEW_STEPS: BrewStep[] = [
  // Neue Profile beginnen mit der Preinfusion ueber den Zulauf (Schutzgrenzen vorbelegt).
  { kind: "preinfusion", gentleness: "normal", exit: { seconds: 25, pressureBar: 4 } },
  { kind: "flow", targetFlowGs: 1.4, exit: {} },
];

const NO_CURVE: CurveDraft = { scriptId: null, baseContent: null, cmds: null, steps: null, title: null, start: { cmds: null, steps: null }, names: [], missing: null };

/** Skript-Kurve; fehlt das Skript an der Maschine, aus dem gespeicherten Stand (`orphans`) — Speichern legt es neu an. */
function scriptCurve(scripts: XeniaScript[], orphans: XeniaScript[], id: number, names: (string | null)[] | null): CurveDraft {
  const s = scripts.find((x) => x.id === id);
  if (!s) {
    const o = orphans.find((x) => x.id === id);
    const cmds = o ? parseScript(o.content).commands : [];
    return { ...NO_CURVE, cmds, title: o?.title ?? null, names: names ?? [], start: { cmds, steps: null }, missing: id };
  }
  const cmds = parseScript(s.content).commands;
  return { ...NO_CURVE, scriptId: id, baseContent: s.content, cmds, title: s.title, names: names ?? [], start: { cmds, steps: null } };
}

const stepsCurve = (steps: BrewStep[]): CurveDraft => ({ ...NO_CURVE, steps, start: { cmds: null, steps } });

function initDraft(p: Profile | null, scripts: XeniaScript[], baskets: Basket[], orphans: XeniaScript[]): Draft {
  const base = { name: p?.name ?? "", fav: p?.isFavorite ?? false, trial: p?.isTrial ?? false, fit: p?.fit ?? [], tempC: p?.targetTempC ?? null, notes: p?.notes ?? "" };
  if (!p) {
    // Neues Profil: das erste Sieb (nach id) — einen Siebtyp fragt die App nicht mehr ab.
    const basket = [...baskets].sort((a, b) => a.id - b.id)[0];
    return {
      ...base, kind: "brew",
      variants: [{ key: -1, id: null, name: "Einzel", basketId: basket?.id ?? null, yieldG: null, sameAs: null, curve: stepsCurve(NEW_STEPS) }],
    };
  }
  const variants = startVariants(p).map((v): VariantDraft => ({
    key: v.id, id: v.id, name: v.name, basketId: v.defaultBasketId, yieldG: v.yieldG, sameAs: v.sameAsId,
    curve: v.sameAsId !== null ? NO_CURVE : v.scriptId !== null ? scriptCurve(scripts, orphans, v.scriptId, v.phaseNames) : stepsCurve(v.brewSteps?.steps ?? []),
  }));
  return { ...base, variants, kind: p.kind };
}

/** Index der Variante, deren Kurve Variante i faehrt („wie Variante X“ → X). */
function ownerOf(d: Draft, i: number): number {
  const v = d.variants[i]!;
  if (v.sameAs === null) return i;
  const o = d.variants.findIndex((x) => x.key === v.sameAs);
  return o >= 0 ? o : i;
}

/** Die Kurve, die Variante i wirklich faehrt. */
const curveOf = (d: Draft, i: number): CurveDraft => d.variants[ownerOf(d, i)]!.curve;

const text = (c: ParsedCmd[]) => serializeScript({ commands: c, unknownCmds: [] });

/** Nur, was die Maschine in Skriptnamen nimmt: Buchstaben ohne Umlaute, Ziffern, - _ # und Leerzeichen. */
const machineChars = (t: string) => t
  .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss")
  .replace(/[^A-Za-z0-9\-_# ]/g, " ").replace(/\s+/g, " ").trim();

/** Skriptname einer Variante: Profil und Variante, max. 40 Zeichen — gekuerzt wird am Profilnamen. */
export function machineScriptTitle(name: string, variant: string): string {
  const suffix = ` ${(machineChars(variant) || "Variante").slice(0, 20).trimEnd()}`;
  return `${(machineChars(name) || "Profil").slice(0, 40 - suffix.length).trimEnd()}${suffix}`;
}

/** Maschinenregel fuer Skriptnamen: Buchstaben ohne Umlaute, Ziffern, - _ # und Leerzeichen, nicht am Rand, max. 40. */
const SCRIPT_NAME_RE = /^(?! )[A-Za-z0-9\-_# ]*(?<! )$/;
const scriptNameOk = (t: string) => t.length > 0 && t.length <= 40 && SCRIPT_NAME_RE.test(t);

/** Ein Skriptname, der noch nicht vergeben ist („… 2“, „… 3“) — an der Maschine und in diesem Speichern. */
function freeTitle(title: string, taken: Set<string>): string {
  let out = title;
  for (let n = 2; taken.has(out); n++) out = `${title.slice(0, 39 - String(n).length).trimEnd()} ${n}`;
  return out;
}

// ---------------------------------------------------------------------------
// Anzeige-Helfer
// ---------------------------------------------------------------------------

// Beschriftungen als Funktionen — eine Konstante wuerde die Sprache beim Laden einfrieren.
const kindLabel = (k: PhaseKind): string => ({
  pressure: t("editor.kind.pressure"), flow: t("editor.kind.flow"), power: t("editor.kind.power"), pause: t("editor.kind.pause"), preinfusion: t("editor.kind.preinfusion"),
})[k];
const KIND_COLOR: Record<PhaseKind, string> = { pressure: C.seriesPressure, flow: C.seriesFlow, power: C.seriesPower, pause: C.mut, preinfusion: C.seriesPower };
const UNIT: Record<PhaseKind, string> = { pressure: "bar", flow: "g/s", power: "%", pause: "", preinfusion: "" };
const gentleOptions = (): { key: PreinfusionGentleness; label: string }[] => [
  { key: "gentle", label: t("editor.gentle.gentle") }, { key: "normal", label: t("editor.gentle.normal") }, { key: "brisk", label: t("editor.gentle.brisk") },
  { key: "none", label: t("editor.gentle.none") },
];
const fillOptions = (): { key: PreinfusionFill; label: string }[] => [
  { key: "normal", label: t("editor.fill.normal") }, { key: "fast", label: t("editor.fill.fast") },
];
const exitMeta = (k: ExitKind): { pre: string; unit: string; add: string; def: number } => ({
  weight: { pre: "→", unit: "g", add: t("editor.exit.add.weight"), def: 20 },
  pressureAbove: { pre: "P ≥", unit: "bar", add: t("editor.exit.add.pressureAbove"), def: 4 },
  pressureBelow: { pre: "P ≤", unit: "bar", add: t("editor.exit.add.pressureBelow"), def: 6 },
  flowBelow: { pre: "F ≤", unit: "g/s", add: t("editor.exit.add.flowBelow"), def: 0.8 },
  flowAbove: { pre: "F ≥", unit: "g/s", add: t("editor.exit.add.flowAbove"), def: 2 },
  time: { pre: t("editor.exit.after"), unit: "s", add: t("editor.exit.add.time"), def: 10 },
  tempAbove: { pre: "≥", unit: "°C", add: t("editor.exit.add.tempAbove"), def: 90 },
})[k];
const EXIT_ORDER: ExitKind[] = ["weight", "pressureAbove", "pressureBelow", "flowBelow", "flowAbove", "time", "tempAbove"];

const fmt = (v: number) => dec(String(Math.round(v * 100) / 100));
/** Getippte Werte bleiben, wie sie sind (auf 0,01) — nur −/+ geht in Schritten. */
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Gruende kurz: je Art einmal, ohne Phasennummer. */
const short = (rs: string[]) => [...new Set(rs.map((r) => r.replace(/ in (Phase|stage) \d+$/, "")))].join(", ");

/** Skript-Phase ohne eigenen Pumpenbefehl: haelt das Ziel der Phase davor (z. B. „bis 3,8 bar, dann 3 s“). */
const isHold = (p: Phase) => "pumpIndex" in p && (p as { pumpIndex: number | null }).pumpIndex === null && p.kind !== "pause";

function autoLabel(p: Phase): string {
  if (p.kind === "pause") return kindLabel("pause");
  if (p.kind === "preinfusion" && p.gentleness === "none") return t("editor.phase.autoPreinfusionNone");
  if (p.kind === "preinfusion") return t("editor.phase.autoPreinfusion", { gentle: gentleOptions().find((g) => g.key === (p.gentleness ?? "normal"))!.label });
  const parts = { kind: kindLabel(p.kind), value: p.target === null ? "—" : fmt(p.target), unit: UNIT[p.kind] };
  return isHold(p) ? t("editor.phase.autoLabelHold", parts) : t("editor.phase.autoLabel", parts);
}

function exitText(e: PhaseExit): string {
  const m = exitMeta(e.kind);
  return `${m.pre} ${fmt(e.value)} ${m.unit}`.trim();
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

/** Zahl mit −/+ und Eingabe; leer = null, wenn `nullable`. */
function NumberStepper({ label, value, unit, step, min, max, nullable, color, onChange }: {
  label: string; value: number | null; unit: string; step: number; min: number; max: number;
  nullable?: boolean; color?: string; onChange: (v: number | null) => void;
}) {
  const [txt, setTxt] = useState(value === null ? "" : fmt(value));
  useEffect(() => { setTxt(value === null ? "" : fmt(value)); }, [value]);
  const commit = (raw: string) => {
    const reset = () => setTxt(value === null ? "" : fmt(value));
    if (raw.trim() === "") { if (nullable && value !== null) onChange(null); else reset(); return; }
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n)) { reset(); return; }
    const v = Math.min(max, Math.max(min, r2(n)));
    if (v !== value) onChange(v); else reset();
  };
  const bump = (dir: 1 | -1) => {
    onChange(Math.min(max, Math.max(min, r2((value ?? min) + dir * step))));
  };
  const btn: React.CSSProperties = {
    width: 34, height: 34, flexShrink: 0, borderRadius: 8, border: `1px solid ${C.bdr2}`, background: C.sunken,
    color: C.txtS, fontSize: 16, cursor: "pointer", fontFamily: "inherit",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={fieldLabel}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button type="button" aria-label={t("editor.stepper.decrease", { label })} onClick={() => bump(-1)} style={btn}>−</button>
        <input
          value={txt}
          inputMode="decimal"
          placeholder="—"
          aria-label={label}
          onChange={(e) => setTxt(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={{
            width: 58, height: 34, boxSizing: "border-box", textAlign: "center", borderRadius: 8,
            border: `1px solid ${C.bdr2}`, background: C.bg, color: color ?? C.txt, fontSize: 14, fontWeight: 600, ...MONO, outline: "none",
          }}
        />
        <span style={{ fontSize: 11, color: C.mut, minWidth: 22 }}>{unit}</span>
        <button type="button" aria-label={t("editor.stepper.increase", { label })} onClick={() => bump(1)} style={btn}>+</button>
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = { fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: C.mut };

/** „?“ neben einem Feldnamen — kurze Erklaerung beim Antippen, knapp, keine Saetze. */
function FieldHelp({ lines }: { lines: string[] }) {
  return (
    <HoverTip
      content={<div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, maxWidth: 340 }}>{lines.map((l) => <span key={l}>{l}</span>)}</div>}
      style={{ display: "inline-flex", color: C.mut, cursor: "help" }}
    >
      <HelpCircle size={13} aria-label={t("editor.help.aria")} />
    </HoverTip>
  );
}
const labelWithHelp: React.CSSProperties = { ...fieldLabel, display: "inline-flex", alignItems: "center", gap: 5 };

function Segmented<T extends string>({ options, value, onPick, label, color }: {
  options: { key: T; label: string }[]; value: T; onPick: (k: T) => void; label: string; color?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "inline-flex", border: `1px solid ${C.bdr2}`, borderRadius: 9, overflow: "hidden", flexShrink: 0 }}>
      {options.map((o, i) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            role="radio"
            aria-checked={on}
            onClick={() => onPick(o.key)}
            style={{
              height: 34, padding: "0 11px", border: "none", borderLeft: i ? `1px solid ${C.bdr2}` : "none",
              background: on ? alpha(color ?? C.acc, 0.18) : C.sunken, color: on ? (color ?? C.accLight) : C.mut,
              fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type Tab = "phasen" | "befehle" | "variante" | "liefmit" | "notiz";
type Choice = "overwrite" | "new" | "keep" | "delete";

interface VariantPlan {
  /** Schluessel der Variante mit dieser (eigenen) Kurve. */
  key: number;
  name: string;
  case: SaveCase;
  /** So laeuft die Kurve nach dem Speichern. */
  engine: Engine;
  /** Skriptinhalt, der geschrieben wird (overwrite / newScript). */
  content: string | null;
  /** Name des vorhandenen Skripts (Ueberschreiben behaelt ihn). */
  title: string;
  /** Name fuer ein neues Skript — den es an der Maschine noch nicht gibt. */
  newTitle: string;
  /** Nur der Name des vorhandenen Skripts aendert sich (Inhalt gleich). */
  rename: boolean;
  /** Warnungen der Pruefung fuer das, was geschrieben wird. */
  warnings: string[];
  /** Varianten, die diese Kurve mitfahren („wie …“). */
  followers: string[];
}

export interface ProfileEditorViewProps {
  /** null = neues Profil. */
  profile: Profile | null;
  profiles: Profile[];
  scripts: XeniaScript[];
  /** Waehrend die Skripte von der Maschine kommen, wartet der Editor mit dem Laden. */
  scriptsSyncing?: boolean;
  scriptActions: Pick<UseScriptsReturn, "createScript" | "updateScript" | "deleteScript">;
  /** Speichert das Profil (anlegen oder aendern). */
  onSaveProfile: (data: ProfileCreate) => Promise<unknown>;
  onClose: () => void;
  /** Reiter „Lief mit“ (Schnitt 4): in die Historie bzw. zur Sorte — verlaesst den Editor. */
  onOpenHistory?: (filters: Partial<ShotFilters>) => void;
  onOpenCoffee?: (coffeeId: number) => void;
  /** Handy: der Kopf in Zeilen statt einer — sonst ist „Speichern“ abgeschnitten. */
  mobile?: boolean;
  /** In dieser Variante oeffnen (Klick auf das Profil im Bezugs-Detail). */
  initialVariantId?: number | null;
}

export function ProfileEditorView(props: ProfileEditorViewProps) {
  const { profile, scriptsSyncing } = props;
  const { t } = useTranslation();
  const { baskets, loaded } = useBaskets();
  // Skripte, die an der Maschine fehlen: ihr gespeicherter Stand (verwaist, aber noch in der DB).
  const [orphans, setOrphans] = useState<XeniaScript[] | null>(null);
  useEffect(() => {
    if (scriptsSyncing || orphans !== null) return;
    const ids = (profile?.variants ?? []).map((v) => v.scriptId).filter((id): id is number => id !== null && !props.scripts.some((s) => s.id === id));
    void Promise.all(ids.map((id) => fetch(`/api/scripts/${id}`).then((r) => (r.ok ? (r.json() as Promise<XeniaScript>) : null)).catch(() => null)))
      .then((list) => setOrphans(list.filter((x): x is XeniaScript => x !== null)));
  }, [scriptsSyncing, orphans, profile, props.scripts]);
  // Erst laden, wenn die Skripte frisch von der Maschine da sind — und die Siebe.
  const [initial, setInitial] = useState<Draft | null>(null);
  useEffect(() => {
    if (initial === null && !scriptsSyncing && loaded && orphans !== null) setInitial(initDraft(profile, props.scripts, baskets, orphans));
  }, [scriptsSyncing, loaded, orphans, initial, profile, props.scripts, baskets]);
  if (initial === null) {
    return <div style={{ padding: 24, color: C.mut, fontSize: 13 }}>{t("editor.loading")}</div>;
  }
  return <EditorBody {...props} initial={initial} baskets={baskets} />;
}

function EditorBody({ profile, profiles, scripts, scriptActions, onSaveProfile, onClose, onOpenHistory, onOpenCoffee, mobile = false, initialVariantId = null, initial, baskets }: ProfileEditorViewProps & { initial: Draft; baskets: Basket[] }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<Draft[]>([initial]);
  const [pos, setPos] = useState(0);
  const draft = history[pos]!;
  const commit = (next: Draft) => {
    setHistory([...history.slice(0, pos + 1), next]);
    setPos(pos + 1);
    setPreview(null);
    setPreviewSteps(null);
    setNotice(null);
  };
  const undo = () => { if (pos > 0) setPos(pos - 1); };
  const redo = () => { if (pos < history.length - 1) setPos(pos + 1); };

  const [active, setActive] = useState(() => Math.max(0, initial.variants.findIndex((v) => v.id !== null && v.id === initialVariantId)));
  const [sel, setSel] = useState(0);
  const [tab, setTab] = useState<Tab>("phasen");
  const [preview, setPreview] = useState<ParsedCmd[] | null>(null);
  /** App-Kurve: Stand waehrend des Ziehens an der Kurve. */
  const [previewSteps, setPreviewSteps] = useState<BrewStep[] | null>(null);
  const [selCmd, setSelCmd] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "save"; plans: VariantPlan[]; choice: Record<number, Choice> }
    | { kind: "conflict"; key: number; machineContent: string; choice: Record<number, Choice> }
    | { kind: "full"; choice: Record<number, Choice> }
    | { kind: "insert" } | { kind: "help" } | { kind: "discard"; then?: () => void } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  /** In diesem Editor schon angelegte Skripte je Variante — ein zweiter Speicherversuch legt sie nicht doppelt an. */
  const created = useRef(new Map<number, { content: string; id: number }>());

  // Rueckgaengig kann die aktive Variante wegnehmen — dann gilt die letzte.
  const ai = Math.min(active, draft.variants.length - 1);
  const av = draft.variants[ai]!;
  const oi = ownerOf(draft, ai);
  const cur = draft.variants[oi]!.curve;
  const isScript = cur.cmds !== null;
  const cmds = preview ?? cur.cmds;
  const proj = useMemo(() => (cmds ? projectScript(cmds) : null), [cmds]);
  // Skript: die Namen stehen neben den Befehlen (Variante), je Phasen-Index.
  const phases: Phase[] = proj ? proj.phases.map((p, i) => ({ ...p, name: cur.names[i] ?? null })) : projectSteps(previewSteps ?? cur.steps ?? []);
  const lastIdx = phases.length - 1;
  const s = Math.max(0, Math.min(sel, lastIdx));
  const ph = phases[s];
  const yieldG = av.yieldG;
  // App-Kurve: dieselbe Darstellung wie ein Skript (Schnitt 2d).
  const stepsTimeline = useMemo(() => stepsToTimeline(previewSteps ?? cur.steps ?? [], yieldG), [previewSteps, cur.steps, yieldG]);
  // Eine Zeitachse fuer alle Varianten (Flavio 22.10.): „wie Einzel“ mit anderem
  // Yield hat ein anderes geschaetztes Ende — ohne gemeinsames Ende sprang die Kurve.
  const sharedEndMs = useMemo(() => Math.max(0, ...draft.variants.map((v, i) => {
    const c = draft.variants[ownerOf(draft, i)]!.curve;
    return c.cmds !== null
      ? scriptToTimeline({ commands: c.cmds, unknownCmds: [] }).totalMs
      : stepsToTimeline(c.steps ?? [], v.yieldG).totalMs;
  })), [draft]);
  // Fluss-Achse nach dem festgehaltenen Stand — beim Ziehen steht sie still.
  const flowAxisMax = useMemo(() => {
    const m = Math.max(0, ...(cur.steps ?? []).map((st) => (st.kind === "flow" ? st.targetFlowGs : 0)));
    return [2, 3, 4, 6, 8].find((c) => c >= m * 1.3) ?? 8;
  }, [cur.steps]);

  // --- Kurve aendern --------------------------------------------------------

  /** Die Kurve von Variante i aendern („wie Variante X“ → die von X). */
  const withCurve = (d: Draft, i: number, next: Partial<CurveDraft>): Draft => {
    const o = ownerOf(d, i);
    return { ...d, variants: d.variants.map((v, k) => (k === o ? { ...v, curve: { ...v.curve, ...next } } : v)) };
  };
  const withVariant = (d: Draft, i: number, next: Partial<VariantDraft>): Draft =>
    ({ ...d, variants: d.variants.map((v, k) => (k === i ? { ...v, ...next } : v)) });
  const setCmds = (c: ParsedCmd[]) => commit(withCurve(draft, ai, { cmds: c }));
  const setSteps = (st: BrewStep[]) => commit(withCurve(draft, ai, { steps: st }));

  /** Die Kurve der aktiven Variante in App-Stufen umwandeln — die anderen laufen weiter, wie sie laufen. */
  const toApp = (d: Draft): Draft | string => {
    const c = curveOf(d, ai);
    if (!c.cmds) return d;
    const r = scriptToSteps(c.cmds);
    if (!r.ok) return t("editor.notice.appOnly", { reasons: short(r.reasons) });
    return withCurve(d, ai, { cmds: null, steps: r.value.map((st, k) => (c.names[k] ? { ...st, name: c.names[k]! } : st)) });
  };

  /** Eine Phase aendern — im Skript an genau den Befehlen, sonst an der Stufe. */
  const editPhase = (i: number, patch: Partial<Phase>) => {
    const p = phases[i];
    if (!p) return;
    const next: Phase = { ...p, ...patch };
    if (isScript && cur.cmds && Object.keys(patch).length === 1 && "name" in patch) {
      const names = fitPhaseNames(cur.names, phases.length);
      names[i] = patch.name ?? null;
      commit(withCurve(draft, ai, { names }));
      return;
    }
    if (isScript && cur.cmds) {
      const exitsOk = next.exits.length <= 1 && next.exits.every((e) => e.kind !== "pressureBelow" && e.kind !== "flowBelow" && e.kind !== "flowAbove");
      const scriptable = (next.kind === "pressure" || next.kind === "power" || next.kind === "pause")
        && next.maxPressureBar === null && next.maxFlowGs === null && !next.adoptPressure && exitsOk;
      if (scriptable) {
        let c = cur.cmds;
        if (patch.kind && patch.kind !== p.kind) c = setScriptPhaseKind(c, i, patch.kind as "pressure" | "power" | "pause");
        if (patch.target !== undefined || patch.rampS !== undefined) {
          c = setScriptPhaseValues(c, i, { target: patch.target ?? undefined, rampS: patch.rampS });
        }
        if (patch.exits) c = setScriptPhaseExit(c, i, next.exits[0] ?? null);
        if (c !== cur.cmds) setCmds(c);
        return;
      }
      // Braucht die App: Variante(n) umwandeln, dann an der Stufe aendern.
      const conv = toApp(draft);
      if (typeof conv === "string") { setNotice(conv); return; }
      const stepsNow = curveOf(conv, ai).steps!;
      const ph2 = projectSteps(stepsNow);
      ph2[i] = { ...ph2[i]!, ...patch };
      commit(withCurve(conv, ai, { steps: ph2.map(phaseToStep) }));
      return;
    }
    if (patch.exits?.some((e) => e.kind === "tempAbove")) { setNotice(t("editor.notice.tempOnlyScript")); return; }
    const list = projectSteps(cur.steps ?? []);
    list[i] = next;
    setSteps(list.map(phaseToStep));
  };

  const setKind = (k: PhaseKind) => {
    if (!ph || k === ph.kind) return;
    // „vom Puck“ gehoert zur Art (Fluss bzw. Druck) — beim Wechsel faellt es weg.
    const patch: Partial<Phase> = { kind: k, adoptFlow: undefined, adoptPressure: undefined };
    if (k === "pressure") patch.target = 9;
    if (k === "flow") patch.target = 1.4;
    if (k === "power") patch.target = 60;
    if (k === "pause" || k === "preinfusion") patch.target = null;
    if (k === "preinfusion") { patch.gentleness = "normal"; patch.fill = undefined; if (ph.exits.length === 0) patch.exits = [{ kind: "time", value: 25 }, { kind: "pressureAbove", value: 4 }]; }
    if (k !== "pressure" && k !== "power" && k !== "flow") patch.rampS = 0;
    editPhase(s, patch);
  };

  const addPhase = () => {
    if (isScript && cur.cmds) {
      const at = scriptPhaseInsertIndex(cur.cmds, s);
      const names = fitPhaseNames(cur.names, phases.length);
      names.splice(at, 0, null);
      commit(withCurve(draft, ai, { cmds: addScriptPhase(cur.cmds, s), names }));
      setSel(at);
      return;
    }
    const list = [...(cur.steps ?? [])];
    const step: BrewStep = list.length === 0 ? NEW_STEPS[0]! : { kind: "flow", targetFlowGs: 1.4, exit: {} };
    list.splice(s + 1, 0, step);
    setSteps(list);
    setSel(list.length === 1 ? 0 : s + 1);
  };
  const removePhase = () => {
    if (phases.length <= 1) return;
    if (isScript && cur.cmds) commit(withCurve(draft, ai, { cmds: removeScriptPhase(cur.cmds, s), names: fitPhaseNames(cur.names, phases.length).filter((_, k) => k !== s) }));
    else setSteps((cur.steps ?? []).filter((_, k) => k !== s));
    setSel(Math.max(0, s - 1));
  };
  const movePhase = (dir: -1 | 1) => {
    const j = s + dir;
    if (j < 0 || j > lastIdx) return;
    if (isScript && cur.cmds) {
      const names = fitPhaseNames(cur.names, phases.length);
      [names[s], names[j]] = [names[j]!, names[s]!];
      commit(withCurve(draft, ai, { cmds: moveScriptPhase(cur.cmds, s, dir), names }));
    } else {
      const list = [...(cur.steps ?? [])];
      [list[s], list[j]] = [list[j]!, list[s]!];
      setSteps(list);
    }
    setSel(j);
  };

  // --- Varianten ------------------------------------------------------------

  const pick = (i: number) => { setActive(i); setSel(0); setSelCmd(null); setPreview(null); setPreviewSteps(null); };
  const setYield = (v: number | null) => commit(withVariant(draft, ai, { yieldG: v }));
  /** Neue Variante als Kopie der aktiven: gleiche Kurve („wie …“), Sieb und Yield — Name und Sieb dann im Reiter „Variante“. */
  const addVariant = () => {
    const key = Math.min(0, ...draft.variants.map((v) => v.key)) - 1;
    const names = new Set(draft.variants.map((v) => v.name.trim().toLowerCase()));
    let n = draft.variants.length + 1;
    while (names.has(`variante ${n}`)) n++;
    const v: VariantDraft = { key, id: null, name: `Variante ${n}`, basketId: av.basketId, yieldG: av.yieldG, sameAs: draft.variants[oi]!.key, curve: NO_CURVE };
    commit({ ...draft, variants: [...draft.variants, v] });
    pick(draft.variants.length);
    setTab("variante");
  };
  /** Variante i loeschen. Fahren andere ihre Kurve mit, uebernimmt die erste sie samt Skript; die uebrigen folgen dann dieser. */
  const removeVariant = (i: number) => {
    if (draft.variants.length <= 1) return;
    const gone = draft.variants[i]!;
    const heir = draft.variants.find((v) => v.sameAs === gone.key);
    const variants = draft.variants.filter((_, k) => k !== i).map((v) => {
      if (!heir || v.sameAs !== gone.key) return v;
      return v.key === heir.key ? { ...v, sameAs: null, curve: gone.curve } : { ...v, sameAs: heir.key };
    });
    commit({ ...draft, variants });
    pick(Math.max(0, i - 1));
  };
  /** Eigene Kurve (Kopie der bisher gefahrenen) oder „wie Variante X“. */
  const setSameAs = (key: number | null) => {
    if (key === av.sameAs) return;
    if (key !== null) { commit(withVariant(draft, ai, { sameAs: key, curve: NO_CURVE })); return; }
    // Im Skript wird beim Speichern ein eigenes angelegt.
    commit(withVariant(draft, ai, { sameAs: null, curve: { ...cur, scriptId: null, baseContent: null, title: null, missing: null } }));
  };
  /** Varianten, die die Kurve der aktiven mitfahren. */
  const followers = draft.variants.filter((v) => v.sameAs === av.key);
  /** Bezug, Wartung oder Messlauf. Wartung hat weder Sieb noch Yield; der Messlauf verhaelt sich hier wie ein Bezug. */
  const setProfileKind = (k: ProfileKind) => {
    if (k === draft.kind) return;
    // Zurueck zu „Bezug“: das Sieb der ersten Variante, sonst das erste Sieb (nach id).
    const fallback = draft.variants.find((v) => v.basketId !== null)?.basketId
      ?? [...baskets].sort((a, b) => a.id - b.id)[0]?.id ?? null;
    commit({
      ...draft,
      kind: k,
      variants: draft.variants.map((v) => (k === "maintenance" ? { ...v, basketId: null, yieldG: null } : { ...v, basketId: v.basketId ?? fallback })),
    });
  };
  const maintenance = draft.kind === "maintenance";

  // --- Pruefen --------------------------------------------------------------

  /** Varianten mit eigener Kurve. */
  const owners = draft.variants.flatMap((v, i) => (v.sameAs === null ? [i] : []));
  const vname = (i: number) => t("editor.quote", { text: draft.variants[i]!.name.trim() || t("editor.variantFallback", { n: i + 1 }) });
  const la: Laufart = proj ? laufart(proj.phases, proj.markers) : laufart(phases);
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push(t("editor.problem.nameMissing"));
  if (draft.tempC !== null && (draft.tempC < 70 || draft.tempC > 110)) problems.push(t("editor.problem.temperature"));
  const seen = new Set<string>();
  draft.variants.forEach((v, i) => {
    const n = v.name.trim().toLowerCase();
    if (!n) problems.push(t("editor.problem.variantNameMissing", { n: i + 1 }));
    else if (seen.has(n)) problems.push(t("editor.problem.variantTwice", { name: vname(i) }));
    seen.add(n);
  });
  for (const i of owners) {
    const v = draft.variants[i]!.curve;
    const name = vname(i);
    if (v.cmds) {
      for (const e of validateScript({ commands: v.cmds, unknownCmds: [] }).errors) problems.push(`${name}: ${e.message}`);
      if (v.title !== null && !scriptNameOk(v.title)) problems.push(t("editor.problem.scriptName", { name }));
      const pr = projectScript(v.cmds);
      const l = laufart(pr.phases, pr.markers);
      if (l.engine === "conflict") problems.push(t("editor.problem.conflict", { name, reasons: [...l.app, ...l.script].join(", ") }));
    } else {
      const st = v.steps ?? [];
      if (st.length === 0) problems.push(t("editor.problem.noPhase", { name }));
      projectSteps(st).forEach((p, k) => {
        if (k < st.length - 1 && p.exits.length === 0) problems.push(t("editor.problem.phaseNeedsExit", { name, n: k + 1 }));
        if (p.kind === "preinfusion" && k > 0) problems.push(t("editor.problem.preinfusionFirst", { name }));
      });
      const chk = validateBrewSteps(st);
      if (!chk.ok && problems.length === 0) problems.push(`${name}: ${chk.error}`);
    }
  }
  // Wartung schaltet Ventile — das kann nur das Skript.
  if (maintenance && owners.some((i) => !draft.variants[i]!.curve.cmds)) problems.push(t("editor.problem.maintenanceScript"));
  else if (!maintenance) {
    draft.variants.forEach((v, i) => {
      // App-Varianten stoppt die Waage beim Yield — ohne Yield beendet die letzte
      // Phase den Bezug, dann braucht sie einen Ausstieg.
      const c = curveOf(draft, i);
      if (!c.cmds && !(v.yieldG !== null && v.yieldG > 0) && !endsWithoutYield(c.steps)) {
        problems.push(t("editor.problem.yieldMissing", { name: vname(i) }));
      }
    });
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  // Zurueck per Browser oder Wischgeste mit ungespeicherten Aenderungen: erst
  // fragen. „Verwerfen“ geht dann den angefangenen Weg weiter.
  const navGuard = useContext(NavGuardContext);
  useEffect(() => {
    if (!navGuard || !dirty) return;
    navGuard.setLeaveGuard((proceed) => setDialog({ kind: "discard", then: proceed }));
    return () => navGuard.setLeaveGuard(null);
  }, [navGuard, dirty]);

  // --- Speichern ------------------------------------------------------------

  /** Wer das Skript sonst faehrt: andere Profile, dazu andere Varianten hier mit eigener Kurve darauf. */
  const usersOf = (id: number | null, i: number) => (id === null ? [] : [
    ...profiles.filter((p) => p.id !== profile?.id && (p.variants ?? []).some((v) => v.scriptId === id)).map((p) => p.name),
    ...owners.filter((k) => k !== i && draft.variants[k]!.curve.scriptId === id).map(vname),
  ]);
  const followersOf = (i: number) => draft.variants.filter((v) => v.sameAs === draft.variants[i]!.key).map((v) => v.name.trim());

  /** Wie die Kurve von Variante i gespeichert wuerde — Laufart je Variante. */
  const planOf = (i: number) => {
    const c = draft.variants[i]!.curve;
    return planVariantSave({
      start: c.start,
      now: { cmds: c.cmds, steps: c.steps, scriptId: c.scriptId, baseContent: c.baseContent },
      otherUsers: usersOf(c.scriptId, i),
      otherSlot: followersOf(i).length > 0,
    });
  };
  const activePlan = planOf(oi);

  const planSave = (): VariantPlan[] => {
    const taken = new Set(scripts.map((x) => x.title));
    return owners.map((i) => {
      const v = draft.variants[i]!;
      const c = v.curve;
      const plan = planOf(i);
      const engine = plan.engine;
      let content: string | null = null;
      if (engine === "script") {
        if (c.cmds) content = text(c.cmds);
        else {
          const conv = stepsToScript(c.steps ?? []);
          if (conv.ok) content = text(conv.value);
        }
      }
      const chosen = engine === "script" && c.title !== null && c.title.trim() ? c.title.trim() : null;
      const existing = c.scriptId !== null ? scripts.find((x) => x.id === c.scriptId)?.title : undefined;
      const newTitle = freeTitle(chosen ?? machineScriptTitle(draft.name, v.name), taken);
      taken.add(newTitle);
      const title = chosen ?? existing ?? newTitle;
      const rename = plan.case.kind === "profileOnly" && engine === "script" && c.scriptId !== null && existing !== undefined && title !== existing;
      const warnings = content !== null && (plan.case.kind === "overwrite" || plan.case.kind === "newScript")
        ? validateScript(parseScript(content)).warnings.map((w) => w.message) : [];
      return { key: v.key, name: v.name.trim(), case: plan.case, engine, content, title, newTitle, rename, warnings, followers: followersOf(i) };
    });
  };

  const startSave = () => {
    setSaveErr(null);
    const plans = planSave();
    const blocked = plans.find((p) => p.case.kind === "blocked");
    if (blocked && blocked.case.kind === "blocked") { setNotice(t("editor.notice.blocked", { name: blocked.name, reasons: blocked.case.reasons.join(" · ") })); return; }
    // Nutzen andere das Skript, ist „nur hier“ vorgewählt — für alle überschreiben nur bewusst.
    const choice: Record<number, Choice> = Object.fromEntries(plans.map((p) => [
      p.key, p.case.kind === "overwrite" ? (p.case.otherUsers.length > 0 ? "new" : "overwrite") : "keep",
    ]));
    if (plans.every((p) => p.case.kind === "profileOnly")) { void runSave(plans, choice); return; }
    setDialog({ kind: "save", plans, choice });
  };

  const runSave = async (plans: VariantPlan[], choice: Record<number, Choice>) => {
    setBusy(true);
    setSaveErr(null);
    try {
      /** Je eigene Kurve das Skript nach dem Speichern; null = App. */
      const scriptOf = new Map<number, number | null>();
      const deletes: number[] = [];
      for (const p of plans) {
        const c = draft.variants.find((v) => v.key === p.key)!.curve;
        scriptOf.set(p.key, p.engine === "script" ? c.scriptId : null);
        if (p.case.kind === "newScript" || (p.case.kind === "overwrite" && choice[p.key] === "new")) {
          // Zweiter Versuch (Konflikt, voller Speicher): ein schon angelegtes Skript gleichen Inhalts weiterverwenden.
          const prev = created.current.get(p.key);
          if (prev && prev.content === p.content) { scriptOf.set(p.key, prev.id); continue; }
          let made: XeniaScript;
          try {
            made = await scriptActions.createScript(p.newTitle, p.content!);
          } catch (e) {
            if ((e as { status?: number }).status === 507) { setDialog({ kind: "full", choice }); return; }
            throw e;
          }
          created.current.set(p.key, { content: p.content!, id: made.id });
          scriptOf.set(p.key, made.id);
        } else if (p.case.kind === "overwrite") {
          try {
            await scriptActions.updateScript(p.case.scriptId, p.title, p.content!, c.baseContent ?? "");
          } catch (e) {
            // Steht schon genau diese Fassung an der Maschine (zweiter Versuch), ist nichts zu tun.
            if (e instanceof ScriptConflict && e.machineContent !== p.content) { setDialog({ kind: "conflict", key: p.key, machineContent: e.machineContent, choice }); return; }
            if (!(e instanceof ScriptConflict)) throw e;
          }
        } else if (p.case.kind === "toApp" && !p.case.stillUsed && choice[p.key] === "delete") {
          deletes.push(p.case.scriptId);
        } else if (p.rename && c.scriptId !== null && c.baseContent !== null) {
          // Nur der Name: gleicher Inhalt, neuer Titel (Konflikt-Schutz wie beim Ueberschreiben).
          await scriptActions.updateScript(c.scriptId, p.title, c.baseContent, c.baseContent);
        }
      }
      const index = new Map(draft.variants.map((v, i) => [v.key, i]));
      const variants = draft.variants.map((v): ProfileVariantInput => {
        const base = { id: v.id, name: v.name.trim(), defaultBasketId: v.basketId, yieldG: v.yieldG };
        if (v.sameAs !== null) return { ...base, scriptId: null, brewSteps: null, sameAs: index.get(v.sameAs)! };
        const scriptId = scriptOf.get(v.key) ?? null;
        if (scriptId === null) return { ...base, scriptId, brewSteps: { version: 1, steps: v.curve.steps ?? [] } };
        // Phasennamen zum Skript: aus der Variante, oder aus den App-Stufen mitgenommen.
        const phaseNames = v.curve.cmds
          ? fitPhaseNames(v.curve.names, projectScript(v.curve.cmds).phases.length)
          : projectSteps(v.curve.steps ?? []).map((p) => p.name);
        return { ...base, scriptId, brewSteps: null, phaseNames };
      });
      await onSaveProfile({
        name: draft.name.trim(),
        kind: draft.kind,
        isFavorite: draft.fav,
        isTrial: draft.trial,
        fit: draft.fit,
        targetTempC: draft.tempC,
        notes: draft.notes.trim() ? draft.notes.trim() : null,
        // Die alten Kurven-Felder leitet das Backend aus den Varianten ab.
        scriptIdSingle: null,
        variants,
      });
      for (const id of deletes) await scriptActions.deleteScript(id);
      setDialog(null);
      onClose();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // --- Darstellung ----------------------------------------------------------

  const timeline = useMemo(() => (cmds ? scriptToTimeline({ commands: cmds, unknownCmds: [] }) : null), [cmds]);
  const overridden = useMemo(() => new Set((timeline?.phases ?? []).filter((p) => p.noWait).map((p) => p.cmdIndex)), [timeline]);
  const scriptId = cur.scriptId;
  const check = useMemo(() => validateScript({ commands: cmds ?? [], unknownCmds: [] }), [cmds]);
  const engineLine = (() => {
    if (la.engine === "conflict") return { text: t("editor.engine.conflict", { app: short(la.app), script: short(la.script) }), warn: true };
    if (cur.missing !== null) return { text: t("editor.engine.missing", { id: cur.missing }), warn: true };
    if (isScript) {
      return { text: scriptId !== null ? t("editor.engine.scriptExisting", { id: scriptId }) : t("editor.engine.scriptNew"), warn: false };
    }
    if (activePlan.engine === "script") {
      return { text: cur.start.cmds !== null ? t("editor.engine.backToScript") : t("editor.engine.appToScript"), warn: false };
    }
    // Der Grund steht nur da, wenn die Kurve aus einem Skript kommt.
    const why = cur.start.cmds !== null ? short(activePlan.laufart.app) : "";
    return { text: why ? t("editor.engine.appBecause", { why }) : t("editor.engine.app"), warn: false };
  })();
  const engineChip = isScript ? t("editor.engine.chipScript") : t("editor.engine.chipApp");

  /** Preinfusion vor einer Flussphase endet, sobald der Fluss 90 % davon erreicht (pump-curve.ts). */
  const arrivalGs = (i: number): number | null => {
    const next = phases[i + 1];
    return phases[i]?.kind === "preinfusion" && next?.kind === "flow" && next.target !== null ? PREINFUSION_ARRIVAL_FRACTION * next.target : null;
  };
  const segTitle = (p: Phase, i: number) => `${i + 1} · ${p.name ?? autoLabel(p)}`;
  /** Pumpenbefehl, zu dem Phase i gehoert — beim Halten der der Phase davor (in der Kurve dieselbe Stufe). */
  const segmentPump = (i: number): number | null => {
    for (let k = i; k >= 0; k--) {
      const pi = (phases[k] as { pumpIndex?: number | null } | undefined)?.pumpIndex;
      if (pi !== undefined && pi !== null) return pi;
      if (pi === undefined) return null;
    }
    return null;
  };
  const segSub = (p: Phase, i: number) => {
    const parts: string[] = [];
    if (i === lastIdx && yieldG !== null) parts.push(t("editor.phase.yieldSub", { v: fmt(yieldG) }));
    const arrival = arrivalGs(i);
    if (arrival !== null) parts.push(`F ≥ ${fmt(arrival)} g/s`);
    p.exits.forEach((e) => {
      // Gleiches Gewicht wie der Yield in der letzten Phase ist derselbe Stopp — einmal nennen.
      if (!(i === lastIdx && e.kind === "weight" && e.value === yieldG)) parts.push(exitText(e));
    });
    // Ist die Zeit der einzige Ausstieg, ist sie die Dauer der Phase: „für 3 s“. Mit anderen Ausstiegen „oder nach 25 s“.
    if (parts.length === 1 && p.exits.length === 1 && p.exits[0]!.kind === "time") return t("editor.phase.forSeconds", { v: fmt(p.exits[0]!.value) });
    return parts.length ? parts.join(` ${t("editor.exit.or")} `) : i < lastIdx ? t("editor.phase.exitMissing") : "";
  };

  const kindOptions = (["pressure", "flow", "power", "pause", ...(s === 0 ? ["preinfusion"] : [])] as PhaseKind[])
    .map((k) => ({ key: k, label: kindLabel(k) }));

  const present = new Set(ph?.exits.map((e) => e.kind) ?? []);
  const addable = EXIT_ORDER.filter((k) => !present.has(k) && (isScript || k !== "tempAbove"));

  const variantTab = (v: VariantDraft, i: number) => {
    const on = ai === i;
    const owner = v.sameAs !== null ? draft.variants.find((x) => x.key === v.sameAs) : undefined;
    // Wartung hat keinen Yield — dann steht nur „wie …“ darunter.
    const sub = [maintenance ? null : v.yieldG !== null ? `→ ${fmt(v.yieldG)} g` : endsWithoutYield(curveOf(draft, draft.variants.indexOf(v)).steps) ? t("editor.variantTab.endsWithLast") : t("editor.variantTab.noYield"), owner ? t("editor.sameAs", { name: owner.name.trim() }) : null]
      .filter(Boolean).join(" · ");
    return (
      <button
        key={v.key}
        role="tab"
        aria-selected={on}
        onClick={() => pick(i)}
        style={{
          minWidth: 112, maxWidth: 180, flexShrink: 0, height: 40, boxSizing: "border-box", padding: "0 12px", borderRadius: 10, cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", fontFamily: "inherit",
          border: `1px solid ${on ? alpha(C.acc, 0.45) : C.bdrL}`, background: on ? C.accG : C.card,
        }}
      >
        <span style={{ ...cut, fontSize: 13, fontWeight: 600, color: on ? C.acc : C.txtS }}>{v.name.trim() || "—"}</span>
        <span style={{ ...MONO, ...cut, fontSize: 10.5, color: C.mut }}>{sub}</span>
      </button>
    );
  };

  const iconBtn = (enabled: boolean): React.CSSProperties => ({
    width: 36, height: 36, flexShrink: 0, borderRadius: 9, border: `1px solid ${C.bdrL}`, background: "transparent",
    color: enabled ? C.mut : C.dim, cursor: enabled ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center",
  });

  // Strg/Cmd+Z, Strg/Cmd+Umschalt+Z — nicht in Eingabefeldern.
  const keyRef = useRef({ undo, redo });
  keyRef.current = { undo, redo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (e.shiftKey) keyRef.current.redo(); else keyRef.current.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ein fehlendes Skript neu anzulegen ist auch ohne Aenderung ein Grund zu speichern.
  const missing = owners.some((i) => draft.variants[i]!.curve.missing !== null);
  const canSave = problems.length === 0 && la.engine !== "conflict" && !busy && (dirty || profile === null || missing);

  // Skripte ohne Profil — Kandidaten zum Aufraeumen, wenn die Maschine voll ist.
  const loose = scripts.filter((x) =>
    !profiles.some((p) => (p.variants ?? []).some((v) => v.scriptId === x.id)) && !owners.some((i) => draft.variants[i]!.curve.scriptId === x.id));
  const deleteLoose = async (id: number, title: string) => {
    if (!window.confirm(t("editor.commands.deleteLooseConfirm", { id, title }))) return;
    setBusy(true);
    setSaveErr(null);
    try { await scriptActions.deleteScript(id); } catch (e) { setSaveErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  // --- Kopf-Bausteine (Tablet eine Zeile, Handy mehrere) ----------------------
  const headRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, height: 40, flexShrink: 0 };
  const leave = () => (dirty ? setDialog({ kind: "discard" }) : onClose());
  const backBtn = (
    <button onClick={leave} aria-label={t("editor.common.back")} style={iconBtn(true)}>
      <ChevronLeft size={18} />
    </button>
  );
  const nameInput = (
    <input
      value={draft.name}
      maxLength={80}
      placeholder={t("editor.header.profileName")}
      aria-label={t("editor.header.profileName")}
      onChange={(e) => commit({ ...draft, name: e.target.value })}
      style={{ flex: mobile ? "1 1 auto" : "0 1 340px", minWidth: mobile ? 0 : 160, height: 36, boxSizing: "border-box", padding: "0 10px", borderRadius: 9, border: `1px solid ${C.bdrL}`, background: C.bg, color: C.txt, fontSize: 16, fontWeight: 700, fontFamily: "inherit", outline: "none" }}
    />
  );
  const favBtn = (
    <button aria-label={t("editor.header.favourite")} aria-pressed={draft.fav} onClick={() => commit({ ...draft, fav: !draft.fav })} style={iconBtn(true)}>
      <Star size={16} color={C.acc} fill={draft.fav ? C.acc : "none"} />
    </button>
  );
  // Versuch: nur zum Ausprobieren — angeschaltet gelb wie der Kolben in der Liste.
  const trialBtn = (
    <button
      aria-label={t("editor.header.trial")}
      aria-pressed={draft.trial}
      title={draft.trial ? t("editor.header.trialEnd") : t("editor.header.trialMark")}
      onClick={() => commit({ ...draft, trial: !draft.trial })}
      style={{ ...iconBtn(true), ...(draft.trial ? { color: C.org, background: C.orgD, border: `1px solid ${alpha(C.org, 0.45)}` } : {}) }}
    >
      <FlaskConical size={16} />
    </button>
  );
  const tempField = <TempField value={draft.tempC} onChange={(v) => commit({ ...draft, tempC: v })} />;
  const engineTag = (
    <span style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px", borderRadius: 8, border: `1px solid ${isScript ? C.bdr2 : alpha(C.blu, 0.45)}`, color: isScript ? C.txtS : C.blu }}>
      {engineChip}
    </span>
  );
  const undoBtn = <button onClick={undo} disabled={pos === 0} aria-label={t("editor.header.undo")} title={t("editor.header.undoTitle")} style={iconBtn(pos > 0)}><Undo2 size={15} /></button>;
  const redoBtn = <button onClick={redo} disabled={pos >= history.length - 1} aria-label={t("editor.header.redo")} style={iconBtn(pos < history.length - 1)}><Redo2 size={15} /></button>;
  const cancelBtn = <button onClick={leave} style={textBtn(false)}>{t("editor.common.cancel")}</button>;
  const saveBtn = <button onClick={startSave} disabled={!canSave} style={textBtn(true, canSave)}>{t("editor.common.save")}</button>;
  const kindPicker = (
    <Segmented
      label={t("editor.header.kindLabel")}
      options={[{ key: "brew", label: t("editor.header.kind.brew") }, { key: "maintenance", label: t("editor.header.kind.maintenance") }, { key: "test", label: t("editor.header.kind.test") }]}
      value={draft.kind}
      onPick={setProfileKind}
    />
  );
  const variantTabs = (!maintenance || draft.variants.length > 1) && (
    <div role="tablist" aria-label={t("editor.header.variants")} style={mobile ? { display: "contents" } : { display: "flex", gap: 8, minWidth: 0, overflowX: "auto" }}>
      {draft.variants.map((v, i) => variantTab(v, i))}
    </div>
  );
  const addVariantBtn = !maintenance && draft.variants.length < MAX_VARIANTS && (
    <button onClick={addVariant} title={t("editor.header.addVariantTitle")} style={{ ...textBtn(false), borderStyle: "dashed" }}><Plus size={13} /> {t("editor.header.addVariant")}</button>
  );
  const yieldField = !maintenance && <YieldField value={yieldG} onChange={setYield} />;

  return (
    // Tablet: ein festes Fenster, nur der Reiter-Inhalt scrollt. Handy: eine normale
    // Seite — quer blieben dem Reiter-Inhalt sonst 34 px (iPhone, 402 px hoch).
    <div style={mobile ? { display: "flex", flexDirection: "column", gap: 6 } : { display: "flex", flexDirection: "column", gap: 6, height: "calc(100dvh - 32px)", minHeight: 520 }}>
      {/* Kopf — auf dem Handy in Zeilen: Name und Speichern, dann Temperatur und
          Rueckgaengig, dann Art und Yield, dann die Varianten. „Abbrechen“ macht
          dort der Zurueck-Pfeil (derselbe Weg). */}
      {mobile ? (
        <>
          <div style={headRow}>{backBtn}{nameInput}{favBtn}{trialBtn}{saveBtn}</div>
          <div style={headRow}>{tempField}{engineTag}<span style={{ flex: 1 }} />{undoBtn}{redoBtn}</div>
        </>
      ) : (
        <div style={headRow}>
          {backBtn}{nameInput}{favBtn}{trialBtn}{tempField}
          <span style={{ flex: 1 }} />
          {engineTag}{undoBtn}{redoBtn}{cancelBtn}{saveBtn}
        </div>
      )}

      {/* Art und Varianten — Wartung ohne Sieb, Yield und weitere Varianten */}
      {mobile ? (
        <>
          {/* Drei Arten passen mit dem Yield nicht in eine Handy-Zeile — dann bricht der Yield um. */}
          <div style={{ ...headRow, height: "auto", minHeight: 40, flexWrap: "wrap", rowGap: 6 }}>{kindPicker}<span style={{ flex: 1 }} />{yieldField}</div>
          {/* Reiter brechen um statt seitlich zu schieben — sonst lag die dritte Variante unsichtbar rechts. */}
          {(variantTabs || addVariantBtn) && <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>{variantTabs}{addVariantBtn}</div>}
        </>
      ) : (
        <div style={headRow}>
          {kindPicker}{variantTabs}{addVariantBtn}
          <span style={{ flex: 1 }} />
          {yieldField}
        </div>
      )}

      {/* Kurve + Phasenleiste */}
      <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: "6px 10px 8px", flexShrink: 0 }}>
        {isScript && cmds && timeline ? (
          <ScriptCurveEditor
            cmds={cmds}
            timeline={timeline}
            selected={segmentPump(s)}
            onSelect={(ci) => {
              if (ci === null || !proj) return;
              const k = proj.phases.findIndex((p) => p.pumpIndex === ci);
              if (k >= 0) setSel(k);
              setSelCmd(ci);
            }}
            onPreview={setPreview}
            onCommit={(c) => { setPreview(null); setCmds(c); }}
            height={170}
            xEndMs={sharedEndMs}
          />
        ) : (
          <CurveEditor
            value={cur.steps ?? []}
            edit={stepsCurveEdit}
            timeline={stepsTimeline}
            selected={s}
            onSelect={(k) => { if (k !== null) setSel(k); }}
            onPreview={setPreviewSteps}
            onCommit={(st) => { setPreviewSteps(null); setSteps(st); }}
            height={170}
            flowMax={flowAxisMax}
            approxEnd
            xEndMs={sharedEndMs}
          />
        )}
        <div role="tablist" aria-label={t("editor.phase.tablist")} style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {phases.map((p, i) => {
            const on = i === s;
            const sub = segSub(p, i);
            return (
              <button
                key={i}
                role="tab"
                aria-selected={on}
                onClick={() => { setSel(i); setTab("phasen"); }}
                style={{
                  flex: 1, minWidth: 0, height: 44, boxSizing: "border-box", padding: "0 9px", borderRadius: 8, cursor: "pointer",
                  display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-start", gap: 2, overflow: "hidden",
                  border: `1px solid ${on ? alpha(C.acc, 0.55) : C.bdrL}`, background: on ? alpha(C.acc, 0.14) : C.sunken, textAlign: "left", fontFamily: "inherit",
                }}
              >
                <span style={{ ...MONO, ...cut, fontSize: 11.5, fontWeight: 600, color: KIND_COLOR[p.kind] }}>
                  {p.tone && <Bell size={10} style={{ marginRight: 4, verticalAlign: -1 }} />}
                  {segTitle(p, i)}
                </span>
                <span style={{ ...MONO, ...cut, fontSize: 10.5, color: sub === t("editor.phase.exitMissing") ? C.red : C.mut }}>{sub}</span>
              </button>
            );
          })}
          <button onClick={addPhase} aria-label={t("editor.phase.add")} style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, border: `1px dashed ${C.bdr3}`, background: "transparent", color: C.mut, fontSize: 18, cursor: "pointer" }}>+</button>
        </div>
      </div>

      {/* Laufart und Pruefung */}
      <div style={{ minHeight: 16, fontSize: 12, color: engineLine.warn || problems.length || notice ? C.red : C.mut, flexShrink: 0, lineHeight: 1.35 }}>
        {notice ?? (problems.length ? problems.join(" · ") : engineLine.text)}
      </div>

      {/* Reiter */}
      <div role="tablist" aria-label={t("editor.tabs.aria")} style={{ display: "flex", gap: 4, height: 34, flexShrink: 0, borderBottom: `1px solid ${C.bdr}`, ...(mobile ? { overflowX: "auto" as const } : {}) }}>
        {([["phasen", t("editor.tabs.phases")], ["befehle", t("editor.tabs.commands")], ["variante", t("editor.tabs.variant")], ...(profile && !maintenance ? [["liefmit", t("editor.tabs.ranWith")]] : []), ["notiz", t("editor.tabs.note")]] as [Tab, string][]).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            style={{ height: 34, padding: mobile ? "0 9px" : "0 14px", flexShrink: 0, whiteSpace: "nowrap", border: "none", borderBottom: `2px solid ${tab === k ? C.acc : "transparent"}`, background: "transparent", color: tab === k ? C.txt : C.mut, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
          >
            {l}
          </button>
        ))}
      </div>

      <div style={mobile ? undefined : { flex: 1, minHeight: 0, overflowY: "auto" }}>
        {tab === "phasen" && ph && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 36, flexWrap: "wrap" }}>
              <>
                <input
                  value={ph.name ?? ""}
                  placeholder={autoLabel(ph)}
                  maxLength={40}
                  aria-label={t("editor.phase.name")}
                  onChange={(e) => editPhase(s, { name: e.target.value.trim() ? e.target.value : null })}
                  style={{ width: 190, height: 34, boxSizing: "border-box", padding: "0 10px", borderRadius: 8, border: `1px solid ${C.bdrL}`, background: C.bg, color: C.txt, fontSize: 14, fontWeight: 600, fontFamily: "inherit", outline: "none" }}
                />
                <span style={{ fontSize: 10, color: C.mut, border: `1px solid ${C.bdr2}`, borderRadius: 5, padding: "1px 5px" }}>{ph.name ? "✎" : t("editor.phase.auto")}</span>
              </>
              {/* Auf schmalen Handys passt die Auswahl nicht: dann eigene Zeile, notfalls seitlich wischen. */}
              <div style={{ maxWidth: "100%", minWidth: 0, overflowX: "auto" }}>
                <Segmented label={t("editor.phase.kindLabel")} options={kindOptions} value={ph.kind} onPick={setKind} />
              </div>
              <span style={{ flex: 1 }} />
              {/* Nur in der App: im Skript piept die Maschine selbst (Befehl „Signalton“). */}
              {!isScript && activePlan.engine === "app" && (
                <button
                  onClick={() => editPhase(s, { tone: ph.tone ? undefined : true })}
                  aria-pressed={!!ph.tone}
                  aria-label={t("editor.phase.tone")}
                  title={t("editor.phase.tone")}
                  style={ph.tone ? { ...iconBtn(true), color: C.acc, borderColor: alpha(C.acc, 0.55), background: alpha(C.acc, 0.14) } : iconBtn(true)}
                >
                  <Bell size={15} fill={ph.tone ? C.acc : "none"} />
                </button>
              )}
              <button onClick={() => movePhase(-1)} disabled={s === 0} aria-label={t("editor.phase.moveEarlier")} style={iconBtn(s > 0)}><ChevronLeft size={15} /></button>
              <button onClick={() => movePhase(1)} disabled={s >= lastIdx} aria-label={t("editor.phase.moveLater")} style={iconBtn(s < lastIdx)}><ChevronRight size={15} /></button>
              <button onClick={removePhase} disabled={phases.length <= 1} aria-label={t("editor.phase.remove")} style={iconBtn(phases.length > 1)}><Trash2 size={14} /></button>
            </div>

            <div style={{ display: "flex", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
              {ph.kind === "pressure" && (
                <>
                  {/* Decent HOLD-P: das Ziel beim Eintritt vom Puck uebernehmen — braucht eine Phase davor. */}
                  {s > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={labelWithHelp}>{t("editor.phase.pressureTarget")} <FieldHelp lines={[
                        t("editor.help.pressureTarget.fixed"),
                        t("editor.help.pressureTarget.adopt"),
                        t("editor.help.pressureTarget.forCurve"),
                        t("editor.help.pressureTarget.fallback"),
                      ]} /></span>
                      <Segmented
                        label={t("editor.phase.pressureTarget")}
                        options={[{ key: "fix", label: t("editor.phase.fixed") }, { key: "adopt", label: t("editor.phase.adopt") }]}
                        value={ph.adoptPressure ? "adopt" : "fix"}
                        color={C.seriesPressure}
                        onPick={(k) => editPhase(s, { adoptPressure: k === "adopt" ? true : undefined })}
                      />
                    </div>
                  )}
                  <NumberStepper label={ph.adoptPressure && s > 0 ? t("editor.phase.forCurve") : t("editor.phase.target")} value={ph.target} unit="bar" step={0.1} min={0.1} max={12} color={C.seriesPressure} onChange={(v) => editPhase(s, { target: v ?? 9 })} />
                  <NumberStepper label={t("editor.phase.rampOver")} value={ph.rampS} unit="s" step={0.5} min={0} max={120} onChange={(v) => editPhase(s, { rampS: v ?? 0 })} />
                  <NumberStepper label={t("editor.phase.maxFlow")} value={ph.maxFlowGs} unit="g/s" step={0.1} min={0.1} max={8} nullable onChange={(v) => editPhase(s, { maxFlowGs: v })} />
                </>
              )}
              {ph.kind === "flow" && (
                <>
                  {/* Gagne: das Ziel beim Eintritt vom Puck uebernehmen — braucht eine Phase davor. */}
                  {s > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={labelWithHelp}>{t("editor.phase.flowTarget")} <FieldHelp lines={[
                        t("editor.help.flowTarget.fixed"),
                        t("editor.help.flowTarget.adopt"),
                        t("editor.help.flowTarget.forCurve"),
                        t("editor.help.flowTarget.fallback"),
                      ]} /></span>
                      <Segmented
                        label={t("editor.phase.flowTarget")}
                        options={[{ key: "fix", label: t("editor.phase.fixed") }, { key: "adopt", label: t("editor.phase.adopt") }]}
                        value={ph.adoptFlow ? "adopt" : "fix"}
                        color={C.seriesFlow}
                        onPick={(k) => editPhase(s, { adoptFlow: k === "adopt" ? true : undefined })}
                      />
                    </div>
                  )}
                  <NumberStepper label={ph.adoptFlow && s > 0 ? t("editor.phase.forCurve") : t("editor.phase.target")} value={ph.target} unit="g/s" step={0.1} min={0.1} max={8} color={C.seriesFlow} onChange={(v) => editPhase(s, { target: v ?? 1.4 })} />
                  <NumberStepper label={t("editor.phase.rampOver")} value={ph.rampS} unit="s" step={0.5} min={0} max={120} onChange={(v) => editPhase(s, { rampS: v ?? 0 })} />
                  <NumberStepper label={t("editor.phase.maxPressure")} value={ph.maxPressureBar} unit="bar" step={0.5} min={0.5} max={12} nullable onChange={(v) => editPhase(s, { maxPressureBar: v })} />
                </>
              )}
              {ph.kind === "power" && (
                <>
                  <NumberStepper label={t("editor.phase.target")} value={ph.target} unit="%" step={1} min={0} max={100} color={C.seriesPower} onChange={(v) => editPhase(s, { target: v ?? 60 })} />
                  <NumberStepper label={t("editor.phase.rampOver")} value={ph.rampS} unit="s" step={0.5} min={0} max={120} onChange={(v) => editPhase(s, { rampS: v ?? 0 })} />
                  <NumberStepper label={t("editor.phase.maxPressure")} value={ph.maxPressureBar} unit="bar" step={0.5} min={0.5} max={12} nullable onChange={(v) => editPhase(s, { maxPressureBar: v })} />
                  <NumberStepper label={t("editor.phase.maxFlow")} value={ph.maxFlowGs} unit="g/s" step={0.1} min={0.1} max={8} nullable onChange={(v) => editPhase(s, { maxFlowGs: v })} />
                </>
              )}
              {ph.kind === "preinfusion" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={labelWithHelp}>{t("editor.phase.fill")} <FieldHelp lines={[
                    t("editor.help.fill.line1"),
                    t("editor.help.fill.line2"),
                  ]} /></span>
                  {/* normal wird nicht gespeichert — so bleibt der Hash bestehender Profile gleich. */}
                  <Segmented label={t("editor.phase.fill")} options={fillOptions()} value={ph.fill ?? "normal"} color={C.seriesPower} onPick={(f) => editPhase(s, { fill: f === "fast" ? "fast" : undefined })} />
                </div>
              )}
              {ph.kind === "preinfusion" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={labelWithHelp}>{t("editor.phase.gentleness")} <FieldHelp lines={[
                    t("editor.help.gentleness.line1"),
                    t("editor.help.gentleness.line2"),
                    t("editor.help.gentleness.line3"),
                    t("editor.help.gentleness.line4"),
                  ]} /></span>
                  <Segmented label={t("editor.phase.gentleness")} options={gentleOptions()} value={ph.gentleness ?? "normal"} color={C.seriesPower} onPick={(g) => editPhase(s, { gentleness: g })} />
                </div>
              )}
              <span style={{ paddingBottom: 9, fontSize: 12, color: C.mut }}>
                {ph.kind === "pause" ? t("editor.phase.pauseHint")
                  : ph.kind === "preinfusion" ? (arrivalGs(s) !== null ? t("editor.phase.arrivalHint") : t("editor.phase.pressureNextHint"))
                  : ""}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={fieldLabel}>{t("editor.exit.label")}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 32 }}>
                {s === lastIdx && yieldG !== null && (
                  <span style={{ ...chip, borderColor: alpha(C.grn, 0.45), color: C.grn, background: alpha(C.grn, 0.08), fontWeight: 600 }}>{t("editor.exit.yieldChip", { v: fmt(yieldG) })}</span>
                )}
                {arrivalGs(s) !== null && <span style={{ ...chip, color: C.org, borderColor: alpha(C.org, 0.45) }}>F ≥ {fmt(arrivalGs(s)!)} g/s</span>}
                {ph.exits.map((e, k) => (
                  <ExitChip
                    key={`${e.kind}-${k}`}
                    exit={e}
                    or={k > 0 || s === lastIdx || arrivalGs(s) !== null}
                    onChange={(v) => editPhase(s, { exits: ph.exits.map((x, m) => (m === k ? { ...x, value: v } : x)) })}
                    onRemove={() => editPhase(s, { exits: ph.exits.filter((_, m) => m !== k) })}
                  />
                ))}
                {s < lastIdx && ph.exits.length === 0 && ph.kind !== "preinfusion" && <span style={{ fontSize: 12, color: C.red }}>{t("editor.exit.missing")}</span>}
                {addable.length > 0 && (
                  <select
                    value=""
                    aria-label={t("editor.exit.addCondition")}
                    onChange={(e) => {
                      const k = e.target.value as ExitKind;
                      if (k) editPhase(s, { exits: [...ph.exits, { kind: k, value: exitMeta(k).def }] });
                    }}
                    style={{ height: 30, padding: "0 6px", borderRadius: 7, border: `1px dashed ${C.bdr3}`, background: "transparent", color: C.mut, fontSize: 12, fontFamily: "inherit" }}
                  >
                    <option value="">{t("editor.exit.addConditionOption")}</option>
                    {addable.map((k) => <option key={k} value={k}>{exitMeta(k).add}</option>)}
                  </select>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "befehle" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {isScript && (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={fieldLabel}>{t("editor.commands.scriptName")}</span>
                  <input
                    value={cur.title ?? ""}
                    maxLength={40}
                    placeholder={machineScriptTitle(draft.name, draft.variants[oi]!.name)}
                    aria-label={t("editor.commands.scriptName")}
                    onChange={(e) => commit(withCurve(draft, ai, { title: e.target.value === "" && cur.scriptId === null ? null : e.target.value }))}
                    style={{ width: 260, height: 34, boxSizing: "border-box", padding: "0 10px", borderRadius: 8, border: `1px solid ${cur.title !== null && !scriptNameOk(cur.title) ? C.red : C.bdrL}`, background: C.bg, color: C.txt, fontSize: 13, fontFamily: "inherit", outline: "none" }}
                  />
                </div>
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 34 }}>
              {isScript ? (
                <>
                  <span style={{ fontSize: 12.5, color: C.txtS }}>
                    {scriptId !== null ? t("editor.commands.scriptLabel", { id: scriptId, title: scripts.find((x) => x.id === scriptId)?.title ?? "?" }) : t("editor.commands.newScript")}
                  </span>
                  <span style={{ fontSize: 11.5, color: C.mut }}>
                    {(() => { const u = usersOf(scriptId, oi); return u.length ? t("editor.commands.alsoUsedBy", { list: u.join(", ") }) : t("editor.commands.onlyThisProfile"); })()}
                  </span>
                </>
              ) : (
                <span style={{ fontSize: 12.5, color: C.txtS }}>{t("editor.commands.runsInApp")}</span>
              )}
              <span style={{ flex: 1 }} />
              <select
                value=""
                aria-label={isScript ? t("editor.commands.chooseOther") : t("editor.commands.choose")}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  const sc = scripts.find((x) => x.id === id);
                  if (!sc) return;
                  commit(withCurve(draft, ai, { scriptId: id, baseContent: sc.content, cmds: parseScript(sc.content).commands, steps: null, title: sc.title, names: [], missing: null }));
                }}
                style={{ height: 30, padding: "0 6px", borderRadius: 7, border: `1px solid ${C.bdr2}`, background: C.sunken, color: C.txtS, fontSize: 12, fontFamily: "inherit" }}
              >
                <option value="">{isScript ? t("editor.commands.chooseOtherOption") : t("editor.commands.chooseOption")}</option>
                {scripts.filter((x) => x.id !== scriptId).map((x) => <option key={x.id} value={x.id}>{x.title} (#{x.id})</option>)}
              </select>
              {isScript && <button onClick={() => setDialog({ kind: "insert" })} style={textBtn(false)}><Plus size={13} /> {selCmd !== null ? t("editor.commands.insertAfter") : t("editor.commands.insert")}</button>}
              <button onClick={() => setDialog({ kind: "help" })} style={textBtn(false)}>{t("editor.commands.howScriptsRun")}</button>
            </div>
            {!isScript && (
              <p style={{ margin: "4px 0 0", fontSize: 13, color: C.mut, lineHeight: 1.45 }}>
                {t("editor.commands.appOnlyHint")}
              </p>
            )}
            {isScript && cmds && (check.errors.length > 0 || check.warnings.length > 0 || overridden.size > 0) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 12px", borderRadius: 10, border: `1px solid ${C.bdr}`, background: C.card }}>
                {check.errors.map((e) => <div key={e.code} style={{ fontSize: 12.5, color: C.red }}>✕ {e.message}</div>)}
                {check.warnings.map((w) => <div key={w.code} style={{ fontSize: 12.5, color: C.org }}>⚠ {w.message}</div>)}
                {overridden.size > 0 && <div style={{ fontSize: 12.5, color: C.org }}>⚠ {t("editor.commands.overriddenWarning")}</div>}
              </div>
            )}
            {isScript && cmds && (
              <ScriptCommandList
                cmds={cmds}
                selected={selCmd}
                overridden={overridden}
                onSelect={setSelCmd}
                onArg={(i, a, raw) => setCmds(setArg(cmds, i, a, raw))}
                onMove={(from, to) => { setCmds(moveCmd(cmds, from, to)); setSelCmd(to); }}
                onRemove={(i) => { setCmds(removeCmd(cmds, i)); setSelCmd(null); }}
              />
            )}
          </div>
        )}

        {tab === "variante" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={fieldLabel}>{t("editor.variant.name")}</span>
                <input
                  value={av.name}
                  maxLength={40}
                  aria-label={t("editor.variant.nameAria")}
                  onChange={(e) => commit(withVariant(draft, ai, { name: e.target.value }))}
                  style={{ width: 190, height: 34, boxSizing: "border-box", padding: "0 10px", borderRadius: 8, border: `1px solid ${av.name.trim() ? C.bdrL : C.red}`, background: C.bg, color: C.txt, fontSize: 14, fontWeight: 600, fontFamily: "inherit", outline: "none" }}
                />
              </div>
              {!maintenance && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={fieldLabel}>{t("editor.variant.basket")}</span>
                  <select
                    value={av.basketId ?? ""}
                    aria-label={t("editor.variant.basket")}
                    onChange={(e) => commit(withVariant(draft, ai, { basketId: e.target.value === "" ? null : Number(e.target.value) }))}
                    style={selectStyle}
                  >
                    {av.basketId === null && <option value="">—</option>}
                    {baskets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={fieldLabel}>{t("editor.variant.curve")}</span>
                <select
                  value={av.sameAs ?? ""}
                  aria-label={t("editor.variant.curveAria")}
                  disabled={followers.length > 0}
                  onChange={(e) => setSameAs(e.target.value === "" ? null : Number(e.target.value))}
                  style={selectStyle}
                >
                  <option value="">{t("editor.variant.ownCurve")}</option>
                  {draft.variants.filter((x, k) => k !== ai && x.sameAs === null).map((x) => (
                    <option key={x.key} value={x.key}>{t("editor.sameAs", { name: x.name.trim() || "—" })}</option>
                  ))}
                </select>
              </div>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => removeVariant(ai)}
                disabled={draft.variants.length <= 1}
                style={{ ...textBtn(false, draft.variants.length > 1), color: draft.variants.length > 1 ? C.red : C.dim }}
              >
                <Trash2 size={13} /> {t("editor.variant.remove")}
              </button>
            </div>
            {followers.length > 0 && (
              <span style={{ fontSize: 12, color: C.mut }}>
                {(() => {
                  const names = followers.map((f) => t("editor.quote", { text: f.name.trim() })).join(", ");
                  return followers.length === 1 ? t("editor.variant.followsOne", { names }) : t("editor.variant.followsMany", { names });
                })()}
              </span>
            )}
          </div>
        )}

        {tab === "liefmit" && profile && (
          <ProfileRanWith
            profileId={profile.id}
            variantId={av.id}
            variantName={av.name.trim()}
            // Verlaesst den Editor — mit ungespeicherten Aenderungen nur nach Rueckfrage.
            onOpenHistory={onOpenHistory && ((f) => { if (!dirty || window.confirm(t("editor.dialog.discard.title"))) onOpenHistory(f); })}
            onOpenCoffee={onOpenCoffee && ((id) => { if (!dirty || window.confirm(t("editor.dialog.discard.title"))) onOpenCoffee(id); })}
          />
        )}

        {tab === "notiz" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Einordnung: mehrere moeglich (ein Profil kann fuer dunkel und hell passen). */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={fieldLabel}>{t("editor.fit.label")}</span>
              <div role="group" aria-label={t("editor.fit.label")} style={{ display: "inline-flex", border: `1px solid ${C.bdr2}`, borderRadius: 9, overflow: "hidden" }}>
                {PROFILE_FITS.map((f, i) => {
                  const on = draft.fit.includes(f);
                  return (
                    <button
                      key={f}
                      aria-pressed={on}
                      onClick={() => commit({ ...draft, fit: PROFILE_FITS.filter((x) => (x === f ? !on : draft.fit.includes(x))) })}
                      style={{
                        padding: "6px 12px", border: "none", borderLeft: i > 0 ? `1px solid ${C.bdr2}` : "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
                        background: on ? C.accG2 : "transparent", color: on ? C.acc : C.mut,
                      }}
                    >
                      {t(`editor.fit.${f}`)}
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              value={draft.notes}
              aria-label={t("editor.note.aria")}
              placeholder={t("editor.note.placeholder")}
              onChange={(e) => commit({ ...draft, notes: e.target.value })}
              style={{ width: "100%", height: 130, boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.bdr2}`, background: C.bg, color: C.txt, fontSize: 13, fontFamily: "inherit", lineHeight: 1.45, resize: "none", outline: "none" }}
            />
          </div>
        )}
      </div>

      {dialog && (
        <Modal onClose={() => { if (!busy) setDialog(null); }}>
          {dialog.kind === "insert" && cmds && (
            <InsertMenu onPick={(cmd) => {
              const { last } = editableRange(cmds);
              const at = selCmd !== null && selCmd <= last ? selCmd + 1 : defaultInsertIndex(cmds);
              const r = insertWithWait(cmds, at, makeCmd(cmd, defaultArgs(cmd)));
              setCmds(r.cmds);
              setSelCmd(r.index);
              setDialog(null);
            }} />
          )}
          {dialog.kind === "help" && (
            <>
              <h3 style={modalTitle}>{t("editor.commands.howScriptsRun")}</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55, color: C.txtS }}>
                {SCRIPT_MODEL_HELP.map((t, i) => <li key={i} style={{ marginBottom: 6 }}>{t}</li>)}
              </ul>
            </>
          )}
          {dialog.kind === "discard" && (
            <>
              <h3 style={modalTitle}>{t("editor.dialog.discard.title")}</h3>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setDialog(null)} style={textBtn(false)}>{t("editor.dialog.discard.keep")}</button>
                <button onClick={() => { const next = dialog.then; setDialog(null); if (next) next(); else onClose(); }} style={{ ...textBtn(false), color: C.red, borderColor: C.red }}>{t("editor.dialog.discard.discard")}</button>
              </div>
            </>
          )}
          {dialog.kind === "full" && (
            <>
              <h3 style={modalTitle}>{t("editor.dialog.full.title")}</h3>
              <p style={modalText}>
                {t("editor.dialog.full.text")}
                {" "}{loose.length > 0 ? t("editor.dialog.full.deleteLoose") : t("editor.dialog.full.noLoose")}
              </p>
              {loose.map((x) => (
                <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 36 }}>
                  <span style={{ flex: 1, fontSize: 13, color: C.txtS }}>{t("editor.dialog.full.looseItem", { id: x.id, title: x.title })}</span>
                  <button onClick={() => void deleteLoose(x.id, x.title)} disabled={busy} style={{ ...textBtn(false, !busy), color: C.red }}><Trash2 size={13} /> {t("editor.common.delete")}</button>
                </div>
              ))}
              {saveErr && <div style={{ fontSize: 12.5, color: C.red }}>{saveErr}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <button onClick={() => setDialog(null)} disabled={busy} style={textBtn(false)}>{t("editor.common.back")}</button>
                <button onClick={() => void runSave(planSave(), dialog.choice)} disabled={busy} style={textBtn(true, !busy)}>{t("editor.dialog.full.retry")}</button>
              </div>
            </>
          )}
          {dialog.kind === "conflict" && (
            <>
              <h3 style={modalTitle}>{t("editor.dialog.conflict.title")}</h3>
              <p style={modalText}>
                {t("editor.dialog.conflict.text")}
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button
                  onClick={() => {
                    const i = draft.variants.findIndex((v) => v.key === dialog.key);
                    commit(withCurve(draft, i, { baseContent: dialog.machineContent, cmds: parseScript(dialog.machineContent).commands }));
                    setDialog(null);
                  }}
                  style={textBtn(false)}
                >
                  {t("editor.dialog.conflict.loadMachine")}
                </button>
                <button
                  onClick={() => {
                    void runSave(planSave(), { ...dialog.choice, [dialog.key]: "new" });
                  }}
                  style={textBtn(true, true)}
                >
                  {t("editor.dialog.conflict.mineAsNew")}
                </button>
              </div>
            </>
          )}
          {dialog.kind === "save" && (
            <SaveDialog
              plans={dialog.plans}
              choice={dialog.choice}
              busy={busy}
              error={saveErr}
              onChoice={(key, c) => setDialog({ ...dialog, choice: { ...dialog.choice, [key]: c } })}
              onCancel={() => setDialog(null)}
              onConfirm={() => void runSave(dialog.plans, dialog.choice)}
            />
          )}
        </Modal>
      )}
      {saveErr && !dialog && <div style={{ fontSize: 12, color: C.red }}>{saveErr}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kleinteile
// ---------------------------------------------------------------------------

/** Einzeilig, zu lang endet mit „…“ statt mitten im Wort. */
const cut: React.CSSProperties = { maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

const chip: React.CSSProperties = {
  height: 30, boxSizing: "border-box", display: "inline-flex", alignItems: "center", gap: 4, padding: "0 9px",
  borderRadius: 7, border: `1px solid ${C.bdr2}`, background: C.card, color: C.txtS, fontSize: 12, ...MONO,
};

const selectStyle: React.CSSProperties = {
  height: 34, padding: "0 8px", borderRadius: 8, border: `1px solid ${C.bdr2}`, background: C.sunken, color: C.txtS, fontSize: 13, fontFamily: "inherit",
};

function textBtn(primary: boolean, enabled = true): React.CSSProperties {
  return {
    height: 36, padding: "0 12px", borderRadius: 9, display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
    border: `1px solid ${primary && enabled ? alpha(C.acc, 0.35) : C.bdr2}`,
    background: primary && enabled ? C.accG2 : "transparent",
    color: primary ? (enabled ? C.accLight : C.dim) : C.txtS,
    fontSize: 13, fontWeight: primary ? 600 : 500, fontFamily: "inherit", cursor: enabled ? "pointer" : "default",
  };
}

function ExitChip({ exit, or, onChange, onRemove }: { exit: PhaseExit; or: boolean; onChange: (v: number) => void; onRemove: () => void }) {
  const m = exitMeta(exit.kind);
  const [txt, setTxt] = useState(fmt(exit.value));
  useEffect(() => { setTxt(fmt(exit.value)); }, [exit.value]);
  const commit = () => {
    const n = Number(txt.replace(",", "."));
    if (Number.isFinite(n) && n > 0 && r2(n) !== exit.value) onChange(r2(n));
    else setTxt(fmt(exit.value));
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {or && <span style={{ fontSize: 11, color: C.mut }}>{t("editor.exit.or")}</span>}
      <span style={{ ...chip, paddingRight: 2 }}>
        {m.pre}
        <input
          value={txt}
          inputMode="decimal"
          aria-label={m.add}
          onChange={(e) => setTxt(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={{ width: 44, height: 24, boxSizing: "border-box", padding: "0 4px", border: "none", borderRadius: 5, background: C.bg, color: C.txt, fontSize: 12, fontWeight: 600, textAlign: "right", ...MONO, outline: "none" }}
        />
        {m.unit}
        <button onClick={onRemove} aria-label={t("editor.exit.remove", { label: m.add })} style={{ width: 24, height: 24, border: "none", background: "transparent", color: C.mut, cursor: "pointer", fontSize: 14 }}>×</button>
      </span>
    </span>
  );
}

function TempField({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [txt, setTxt] = useState(value === null ? "" : dec(value.toFixed(1)));
  useEffect(() => { setTxt(value === null ? "" : dec(value.toFixed(1))); }, [value]);
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 36, padding: "0 8px", borderRadius: 9, border: `1px solid ${C.bdrL}`, color: C.mut, fontSize: 12 }}>
      <input
        value={txt}
        inputMode="decimal"
        placeholder="—"
        aria-label={t("editor.header.temp")}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => {
          const reset = () => setTxt(value === null ? "" : dec(value.toFixed(1)));
          if (txt.trim() === "") { if (value !== null) onChange(null); else reset(); return; }
          const n = Number(txt.replace(",", "."));
          const v = Math.round(n * 10) / 10;
          if (Number.isFinite(n) && v !== value) onChange(v); else reset();
        }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ width: 44, border: "none", background: "transparent", color: C.txt, fontSize: 13, textAlign: "right", ...MONO, outline: "none" }}
      />
      °C
    </label>
  );
}

function YieldField({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={fieldLabel}>{t("editor.header.yield")}</span>
      <NumberStepperInline value={value} onChange={onChange} />
    </div>
  );
}

function NumberStepperInline({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [txt, setTxt] = useState(value === null ? "" : fmt(value));
  useEffect(() => { setTxt(value === null ? "" : fmt(value)); }, [value]);
  const btn: React.CSSProperties = { width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.bdr2}`, background: C.sunken, color: C.txtS, fontSize: 16, cursor: "pointer", fontFamily: "inherit" };
  const set = (n: number | null) => {
    const v = n === null ? null : Math.max(1, r2(n));
    if (v !== value) onChange(v); else setTxt(value === null ? "" : fmt(value));
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button type="button" aria-label={t("editor.stepper.decrease", { label: t("editor.header.yield") })} onClick={() => set((value ?? 1) - 0.5)} style={btn}>−</button>
      <input
        value={txt}
        inputMode="decimal"
        placeholder="—"
        aria-label={t("editor.header.yield")}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => {
          if (txt.trim() === "") { set(null); return; }
          const n = Number(txt.replace(",", "."));
          if (Number.isFinite(n) && n > 0) set(n); else setTxt(value === null ? "" : fmt(value));
        }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ width: 54, height: 34, boxSizing: "border-box", textAlign: "center", borderRadius: 8, border: `1px solid ${C.bdr2}`, background: C.bg, color: C.txt, fontSize: 14, fontWeight: 600, ...MONO, outline: "none" }}
      />
      <span style={{ fontSize: 11, color: C.mut }}>g</span>
      <button type="button" aria-label={t("editor.stepper.increase", { label: t("editor.header.yield") })} onClick={() => set((value ?? 0) + 0.5)} style={btn}>+</button>
    </span>
  );
}

function SaveDialog({ plans, choice, busy, error, onChoice, onCancel, onConfirm }: {
  plans: VariantPlan[];
  choice: Record<number, Choice>;
  busy: boolean;
  error: string | null;
  onChoice: (key: number, c: Choice) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const radio = (key: number, value: Choice, label: string) => (
    <label key={value} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.txtS, cursor: "pointer", minHeight: 30 }}>
      <input type="radio" name={`save-${key}`} checked={choice[key] === value} onChange={() => onChoice(key, value)} />
      {label}
    </label>
  );
  return (
    <>
      <h3 style={modalTitle}>{t("editor.common.save")}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {plans.filter((p) => p.case.kind !== "profileOnly").map((p) => {
          const c = p.case;
          return (
            <div key={p.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.txt }}>{p.name}</span>
              {c.kind === "overwrite" && (
                <>
                  <span style={{ fontSize: 12.5, color: C.mut, lineHeight: 1.45 }}>
                    {t("editor.save.scriptOnMachine", { id: c.scriptId, title: p.title })}{" "}
                    {c.otherUsers.length > 0 ? t("editor.save.otherUsers", { list: c.otherUsers.join(", ") })
                      : c.otherSlot ? t("editor.save.alsoFor", { list: p.followers.map((n) => t("editor.quote", { text: n })).join(", ") }) : t("editor.save.onlyThisVariant")}
                    {" "}{t("editor.save.oldVersionReadable")}
                  </span>
                  {radio(p.key, "overwrite", c.otherUsers.length > 0 ? t("editor.save.overwriteAll") : t("editor.save.overwrite"))}
                  {radio(p.key, "new", c.otherUsers.length > 0 ? t("editor.save.newScriptHere", { title: p.newTitle }) : t("editor.save.newScript", { title: p.newTitle }))}
                </>
              )}
              {c.kind === "newScript" && (
                <span style={{ fontSize: 12.5, color: C.mut, lineHeight: 1.45 }}>
                  {t("editor.save.createdAs", { title: p.newTitle })}
                </span>
              )}
              {p.warnings.map((w, k) => <span key={k} style={{ fontSize: 12, color: C.org, lineHeight: 1.4 }}>⚠ {w}</span>)}
              {c.kind === "toApp" && (
                <>
                  <span style={{ fontSize: 12.5, color: C.mut, lineHeight: 1.45 }}>
                    {t("editor.save.toApp")} {c.stillUsed ? t("editor.save.stillUsed", { id: c.scriptId }) : t("editor.save.notNeeded", { id: c.scriptId })}
                  </span>
                  {!c.stillUsed && radio(p.key, "keep", t("editor.save.keep"))}
                  {!c.stillUsed && radio(p.key, "delete", t("editor.save.delete"))}
                </>
              )}
            </div>
          );
        })}
        {error && <div style={{ fontSize: 12.5, color: C.red }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} disabled={busy} style={textBtn(false)}>{t("editor.common.back")}</button>
          <button onClick={onConfirm} disabled={busy} style={textBtn(true, !busy)}>{busy ? t("editor.save.writing") : t("editor.common.save")}</button>
        </div>
      </div>
    </>
  );
}
