/**
 * BasketEditor — Dialog zum Anlegen oder Bearbeiten eines Siebs (wie GrinderEditor).
 * Felder: Name (kurz, Pflicht), Beschreibung (frei) und Nenndosis (g). Einen
 * Typ gibt es nicht mehr — das Sieb selbst ist die Einheit.
 */

import { useState, useCallback } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import type { Basket, BasketCreate } from "@shared/types.js";
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

interface BasketEditorProps {
  basket?: Basket;
  onSave: (data: BasketCreate) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}

export function BasketEditor({ basket, onSave, onDelete, onClose }: BasketEditorProps) {
  const { t } = useTranslation();
  const isEdit = basket !== undefined;
  const [name, setName] = useState(basket?.name ?? "");
  const [description, setDescription] = useState(basket?.description ?? "");
  const [dose, setDose] = useState(basket?.nominalDoseG != null ? String(basket.nominalDoseG).replace(".", ",") : "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setSaveError(t("settings.baskets.nameRequired")); return; }
    const doseRaw = dose.trim().replace(",", ".");
    const nominalDoseG = doseRaw === "" ? null : Number(doseRaw);
    if (nominalDoseG !== null && !(Number.isFinite(nominalDoseG) && nominalDoseG > 0 && nominalDoseG <= 40)) {
      setSaveError(t("settings.baskets.doseInvalid"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ name: name.trim(), description: description.trim() || null, nominalDoseG });
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [name, description, dose, onSave, onClose, t]);

  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    if (!window.confirm(t("settings.baskets.deleteConfirm"))) return;
    setDeleting(true);
    try { await onDelete(); onClose(); }
    catch (err) { setSaveError(err instanceof Error ? err.message : String(err)); }
    finally { setDeleting(false); }
  }, [onDelete, onClose, t]);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 100 }} />
      <div
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 101,
          width: "min(420px, 95vw)", background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 14,
          padding: "20px 24px 24px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.txt }}>
            {isEdit ? t("settings.baskets.editTitle") : t("settings.baskets.createTitle")}
          </h2>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex" }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t("settings.baskets.fields.name")}</label>
          <input
            style={inputStyle}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.baskets.fields.namePlaceholder")}
            autoFocus
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t("settings.baskets.fields.description")}</label>
          <input
            style={inputStyle}
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("settings.baskets.fields.descriptionPlaceholder")}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>{t("settings.baskets.fields.nominalDose")}</label>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              style={{ ...inputStyle, width: 90 }}
              value={dose}
              inputMode="decimal"
              onChange={(e) => setDose(e.target.value)}
              placeholder="–"
            />
            <span style={{ fontSize: 12, color: C.mut }}>g</span>
          </div>
        </div>

        {saveError && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{saveError}</div>}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <div>
            {isEdit && onDelete && (
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                style={{ background: C.redD, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 14px", color: C.red, fontSize: 13, cursor: "pointer" }}
              >
                {deleting ? "…" : t("settings.baskets.delete")}
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{ background: "transparent", border: `1px solid ${C.bdr}`, borderRadius: 8, padding: "8px 16px", color: C.mut, fontSize: 13, cursor: "pointer" }}
            >
              {t("settings.baskets.cancel")}
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ background: C.accG2, border: `1px solid ${C.accB}`, borderRadius: 8, padding: "8px 18px", color: C.acc, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              {saving ? t("settings.baskets.saving") : t("settings.baskets.save")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
