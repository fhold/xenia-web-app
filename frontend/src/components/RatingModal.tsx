/**
 * RatingModal — modal chrome around the shared RatingScreen. Used both by the
 * auto-opening post-shot review (after a brew ends) and by the History detail
 * "Bewerten" flow. Persistence is delegated to `onSave` so each caller can
 * wire it up (raw PUT vs. useShots.update with list refetch).
 *
 * Rating is optional: "Überspringen" / X close without saving.
 */

import { useState } from "react";
import { X, Check, ShieldAlert, Package } from "lucide-react";
import { RatingScreen } from "./RatingScreen.js";
import type { ShotRatingValues } from "./RatingScreen.js";
import { useTranslation } from "../i18n/index.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

interface RatingModalProps {
  initial: ShotRatingValues;
  /** Small mono label shown right of the title, e.g. "1× · 24.6 g". */
  headerLabel?: string;
  mobile?: boolean;
  /** Cancel/skip label — "Überspringen" (post-brew) or "Abbrechen" (re-rate). */
  cancelLabel?: string;
  /** Optional warning banner shown above the rating (e.g. watchdog intervened). */
  notice?: string;
  /**
   * PT-2: post-shot reset prompt. Only set when a profile-temp set armed a reset
   * this session. Ja restores the previous BG setpoint; Nein dismisses. Either
   * way the element hides afterwards.
   */
  resetPrompt?: {
    previousSetpointC: number;
    onApply: () => void | Promise<void>;
    onDismiss: () => void | Promise<void>;
  };
  /**
   * Aufgebraucht-Hinweis für die Röstung dieses Bezugs. Bewusst hier statt in
   * einem eigenen Dialog: das Bewertungs-Modal öffnet nach jedem Bezug ohnehin
   * automatisch, ein zweites Fenster obendrauf wäre ein Stapel.
   */
  stockPrompt?: {
    /** Fertig formatiert, z.B. "Deepwood (09.06.) ist leer · −206 g / 250 g". */
    label: string;
    /** Reserve-Röstungen derselben Sorte; leer = nur archivieren. */
    candidates: { id: number; label: string }[];
    onArchive: (openNextId: number | null) => void | Promise<void>;
    onDismiss: () => void | Promise<void>;
  };
  /** Persist the rating. Resolves before the modal closes. */
  onSave: (values: ShotRatingValues) => Promise<void>;
  /** Close without saving (skip / cancel / X / backdrop). */
  onClose: () => void;
}

export function RatingModal({ initial, headerLabel, mobile = false, cancelLabel, notice, resetPrompt, stockPrompt, onSave, onClose }: RatingModalProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<ShotRatingValues>(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetAnswered, setResetAnswered] = useState(false); // PT-2: hide prompt after Ja/Nein
  const [stockAnswered, setStockAnswered] = useState(false);
  const [nextBagId, setNextBagId] = useState<number | null>(stockPrompt?.candidates[0]?.id ?? null);
  const cancelText = cancelLabel ?? t("shotRating.skip");

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(values);
      onClose();
    } catch (err) {
      // Closing on a failed save throws the input away — the post-shot review
      // opens only once per shot. Stay open and say why instead.
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: C.overlay,
        backdropFilter: "blur(4px)",
        zIndex: 110,
        display: "flex",
        alignItems: mobile ? "stretch" : "center",
        justifyContent: "center",
        padding: mobile ? 0 : 16,
      }}
    >
      <div
        onClick={(e) => { e.stopPropagation(); }}
        style={{
          background: C.cardElev,
          border: mobile ? "none" : `1px solid ${C.bdrL}`,
          padding: mobile ? `calc(16px + ${C.safeTop}) 24px 16px` : "16px 24px 16px",
          width: mobile ? "100%" : "min(860px, 94vw)",
          maxHeight: mobile ? "100%" : "92vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          borderRadius: mobile ? 0 : 18,
          boxShadow: mobile ? "none" : `0 16px 60px ${alpha(C.black, 0.55)}`,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.txt }}>
              {t("shotRating.title")}
            </span>
            {headerLabel && (
              <span style={{ ...MONO, fontSize: 12, color: C.mut, marginLeft: 8 }}>{headerLabel}</span>
            )}
          </div>
          <button
            onClick={onClose}
            title={cancelText}
            style={{
              background: "transparent",
              border: "none",
              color: C.mut,
              cursor: "pointer",
              padding: 2,
              display: "flex",
              flexShrink: 0,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {notice && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 12px",
              borderRadius: 10,
              background: C.orgD,
              color: C.org,
              fontSize: 12.5,
              fontWeight: 500,
            }}
          >
            <ShieldAlert size={15} style={{ flexShrink: 0 }} />
            <span>{notice}</span>
          </div>
        )}

        {resetPrompt && !resetAnswered && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              background: C.sunken,
              border: `1px solid ${C.bdr2}`,
              fontSize: 12.5,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, color: C.txtS }}>
              {t("preshot.resetPrompt")}{" "}
              <span style={{ ...MONO, color: C.txt }}>
                {resetPrompt.previousSetpointC.toFixed(1)} °C
              </span>
              ?
            </span>
            <button
              onClick={() => { setResetAnswered(true); void resetPrompt.onDismiss(); }}
              style={{
                flexShrink: 0,
                padding: "5px 12px",
                borderRadius: 7,
                background: "transparent",
                border: `1px solid ${C.bdr2}`,
                color: C.txtS,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("preshot.resetNo")}
            </button>
            <button
              onClick={() => { setResetAnswered(true); void resetPrompt.onApply(); }}
              style={{
                flexShrink: 0,
                padding: "5px 12px",
                borderRadius: 7,
                background: C.accG2,
                border: `1px solid ${C.accB}`,
                color: C.acc,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("preshot.resetYes")}
            </button>
          </div>
        )}

        {stockPrompt && !stockAnswered && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              background: C.sunken,
              border: `1px solid ${C.bdr2}`,
              fontSize: 12.5,
            }}
          >
            <Package size={15} color={C.org} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 140, color: C.txtS }}>{stockPrompt.label}</span>
            {stockPrompt.candidates.length > 0 && (
              <select
                value={nextBagId ?? ""}
                onChange={(e) => { setNextBagId(e.target.value ? Number(e.target.value) : null); }}
                style={{
                  flexShrink: 0, padding: "5px 8px", borderRadius: 7, background: C.bg,
                  border: `1px solid ${C.bdr2}`, color: C.txt, fontSize: 12, fontFamily: "inherit",
                }}
              >
                {stockPrompt.candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
                <option value="">{t("stockAlert.noNext")}</option>
              </select>
            )}
            <button
              onClick={() => { setStockAnswered(true); void stockPrompt.onDismiss(); }}
              style={{
                flexShrink: 0, padding: "5px 12px", borderRadius: 7, background: "transparent",
                border: `1px solid ${C.bdr2}`, color: C.txtS, fontSize: 12, fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              {t("stockAlert.dismiss")}
            </button>
            <button
              onClick={() => { setStockAnswered(true); void stockPrompt.onArchive(nextBagId); }}
              style={{
                flexShrink: 0, padding: "5px 12px", borderRadius: 7, background: C.accG2,
                border: `1px solid ${C.accB}`, color: C.acc, fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              {nextBagId !== null ? t("stockAlert.archiveAndOpen") : t("stockAlert.archive")}
            </button>
          </div>
        )}

        <RatingScreen initial={values} onChange={setValues} mobile={mobile} />

        {saveError !== null && (
          <div
            style={{
              marginBottom: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: C.redD,
              border: `1px solid ${C.red}`,
              color: C.txt,
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {saveError}
          </div>
        )}

        {/* Footer: cancel/skip (ghost, no write) + save (primary gradient) */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: "10px 0",
              borderRadius: 10,
              background: "transparent",
              border: `1px solid ${C.bdr2}`,
              color: C.txtS,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={() => { void save(); }}
            disabled={saving}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              padding: "10px 0",
              borderRadius: 10,
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
            <Check size={15} />
            {t("shotRating.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
