/**
 * Settings view — chart X-axis, brew-by-weight, and language.
 *
 * Fetches all settings via GET /api/settings on mount.
 * Number inputs: debounced auto-save (800ms after last keystroke).
 * Toggles + select: save immediately on change.
 * Per-field status: idle | saving | saved | error.
 */

import { useEffect, useRef, useState } from "react"; // useRef for debounceRefs
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Toggle } from "../components/Toggle.js";
import { BackflushSettings } from "../components/BackflushSettings.js";
import { GrinderEditor } from "../components/GrinderEditor.js";
import { useGrinders } from "../hooks/useGrinders.js";
import { useTranslation, setLanguage } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { Grinder, GrinderCreate, GrinderUpdate } from "@shared/types.js";
import { normalizeMachineAddress } from "@shared/machine-address.js";
import type { ConnectionState } from "../hooks/useXeniaFrame.js";
import theme from "../theme.js";

const C = theme;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SettingsProps {
  /** Called after any chart_x_* PUT succeeds, so Dashboard refetches. */
  onChartSettingsSaved: () => void;
  /** Called after any brew_by_weight_* PUT succeeds. */
  onBrewSettingsSaved: () => void;
  mobile: boolean;
  /** Live connection to the machine — shown under the address field. */
  connectionState: ConnectionState;
}

interface FormState {
  // chart
  chart_x_window_s: string;
  chart_x_slide_step_s: string;
  chart_x_grow: boolean;
  chart_x_resize_on_end: boolean;
  chart_x_resize_animation: boolean;
  show_script_overlay: boolean;
  show_pump_curve: boolean;
  show_ghosts: boolean;
  ghost_count: string;
  // brew-by-weight
  brew_by_weight_active: boolean;
  /** UI value in seconds (= brew_by_weight_window_ms / 1000) */
  brew_by_weight_window_s: string;
  brew_by_weight_residual_lag_s: string;
  brew_by_weight_auto_calibrate: boolean;
  brew_by_weight_watchdog_enabled: boolean;
  brew_by_weight_watchdog_stop_lag_ms: string;
  brew_by_weight_watchdog_overshoot_g: string;
  // shot recording
  show_tds_input: boolean;
  // bean editor section visibility
  bean_fields_origin: boolean;
  bean_fields_inventory: boolean;
  bean_fields_aroma: boolean;
  bean_fields_freeze_dates: boolean;
  // pre-shot dialog field visibility
  preshot_field_grinder: boolean;
  preshot_field_grind_setting: boolean;
  preshot_field_grinder_rpm: boolean;
  preshot_field_dose: boolean;
  preshot_field_profile_notes: boolean;
  // language
  language: Language;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

// ---------------------------------------------------------------------------
// Validation (mirrors backend ALLOWED table)
// ---------------------------------------------------------------------------

const NUM_RULES: Record<string, { min: number; max: number }> = {
  chart_x_window_s:              { min: 5,   max: 600  },
  chart_x_slide_step_s:          { min: 1,   max: 60   },
  ghost_count:                   { min: 1,   max: 50   },
  brew_by_weight_window_s:       { min: 0.1, max: 10   },
  brew_by_weight_residual_lag_s: { min: 0,   max: 10   },
  brew_by_weight_watchdog_stop_lag_ms: { min: 500, max: 30000 },
  brew_by_weight_watchdog_overshoot_g: { min: 1,   max: 50    },
};

function validateNum(key: string, raw: string): string | undefined {
  const rule = NUM_RULES[key];
  if (!rule) return undefined;
  const num = parseFloat(raw);
  if (isNaN(num)) return "Ungültiger Wert";
  if (num < rule.min) return `Minimum: ${rule.min}`;
  if (num > rule.max) return `Maximum: ${rule.max}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// PUT helper
// ---------------------------------------------------------------------------

async function putSetting(key: string, value: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/settings/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.1em",
        color: C.acc,
        textTransform: "uppercase",
        padding: "20px 0 10px",
      }}
    >
      {title}
    </div>
  );
}

interface RowProps {
  label: string;
  description: string;
  children: React.ReactNode;
  error?: string;
  saveStatus?: SaveStatus;
  savingLabel: string;
  savedLabel: string;
  /** UP-3: default-value hint + reset action for numeric fields. */
  defaultHint?: React.ReactNode;
}

function Row({
  label,
  description,
  children,
  error,
  saveStatus,
  savingLabel,
  savedLabel,
  defaultHint,
}: RowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 0",
        borderBottom: `1px solid ${C.bdr}`,
        gap: 16,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: C.txt, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11, color: C.mut, marginTop: 2 }}>{description}</div>
        {defaultHint}
        {/* Status line — exactly one of these renders at a time */}
        {error && (
          <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{error}</div>
        )}
        {!error && saveStatus === "saving" && (
          <div style={{ fontSize: 11, color: C.mut, marginTop: 3 }}>{savingLabel}</div>
        )}
        {!error && saveStatus === "saved" && (
          <div style={{ fontSize: 11, color: C.grn, marginTop: 3 }}>{savedLabel}</div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

/** UP-3: shared default-value hint + reset for numeric settings fields. */
function DefaultHint({ defaultText, isDefault, onReset, prefix, resetLabel }: {
  defaultText: string;
  isDefault: boolean;
  onReset: () => void;
  prefix: string;
  resetLabel: string;
}) {
  return (
    <div style={{ fontSize: 11, color: C.mut, marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
      <span>
        {prefix} <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{defaultText}</span>
      </span>
      {!isDefault && (
        <button
          onClick={onReset}
          style={{ background: "transparent", border: "none", color: C.acc, cursor: "pointer", fontSize: 11, fontFamily: "inherit", padding: 0, textDecoration: "underline" }}
        >
          {resetLabel}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Settings({
  onChartSettingsSaved,
  onBrewSettingsSaved,
  mobile,
  connectionState,
}: SettingsProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState | null>(null);
  const { grinders, create: createGrinder, update: updateGrinder, remove: removeGrinder } = useGrinders();
  const [grinderEditor, setGrinderEditor] = useState<Grinder | null | "new">(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saveStatuses, setSaveStatuses] = useState<Record<string, SaveStatus>>({});
  const [loadError, setLoadError] = useState(false);
  // Maschinen-Adresse: eigener Weg (PUT /api/machine/address schaltet sofort
  // um), darum nicht im Auto-Save-Formular. saved = was die App gerade nutzt.
  const [machineAddr, setMachineAddr] = useState<{ saved: string; draft: string }>({ saved: "", draft: "" });

  // Per-field debounce timer handles.
  const debounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Load all settings once on mount.
  // AbortController avoids the React 18 strict-mode double-effect pitfall:
  // cleanup aborts the stale first fetch; the second fetch runs cleanly.
  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/settings", { signal: controller.signal })
      .then((r) => r.json() as Promise<Record<string, string>>)
      .then((data) => {
        const ip = data["machine_ip"] ?? "";
        setMachineAddr({ saved: ip, draft: ip });
        setForm({
          chart_x_window_s:              data["chart_x_window_s"]              ?? "30",
          chart_x_slide_step_s:          data["chart_x_slide_step_s"]          ?? "10",
          chart_x_grow:                 (data["chart_x_grow"]                  ?? "true") === "true",
          chart_x_resize_on_end:        (data["chart_x_resize_on_end"]         ?? "true") === "true",
          show_script_overlay:          (data["show_script_overlay"]           ?? "false") === "true",
          show_pump_curve:              (data["show_pump_curve"]               ?? "false") === "true",
          show_ghosts:                  (data["show_ghosts"]                   ?? "false") === "true",
          ghost_count:                   data["ghost_count"]                   ?? "20",
          chart_x_resize_animation:     (data["chart_x_resize_animation"]      ?? "true") === "true",
          brew_by_weight_active:        (data["brew_by_weight_active"]          ?? "false") === "true",
          brew_by_weight_window_s:       String(
            parseFloat(data["brew_by_weight_window_ms"] ?? "1000") / 1000,
          ),
          brew_by_weight_residual_lag_s: data["brew_by_weight_residual_lag_s"] ?? "1.35",
          brew_by_weight_auto_calibrate: (data["brew_by_weight_auto_calibrate"] ?? "true") === "true",
          brew_by_weight_watchdog_enabled: (data["brew_by_weight_watchdog_enabled"] ?? "true") === "true",
          brew_by_weight_watchdog_stop_lag_ms: data["brew_by_weight_watchdog_stop_lag_ms"] ?? "3000",
          brew_by_weight_watchdog_overshoot_g: data["brew_by_weight_watchdog_overshoot_g"] ?? "7",
          show_tds_input:               (data["show_tds_input"] ?? "false") === "true",
          bean_fields_origin:           (data["bean_fields_origin"]       ?? "true") === "true",
          bean_fields_inventory:        (data["bean_fields_inventory"]    ?? "true") === "true",
          bean_fields_aroma:            (data["bean_fields_aroma"]        ?? "true") === "true",
          bean_fields_freeze_dates:     (data["bean_fields_freeze_dates"] ?? "true") === "true",
          preshot_field_grinder:        (data["preshot_field_grinder"]       ?? "true")  === "true",
          preshot_field_grind_setting:  (data["preshot_field_grind_setting"] ?? "true")  === "true",
          preshot_field_grinder_rpm:    (data["preshot_field_grinder_rpm"]   ?? "true")  === "true",
          preshot_field_dose:           (data["preshot_field_dose"]          ?? "true")  === "true",
          preshot_field_profile_notes:  (data["preshot_field_profile_notes"] ?? "true")  === "true",
          language:                     (data["language"] === "en" ? "en" : "de") as Language,
        });
      })
      .catch((err: unknown) => {
        // AbortError means the cleanup cancelled the stale request — not a real error.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError(true);
      });

    // Note: debounce timers are intentionally NOT cleared on unmount.
    // If the user navigates away within the 800ms window, the timer still
    // fires and the PUT completes. setState calls on an unmounted component
    // are harmless no-ops in React 18.
    return () => { controller.abort(); };
  }, []);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const setStatus = (key: string, status: SaveStatus) => {
    setSaveStatuses((prev) => ({ ...prev, [key]: status }));
  };

  const clearError = (key: string) => {
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /** Schedule a debounced number save. Resets the timer on each call. */
  const scheduleNumSave = (
    formKey: string,
    backendKey: string,
    rawValue: string,
    transform: (v: number) => number,
    callback: () => void,
  ) => {
    clearTimeout(debounceRefs.current[formKey]);
    setStatus(formKey, "saving");

    debounceRefs.current[formKey] = setTimeout(async () => {
      const err = validateNum(formKey, rawValue);
      if (err) {
        setErrors((prev) => ({ ...prev, [formKey]: err }));
        setStatus(formKey, "error");
        return;
      }
      clearError(formKey);
      const stored = transform(parseFloat(rawValue));
      const ok = await putSetting(backendKey, String(stored));
      if (ok) {
        setStatus(formKey, "saved");
        callback();
        setTimeout(() => { setStatus(formKey, "idle"); }, 2000);
      } else {
        setStatus(formKey, "error");
      }
    }, 800);
  };

  /** UP-3: build the default-hint + reset node for a numeric field. */
  const numDefaultHint = (
    formKey: keyof FormState,
    backendKey: string,
    defaultUi: string,
    transform: (v: number) => number,
    cb: () => void,
  ): React.ReactNode => {
    if (!form) return null;
    const cur = String(form[formKey] ?? "");
    const isDefault = cur !== "" && parseFloat(cur) === parseFloat(defaultUi);
    return (
      <DefaultHint
        defaultText={defaultUi}
        isDefault={isDefault}
        prefix={t("settings.defaultPrefix")}
        resetLabel={t("settings.resetToDefault")}
        onReset={() => {
          setField(formKey, defaultUi as FormState[typeof formKey]);
          clearError(formKey as string);
          scheduleNumSave(formKey as string, backendKey, defaultUi, transform, cb);
        }}
      />
    );
  };

  /** Save a toggle immediately, with status feedback. */
  const saveToggle = async (
    key: string,
    value: boolean,
    callback?: () => void,
  ) => {
    setStatus(key, "saving");
    const ok = await putSetting(key, String(value));
    if (ok) {
      setStatus(key, "saved");
      callback?.();
      setTimeout(() => { setStatus(key, "idle"); }, 2000);
    } else {
      setStatus(key, "error");
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loadError) {
    return (
      <div style={{ color: C.red, fontSize: 13, padding: "40px 0", textAlign: "center" }}>
        Einstellungen konnten nicht geladen werden.
      </div>
    );
  }

  if (!form) {
    return (
      <div style={{ color: C.mut, fontSize: 13, padding: "40px 0", textAlign: "center" }}>
        Lade…
      </div>
    );
  }

  const rowProps = {
    savingLabel: t("settings.saving"),
    savedLabel:  t("settings.saved"),
  };

  const saveMachineAddress = async () => {
    const address = normalizeMachineAddress(machineAddr.draft);
    if (address === null) {
      setErrors((prev) => ({ ...prev, machine_ip: t("settings.machine.address.invalid") }));
      return;
    }
    if (address === machineAddr.saved) {
      setMachineAddr({ saved: address, draft: address });
      return;
    }
    setStatus("machine_ip", "saving");
    try {
      const res = await fetch("/api/machine/address", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) {
        setStatus("machine_ip", "idle");
        setErrors((prev) => ({
          ...prev,
          machine_ip: t(res.status === 409 ? "settings.machine.address.brewing" : "settings.machine.address.failed"),
        }));
        return;
      }
      setMachineAddr({ saved: address, draft: address });
      setStatus("machine_ip", "saved");
      setTimeout(() => { setStatus("machine_ip", "idle"); }, 2000);
    } catch {
      setStatus("machine_ip", "idle");
      setErrors((prev) => ({ ...prev, machine_ip: t("settings.machine.address.failed") }));
    }
  };

  return (
    <div
      style={{
        maxWidth: mobile ? undefined : 560,
        margin: mobile ? undefined : "0 auto",
        paddingBottom: 32,
      }}
    >
      {/* Auto-save hint */}
      <div style={{ fontSize: 11, color: C.mut, paddingTop: 4, paddingBottom: 4 }}>
        {t("settings.autoSaveHint")}
      </div>

      {/* ---- Maschine ---- */}
      <SectionHeader title={t("settings.machine.title")} />

      <Row
        label={t("settings.machine.address.label")}
        description={t("settings.machine.address.description")}
        error={errors["machine_ip"]}
        saveStatus={saveStatuses["machine_ip"]}
        defaultHint={
          <div style={{ fontSize: 11, marginTop: 3, display: "flex", alignItems: "center", gap: 6, color: C.mut }}>
            <span
              style={{
                width: 7, height: 7, borderRadius: "50%",
                background: connectionState === "connected" ? C.grn : connectionState === "connecting" ? C.mut : C.red,
              }}
            />
            {t(`settings.machine.connection.${connectionState}`)}
          </div>
        }
        {...rowProps}
      >
        <input
          type="text"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={t("settings.machine.address.label")}
          value={machineAddr.draft}
          onChange={(e) => {
            setMachineAddr((prev) => ({ ...prev, draft: e.target.value }));
            clearError("machine_ip");
          }}
          onBlur={() => { void saveMachineAddress(); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={{ ...numInputStyle(!!errors["machine_ip"]), width: 150 }}
        />
      </Row>

      {/* ---- Diagramm ---- */}
      <SectionHeader title={t("settings.chart.title")} />

      <Row
        label={t("settings.chart.grow.label")}
        description={t("settings.chart.grow.description")}
        saveStatus={saveStatuses["chart_x_grow"]}
        {...rowProps}
      >
        <Toggle
          checked={form.chart_x_grow}
          onChange={(val) => {
            setField("chart_x_grow", val);
            void saveToggle("chart_x_grow", val, onChartSettingsSaved);
          }}
        />
      </Row>

      {/* Breite und Schrittweite gelten nur fuer das nachrueckende Fenster —
          bei "immer gefuellt" ignoriert chartXDomain beide. */}
      {!form.chart_x_grow && (
        <>
        <Row
          label={t("settings.chart.windowS.label")}
          description={t("settings.chart.windowS.description")}
          error={errors["chart_x_window_s"]}
          saveStatus={saveStatuses["chart_x_window_s"]}
          defaultHint={numDefaultHint("chart_x_window_s", "chart_x_window_s", "30", Math.round, onChartSettingsSaved)}
          {...rowProps}
        >
          <input
            type="number"
            min={5}
            max={600}
            step={1}
            value={form.chart_x_window_s}
            onChange={(e) => {
              const v = e.target.value;
              setField("chart_x_window_s", v);
              clearError("chart_x_window_s");
              scheduleNumSave("chart_x_window_s", "chart_x_window_s", v, Math.round, onChartSettingsSaved);
            }}
            style={numInputStyle(!!errors["chart_x_window_s"])}
          />
        </Row>

        <Row
          label={t("settings.chart.slideStepS.label")}
          description={t("settings.chart.slideStepS.description")}
          error={errors["chart_x_slide_step_s"]}
          saveStatus={saveStatuses["chart_x_slide_step_s"]}
          defaultHint={numDefaultHint("chart_x_slide_step_s", "chart_x_slide_step_s", "10", Math.round, onChartSettingsSaved)}
          {...rowProps}
        >
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={form.chart_x_slide_step_s}
            onChange={(e) => {
              const v = e.target.value;
              setField("chart_x_slide_step_s", v);
              clearError("chart_x_slide_step_s");
              scheduleNumSave("chart_x_slide_step_s", "chart_x_slide_step_s", v, Math.round, onChartSettingsSaved);
            }}
            style={numInputStyle(!!errors["chart_x_slide_step_s"])}
          />
        </Row>
        </>
      )}

      {/* Zoom am Bezugsende gilt nur fuers nachrueckende Fenster — "immer
          gefuellt" zeigt am Ende ohnehin den ganzen Bezug (chartXDomain). Die
          Animation nur, wenn gezoomt wird. */}
      {!form.chart_x_grow && (
        <>
          <Row
            label={t("settings.chart.resizeOnEnd.label")}
            description={t("settings.chart.resizeOnEnd.description")}
            saveStatus={saveStatuses["chart_x_resize_on_end"]}
            {...rowProps}
          >
            <Toggle
              checked={form.chart_x_resize_on_end}
              onChange={(val) => {
                setField("chart_x_resize_on_end", val);
                void saveToggle("chart_x_resize_on_end", val, onChartSettingsSaved);
              }}
            />
          </Row>

          {form.chart_x_resize_on_end && (
            <Row
              label={t("settings.chart.resizeAnimation.label")}
              description={t("settings.chart.resizeAnimation.description")}
              saveStatus={saveStatuses["chart_x_resize_animation"]}
              {...rowProps}
            >
              <Toggle
                checked={form.chart_x_resize_animation}
                onChange={(val) => {
                  setField("chart_x_resize_animation", val);
                  void saveToggle("chart_x_resize_animation", val, onChartSettingsSaved);
                }}
              />
            </Row>
          )}
        </>
      )}

      <Row
        label={t("settings.chart.scriptOverlay.label")}
        description={t("settings.chart.scriptOverlay.description")}
        saveStatus={saveStatuses["show_script_overlay"]}
        {...rowProps}
      >
        <Toggle
          checked={form.show_script_overlay}
          onChange={(val) => {
            setField("show_script_overlay", val);
            void saveToggle("show_script_overlay", val, onChartSettingsSaved);
          }}
        />
      </Row>

      <Row
        label={t("settings.chart.pumpCurve.label")}
        description={t("settings.chart.pumpCurve.description")}
        saveStatus={saveStatuses["show_pump_curve"]}
        {...rowProps}
      >
        <Toggle
          checked={form.show_pump_curve}
          onChange={(val) => {
            setField("show_pump_curve", val);
            void saveToggle("show_pump_curve", val, onChartSettingsSaved);
          }}
        />
      </Row>

      <Row
        label={t("settings.chart.ghosts.label")}
        description={t("settings.chart.ghosts.description")}
        saveStatus={saveStatuses["show_ghosts"]}
        {...rowProps}
      >
        <Toggle
          checked={form.show_ghosts}
          onChange={(val) => {
            setField("show_ghosts", val);
            void saveToggle("show_ghosts", val, onChartSettingsSaved);
          }}
        />
      </Row>

      <Row
        label={t("settings.chart.ghostCount.label")}
        description={t("settings.chart.ghostCount.description")}
        error={errors["ghost_count"]}
        saveStatus={saveStatuses["ghost_count"]}
        defaultHint={numDefaultHint("ghost_count", "ghost_count", "20", Math.round, onChartSettingsSaved)}
        {...rowProps}
      >
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={form.ghost_count}
          onChange={(e) => {
            const v = e.target.value;
            setField("ghost_count", v);
            clearError("ghost_count");
            scheduleNumSave("ghost_count", "ghost_count", v, Math.round, onChartSettingsSaved);
          }}
          style={numInputStyle(!!errors["ghost_count"])}
        />
      </Row>

      {/* ---- Automatischer Stopp ---- */}
      <SectionHeader title={t("settings.brewByWeight.title")} />

      <Row
        label={t("settings.brewByWeight.active.label")}
        description={t("settings.brewByWeight.active.description")}
        saveStatus={saveStatuses["brew_by_weight_active"]}
        {...rowProps}
      >
        <Toggle
          checked={form.brew_by_weight_active}
          onChange={(val) => {
            setField("brew_by_weight_active", val);
            void saveToggle("brew_by_weight_active", val, onBrewSettingsSaved);
          }}
        />
      </Row>

      <Row
        label={t("settings.brewByWeight.windowMs.label")}
        description={t("settings.brewByWeight.windowMs.description")}
        error={errors["brew_by_weight_window_s"]}
        saveStatus={saveStatuses["brew_by_weight_window_s"]}
        defaultHint={numDefaultHint("brew_by_weight_window_s", "brew_by_weight_window_ms", "1", (n) => Math.round(n * 1000), onBrewSettingsSaved)}
        {...rowProps}
      >
        <input
          type="number"
          min={0.1}
          max={10}
          step={0.1}
          value={form.brew_by_weight_window_s}
          onChange={(e) => {
            const v = e.target.value;
            setField("brew_by_weight_window_s", v);
            clearError("brew_by_weight_window_s");
            // UI in seconds, backend stores milliseconds
            scheduleNumSave(
              "brew_by_weight_window_s",
              "brew_by_weight_window_ms",
              v,
              (n) => Math.round(n * 1000),
              onBrewSettingsSaved,
            );
          }}
          style={numInputStyle(!!errors["brew_by_weight_window_s"])}
        />
      </Row>

      <Row
        label={t("settings.brewByWeight.residualLagS.label")}
        description={t("settings.brewByWeight.residualLagS.description")}
        error={errors["brew_by_weight_residual_lag_s"]}
        saveStatus={saveStatuses["brew_by_weight_residual_lag_s"]}
        defaultHint={numDefaultHint("brew_by_weight_residual_lag_s", "brew_by_weight_residual_lag_s", "1.35", (n) => n, onBrewSettingsSaved)}
        {...rowProps}
      >
        <input
          type="number"
          min={0}
          max={10}
          step={0.05}
          value={form.brew_by_weight_residual_lag_s}
          onChange={(e) => {
            const v = e.target.value;
            setField("brew_by_weight_residual_lag_s", v);
            clearError("brew_by_weight_residual_lag_s");
            scheduleNumSave(
              "brew_by_weight_residual_lag_s",
              "brew_by_weight_residual_lag_s",
              v,
              (n) => n,
              onBrewSettingsSaved,
            );
          }}
          style={numInputStyle(!!errors["brew_by_weight_residual_lag_s"])}
        />
      </Row>

      <Row
        label={t("settings.brewByWeight.autoCalibrate.label")}
        description={t("settings.brewByWeight.autoCalibrate.description")}
        saveStatus={saveStatuses["brew_by_weight_auto_calibrate"]}
        {...rowProps}
      >
        <Toggle
          checked={form.brew_by_weight_auto_calibrate}
          onChange={(val) => {
            setField("brew_by_weight_auto_calibrate", val);
            void saveToggle("brew_by_weight_auto_calibrate", val, onBrewSettingsSaved);
          }}
        />
      </Row>

      <Row
        label={t("settings.brewByWeight.watchdogEnabled.label")}
        description={t("settings.brewByWeight.watchdogEnabled.description")}
        saveStatus={saveStatuses["brew_by_weight_watchdog_enabled"]}
        {...rowProps}
      >
        <Toggle
          checked={form.brew_by_weight_watchdog_enabled}
          onChange={(val) => {
            setField("brew_by_weight_watchdog_enabled", val);
            void saveToggle("brew_by_weight_watchdog_enabled", val, onBrewSettingsSaved);
          }}
        />
      </Row>

      <Row
        label={t("settings.brewByWeight.watchdogStopLagMs.label")}
        description={t("settings.brewByWeight.watchdogStopLagMs.description")}
        error={errors["brew_by_weight_watchdog_stop_lag_ms"]}
        saveStatus={saveStatuses["brew_by_weight_watchdog_stop_lag_ms"]}
        defaultHint={numDefaultHint("brew_by_weight_watchdog_stop_lag_ms", "brew_by_weight_watchdog_stop_lag_ms", "3000", Math.round, onBrewSettingsSaved)}
        {...rowProps}
      >
        <input
          type="number"
          min={500}
          max={30000}
          step={100}
          value={form.brew_by_weight_watchdog_stop_lag_ms}
          onChange={(e) => {
            const v = e.target.value;
            setField("brew_by_weight_watchdog_stop_lag_ms", v);
            clearError("brew_by_weight_watchdog_stop_lag_ms");
            scheduleNumSave(
              "brew_by_weight_watchdog_stop_lag_ms",
              "brew_by_weight_watchdog_stop_lag_ms",
              v,
              Math.round,
              onBrewSettingsSaved,
            );
          }}
          style={numInputStyle(!!errors["brew_by_weight_watchdog_stop_lag_ms"])}
        />
      </Row>

      <Row
        label={t("settings.brewByWeight.watchdogOvershootG.label")}
        description={t("settings.brewByWeight.watchdogOvershootG.description")}
        error={errors["brew_by_weight_watchdog_overshoot_g"]}
        saveStatus={saveStatuses["brew_by_weight_watchdog_overshoot_g"]}
        defaultHint={numDefaultHint("brew_by_weight_watchdog_overshoot_g", "brew_by_weight_watchdog_overshoot_g", "7", (n) => n, onBrewSettingsSaved)}
        {...rowProps}
      >
        <input
          type="number"
          min={1}
          max={50}
          step={0.5}
          value={form.brew_by_weight_watchdog_overshoot_g}
          onChange={(e) => {
            const v = e.target.value;
            setField("brew_by_weight_watchdog_overshoot_g", v);
            clearError("brew_by_weight_watchdog_overshoot_g");
            scheduleNumSave(
              "brew_by_weight_watchdog_overshoot_g",
              "brew_by_weight_watchdog_overshoot_g",
              v,
              (n) => n,
              onBrewSettingsSaved,
            );
          }}
          style={numInputStyle(!!errors["brew_by_weight_watchdog_overshoot_g"])}
        />
      </Row>

      {/* ---- Wartung / Rückspülen ---- */}
      <BackflushSettings />

      {/* ---- Mühlen ---- */}
      <SectionHeader title={t("settings.grinders.title")} />

      {grinders.length === 0 && (
        <div style={{ fontSize: 12, color: C.mut, padding: "8px 0 4px" }}>
          {t("settings.grinders.empty")}
        </div>
      )}

      {grinders.map((g) => (
        <div
          key={g.id}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "10px 0",
            borderBottom: `1px solid ${C.bdr}`,
            gap: 8,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: C.txt, fontWeight: 500 }}>{g.name}</span>
            {g.supportsRpm && (
              <span style={{ fontSize: 11, color: C.mut, marginLeft: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                {[g.rpmMin, g.rpmMax].filter(Boolean).join("–")} RPM
              </span>
            )}
          </div>
          <button
            onClick={() => setGrinderEditor(g)}
            title={t("settings.grinders.editTitle")}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex", padding: "2px 4px" }}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={async () => {
              if (window.confirm(t("settings.grinders.deleteConfirm"))) {
                await removeGrinder(g.id);
              }
            }}
            title={t("settings.grinders.delete")}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex", padding: "2px 4px" }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      <button
        onClick={() => setGrinderEditor("new")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 10,
          background: "transparent",
          border: `1px dashed ${C.bdr}`,
          borderRadius: 8,
          padding: "7px 14px",
          color: C.mut,
          fontSize: 12,
          cursor: "pointer",
          width: "100%",
          justifyContent: "center",
        }}
      >
        <Plus size={13} />
        {t("settings.grinders.add")}
      </button>

      {/* ---- Bohnen-Eingabe-Felder ---- */}
      <SectionHeader title={t("settings.beanFields.title")} />

      <Row
        label={t("settings.beanFields.origin.label")}
        description={t("settings.beanFields.origin.description")}
        saveStatus={saveStatuses["bean_fields_origin"]}
        {...rowProps}
      >
        <Toggle
          checked={form.bean_fields_origin}
          onChange={(val) => {
            setField("bean_fields_origin", val);
            void saveToggle("bean_fields_origin", val);
          }}
        />
      </Row>

      <Row
        label={t("settings.beanFields.inventory.label")}
        description={t("settings.beanFields.inventory.description")}
        saveStatus={saveStatuses["bean_fields_inventory"]}
        {...rowProps}
      >
        <Toggle
          checked={form.bean_fields_inventory}
          onChange={(val) => {
            setField("bean_fields_inventory", val);
            void saveToggle("bean_fields_inventory", val);
          }}
        />
      </Row>

      <Row
        label={t("settings.beanFields.aroma.label")}
        description={t("settings.beanFields.aroma.description")}
        saveStatus={saveStatuses["bean_fields_aroma"]}
        {...rowProps}
      >
        <Toggle
          checked={form.bean_fields_aroma}
          onChange={(val) => {
            setField("bean_fields_aroma", val);
            void saveToggle("bean_fields_aroma", val);
          }}
        />
      </Row>

      <Row
        label={t("settings.beanFields.freezeDates.label")}
        description={t("settings.beanFields.freezeDates.description")}
        saveStatus={saveStatuses["bean_fields_freeze_dates"]}
        {...rowProps}
      >
        <Toggle
          checked={form.bean_fields_freeze_dates}
          onChange={(val) => {
            setField("bean_fields_freeze_dates", val);
            void saveToggle("bean_fields_freeze_dates", val);
          }}
        />
      </Row>

      {/* ---- Pre-Shot-Dialog ---- */}
      <SectionHeader title={t("settings.preshot.title")} />

      <Row
        label={t("settings.preshot.grinder.label")}
        description={t("settings.preshot.grinder.description")}
        saveStatus={saveStatuses["preshot_field_grinder"]}
        {...rowProps}
      >
        <Toggle
          checked={form.preshot_field_grinder}
          onChange={(val) => {
            setField("preshot_field_grinder", val);
            void saveToggle("preshot_field_grinder", val);
          }}
        />
      </Row>

      <Row
        label={t("settings.preshot.grindSetting.label")}
        description={t("settings.preshot.grindSetting.description")}
        saveStatus={saveStatuses["preshot_field_grind_setting"]}
        {...rowProps}
      >
        <Toggle
          checked={form.preshot_field_grind_setting}
          onChange={(val) => {
            setField("preshot_field_grind_setting", val);
            void saveToggle("preshot_field_grind_setting", val);
          }}
        />
      </Row>

      <Row
        label={t("settings.preshot.grinderRpm.label")}
        description={t("settings.preshot.grinderRpm.description")}
        saveStatus={saveStatuses["preshot_field_grinder_rpm"]}
        {...rowProps}
      >
        <Toggle
          checked={form.preshot_field_grinder_rpm}
          onChange={(val) => {
            setField("preshot_field_grinder_rpm", val);
            void saveToggle("preshot_field_grinder_rpm", val);
          }}
        />
      </Row>

      <Row
        label={t("settings.preshot.dose.label")}
        description={t("settings.preshot.dose.description")}
        saveStatus={saveStatuses["preshot_field_dose"]}
        {...rowProps}
      >
        <Toggle
          checked={form.preshot_field_dose}
          onChange={(val) => {
            setField("preshot_field_dose", val);
            void saveToggle("preshot_field_dose", val);
          }}
        />
      </Row>

      <Row
        label={t("settings.preshot.profileNotes.label")}
        description={t("settings.preshot.profileNotes.description")}
        saveStatus={saveStatuses["preshot_field_profile_notes"]}
        {...rowProps}
      >
        <Toggle
          checked={form.preshot_field_profile_notes}
          onChange={(val) => {
            setField("preshot_field_profile_notes", val);
            void saveToggle("preshot_field_profile_notes", val);
          }}
        />
      </Row>

      {/* ---- Shot-Aufzeichnung ---- */}
      <SectionHeader title={t("settings.shotInput.title")} />

      <Row
        label={t("settings.shotInput.tdsInput.label")}
        description={t("settings.shotInput.tdsInput.description")}
        saveStatus={saveStatuses["show_tds_input"]}
        {...rowProps}
      >
        <Toggle
          checked={form.show_tds_input}
          onChange={(val) => {
            setField("show_tds_input", val);
            void saveToggle("show_tds_input", val);
          }}
        />
      </Row>

      {/* ---- Sprache ---- */}
      <SectionHeader title={t("settings.language.title")} />

      <Row
        label={t("settings.language.select.label")}
        description={t("settings.language.select.description")}
        saveStatus={saveStatuses["language"]}
        {...rowProps}
      >
        <select
          value={form.language}
          onChange={async (e) => {
            const lang = e.target.value as Language;
            setField("language", lang);
            setLanguage(lang);
            setStatus("language", "saving");
            const ok = await putSetting("language", lang);
            if (ok) {
              setStatus("language", "saved");
              setTimeout(() => { setStatus("language", "idle"); }, 2000);
            } else {
              setStatus("language", "error");
            }
          }}
          style={{
            background: C.card,
            color: C.txt,
            border: `1px solid ${C.bdr}`,
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 13,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          <option value="de">{t("settings.language.options.de")}</option>
          <option value="en">{t("settings.language.options.en")}</option>
        </select>
      </Row>

      {/* GrinderEditor modal */}
      {grinderEditor !== null && (
        <GrinderEditor
          grinder={grinderEditor === "new" ? undefined : grinderEditor}
          onSave={async (data) => {
            if (grinderEditor === "new") {
              await createGrinder(data as GrinderCreate);
            } else {
              await updateGrinder(grinderEditor.id, data as GrinderUpdate);
            }
          }}
          onDelete={
            grinderEditor !== "new"
              ? async () => { await removeGrinder(grinderEditor.id); }
              : undefined
          }
          onClose={() => setGrinderEditor(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function numInputStyle(hasError: boolean): React.CSSProperties {
  return {
    width: 80,
    padding: "6px 8px",
    background: C.card,
    color: C.txt,
    border: `1px solid ${hasError ? C.red : C.bdr}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    textAlign: "right",
    outline: "none",
  };
}
