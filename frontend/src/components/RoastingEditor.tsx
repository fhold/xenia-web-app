/**
 * RoastingEditor — modal to create ("Nachkaufen") or edit a Röstung (Bean) — §3.4b.
 * Create mode shows only roast date / bag size / price (inherits master data
 * from the coffee). Edit mode adds remaining, status and freeze/thaw dates.
 */

import { useState, useCallback } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import type { Bean, BeanStatus, BeanUpdate } from "@shared/types.js";
import theme from "../theme.js";
import {
  RoastDateField,
  BagSizeField,
  PriceField,
  StatusField,
  ActiveSourceField,
} from "./RoastingFields.js";

const C = theme;
const MONO = "'JetBrains Mono', monospace";
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 7, background: C.bg,
  border: `1px solid ${C.bdr}`, color: C.txt, fontSize: 13, fontFamily: "inherit",
  boxSizing: "border-box", outline: "none",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 10, color: C.mut, fontWeight: 600,
  textTransform: "uppercase", letterSpacing: 1, marginBottom: 4,
};
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 10 }}><label style={labelStyle}>{label}</label>{children}</div>;
}
function TwoCol({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>;
}

interface Props {
  /** Edit an existing roasting; omit for "Nachkaufen" (create). */
  roasting?: Bean;
  coffeeName: string;
  /** F-B8: on "Nachkaufen", prefill bag size + price from the latest roasting. */
  prefill?: { bagSizeG: number | null; pricePerBagEur: number | null };
  onSave: (data: BeanUpdate) => Promise<void>;
  onClose: () => void;
}

export function RoastingEditor({ roasting, coffeeName, prefill, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const isEdit = roasting !== undefined;

  // Create ("Nachkaufen"): roast date stays empty; bag size + price prefilled
  // from the latest roasting; remaining defaults to the full bag on save.
  const [roastDate, setRoastDate] = useState(roasting?.roastDate ?? "");
  const initBag = roasting?.bagSizeG ?? prefill?.bagSizeG ?? null;
  const initPrice = roasting?.pricePerBagEur ?? prefill?.pricePerBagEur ?? null;
  const [bagSize, setBagSize] = useState(initBag != null ? String(initBag) : "");
  const initRemaining = roasting?.remainingG != null ? String(roasting.remainingG) : "";
  const [remaining, setRemaining] = useState(initRemaining);
  const [price, setPrice] = useState(initPrice != null ? String(initPrice) : "");
  const [status, setStatus] = useState<BeanStatus>(roasting?.status ?? "stock");
  const [isActive, setIsActive] = useState<boolean>(roasting?.isActive ?? false);
  const [frozenDate, setFrozenDate] = useState(roasting?.frozenDate ?? "");
  const [thawDate, setThawDate] = useState(roasting?.thawDate ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true); setErr(null);
    try {
      const data: BeanUpdate = {
        roastDate: roastDate || null,
        bagSizeG: bagSize ? parseFloat(bagSize) : null,
        pricePerBagEur: price ? parseFloat(price) : null,
      };
      if (isEdit) {
        // Nur bei echter Aenderung mitsenden: der Restbestand wird aus den
        // Bezuegen abgeleitet, ein gesendeter Wert setzt einen manuellen
        // Korrektur-Anker. Unveraendertes Durchreichen wuerde jede beliebige
        // Bearbeitung (z.B. Einfrierdatum) still zum Anker machen.
        if (remaining !== initRemaining) data.remainingG = remaining ? parseFloat(remaining) : null;
        data.status = status;
        data.isActive = isActive;
        data.frozenDate = frozenDate || null;
        // Das Auftaudatum-Feld wird nur bei Status 'thawed' gezeigt. Es trotzdem
        // immer mitzusenden schrieb ein unsichtbares Datum aus dem vorigen Zyklus
        // zurück — lag es vor dem frozenDate, wurde die Frostdauer negativ und das
        // Einfrieren fiel aus der Altersrechnung.
        data.thawDate = status === "thawed" ? thawDate || null : null;
      }
      await onSave(data);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [roastDate, bagSize, remaining, initRemaining, price, status, isActive, frozenDate, thawDate, isEdit, onSave, onClose]);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 200 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 201,
        width: "min(480px, 96vw)", maxHeight: "90vh", overflowY: "auto", background: C.cardElev,
        border: `1px solid ${C.bdrL}`, borderRadius: 14, padding: "20px 24px 24px",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.txt }}>
              {isEdit ? t("coffee.editRoasting") : t("coffee.newRoasting")}
            </h2>
            <div style={{ fontSize: 12, color: C.mut, marginTop: 2 }}>{coffeeName}</div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex" }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ marginTop: 14 }}>
          <TwoCol>
            <RoastDateField value={roastDate} onChange={setRoastDate} />
            <BagSizeField value={bagSize} onChange={setBagSize} />
          </TwoCol>
          <TwoCol>
            <PriceField value={price} onChange={setPrice} />
            {isEdit && (
              <Field label={t("beans.fields.remainingG")}>
                <input style={{ ...inputStyle, fontFamily: MONO }} type="number" min={0} value={remaining} onChange={(e) => setRemaining(e.target.value)} />
              </Field>
            )}
          </TwoCol>

          {isEdit && (
            <>
              <StatusField value={status} onChange={setStatus} />
              <ActiveSourceField value={isActive} onChange={setIsActive} />
              {(status === "frozen" || status === "thawed") && (
                <TwoCol>
                  <Field label={t("beans.fields.frozenDate")}>
                    <input style={inputStyle} type="date" value={frozenDate} onChange={(e) => setFrozenDate(e.target.value)} />
                  </Field>
                  {status === "thawed" && (
                    <Field label={t("beans.fields.thawDate")}>
                      <input style={inputStyle} type="date" value={thawDate} onChange={(e) => setThawDate(e.target.value)} />
                    </Field>
                  )}
                </TwoCol>
              )}
            </>
          )}
        </div>

        {err && <div style={{ color: C.red, fontSize: 12, margin: "8px 0" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.bdr}`, borderRadius: 8, padding: "8px 16px", color: C.mut, fontSize: 13, cursor: "pointer" }}>
            {t("coffee.cancel")}
          </button>
          <button onClick={() => void handleSave()} disabled={saving}
            style={{ background: C.accG2, border: `1px solid ${C.accB}`, borderRadius: 8, padding: "8px 18px", color: C.acc, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {saving ? t("coffee.saving") : t("coffee.save")}
          </button>
        </div>
      </div>
    </>
  );
}
