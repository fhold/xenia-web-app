/**
 * Eigene Farbschemata (Einstellungen → Oberfläche, Flavio 22.10.): Liste,
 * Anlegen auf Basis Dunkel oder Hell, Bearbeiten der Grundfarben mit Vorschau
 * und Kontrast-Warnung, Löschen. Gespeichert wird die ganze Liste
 * (`ui_color_schemes`); das Übernehmen eines Schemas lädt die App neu.
 */

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { ColorScheme, EditableColor, SchemeBase } from "@shared/color-scheme.js";
import theme, { alpha, buildTheme, contrast, PALETTES } from "../theme.js";
import type { ThemeTokens } from "../theme.js";
import { useTranslation } from "../i18n/index.js";
import { dec } from "../lib/num.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

/** Gruppen des Editors — jede Grundfarbe aus EDITABLE_COLORS genau einmal. */
const GROUPS: { key: string; colors: EditableColor[] }[] = [
  { key: "surfaces", colors: ["bg", "card", "cardElev"] },
  { key: "text", colors: ["txt", "mut"] },
  { key: "lines", colors: ["bdr"] },
  { key: "accent", colors: ["acc"] },
  { key: "status", colors: ["grn", "org", "red"] },
  { key: "curves", colors: ["seriesPressure", "seriesFlow", "seriesWeight", "seriesTemp", "seriesPower", "seriesTarget", "seriesStage"] },
  { key: "compare", colors: ["seriesPressureB", "seriesFlowB", "seriesWeightB"] },
  { key: "rating", colors: ["rateAcidity", "rateBitter"] },
];

interface Props {
  schemes: ColorScheme[];
  /** Wert von ui_theme — welches Schema gerade gilt. */
  active: string;
  /** Liste speichern; `use` = danach dieses Schema verwenden. */
  onSave: (schemes: ColorScheme[], use: string | null) => Promise<boolean>;
}

export function ColorSchemes({ schemes, active, onSave }: Props) {
  const { t } = useTranslation();
  const [edit, setEdit] = useState<ColorScheme | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startNew = (base: SchemeBase) => {
    setError(null);
    setEdit({ id: `s-${Date.now().toString(36)}`, name: "", base, colors: {} });
  };
  const save = async (use: boolean) => {
    if (!edit) return;
    if (edit.name.trim() === "") { setError(t("settings.ui.editor.nameMissing")); return; }
    const next = schemes.some((s) => s.id === edit.id) ? schemes.map((s) => (s.id === edit.id ? edit : s)) : [...schemes, edit];
    const ok = await onSave(next.map((s) => ({ ...s, name: s.name.trim() })), use ? `scheme:${edit.id}` : null);
    if (ok) setEdit(null); else setError(t("settings.ui.editor.saveFailed"));
  };
  const remove = async (s: ColorScheme) => {
    if (!window.confirm(t("settings.ui.schemes.deleteConfirm", { name: s.name }))) return;
    await onSave(schemes.filter((x) => x.id !== s.id), active === `scheme:${s.id}` ? "dark" : null);
  };

  const btn: React.CSSProperties = {
    padding: "6px 11px", borderRadius: 7, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
    background: C.sunken, border: `1px solid ${C.bdr2}`, color: C.txtS, whiteSpace: "nowrap",
  };

  return (
    <div style={{ padding: "12px 0", borderBottom: `1px solid ${C.bdr}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, color: C.txt, fontWeight: 500 }}>{t("settings.ui.schemes.label")}</div>
          <div style={{ fontSize: 11, color: C.mut, marginTop: 2 }}>{t("settings.ui.schemes.description")}</div>
        </div>
        {!edit && (
          <div style={{ display: "flex", gap: 6 }}>
            <button style={btn} onClick={() => startNew("dark")}>{t("settings.ui.schemes.newDark")}</button>
            <button style={btn} onClick={() => startNew("light")}>{t("settings.ui.schemes.newLight")}</button>
          </div>
        )}
      </div>

      {!edit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          {schemes.length === 0 && <div style={{ fontSize: 12, color: C.mut }}>{t("settings.ui.schemes.none")}</div>}
          {schemes.map((s) => {
            const tk = buildTheme(s.base, s.colors);
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 10px", borderRadius: 9, background: C.card, border: `1px solid ${C.bdr}` }}>
                <Swatches tk={tk} />
                <span style={{ flex: "1 1 80px", minWidth: 0, fontSize: 13, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                <span style={{ fontSize: 11, color: C.mut }}>{t(`settings.ui.theme.options.${s.base}`)}</span>
                {active === `scheme:${s.id}` && <span style={{ fontSize: 11, color: C.acc }}>{t("settings.ui.schemes.inUse")}</span>}
                <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                  <button style={btn} onClick={() => { setError(null); setEdit(s); }}>{t("settings.ui.schemes.edit")}</button>
                  <button style={{ ...btn, color: C.redText }} onClick={() => { void remove(s); }}>{t("settings.ui.schemes.delete")}</button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {edit && <Editor scheme={edit} onChange={setEdit} />}
      {edit && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 160px", fontSize: 11, color: error ? C.red : C.mut }}>{error ?? t("settings.ui.editor.reloadHint")}</span>
          <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            <button style={btn} onClick={() => { setEdit(null); setError(null); }}>{t("settings.ui.editor.cancel")}</button>
            <button style={btn} onClick={() => { void save(false); }}>{t("settings.ui.editor.save")}</button>
            <button style={{ ...btn, background: C.accG2, border: `1px solid ${C.accB}`, color: C.acc, fontWeight: 600 }} onClick={() => { void save(true); }}>
              {t("settings.ui.editor.saveUse")}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** Ein paar Farbtupfer — so erkennt man ein Schema in der Liste. */
function Swatches({ tk }: { tk: ThemeTokens }) {
  return (
    <span style={{ display: "inline-flex", borderRadius: 5, overflow: "hidden", border: `1px solid ${C.bdr2}`, flexShrink: 0 }}>
      {[tk.bg, tk.card, tk.txt, tk.acc, tk.seriesPressure, tk.seriesFlow, tk.seriesWeight].map((c, i) => (
        <span key={i} style={{ width: 12, height: 18, background: c }} />
      ))}
    </span>
  );
}

function Editor({ scheme, onChange }: { scheme: ColorScheme; onChange: (s: ColorScheme) => void }) {
  const { t } = useTranslation();
  const tk = buildTheme(scheme.base, scheme.colors);
  const palette = PALETTES[scheme.base];
  const setColor = (k: EditableColor, v: string | null) => {
    const colors = { ...scheme.colors };
    if (v === null || v.toUpperCase() === palette[k].toUpperCase()) delete colors[k]; else colors[k] = v.toUpperCase();
    onChange({ ...scheme, colors });
  };

  // Kontrast: Text, den man lesen muss — WCAG AA 4,5 : 1.
  const checks: [string, string, string][] = [
    ["txtOnBg", tk.txt, tk.bg],
    ["txtOnCard", tk.txt, tk.card],
    ["mutOnCard", tk.mut, tk.card],
    ["onAcc", tk.onAcc, tk.acc],
  ];
  const bad = checks.map(([k, a, b]) => ({ k, r: contrast(a, b) })).filter((x) => x.r < 4.5);

  const input: React.CSSProperties = {
    padding: "6px 9px", borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: C.bg,
    border: `1px solid ${C.bdr2}`, color: C.txt, outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={scheme.name}
            maxLength={40}
            placeholder={t("settings.ui.editor.name")}
            onChange={(e) => onChange({ ...scheme, name: e.target.value })}
            style={{ ...input, flex: 1, minWidth: 160 }}
          />
          <span style={{ fontSize: 11, color: C.mut }}>{t("settings.ui.editor.base")}</span>
          <div style={{ display: "inline-flex", border: `1px solid ${C.bdr2}`, borderRadius: 8, overflow: "hidden" }}>
            {(["dark", "light"] as SchemeBase[]).map((b) => (
              <button
                key={b}
                onClick={() => onChange({ ...scheme, base: b })}
                style={{
                  padding: "6px 11px", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                  background: scheme.base === b ? C.accG2 : "transparent", color: scheme.base === b ? C.acc : C.mut,
                }}
              >
                {t(`settings.ui.theme.options.${b}`)}
              </button>
            ))}
          </div>
        </div>
        {GROUPS.map((g) => (
          <div key={g.key}>
            <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: C.mut, fontWeight: 600, marginBottom: 4 }}>
              {t(`settings.ui.editor.groups.${g.key}`)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
              {g.colors.map((k) => {
                const changed = scheme.colors[k] !== undefined;
                return (
                  <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: "3px 6px 3px 3px", borderRadius: 8, border: `1px solid ${changed ? C.accB : C.bdr}`, background: C.card }}>
                    <input
                      type="color"
                      value={tk[k].toLowerCase()}
                      onChange={(e) => setColor(k, e.target.value)}
                      style={{ width: 28, height: 24, padding: 0, border: "none", background: "transparent", cursor: "pointer", flexShrink: 0 }}
                    />
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <span style={{ fontSize: 12, color: C.txtS, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(`settings.ui.editor.colors.${k}`)}</span>
                      <span style={{ ...MONO, fontSize: 10, color: C.mut }}>{tk[k].toUpperCase()}</span>
                    </span>
                    {changed && (
                      <button
                        onClick={(e) => { e.preventDefault(); setColor(k, null); }}
                        title={t("settings.ui.editor.reset")}
                        aria-label={t("settings.ui.editor.reset")}
                        style={{ display: "flex", padding: 2, border: "none", background: "transparent", color: C.mut, cursor: "pointer" }}
                      >
                        <RotateCcw size={12} />
                      </button>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={{ width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: C.mut, fontWeight: 600 }}>{t("settings.ui.editor.preview")}</div>
        <Preview tk={tk} />
        {bad.map((b) => (
          <div key={b.k} style={{ fontSize: 11.5, color: C.org }}>
            {t("settings.ui.editor.contrast", { what: t(`settings.ui.editor.contrastWhat.${b.k}`), ratio: dec((Math.round(b.r * 10) / 10).toString()) })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ein Ausschnitt der App im Schema: Karte, Knöpfe, Status, Mini-Diagramm. */
function Preview({ tk }: { tk: ThemeTokens }) {
  const { t } = useTranslation();
  const line = (pts: number[], color: string, dash?: string) => (
    <polyline points={pts.map((y, i) => `${8 + i * 22},${60 - y}`).join(" ")} fill="none" stroke={color} strokeWidth={2} strokeDasharray={dash} strokeLinejoin="round" />
  );
  return (
    <div style={{ background: tk.bg, borderRadius: 10, padding: 10, border: `1px solid ${tk.bdr}` }}>
      <div style={{ background: tk.card, border: `1px solid ${tk.bdr}`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: tk.txt, flex: 1 }}>{t("settings.ui.editor.previewTitle")}</span>
          <span style={{ fontSize: 11, color: tk.acc, border: `1px solid ${tk.accB}`, background: tk.accG, borderRadius: 6, padding: "1px 6px" }}>{t("settings.ui.editor.previewChip")}</span>
        </div>
        <span style={{ fontSize: 11.5, color: tk.mut }}>{t("settings.ui.editor.previewSub")}</span>
        <svg viewBox="0 0 160 64" style={{ width: "100%", height: 70, background: tk.sunken, borderRadius: 6 }}>
          {line([2, 4, 30, 44, 42, 40, 38, 36], tk.seriesPressure)}
          {line([0, 0, 6, 14, 16, 16, 15, 15], tk.seriesFlow)}
          {line([0, 0, 2, 10, 20, 30, 38, 44], tk.seriesWeight, "4 2")}
          {line([2, 6, 36, 48, 46, 44, 42, 40], tk.seriesPressureB, "5 3")}
          {line([0, 0, 8, 12, 13, 13, 12, 12], tk.seriesFlowB, "5 3")}
          {line([50, 50, 50, 51, 51, 51, 51, 51], tk.seriesTemp)}
        </svg>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
          {[tk.grn, tk.org, tk.red].map((c, i) => <span key={i} style={{ width: 9, height: 9, borderRadius: 5, background: c }} />)}
          <span style={{ flex: 1 }} />
          <span style={{ padding: "5px 10px", borderRadius: 8, border: `1px solid ${tk.bdr2}`, background: tk.sunken, color: tk.txtS }}>{t("settings.ui.editor.cancel")}</span>
          <span style={{ padding: "5px 10px", borderRadius: 8, background: `linear-gradient(180deg,${tk.accTop},${tk.accBottom})`, color: tk.onAcc, fontWeight: 600 }}>
            {t("settings.ui.editor.previewButton")}
          </span>
        </div>
      </div>
      <div style={{ marginTop: 8, background: tk.cardElev, border: `1px solid ${tk.bdrL}`, borderRadius: 10, padding: "8px 10px", fontSize: 11.5, color: tk.txtS, boxShadow: `0 4px 16px ${alpha(tk.black, 0.25)}` }}>
        {t("settings.ui.editor.previewWindow")}
      </div>
    </div>
  );
}

