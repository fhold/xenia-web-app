/**
 * RoastingFields — shared, controlled field widgets for a Röstung (Bean).
 * Used by both RoastingEditor ("Nachkaufen"/edit) and the CoffeeEditor "Erste
 * Röstung" section (§3.4b) so there is a single, non-divergent input mask.
 * Each component renders its own labelled <Field>; the caller arranges them.
 */

import { Check } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import type { BeanStatus } from "@shared/types.js";
import theme from "../theme.js";

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

export function RoastDateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t("beans.fields.roastDate")}>
      <input style={inputStyle} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function BagSizeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t("beans.fields.bagSizeG")}>
      <input style={{ ...inputStyle, fontFamily: MONO }} type="number" min={0} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function PriceField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t("beans.fields.pricePerBagEur")}>
      <input style={{ ...inputStyle, fontFamily: MONO }} type="number" min={0} step={0.01} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function StatusField({ value, onChange }: { value: BeanStatus; onChange: (v: BeanStatus) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t("beans.status.label")}>
      <select style={inputStyle} value={value} onChange={(e) => onChange(e.target.value as BeanStatus)}>
        <option value="stock">{t("beans.status.stock")}</option>
        <option value="frozen">{t("beans.status.frozen")}</option>
        <option value="thawed">{t("beans.status.thawed")}</option>
        <option value="archived">{t("beans.status.archived")}</option>
      </select>
    </Field>
  );
}

export function ActiveSourceField({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t("coffee.activeSource")}>
      <button
        type="button"
        onClick={() => onChange(!value)}
        style={{
          display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "9px 11px",
          borderRadius: 7, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left",
          border: `1px solid ${value ? C.accB : C.bdr}`,
          background: value ? C.accG : "transparent",
          color: value ? C.acc : C.txtS,
        }}
      >
        <span style={{
          width: 16, height: 16, borderRadius: 5, flexShrink: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          border: `1px solid ${value ? C.accB : C.bdr}`,
          background: value ? C.acc : "transparent",
        }}>
          {value && <Check size={12} color={C.bg} />}
        </span>
        {t("coffee.activeSourceHint")}
      </button>
    </Field>
  );
}
