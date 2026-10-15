/**
 * PreShotDialog — Phase 1 Step 9.
 *
 * Opens after the ShotSizePicker (1×/2×) and before the brew actually starts.
 * The user picks bean, grinder, grind setting, RPM and dose; "Bezug starten"
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
import type { Profile, ShotSize } from "@shared/types.js";
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

interface PreShotDialogProps {
  profile: Profile;
  shotSize: ShotSize;
  /** Whether the script for this shot size stops via Cmd 27 (machine-native). */
  hasCmd27?: boolean;
  /**
   * When set (repeat flow), the dialog opens prefilled with these exact
   * values instead of the active bean/grinder + the prefill cascade.
   */
  initialValues?: PreShotInitialValues;
  /** Performs the execute. Resolves to an error message, or null on success. */
  onStart: (payload: PreShotPayload) => Promise<string | null>;
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={labelStyle}>{label}</label>
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
  shotSize,
  hasCmd27 = false,
  initialValues,
  onStart,
  onClose,
  liveBgTempC,
  currentBgSetpointC,
  currentBbSetpointC,
  onSetFromProfile,
}: PreShotDialogProps) {
  const { t } = useTranslation();
  const { beans, grinders, activeBeanId, activeGrinderId, loading } = usePreShotData();
  const { settings: fields } = usePreShotFieldSettings();

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
    if (scaleWarn) actionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [scaleWarn]);

  // --- Yield override (per-shot only; null = use profile default) ---
  const [yieldOverrideG, setYieldOverrideG] = useState<number | null>(null);
  const [yieldPopupOpen, setYieldPopupOpen] = useState(false);
  const [yieldInput, setYieldInput]         = useState("");

  // Fetch the grind/RPM/dose prefill cascade for a bean+grinder pair and
  // write the result into the number fields. Called on the initial (non-repeat)
  // load and whenever the user changes the bean or grinder.
  const fetchDefaults = useCallback(
    async (
      bId: number | null,
      gId: number | null,
      profileId?: number,
    ): Promise<{ suggestedBeanId: number | null; suggestedGrinderId: number | null }> => {
      const params = new URLSearchParams();
      if (bId !== null) params.set("beanId", String(bId));
      if (gId !== null) params.set("grinderId", String(gId));
      if (profileId !== undefined) params.set("profileId", String(profileId));
      try {
        const r = await fetch(`/api/shots/preshot-defaults?${params.toString()}`);
        const d = (await r.json()) as {
          grindSetting: number | null;
          grinderRpm: number | null;
          doseG: number | null;
          suggestedBeanId?: number | null;
          suggestedGrinderId?: number | null;
        };
        setGrindSetting(d.grindSetting !== null ? String(d.grindSetting) : "");
        setGrinderRpm(d.grinderRpm !== null ? String(d.grinderRpm) : "");
        setDoseG(d.doseG !== null ? String(d.doseG) : "");
        return {
          suggestedBeanId: d.suggestedBeanId ?? null,
          suggestedGrinderId: d.suggestedGrinderId ?? null,
        };
      } catch {
        // Leave fields as-is — prefill is a convenience, not a requirement
        return { suggestedBeanId: null, suggestedGrinderId: null };
      }
    },
    [],
  );

  // Initial prefill, once the dialog's data has loaded.
  const initRef = useRef(false);
  useEffect(() => {
    if (loading || initRef.current) return;
    initRef.current = true;

    if (initialValues) {
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
      const sug = await fetchDefaults(null, null, profile.id);

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
        void fetchDefaults(finalBean, finalGrinder);
      }
    })();
  }, [loading, activeBeanId, activeGrinderId, beans, grinders, initialValues, fetchDefaults, profile.id]);

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

  const yieldG =
    shotSize === "single" ? profile.yieldTargetSingleG : profile.yieldTargetDoubleG;

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
        fetch(`/api/shots/preshot-defaults?${q.toString()}`)
          .then((r) => (r.ok ? (r.json() as Promise<{ doseG: number | null }>) : null))
          .then((d) => setLastDoseG(d?.doseG ?? null))
          .catch(() => { /* Vorschlag ist Komfort */ });
      }
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
      beanId,
      // Nur mitschicken, wenn keine gepflegte Bohne gewaehlt ist — sonst
      // stuenden zwei Bohnen am selben Bezug.
      beanLabel: beanId === null && beanLabel.trim() !== "" ? beanLabel.trim() : null,
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

    const err = await onStart(payload);
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
          padding: "16px 24px 18px",
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
            background: C.accG,
            border: `1px solid ${C.accB}`,
            borderRadius: 8,
            padding: "7px 12px",
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: C.txt }}>
            {profile.name}
          </span>
          <span
            style={{
              fontSize: 13,
              color: C.acc,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {shotSize === "single" ? "1×" : "2×"}
          </span>
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
            the profile has a target, D4) + "Setzen" button (only when the BG
            setpoint differs from the target). Starting a brew stays enabled in
            every ampel color (non-blocking, Fork 2). */}
        {profile.targetTempC !== null && (() => {
          const target = profile.targetTempC;
          const ist = liveBgTempC ?? null;
          // Ampel color = same 4-step thresholds as the dashboard gauge (§5.7),
          // relative to the profile target. Grey when the live temp is unknown.
          const istColor = ist !== null ? resolveColor(ist, target, false) : C.mut;
          // "Setzen" only when a known setpoint differs from the target — gate
          // on the SETPOINTS (not the live temp). Both BG and BB are set, so the
          // button shows while EITHER still differs. Tolerance 0.05 °C since
          // setpoints are whole/one-decimal values.
          const bgDiffers = currentBgSetpointC != null && Math.abs(currentBgSetpointC - target) >= 0.05;
          const bbDiffers = currentBbSetpointC != null && Math.abs(currentBbSetpointC - target) >= 0.05;
          const showSet = onSetFromProfile !== undefined && (bgDiffers || bbDiffers);
          async function handleSet() {
            if (!onSetFromProfile) return;
            setSettingTemp(true);
            try {
              await onSetFromProfile(target);
            } finally {
              setSettingTemp(false);
            }
          }
          return (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: -4,
                marginBottom: 10,
                fontSize: 11,
                color: C.mut,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
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
              {showSet && (
                <button
                  onClick={() => void handleSet()}
                  disabled={settingTemp}
                  style={{
                    flexShrink: 0,
                    padding: "5px 12px",
                    borderRadius: 7,
                    background: C.accG2,
                    border: `1px solid ${C.acc}40`,
                    color: C.acc,
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: settingTemp ? "not-allowed" : "pointer",
                    opacity: settingTemp ? 0.6 : 1,
                  }}
                >
                  {settingTemp ? t("preshot.settingTemp") : t("preshot.setTemp")}
                </button>
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
            {/* Bean — always shown */}
            <Field label={t("preshot.bean")}>
              <BeanPicker
                beans={beans}
                value={beanId}
                onChange={(v) => {
                  setBeanId(v);
                  void fetchDefaults(v, grinderId);
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
            </Field>

            {/* Grinder */}
            {fields.grinder && (
              <Field label={t("preshot.grinder")}>
                <select
                  style={inputStyle}
                  value={grinderId === null ? "" : String(grinderId)}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                    setGrinderId(v);
                    void fetchDefaults(beanId, v);
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
              <Field label={t("preshot.grindSetting")}>
                <GrindStepper value={grindSetting} onChange={setGrindSetting} inputStyle={numInputStyle} />
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
                        color: rpmOutOfRange ? C.red : C.dim,
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
              : scaleWarn
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
