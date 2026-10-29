/**
 * ShotEditModal — edits the editable fields of a recorded shot.
 *
 * Fields: bean (or free-text bean label), grinder, basket (brew shots), grind setting, RPM, dose, TDS, notes.
 *
 * Die BEWERTUNG wird hier nicht als Sternenreihe nachgebaut, sondern an den
 * Bewertungsscreen abgegeben — derselbe Weg wie im Bezugs-Detail. Vorher gab
 * es hier nur die Gesamtnote, waehrend Saeure, Bitterkeit, Extraktion,
 * Channeling, Geschmacksnoten und Mahlgrad-Hinweis nur ueber das Detail
 * erreichbar waren: zwei Wege zur selben Sache, einer davon unvollstaendig.
 * Saving sends a PUT via the onSave callback; closing with unsaved changes
 * asks for confirmation.
 */

import { useState } from "react";
import { Star, X } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import { useBeans } from "../hooks/useBeans.js";
import { useGrinders } from "../hooks/useGrinders.js";
import { useBaskets, basketName } from "../hooks/useBaskets.js";
import { BeanPicker, BeanLabelInput } from "./BeanPicker.js";
import { RatingModal, ratingFacts } from "./RatingModal.js";
import { ratingValuesToPatch } from "./RatingScreen.js";
import { hasRating } from "@shared/shot-rating.js";
import type { ShotRatingValues } from "./RatingScreen.js";
import type { ShotListItem, ShotUpdate } from "@shared/types.js";
import theme, { alpha } from "../theme.js";

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

const monoInputStyle: React.CSSProperties = {
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
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}


/** Empty string represents "no value" for the optional number/rating fields. */
function numToStr(n: number | null): string {
  return n !== null ? String(n) : "";
}

interface ShotEditModalProps {
  shot: ShotListItem;
  onSave: (patch: ShotUpdate) => Promise<void>;
  onClose: () => void;
}

export function ShotEditModal({ shot, onSave, onClose }: ShotEditModalProps) {
  const { t } = useTranslation();
  const { beans } = useBeans();
  const { grinders } = useGrinders();
  const { baskets } = useBaskets();

  const [beanId, setBeanId]           = useState<number | null>(shot.beanId);
  // Fremdbohne als Freitext — wie in „Bezug vorbereiten“, nur ohne gepflegte Bohne.
  const [beanLabel, setBeanLabel]     = useState(shot.beanLabel ?? "");
  // Schnitt 3e: das benutzte Sieb, korrigierbar — nur bei Bezuegen (Wartung hat keins).
  const [basketId, setBasketId]       = useState<number | null>(shot.basketId ?? null);
  const [grinderId, setGrinderId]     = useState<number | null>(shot.grinderId);
  const [grindSetting, setGrindSetting] = useState(numToStr(shot.grindSetting));
  const [grinderRpm, setGrinderRpm]   = useState(numToStr(shot.grinderRpm));
  const [doseG, setDoseG]             = useState(numToStr(shot.doseG));
  const [tdsPercent, setTdsPercent]   = useState(numToStr(shot.tdsPercent));
  const [notes, setNotes]             = useState(shot.notes ?? "");
  // Vollstaendige Bewertung, wie sie der Bewertungsscreen fuehrt. Lokale Kopie,
  // damit die Zeile sofort stimmt — der `shot`-Prop ist ein Schnappschuss.
  const [rv, setRv] = useState<ShotRatingValues>({
    rating: shot.rating,
    acidity: shot.acidity,
    bitterness: shot.bitterness,
    extractionUnder: shot.extractionUnder,
    extractionOver: shot.extractionOver,
    channeling: shot.channeling,
    channelingSeverity: shot.channelingSeverity ?? null,
    tasteTags: shot.tasteTags ?? [],
    grindNote: shot.grindNote,
    notes: shot.notes ?? "",
    vsPrev: shot.vsPrev ?? null,
    vsPrevShotId: shot.vsPrevShotId ?? null,
  });
  const [ratingOpen, setRatingOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  // §3j/§3l: the shared BeanPicker handles active-source filtering, ordering and
  // the "(inaktiv)" carry-over marker for the currently-assigned roasting.

  // Dirty check — compare the form back to the shot's stored values.
  const dirty =
    basketId !== (shot.basketId ?? null) ||
    beanId !== shot.beanId ||
    (beanId === null ? beanLabel.trim() || null : null) !== (shot.beanId === null ? shot.beanLabel : null) ||
    grinderId !== shot.grinderId ||
    grindSetting !== numToStr(shot.grindSetting) ||
    grinderRpm !== numToStr(shot.grinderRpm) ||
    doseG !== numToStr(shot.doseG) ||
    tdsPercent !== numToStr(shot.tdsPercent) ||
    (notes.trim() || null) !== shot.notes;

  const handleClose = () => {
    if (dirty && !window.confirm(t("history.editModal.unsavedConfirm"))) return;
    onClose();
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: ShotUpdate = {
        ...(basketId !== null && basketId !== (shot.basketId ?? null) ? { basketId } : {}),
        beanId,
        beanLabel: beanId === null && beanLabel.trim() !== "" ? beanLabel.trim() : null,
        grinderId,
        grindSetting: grindSetting.trim() !== "" ? parseFloat(grindSetting) : null,
        grinderRpm: grinderRpm.trim() !== "" ? parseInt(grinderRpm, 10) : null,
        doseG: doseG.trim() !== "" ? parseFloat(doseG) : null,
        tdsPercent: tdsPercent.trim() !== "" ? parseFloat(tdsPercent) : null,
        notes: notes.trim() !== "" ? notes.trim() : null,
      };
      await onSave(patch);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <>
    <div
      onClick={handleClose}
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
          width: "min(440px, 96vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: `0 8px 40px ${alpha(C.black, 0.5)}`,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.txt }}>
            {t("history.editModal.title")}
          </h2>
          <button
            onClick={handleClose}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex" }}
          >
            <X size={18} />
          </button>
        </div>

        <Field label={t("history.editModal.bean")}>
          <BeanPicker
            beans={beans}
            value={beanId}
            onChange={setBeanId}
            style={inputStyle}
          />
          {beanId === null && (
            <BeanLabelInput
              listId="shotedit-bean-labels"
              value={beanLabel}
              onChange={setBeanLabel}
              style={{ ...inputStyle, marginTop: 6 }}
            />
          )}
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: shot.category === "brew" ? "1fr 1fr" : "1fr", gap: 10 }}>
          <Field label={t("history.editModal.grinder")}>
            <select
              style={inputStyle}
              value={grinderId ?? ""}
              onChange={(e) => setGrinderId(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">{t("history.editModal.noGrinder")}</option>
              {grinders.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </Field>
          {shot.category === "brew" && (
            <Field label={t("history.editModal.basket")}>
              <select
                style={inputStyle}
                value={basketId ?? ""}
                onChange={(e) => setBasketId(e.target.value === "" ? null : Number(e.target.value))}
              >
                {basketId === null && <option value="">—</option>}
                {baskets.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <Field label={t("history.editModal.grindSetting")}>
            <input
              style={monoInputStyle}
              type="number"
              step={0.1}
              value={grindSetting}
              onChange={(e) => setGrindSetting(e.target.value)}
            />
          </Field>
          <Field label={t("history.editModal.grinderRpm")}>
            <input
              style={monoInputStyle}
              type="number"
              step={1}
              value={grinderRpm}
              onChange={(e) => setGrinderRpm(e.target.value)}
            />
          </Field>
          <Field label={t("history.editModal.dose")}>
            <input
              style={monoInputStyle}
              type="number"
              step={0.1}
              min={0}
              value={doseG}
              onChange={(e) => setDoseG(e.target.value)}
            />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
          <Field label={t("history.editModal.tds")}>
            <input
              style={monoInputStyle}
              type="number"
              step={0.01}
              min={0}
              value={tdsPercent}
              onChange={(e) => setTdsPercent(e.target.value)}
            />
          </Field>
          <Field label={t("history.editModal.rating")}>
            {/* Kein zweiter, unvollstaendiger Bewertungsweg: derselbe Screen wie
                im Bezugs-Detail, damit beide Wege dasselbe koennen. */}
            <button
              type="button"
              onClick={() => { setRatingOpen(true); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "8px 10px", borderRadius: 7, background: C.bg,
                border: `1px solid ${C.bdr}`, color: C.txt, fontSize: 13,
                fontFamily: "inherit", cursor: "pointer", textAlign: "left",
              }}
            >
              <Star size={14} color={rv.rating !== null ? C.acc : C.mut}
                fill={rv.rating !== null ? C.acc : "none"} />
              <span>
                {rv.rating !== null
                  ? `${rv.rating}/5`
                  : hasRating(rv)
                    ? t("history.editModal.ratingNoStars")
                    : t("history.editModal.ratingNone")}
              </span>
              <span style={{ marginLeft: "auto", color: C.acc, fontSize: 12, fontWeight: 600 }}>
                {t("history.editModal.ratingOpen")}
              </span>
            </button>
          </Field>
        </div>

        <Field label={t("history.editModal.notes")}>
          <textarea
            style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        {error && (
          <div style={{ color: C.red, fontSize: 12, margin: "4px 0 8px" }}>{error}</div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            onClick={handleClose}
            disabled={saving}
            style={{
              flex: 1,
              padding: "9px 0",
              borderRadius: 8,
              background: "transparent",
              border: `1px solid ${C.bdr}`,
              color: C.mut,
              fontSize: 13,
              fontWeight: 500,
              cursor: saving ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("history.editModal.cancel")}
          </button>
          <button
            onClick={() => { void handleSave(); }}
            disabled={saving}
            style={{
              flex: 2,
              padding: "9px 0",
              borderRadius: 8,
              background: C.accG2,
              border: `1px solid ${C.accB}`,
              color: C.acc,
              fontSize: 13,
              fontWeight: 600,
              cursor: saving ? "wait" : "pointer",
              opacity: saving ? 0.6 : 1,
              fontFamily: "inherit",
            }}
          >
            {t("history.editModal.save")}
          </button>
        </div>
      </div>
    </div>

      {ratingOpen && (
        <RatingModal
          shotId={shot.id}
          initial={rv}
          headerLabel={basketName(baskets, shot.basketId) ?? (shot.shotSize === "single" ? "1×" : "2×")}
          facts={ratingFacts(shot, shot.profileName, basketName(baskets, shot.basketId) ?? (shot.shotSize === "single" ? "1×" : "2×"))}
          cancelLabel={t("shotRating.cancel")}
          onSave={async (v) => {
            await onSave(ratingValuesToPatch(v));
            setRv(v);
            // Die Notiz gehoert beiden Masken: ohne diese Zeile wuerde das
            // spaetere Speichern hier die gerade gesetzte wieder ueberschreiben.
            setNotes(v.notes);
            setRatingOpen(false);
          }}
          onClose={() => { setRatingOpen(false); }}
        />
      )}
    </>
  );
}
