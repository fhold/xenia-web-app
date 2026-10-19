/**
 * PreShotDialog — Phase 1 Step 9.
 *
 * Opens from every start path (dashboard chip, profile list, repeat) before the
 * brew actually starts. The user picks the variant and the sieve (basket), bean,
 * grinder, grind setting, RPM and dose; "Bezug starten"
 * sends everything to POST /api/scripts/execute via the onStart callback.
 *
 * Field visibility is configured in Settings (usePreShotFieldSettings).
 * The bean field is always shown — the most important pre-shot context.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { usePreShotData } from "../hooks/usePreShotData.js";
import { usePreShotFieldSettings } from "../hooks/usePreShotFieldSettings.js";
import { BeanPicker, isPickableBean } from "./BeanPicker.js";
import { resolveColor } from "./Gauge.js";
import type { GrindSource, Profile, ProfileVariant, ShotSize } from "@shared/types.js";
import { startVariants, shotSizeForBasket } from "@shared/profile-slots.js";
import { useBaskets } from "../hooks/useBaskets.js";
import { useBreakpoint } from "../hooks/useBreakpoint.js";
import { formatDay } from "../lib/dates.js";
import theme, { alpha } from "../theme.js";

const C = theme;

// ---------------------------------------------------------------------------
// Payload sent to the parent's onStart handler
// ---------------------------------------------------------------------------

export interface PreShotPayload {
  beanId: number | null;
  /** Freitext-Bohne, wenn keine gepflegte Sorte gewaehlt ist (Fremdbohne). */
  beanLabel: string | null;
  grinderId: number | null;
  grindSetting: number | null;
  grinderRpm: number | null;
  doseG: number | null;
  /** Per-shot yield override (null = use profile default). */
  yieldTargetOverrideG: number | null;
}

/** Repeat-flow prefill — includes the yield override (UP-1) so a repeat carries
 *  a non-default target. */
export type PreShotInitialValues = PreShotPayload;

/** Was gestartet wird: die Variante, das Sieb und die Groesse, die daraus folgt. */
export interface StartChoice {
  variant: ProfileVariant;
  basketId: number | null;
  shotSize: ShotSize;
}

interface PreShotDialogProps {
  profile: Profile;
  /** Vorgewaehlte Variante; null = die erste. Im Dialog umschaltbar. */
  variantId: number | null;
  /** Vorgewaehltes Sieb (Wiederholen); fehlt es, gilt das Vorgabe-Sieb der Variante. */
  basketId?: number | null;
  /** Start aus der Sorten-Ansicht: diese Roestung statt der zuletzt mit dem Profil benutzten. */
  beanId?: number | null;
  /** Start vom Dashboard-Chip: Variante und Sieb wie beim letzten Bezug mit diesem Profil. */
  suggest?: boolean;
  /** Stoppt das Skript dieser Variante selbst (Cmd 27)? */
  hasCmd27For?: (variant: ProfileVariant) => boolean;
  /**
   * When set (repeat flow), the dialog opens prefilled with these exact
   * values instead of the active bean/grinder + the prefill cascade.
   */
  initialValues?: PreShotInitialValues;
  /** Performs the execute. Resolves to an error message, or null on success. */
  onStart: (payload: PreShotPayload, choice: StartChoice) => Promise<string | null>;
  onClose: () => void;
  /** PT-2: live brew-group temperature (°C) for the readiness ampel. null = unknown. */
  liveBgTempC?: number | null;
  /** PT-2: current brew-group SETPOINT (°C) — gates the "Setzen" button. null = unknown. */
  currentBgSetpointC?: number | null;
  /** PT-2: current brew-boiler SETPOINT (°C) — also gates "Setzen" (both are set). null = unknown. */
  currentBbSetpointC?: number | null;
  /** PT-2: push the profile target temp onto the machine (sets both BG + BB). */
  onSetFromProfile?: (targetTempC: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Bean filtering, ordering and labelling (§3g/§3l) now live in the shared
// BeanPicker component — Pre-Brew, Dashboard-repeat and Shot-Edit all use it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 7,
  background: C.bg,
  border: `1px solid ${C.bdr}`,
  color: C.txt,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
  outline: "none",
};

const numInputStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "'JetBrains Mono', monospace",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  color: C.mut,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 1,
  marginBottom: 4,
};

/** `aside` steht rechts in der Beschriftungszeile — kostet keine Hoehe. */
function Field({ label, aside, children }: { label: string; aside?: string | null; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      {aside ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <label style={labelStyle}>{label}</label>
          <span style={{ marginLeft: "auto", minWidth: 0, fontSize: 10.5, lineHeight: 1, color: C.mut, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {aside}
          </span>
        </div>
      ) : (
        <label style={labelStyle}>{label}</label>
      )}
      {children}
    </div>
  );
}

const fmtG = (g: number) => (Number.isInteger(g) ? String(g) : g.toFixed(1)).replace(".", ",");

/** Mahlgrad-Schritt der Knoepfe — die Einstellungen liegen in halben Schritten. */
const GRIND_STEP = 0.5;

/**
 * Mahlgrad mit −/+: der Wert, der sich zwischen zwei Bezuegen am haeufigsten
 * aendert, ohne Tastatur und mit nassen Fingern. Zwischenwerte gehen weiter
 * per Eingabe.
 */
function GrindStepper({ value, onChange, inputStyle }: {
  value: string; onChange: (v: string) => void; inputStyle: React.CSSProperties;
}) {
  const bump = (dir: 1 | -1) => {
    const n = parseFloat(value.replace(",", "."));
    if (!Number.isFinite(n)) return;
    onChange(String(Math.max(0, Math.round((n + dir * GRIND_STEP) * 10) / 10)));
  };
  const btn: React.CSSProperties = {
    width: 44, height: 40, flexShrink: 0, borderRadius: 8, border: `1px solid ${C.bdr}`,
    background: C.bg, color: C.txt, fontSize: 20, lineHeight: 1, cursor: "pointer", fontFamily: "inherit",
  };
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <button type="button" aria-label="Mahlgrad feiner" onClick={() => bump(-1)} style={btn}>−</button>
      <input
        style={{ ...inputStyle, textAlign: "center" }}
        type="number"
        step={0.1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" aria-label="Mahlgrad gröber" onClick={() => bump(1)} style={btn}>+</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PreShotDialog({
  profile,
  variantId: initialVariantId,
  basketId: initialBasketId,
  beanId: initialBeanId = null,
  suggest = false,
  hasCmd27For,
  initialValues,
  onStart,
  onClose,
  liveBgTempC,
  currentBgSetpointC,
  currentBbSetpointC,
  onSetFromProfile,
}: PreShotDialogProps) {
  const { t, lang } = useTranslation();
  // Handy: die Profilzeile bricht um, das Sieb bekommt eine eigene Zeile.
  const mobile = useBreakpoint() === "mobile";
  const { beans, grinders, activeBeanId, activeGrinderId, loading } = usePreShotData();
  const { settings: fieldSettings } = usePreShotFieldSettings();
  // Messlauf: ohne Bohne, Muehle, Mahlgrad und Dosis — er zaehlt nirgends.
  const measurement = profile.kind === "test";
  const fields = measurement
    ? { ...fieldSettings, grinder: false, grindSetting: false, grinderRpm: false, dose: false }
    : fieldSettings;
  // Variante und Sieb (Schnitt 3d). Das Sieb folgt der Variante (Vorgabe-Sieb),
  // bis es im Dialog oder vom Wiederholen ausdruecklich gewaehlt ist.
  const variants = startVariants(profile);
  const [variantId, setVariantId] = useState<number | null>(initialVariantId ?? variants[0]?.id ?? null);
  const variant = variants.find((v) => v.id === variantId) ?? variants[0] ?? null;
  const { baskets } = useBaskets();
  const [basketChoice, setBasketChoice] = useState<number | null | undefined>(initialBasketId ?? undefined);
  const basketId = basketChoice !== undefined ? basketChoice : (variant?.defaultBasketId ?? null);
  const basket = baskets.find((b) => b.id === basketId) ?? null;
  const defaultBasket = baskets.find((b) => b.id === variant?.defaultBasketId) ?? null;
  // Anderes Sieb als das der Variante — weiche Sperre wie bei der Dosis. Verglichen
  // wird das Sieb selbst, nicht ein Typ: zwei 1er-Siebe sind zwei Siebe.
  const basketMismatch = basket !== null && defaultBasket !== null && basket.id !== defaultBasket.id;
  const [basketWarn, setBasketWarn] = useState(false);
  const showBasket = baskets.length > 0 && variant?.defaultBasketId != null;
  // Das Sieb waehlt die Variante (Flavio: das Dropdown reicht). Die Varianten-
  // Knoepfe bleiben nur, wo das nicht eindeutig geht: eine Variante ohne eigenes
  // Sieb oder zwei Varianten auf demselben Sieb.
  const variantByBasket = variants.length > 1
    && variants.every((v) => v.defaultBasketId != null)
    && new Set(variants.map((v) => v.defaultBasketId)).size === variants.length;
  const showVariantButtons = variants.length > 1 && !variantByBasket;
  const lineControls = variants.length > 1 || showBasket;
  const hasCmd27 = variant ? (hasCmd27For?.(variant) ?? false) : false;

  // --- Selection state ---
  const [beanId, setBeanId]       = useState<number | null>(null);
  // Fremdbohne: nur relevant, wenn KEINE gepflegte Bohne gewaehlt ist. Bewusst
  // keine dritte Option im Picker — "Keine Bohne" gab es schon, das Textfeld
  // haengt sich darunter, wenn man sie waehlt.
  const [beanLabel, setBeanLabel] = useState("");
  const [labelHints, setLabelHints] = useState<{ label: string; count: number }[]>([]);
  const selectedBean = beans.find((b) => b.id === beanId) ?? null;
  const selectedBeanDepleted = selectedBean?.stockDepleted ?? false;

  useEffect(() => {
    if (beanId !== null) return;
    let cancelled = false;
    fetch("/api/shots/bean-labels")
      .then((r) => (r.ok ? (r.json() as Promise<{ label: string; count: number }[]>) : []))
      .then((v) => { if (!cancelled) setLabelHints(v); })
      .catch(() => { /* Vorschlaege sind Komfort, kein Muss */ });
    return () => { cancelled = true; };
  }, [beanId]);
  const [grinderId, setGrinderId] = useState<number | null>(null);
  const [grindSetting, setGrindSetting] = useState("");
  /** Woher der vorbelegte Mahlgrad kommt; null, sobald er von Hand geaendert ist. */
  const [grindSource, setGrindSource]   = useState<GrindSource | null>(null);
  const [grinderRpm, setGrinderRpm]     = useState("");
  const [doseG, setDoseG]               = useState("");

  const [starting, setStarting] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  // Scale-connected warning: shown after a first click finds no scale connected.
  // Soft gate — a second click starts anyway (never blocks the brew).
  const [scaleWarn, setScaleWarn] = useState(false);
  // Dosis vergessen: der erste Klick auf Start haelt an und markiert das Feld,
  // ein zweiter startet trotzdem (wie beim Waagen-Hinweis). Bewusst KEIN
  // stilles Auffuellen — ein Wert, den niemand eingetragen hat, faellt nicht
  // auf; die letzte Dosis gibt es nur als Knopf zum Antippen.
  const [doseWarn, setDoseWarn] = useState(false);
  const [lastDoseG, setLastDoseG] = useState<number | null>(null);
  const doseRef = useRef<HTMLInputElement>(null);
  const [settingTemp, setSettingTemp] = useState(false); // PT-2: "Setzen" in-flight

  // The whole dialog is one scroll container; the scale-not-connected notice
  // appears on the first click and pushes the start button below the fold on
  // small tablet screens. Pull the action area (warning + button) back into
  // view so the user doesn't have to scroll again for "Trotzdem starten".
  const actionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scaleWarn || basketWarn) actionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [scaleWarn, basketWarn]);

  // --- Yield override (per-shot only; null = use profile default) ---
  const [yieldOverrideG, setYieldOverrideG] = useState<number | null>(null);
  const [yieldPopupOpen, setYieldPopupOpen] = useState(false);
  const [yieldInput, setYieldInput]         = useState("");

  // Fetch the grind/RPM/dose prefill cascade for a bean+grinder pair and
  // write the result into the number fields. Called on the initial (non-repeat)
  // load and whenever the user changes the bean, grinder or basket. With the
  // profile and basket the cascade starts at "this profile + this basket"
  // (Schnitt 3e); without a bean the profile would pick one, so it is only sent
  // with a bean — or on the initial load, where that pick is wanted.
  const fetchDefaults = useCallback(
    async (
      bId: number | null,
      gId: number | null,
      profileId?: number,
      bkId?: number | null,
    ): Promise<{ suggestedBeanId: number | null; suggestedGrinderId: number | null; suggestedVariantId: number | null; suggestedBasketId: number | null }> => {
      const params = new URLSearchParams();
      if (bId !== null) params.set("beanId", String(bId));
      if (gId !== null) params.set("grinderId", String(gId));
      if (profileId !== undefined) params.set("profileId", String(profileId));
      if (bkId !== undefined && bkId !== null) params.set("basketId", String(bkId));
      try {
        const r = await fetch(`/api/shots/preshot-defaults?${params.toString()}`);
        const d = (await r.json()) as {
          grindSetting: number | null;
          grinderRpm: number | null;
          doseG: number | null;
          suggestedBeanId?: number | null;
          suggestedGrinderId?: number | null;
          suggestedVariantId?: number | null;
          suggestedBasketId?: number | null;
          grindSource?: GrindSource | null;
        };
        setGrindSetting(d.grindSetting !== null ? String(d.grindSetting) : "");
        setGrindSource(d.grindSource ?? null);
        setGrinderRpm(d.grinderRpm !== null ? String(d.grinderRpm) : "");
        setDoseG(d.doseG !== null ? String(d.doseG) : "");
        return {
          suggestedBeanId: d.suggestedBeanId ?? null,
          suggestedGrinderId: d.suggestedGrinderId ?? null,
          suggestedVariantId: d.suggestedVariantId ?? null,
          suggestedBasketId: d.suggestedBasketId ?? null,
        };
      } catch {
        // Leave fields as-is — prefill is a convenience, not a requirement
        return { suggestedBeanId: null, suggestedGrinderId: null, suggestedVariantId: null, suggestedBasketId: null };
      }
    },
    [],
  );

  // Initial prefill, once the dialog's data has loaded.
  const initRef = useRef(false);
  /** Ab hier holt ein Siebwechsel Mahlgrad und Dosis neu; `cascadeBasket` = das Sieb dazu. */
  const cascadeReady = useRef(false);
  const cascadeBasket = useRef<number | null>(basketId);
  useEffect(() => {
    if (loading || initRef.current) return;
    initRef.current = true;

    if (initialValues) {
      cascadeReady.current = true;
      // Repeat flow — use the source shot's exact values, no cascade.
      setBeanId(initialValues.beanId);
      setBeanLabel(initialValues.beanLabel ?? "");
      setGrinderId(initialValues.grinderId);
      setGrindSetting(initialValues.grindSetting !== null ? String(initialValues.grindSetting) : "");
      setGrinderRpm(initialValues.grinderRpm !== null ? String(initialValues.grinderRpm) : "");
      setDoseG(initialValues.doseG !== null ? String(initialValues.doseG) : "");
      // UP-1: carry the source shot's yield override (already null when it
      // matched the profile default → no "geändert" marker).
      setYieldOverrideG(initialValues.yieldTargetOverrideG);
      return;
    }

    // Normal flow (profile start) — default the bean to the one last brewed
    // with THIS profile; the grinder comes via that bean. Fall back to the
    // global active ids, then unset. §3g: the bean must be a pickable
    // (active-source) roasting to appear in the picker.
    const beanPickable = (id: number | null) =>
      id !== null && beans.some((b) => b.id === id && isPickableBean(b));
    const grinderValid = (id: number | null) =>
      id !== null && grinders.some((g) => g.id === id);

    void (async () => {
      // Vom Chip kennt erst die Antwort das Sieb — dann nimmt der Server das des letzten Bezugs.
      const sug = await fetchDefaults(initialBeanId, null, profile.id, suggest ? undefined : basketId);
      let basketNow = basketId;
      // Vom Chip: Variante und Sieb wie beim letzten Bezug mit diesem Profil.
      if (suggest && sug.suggestedVariantId !== null && variants.some((v) => v.id === sug.suggestedVariantId)) {
        setVariantId(sug.suggestedVariantId);
        if (sug.suggestedBasketId !== null) setBasketChoice(sug.suggestedBasketId);
        basketNow = sug.suggestedBasketId ?? variants.find((v) => v.id === sug.suggestedVariantId)?.defaultBasketId ?? null;
      }

      const finalBean = beanPickable(sug.suggestedBeanId)
        ? sug.suggestedBeanId
        : beanPickable(activeBeanId)
          ? activeBeanId
          : null;
      const finalGrinder = grinderValid(sug.suggestedGrinderId)
        ? sug.suggestedGrinderId
        : grinderValid(activeGrinderId)
          ? activeGrinderId
          : null;

      setBeanId(finalBean);
      setGrinderId(finalGrinder);

      // If we fell back off either suggestion, re-run the cascade so grind/dose
      // match the (bean, grinder) pair we actually show.
      if (finalBean !== sug.suggestedBeanId || finalGrinder !== sug.suggestedGrinderId) {
        void fetchDefaults(finalBean, finalGrinder, finalBean !== null ? profile.id : undefined, basketNow);
      }
      cascadeBasket.current = basketNow;
      cascadeReady.current = true;
    })();
  }, [loading, activeBeanId, activeGrinderId, beans, grinders, initialValues, fetchDefaults, profile.id]);

  // Anderes Sieb (gewaehlt oder mit der Variante): Mahlgrad und Dosis neu fuer dieses Sieb.
  useEffect(() => {
    if (!cascadeReady.current || cascadeBasket.current === basketId) return;
    cascadeBasket.current = basketId;
    void fetchDefaults(beanId, grinderId, beanId !== null ? profile.id : undefined, basketId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketId]);

  // „wie zuletzt mit Profil + Sieb (12.10.) · passt“ — Stufe, Datum und Mahlgrad-Hinweis des Quellbezugs.
  const grindAside = (() => {
    if (!grindSource) return null;
    const date = formatDay(grindSource.startedAt, { style: "numeric", locale: lang === "de" ? "de-DE" : "en-US" });
    const note = grindSource.grindNote === "finer" ? t("shotRating.grindFiner")
      : grindSource.grindNote === "coarser" ? t("shotRating.grindCoarser")
      : grindSource.grindNote === "ok" ? t("shotRating.grindOk") : null;
    return `${t(`preshot.grindFrom.${grindSource.stage}`, { date })}${note ? ` · ${note.toLowerCase()}` : ""}`;
  })();

  const doseMissing = doseWarn && doseG.trim() === "";
  const selectedGrinder = grinders.find((g) => g.id === grinderId) ?? null;
  const showRpm = fields.grinderRpm && selectedGrinder?.supportsRpm === true;
  // Die Profil-Notiz ist die einzige Notiz im Pre-Brew (Bezugs-Notizen werden
  // nach dem Bezug im Rating erfasst) — sie haengt an der Einstellung.
  const showProfileNotes = fields.profileNotes && !!profile.notes;

  const rpmNum = grinderRpm.trim() === "" ? null : parseFloat(grinderRpm);
  const rpmOutOfRange =
    rpmNum !== null &&
    !Number.isNaN(rpmNum) &&
    selectedGrinder !== null &&
    ((selectedGrinder.rpmMin !== null && rpmNum < selectedGrinder.rpmMin) ||
      (selectedGrinder.rpmMax !== null && rpmNum > selectedGrinder.rpmMax));

  const yieldG = variant?.yieldG ?? null;

  // Variante im Dialog umschalten: Sieb zurueck auf ihre Vorgabe, eine
  // Yield-Aenderung galt der alten Variante.
  function pickVariant(next: number): void {
    if (next === variantId) return;
    setVariantId(next);
    setBasketChoice(undefined);
    setBasketWarn(false);
    setYieldOverrideG(null);
  }

  // Sieb waehlen: die Variante, deren Vorgabe-Sieb es ist, kommt mit (die erste
  // in der Reihenfolge). Hat keine Variante dieses Sieb, bleibt die Variante —
  // das Sieb wird trotzdem aufgezeichnet, der Hinweis beim Start sagt es.
  function pickBasket(next: number | null): void {
    const match = next === null ? undefined : variants.find((v) => v.defaultBasketId === next);
    if (match && match.id !== variantId) {
      setVariantId(match.id);
      setYieldOverrideG(null);
    }
    setBasketChoice(next);
    setBasketWarn(false);
  }

  // Effective yield = override if set, else profile default. The override is
  // "active" (and gets the changed-indicator) only when it differs from default.
  const effectiveYieldG = yieldOverrideG ?? yieldG;
  const overrideActive = yieldOverrideG !== null && yieldOverrideG !== yieldG;

  function openYieldPopup(): void {
    setYieldInput(effectiveYieldG !== null ? String(effectiveYieldG) : "");
    setYieldPopupOpen(true);
  }

  function applyYieldPopup(): void {
    // Sanitization (Entscheidung 5 / Task 3): empty / non-numeric / ≤ 0 → fall
    // back to the profile default (override = null). No upper bound — large
    // legitimate targets (e.g. 150 g) are accepted. A 0/negative target must
    // never become an override, or the BBW stop would fire instantly.
    const n = parseFloat(yieldInput);
    const valid = yieldInput.trim() !== "" && !Number.isNaN(n) && n > 0;
    setYieldOverrideG(valid ? n : null);
    setYieldPopupOpen(false);
  }

  function resetYieldOverride(): void {
    setYieldOverrideG(null);
    setYieldPopupOpen(false);
  }

  // --- Start ---
  async function handleStart(): Promise<void> {
    setStarting(true);
    setError(null);

    if (fields.dose && doseG.trim() === "" && !doseWarn) {
      setDoseWarn(true);
      setStarting(false);
      doseRef.current?.focus();
      if (beanId !== null) {
        const q = new URLSearchParams({ beanId: String(beanId) });
        if (grinderId !== null) q.set("grinderId", String(grinderId));
        if (basketId !== null) q.set("basketId", String(basketId));
        fetch(`/api/shots/preshot-defaults?${q.toString()}`)
          .then((r) => (r.ok ? (r.json() as Promise<{ doseG: number | null }>) : null))
          .then((d) => setLastDoseG(d?.doseG ?? null))
          .catch(() => { /* Vorschlag ist Komfort */ });
      }
      return;
    }

    if (basketMismatch && !basketWarn) {
      setBasketWarn(true);
      setStarting(false);
      return;
    }

    // One-off scale-connected check. If no scale is paired, surface a warning
    // and stop — a second click (scaleWarn already true) proceeds. Fail-open:
    // any error/timeout on the check must never prevent a brew from starting.
    if (!scaleWarn) {
      try {
        const r = await fetch("/api/scale");
        if (r.ok) {
          const d = (await r.json()) as { connected?: boolean };
          if (d.connected === false) {
            setScaleWarn(true);
            setStarting(false);
            return;
          }
        }
      } catch {
        // ignore — proceed without warning
      }
    }

    // Hidden fields contribute null — a fresh shot record, nothing to preserve.
    const payload: PreShotPayload = {
      beanId: measurement ? null : beanId,
      // Nur mitschicken, wenn keine gepflegte Bohne gewaehlt ist — sonst
      // stuenden zwei Bohnen am selben Bezug.
      beanLabel: !measurement && beanId === null && beanLabel.trim() !== "" ? beanLabel.trim() : null,
      grinderId: fields.grinder ? grinderId : null,
      grindSetting:
        fields.grindSetting && grindSetting.trim() !== ""
          ? parseFloat(grindSetting)
          : null,
      grinderRpm:
        showRpm && grinderRpm.trim() !== "" ? parseInt(grinderRpm, 10) : null,
      doseG: fields.dose && doseG.trim() !== "" ? parseFloat(doseG) : null,
      yieldTargetOverrideG: yieldOverrideG,
    };

    if (!variant) {
      setError(t("preshot.noVariant"));
      setStarting(false);
      return;
    }
    const err = await onStart(payload, { variant, basketId, shotSize: shotSizeForBasket(basket?.type ?? null) });
    if (err) {
      setError(err);
      setStarting(false);
    } else {
      onClose();
    }
  }

  return (
    <>
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: C.overlay,
        backdropFilter: "blur(4px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => { e.stopPropagation(); }}
        style={{
          background: C.cardElev,
          border: `1px solid ${C.bdrL}`,
          borderRadius: 14,
          // 14 px oben und unten: so passt der Dialog bei 1072×590 ohne
          // Scrollen (vorher 4 px zu hoch, gemessen 533 bei 529 Platz).
          padding: "14px 24px 14px",
          // The profile note gets its own column beside the fields — that needs
          // room the 440px single-column dialog does not have.
          width: showProfileNotes ? "min(760px, 96vw)" : "min(440px, 96vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: `0 8px 40px ${alpha(C.black, 0.5)}`,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.txt }}>
            {t("preshot.title")}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: C.mut,
              display: "flex",
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Profile summary — read-only */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            ...(mobile ? { flexWrap: "wrap" as const, rowGap: 6 } : {}),
            background: C.accG,
            border: `1px solid ${C.accB}`,
            borderRadius: 8,
            // Mit Varianten-Umschalter oder Sieb 1 px weniger Polster: die Zeile
            // bleibt so hoch wie vorher, der Dialog wird nicht laenger.
            padding: lineControls ? "6px 12px" : "7px 12px",
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: C.txt }}>
            {profile.name}
          </span>
          {showVariantButtons ? (
            <span role="radiogroup" aria-label={t("preshot.variant")} style={{ display: "inline-flex", border: `1px solid ${C.accB}`, borderRadius: 7, overflow: "hidden", flexShrink: mobile ? 0 : 1, minWidth: 0 }}>
              {variants.map((v) => (
                <button
                  key={v.id}
                  role="radio"
                  aria-checked={variant?.id === v.id}
                  onClick={() => pickVariant(v.id)}
                  style={{
                    height: 17, padding: "0 9px", border: "none", cursor: "pointer", fontFamily: "inherit",
                    fontSize: 12, lineHeight: "17px", fontWeight: 600, whiteSpace: "nowrap",
                    background: variant?.id === v.id ? C.accG2 : "transparent",
                    color: variant?.id === v.id ? C.acc : C.mut,
                  }}
                >
                  {v.name}
                </button>
              ))}
            </span>
          ) : variantByBasket ? null : (
            <span style={{ fontSize: 12, fontWeight: 600, color: C.acc }}>{variant?.name ?? ""}</span>
          )}
          {mobile && showBasket && <span aria-hidden="true" style={{ order: 1, flexBasis: "100%", height: 0 }} />}
          {showBasket && (
            <select
              aria-label={t("preshot.basket")}
              title={basket?.description ?? undefined}
              value={basketId ?? ""}
              onChange={(e) => { pickBasket(e.target.value === "" ? null : Number(e.target.value)); }}
              style={{
                height: 19, boxSizing: "border-box", padding: "0 4px", maxWidth: mobile ? "100%" : 150, borderRadius: 7, fontSize: 12,
                order: mobile ? 2 : undefined,
                fontFamily: "inherit", background: "transparent", cursor: "pointer",
                border: `1px solid ${basketMismatch ? C.warnSoft : C.accB}`, color: basketMismatch ? C.warnSoft : C.mut,
              }}
            >
              {baskets.map((b) => <option key={b.id} value={b.id} title={b.description ?? undefined}>{b.name}</option>)}
            </select>
          )}
          {/* Yield — tappable, opens the per-shot override popup. Shown even
              when the profile has no yield (placeholder invites setting one). */}
          <button
            onClick={openYieldPopup}
            title={t("preshot.yieldEditTitle")}
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              whiteSpace: "nowrap",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              color: C.mut,
            }}
          >
            {effectiveYieldG !== null ? (
              <span>
                →{" "}
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: overrideActive ? C.acc : C.txt,
                    fontWeight: overrideActive ? 700 : 400,
                  }}
                >
                  {effectiveYieldG}
                </span>{" "}
                g {t("preshot.yield")}
              </span>
            ) : (
              <span style={{ color: C.mut }}>
                — g, {t("preshot.yieldSetHint")}
              </span>
            )}
            {overrideActive && (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: C.acc,
                  background: C.accG,
                  border: `1px solid ${C.accB}`,
                  borderRadius: 6,
                  padding: "1px 5px",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {t("preshot.yieldChanged")}
              </span>
            )}
          </button>
        </div>

        {/* Profile target brew temp (PT-2) — readiness ampel (always shown when
            the profile has a target, D4). Steht ein Sollwert der Maschine (BG
            oder BB) anders als das Profil, kommt an dieselbe Stelle ein gelber
            Hinweis mit grossem Knopf — klein und grau wurde er uebersehen
            (17.10.). Starting a brew stays enabled either way (non-blocking,
            Fork 2). */}
        {profile.targetTempC !== null && (() => {
          const target = profile.targetTempC;
          const ist = liveBgTempC ?? null;
          // Ampel color = same 4-step thresholds as the dashboard gauge (§5.7),
          // relative to the profile target. Grey when the live temp is unknown.
          const istColor = ist !== null ? resolveColor(ist, target, false) : C.mut;
          // Gate on the SETPOINTS (not the live temp). Both BG and BB are set,
          // so the hint shows while EITHER still differs. Tolerance 0.05 °C since
          // setpoints are whole/one-decimal values.
          const bgDiffers = currentBgSetpointC != null && Math.abs(currentBgSetpointC - target) >= 0.05;
          const bbDiffers = currentBbSetpointC != null && Math.abs(currentBbSetpointC - target) >= 0.05;
          async function handleSet() {
            if (!onSetFromProfile) return;
            setSettingTemp(true);
            try {
              await onSetFromProfile(target);
            } finally {
              setSettingTemp(false);
            }
          }
          if (bgDiffers || bbDiffers) {
            const machine = bgDiffers ? currentBgSetpointC! : currentBbSetpointC!;
            const deg = (v: number) => (Number.isInteger(v) ? String(v) : lang === "de" ? v.toFixed(1).replace(".", ",") : v.toFixed(1));
            // Am Tablet so hoch wie die alte Knopfzeile (der Dialog darf nicht
            // scrollen), der Knopf sitzt buendig am rechten Rand; am Handy groesser.
            return (
              <div
                role="status"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: -4,
                  marginBottom: 8,
                  paddingLeft: 10,
                  borderRadius: 8,
                  overflow: "hidden",
                  background: C.orgD,
                  border: `1px solid ${alpha(C.org, 0.45)}`,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: C.org, lineHeight: 1.25 }}>
                  {t("preshot.tempMismatch", { machine: deg(machine), target: deg(target) })}
                </span>
                {onSetFromProfile !== undefined && (
                  <button
                    onClick={() => void handleSet()}
                    disabled={settingTemp}
                    style={{
                      flexShrink: 0,
                      alignSelf: "stretch",
                      minHeight: mobile ? 34 : 26,
                      padding: "0 12px",
                      borderRadius: 0,
                      background: C.org,
                      border: "none",
                      color: C.bg,
                      fontSize: 12.5,
                      fontWeight: 700,
                      fontFamily: "inherit",
                      whiteSpace: "nowrap",
                      cursor: settingTemp ? "not-allowed" : "pointer",
                      opacity: settingTemp ? 0.6 : 1,
                    }}
                  >
                    {settingTemp ? t("preshot.settingTemp") : t("preshot.setTempTo", { target: deg(target) })}
                  </button>
                )}
              </div>
            );
          }
          return (
            <div
              style={{
                marginTop: -4,
                marginBottom: 10,
                fontSize: 11,
                color: C.mut,
              }}
            >
              {t("preshot.profileTargetTemp")}{" "}
              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: C.txtS }}>
                {target.toFixed(1)} °C
              </span>
              {ist !== null && (
                <>
                  {" · "}
                  {t("preshot.currentTemp")}{" "}
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: istColor }}>
                    {ist.toFixed(1)} °C
                  </span>
                </>
              )}
            </div>
          );
        })()}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: "3 1 260px", minWidth: 0 }}>
        {loading ? (
          <div style={{ color: C.mut, fontSize: 13, padding: "24px 0", textAlign: "center" }}>
            {t("preshot.loading")}
          </div>
        ) : (
          <>
            {/* Bean — immer, ausser beim Messlauf */}
            {!measurement && <Field label={t("preshot.bean")}>
              <BeanPicker
                beans={beans}
                value={beanId}
                onChange={(v) => {
                  setBeanId(v);
                  void fetchDefaults(v, grinderId, v !== null ? profile.id : undefined, basketId);
                }}
                style={inputStyle}
              />
              {beans.length === 0 && (
                <div style={{ fontSize: 11, color: C.mut, marginTop: 4 }}>
                  {t("preshot.noBeansHint")}
                </div>
              )}
              {selectedBean && selectedBean.remainingG !== null && selectedBean.remainingG >= 0 && (
                <div style={{ fontSize: 11.5, color: C.mut, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                  {selectedBean.bagSizeG !== null
                    ? t("preshot.remaining").replace("{rest}", fmtG(selectedBean.remainingG)).replace("{bag}", fmtG(selectedBean.bagSizeG))
                    : t("preshot.remainingNoBag").replace("{rest}", fmtG(selectedBean.remainingG))}
                </div>
              )}
              {/* Fremdbohne: Bohnen, die hier bewusst nicht gepflegt werden.
                  Freitext mit Vorschlaegen aus dem, was schon benutzt wurde —
                  das native datalist rendert dank color-scheme: dark dunkel. */}
              {beanId === null && (
                <>
                  <input
                    type="text"
                    list="preshot-bean-labels"
                    value={beanLabel}
                    onChange={(e) => { setBeanLabel(e.target.value); }}
                    placeholder={t("preshot.beanLabelPlaceholder")}
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                  <datalist id="preshot-bean-labels">
                    {labelHints.map((h) => (
                      <option key={h.label} value={h.label}>{`${h.count}×`}</option>
                    ))}
                  </datalist>
                </>
              )}
              {/* Vor dem Mahlen sichtbar: der Beutel traegt keinen Bezug mehr. */}
              {selectedBeanDepleted && (
                <div style={{ fontSize: 11, color: C.org, marginTop: 4 }}>
                  {t("stockAlert.preBrew")}
                </div>
              )}
            </Field>}

            {/* Grinder */}
            {fields.grinder && (
              <Field label={t("preshot.grinder")}>
                <select
                  style={inputStyle}
                  value={grinderId === null ? "" : String(grinderId)}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                    setGrinderId(v);
                    void fetchDefaults(beanId, v, beanId !== null ? profile.id : undefined, basketId);
                  }}
                >
                  <option value="">{t("preshot.noGrinder")}</option>
                  {grinders.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </Field>
            )}

            {/* Grind setting */}
            {fields.grindSetting && (
              <Field label={t("preshot.grindSetting")} aside={grindAside}>
                <GrindStepper value={grindSetting} onChange={(v) => { setGrindSetting(v); setGrindSource(null); }} inputStyle={numInputStyle} />
              </Field>
            )}

            {/* RPM — only when the selected grinder supports it */}
            {showRpm && (
              <Field label={t("preshot.grinderRpm")}>
                <input
                  style={{
                    ...numInputStyle,
                    borderColor: rpmOutOfRange ? C.red : C.bdr,
                  }}
                  type="number"
                  step={1}
                  value={grinderRpm}
                  onChange={(e) => setGrinderRpm(e.target.value)}
                />
                {selectedGrinder !== null &&
                  selectedGrinder.rpmMin !== null &&
                  selectedGrinder.rpmMax !== null && (
                    <div
                      style={{
                        fontSize: 11,
                        color: rpmOutOfRange ? C.red : C.mut,
                        marginTop: 4,
                      }}
                    >
                      {t("preshot.rpmRange")
                        .replace("{{min}}", String(selectedGrinder.rpmMin))
                        .replace("{{max}}", String(selectedGrinder.rpmMax))}
                    </div>
                  )}
              </Field>
            )}

            {/* Dose */}
            {fields.dose && (
              <Field label={`${t("preshot.dose")} (g)`}>
                <input
                  ref={doseRef}
                  style={doseMissing ? { ...numInputStyle, borderColor: C.red } : numInputStyle}
                  type="number"
                  step={0.1}
                  min={0}
                  value={doseG}
                  onChange={(e) => {
                    setDoseG(e.target.value);
                    if (e.target.value.trim() !== "") setDoseWarn(false);
                  }}
                />
                {doseMissing && (
                  <div style={{ fontSize: 11.5, color: C.red, marginTop: 5 }}>
                    {t("preshot.doseMissing")}
                    {lastDoseG !== null && (
                      <>
                        {" · "}
                        <button
                          onClick={() => { setDoseG(String(lastDoseG)); setDoseWarn(false); }}
                          style={{ background: "transparent", border: "none", padding: 0, color: C.acc, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
                        >
                          {t("preshot.doseLast").replace("{g}", String(lastDoseG).replace(".", ","))}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </Field>
            )}

          </>
        )}
        </div>

        {/* Profile note — read-only context beside the fields (never editable
            here; it belongs to the profile, not to this shot). */}
        {showProfileNotes && (
          <aside
            style={{
              flex: "1 1 200px",
              minWidth: 0,
              background: C.bg,
              border: `1px solid ${C.bdr}`,
              borderRadius: 8,
              padding: "10px 12px",
            }}
          >
            <div style={{ ...labelStyle, marginBottom: 6 }}>{t("preshot.profileNotes")}</div>
            <div style={{ fontSize: 12.5, color: C.txtS, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {profile.notes}
            </div>
          </aside>
        )}
        </div>

        <div ref={actionRef}>
        {/* Sieb passt nicht zur Variante (weich — der zweite Klick startet trotzdem) */}
        {basketWarn && basketMismatch && basket && defaultBasket && variant && (
          <div
            style={{
              color: C.warnSoft,
              background: alpha(C.warnSoft, 0.10),
              border: `1px solid ${alpha(C.warnSoft, 0.30)}`,
              borderRadius: 8,
              fontSize: 12,
              padding: "8px 12px",
              margin: "4px 0 8px",
            }}
          >
            {t("preshot.basketMismatch", { basket: basket.name, variant: variant.name, default: defaultBasket.name })}
          </div>
        )}

        {/* Scale-not-connected warning (soft — second click starts anyway) */}
        {scaleWarn && (
          <div
            style={{
              color: C.warnSoft,
              background: alpha(C.warnSoft, 0.10),
              border: `1px solid ${alpha(C.warnSoft, 0.30)}`,
              borderRadius: 8,
              fontSize: 12,
              padding: "8px 12px",
              margin: "4px 0 8px",
            }}
          >
            {t("preshot.scaleNotConnected")}
          </div>
        )}

        {/* Error bar */}
        {error && (
          <div style={{ color: C.red, fontSize: 12, margin: "4px 0 8px" }}>{error}</div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            onClick={onClose}
            disabled={starting}
            style={{
              flex: 1,
              padding: "10px 0",
              borderRadius: 8,
              background: "transparent",
              border: `1px solid ${C.bdr}`,
              color: C.mut,
              fontSize: 13,
              fontWeight: 500,
              cursor: starting ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("preshot.cancel")}
          </button>
          <button
            onClick={() => { void handleStart(); }}
            disabled={starting || loading}
            style={{
              flex: 2,
              padding: "10px 0",
              borderRadius: 8,
              background: C.accG2,
              border: `1px solid ${C.accB}`,
              color: C.acc,
              fontSize: 13,
              fontWeight: 600,
              cursor: starting || loading ? "wait" : "pointer",
              opacity: starting || loading ? 0.6 : 1,
              fontFamily: "inherit",
            }}
          >
            {starting
              ? t("preshot.starting")
              : doseMissing
                ? t("preshot.startWithoutDose")
              : scaleWarn || (basketWarn && basketMismatch)
                ? t("preshot.startAnyway")
                : t("preshot.start")}
          </button>
        </div>
        </div>
      </div>
    </div>

    {/* Yield-override popup — direct numeric entry, no bounds (Entscheidung 5). */}
    {yieldPopupOpen && (
      <div
        onClick={() => { setYieldPopupOpen(false); }}
        style={{
          position: "fixed",
          inset: 0,
          background: C.overlay,
          backdropFilter: "blur(4px)",
          zIndex: 110,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
      >
        <div
          onClick={(e) => { e.stopPropagation(); }}
          style={{
            background: C.cardElev,
            border: `1px solid ${C.bdrL}`,
            borderRadius: 14,
            padding: "20px 24px 24px",
            width: "min(340px, 92vw)",
            boxShadow: `0 8px 40px ${alpha(C.black, 0.5)}`,
          }}
        >
          <h2 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 600, color: C.txt }}>
            {t("preshot.yieldEditTitle")}
          </h2>

          <Field label={`${t("preshot.yield")} (g)`}>
            <input
              autoFocus
              style={numInputStyle}
              type="number"
              inputMode="decimal"
              step={0.5}
              value={yieldInput}
              placeholder={t("preshot.yieldPlaceholder")}
              onChange={(e) => { setYieldInput(e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter") applyYieldPopup(); }}
            />
            <div style={{ fontSize: 11, color: C.mut, marginTop: 4 }}>
              {t("preshot.yieldEmptyHint")}
            </div>
          </Field>

          {hasCmd27 && (
            <div
              style={{
                fontSize: 11,
                color: C.mut,
                background: C.bg,
                border: `1px solid ${C.bdr}`,
                borderRadius: 7,
                padding: "8px 10px",
                marginBottom: 12,
                lineHeight: 1.4,
              }}
            >
              {t("preshot.yieldCmd27Hint")}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={resetYieldOverride}
              style={{
                flex: 1,
                padding: "10px 0",
                borderRadius: 8,
                background: "transparent",
                border: `1px solid ${C.bdr}`,
                color: C.mut,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("preshot.yieldReset")}
            </button>
            <button
              onClick={applyYieldPopup}
              style={{
                flex: 1,
                padding: "10px 0",
                borderRadius: 8,
                background: C.accG2,
                border: `1px solid ${C.accB}`,
                color: C.acc,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("preshot.yieldApply")}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
