/**
 * GrinderEditor — modal for creating or editing a grinder.
 * Fields: name (required), supports_rpm toggle,
 *         rpm_min + rpm_max (shown only when supports_rpm), notes.
 */

import { useState, useCallback } from "react";
import { X } from "lucide-react";
import { Toggle } from "./Toggle.js";
import { useTranslation } from "../i18n/index.js";
import type { Grinder, GrinderCreate, GrinderUpdate } from "@shared/types.js";
import theme from "../theme.js";

const C = theme;

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
    <div style={{ marginBottom: 12 }}>
      {label && <label style={labelStyle}>{label}</label>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface GrinderEditorProps {
  grinder?: Grinder;
  onSave: (data: GrinderCreate | GrinderUpdate) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}

export function GrinderEditor({ grinder, onSave, onDelete, onClose }: GrinderEditorProps) {
  const { t } = useTranslation();
  const isEdit = grinder !== undefined;

  const [name, setName]             = useState(grinder?.name ?? "");
  const [supportsRpm, setSupports]  = useState(grinder?.supportsRpm ?? false);
  const [rpmMin, setRpmMin]         = useState(grinder?.rpmMin != null ? String(grinder.rpmMin) : "");
  const [rpmMax, setRpmMax]         = useState(grinder?.rpmMax != null ? String(grinder.rpmMax) : "");
  const [notes, setNotes]           = useState(grinder?.notes ?? "");

  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [deleting, setDeleting]     = useState(false);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setSaveError("Name ist erforderlich."); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const data: GrinderCreate = {
        name: name.trim(),
        supportsRpm,
        rpmMin: supportsRpm && rpmMin ? parseInt(rpmMin, 10) : null,
        rpmMax: supportsRpm && rpmMax ? parseInt(rpmMax, 10) : null,
        notes: notes.trim() || null,
      };
      await onSave(data);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [name, supportsRpm, rpmMin, rpmMax, notes, onSave, onClose]);

  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    if (!window.confirm(t("settings.grinders.deleteConfirm"))) return;
    setDeleting(true);
    try { await onDelete(); onClose(); }
    finally { setDeleting(false); }
  }, [onDelete, onClose, t]);

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 100 }}
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 101,
          width: "min(420px, 95vw)",
          background: C.cardElev,
          border: `1px solid ${C.bdrL}`,
          borderRadius: 14,
          padding: "20px 24px 24px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.txt }}>
            {isEdit ? t("settings.grinders.editTitle") : t("settings.grinders.createTitle")}
          </h2>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex" }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Name */}
        <Field label={t("settings.grinders.fields.name")}>
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.grinders.fields.namePlaceholder")}
            autoFocus
          />
        </Field>

        {/* RPM toggle */}
        <Field label="">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 13, color: C.txt, fontWeight: 500 }}>
                {t("settings.grinders.fields.supportsRpm")}
              </div>
              <div style={{ fontSize: 11, color: C.mut, marginTop: 2 }}>
                {t("settings.grinders.fields.supportsRpmDesc")}
              </div>
            </div>
            <Toggle checked={supportsRpm} onChange={setSupports} />
          </div>
        </Field>

        {/* RPM range — only shown when supports_rpm */}
        {supportsRpm && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label={t("settings.grinders.fields.rpmMin")}>
              <input
                style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                type="number"
                min={0}
                value={rpmMin}
                onChange={(e) => setRpmMin(e.target.value)}
                placeholder="400"
              />
            </Field>
            <Field label={t("settings.grinders.fields.rpmMax")}>
              <input
                style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                type="number"
                min={0}
                value={rpmMax}
                onChange={(e) => setRpmMax(e.target.value)}
                placeholder="1200"
              />
            </Field>
          </div>
        )}

        {/* Notes */}
        <Field label={t("settings.grinders.fields.notes")}>
          <textarea
            style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("settings.grinders.fields.notesPlaceholder")}
          />
        </Field>

        {saveError && (
          <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{saveError}</div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <div>
            {isEdit && onDelete && (
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                style={{
                  background: C.redD, border: `1px solid ${C.red}30`, borderRadius: 8,
                  padding: "8px 14px", color: C.red, fontSize: 13, cursor: "pointer",
                }}
              >
                {deleting ? "…" : t("settings.grinders.delete")}
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                background: "transparent", border: `1px solid ${C.bdr}`, borderRadius: 8,
                padding: "8px 16px", color: C.mut, fontSize: 13, cursor: "pointer",
              }}
            >
              {t("settings.grinders.cancel")}
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                background: C.accG2, border: `1px solid ${C.accB}`, borderRadius: 8,
                padding: "8px 18px", color: C.acc, fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              {saving ? t("settings.grinders.saving") : t("settings.grinders.save")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
