/**
 * CoffeeEditor — modal to create or edit a Coffee (Sorte) — §3.4b master data.
 * Master data only (name, roaster, origin, processing, roast level, brew type,
 * flavour notes, notes, rating, favourite). Roasting fields live in RoastingEditor.
 */

import { useState, useCallback, useEffect, KeyboardEvent } from "react";
import { X, Plus, FileUp, Upload, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { Toggle } from "./Toggle.js";
import { useTranslation } from "../i18n/index.js";
import type {
  Coffee,
  CoffeeCreatePayload,
  CoffeeUpdate,
  CoffeeFirstRoasting,
  RoastLevel,
  BeanRating,
  BeanStatus,
  BrewType,
  MatchCandidate,
} from "@shared/types.js";
import theme from "../theme.js";
import { RoastDateField, BagSizeField, PriceField, StatusField, ActiveSourceField } from "./RoastingFields.js";

const C = theme;

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 7, background: C.bg,
  border: `1px solid ${C.bdr}`, color: C.txt, fontSize: 13, fontFamily: "inherit",
  boxSizing: "border-box", outline: "none",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 10, color: C.mut, fontWeight: 600,
  textTransform: "uppercase", letterSpacing: 1, marginBottom: 4,
};
const sectionStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: C.acc,
  textTransform: "uppercase", padding: "16px 0 8px", borderBottom: `1px solid ${C.bdr}`,
  marginBottom: 12,
};
const MONO = "'JetBrains Mono', monospace";

// §3i: enum allow-lists for the single-JSON-import (validate against the CHECK enums).
const ROAST_LEVEL_SET = new Set<RoastLevel>(["light", "light-medium", "medium", "medium-dark", "dark"]);
const BREW_TYPE_SET = new Set<BrewType>(["espresso", "filter", "omni"]);
const BEAN_STATUS_SET = new Set<BeanStatus>(["stock", "frozen", "thawed", "archived"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 10 }}><label style={labelStyle}>{label}</label>{children}</div>;
}
function TwoCol({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>;
}
function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
            style={{
              flex: 1, padding: "7px 4px", borderRadius: 7, fontSize: 12, fontFamily: "inherit",
              cursor: "pointer", background: active ? C.accG2 : C.bg,
              border: `1px solid ${active ? C.accB : C.bdr}`, color: active ? C.acc : C.mut,
              fontWeight: active ? 600 : 400,
            }}>{opt.label}</button>
        );
      })}
    </div>
  );
}

interface Props {
  coffee?: Coffee;
  onSave: (data: CoffeeCreatePayload | CoffeeUpdate) => Promise<void>;
  onClose: () => void;
  /** §3i: matcher for the single-JSON-import duplicate warning (create mode only). */
  match?: (name: string, roaster: string | null) => Promise<MatchCandidate[]>;
  /** §3i: jump to an existing coffee (append a roasting there instead of a new Sorte). */
  onJumpToCoffee?: (coffeeId: number) => void;
}

export function CoffeeEditor({ coffee, onSave, onClose, match, onJumpToCoffee }: Props) {
  const { t } = useTranslation();
  const isEdit = coffee !== undefined;

  const [name, setName] = useState(coffee?.name ?? "");
  const [roaster, setRoaster] = useState(coffee?.roaster ?? "");
  const [country, setCountry] = useState(coffee?.country ?? "");
  const [region, setRegion] = useState(coffee?.region ?? "");
  const [farm, setFarm] = useState(coffee?.farm ?? "");
  const [variety, setVariety] = useState(coffee?.variety ?? "");
  const [processing, setProcessing] = useState(coffee?.processing ?? "");
  const [altMin, setAltMin] = useState(coffee?.altitudeMin != null ? String(coffee.altitudeMin) : "");
  const [altMax, setAltMax] = useState(coffee?.altitudeMax != null ? String(coffee.altitudeMax) : "");
  const [roastLevel, setRoastLevel] = useState<RoastLevel | "">(coffee?.roastLevel ?? "");
  const [brewType, setBrewType] = useState<BrewType | "">(coffee?.brewType ?? "");
  const [notes, setNotes] = useState(coffee?.notes ?? "");
  const [rating, setRating] = useState<BeanRating | "">(coffee?.rating ?? "");
  const [favourite, setFavourite] = useState(coffee?.favourite ?? false);
  const [flavorNotes, setFlavorNotes] = useState<string[]>(coffee?.flavorNotes ?? []);
  const [flavorInput, setFlavorInput] = useState("");

  const addFlavor = useCallback(() => {
    const v = flavorInput.trim();
    if (v && !flavorNotes.includes(v)) setFlavorNotes((p) => [...p, v]);
    setFlavorInput("");
  }, [flavorInput, flavorNotes]);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // §3.4b — "Erste Röstung" section (create mode only): default expanded +
  // active, collapsible. Collapsed → Sorte-only (no roasting sent). Defaults:
  // status `stock`, active on; remaining is derived (= full bag) server-side.
  const [roastingOpen, setRoastingOpen] = useState(true);
  const [rRoastDate, setRRoastDate] = useState("");
  const [rBagSize, setRBagSize] = useState("");
  const [rPrice, setRPrice] = useState("");
  const [rStatus, setRStatus] = useState<BeanStatus>("stock");
  const [rActive, setRActive] = useState(true);

  // §3i — single-JSON-import: paste/upload one Sorte JSON → prefill the form.
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const applyImport = useCallback((raw: string) => {
    setImportMsg(null);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { setImportErr(t("coffee.importCoffee.errInvalidJson")); return; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setImportErr(t("coffee.importCoffee.errNotObject")); return;
    }
    const o = parsed as Record<string, unknown>;
    const nameVal = typeof o.name === "string" ? o.name.trim() : "";
    if (!nameVal) { setImportErr(t("coffee.importCoffee.errNoName")); return; }
    if (o.flavorNotes !== undefined &&
        !(Array.isArray(o.flavorNotes) && o.flavorNotes.every((x) => typeof x === "string"))) {
      setImportErr(t("coffee.importCoffee.errFlavor")); return;
    }
    // §3i — firstRoasting structure is a HARD error (no partial import); its
    // individual field values are validated softly below.
    if (o.firstRoasting !== undefined && o.firstRoasting !== null &&
        (typeof o.firstRoasting !== "object" || Array.isArray(o.firstRoasting))) {
      setImportErr(t("coffee.importCoffee.errFirstRoasting")); return;
    }

    const ignored: string[] = [];
    const str = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
    const num = (v: unknown): string => {
      if (typeof v === "number" && Number.isFinite(v)) return String(Math.round(v));
      if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return String(Math.round(Number(v)));
      return "";
    };

    setName(nameVal);
    setRoaster(str(o.roaster));
    setCountry(str(o.country));
    setRegion(str(o.region));
    setFarm(str(o.farm));
    setVariety(str(o.variety));
    setProcessing(str(o.processing));
    setNotes(str(o.notes));
    setAltMin(num(o.altitudeMin));
    setAltMax(num(o.altitudeMax));

    if (o.roastLevel === undefined) setRoastLevel("");
    else if (typeof o.roastLevel === "string" && ROAST_LEVEL_SET.has(o.roastLevel as RoastLevel)) setRoastLevel(o.roastLevel as RoastLevel);
    else { setRoastLevel(""); ignored.push("roastLevel"); }

    // brew_type fix (3i): map it through so it's actually persisted on save.
    if (o.brewType === undefined) setBrewType("");
    else if (typeof o.brewType === "string" && BREW_TYPE_SET.has(o.brewType as BrewType)) setBrewType(o.brewType as BrewType);
    else { setBrewType(""); ignored.push("brewType"); }

    setFlavorNotes(Array.isArray(o.flavorNotes) ? (o.flavorNotes as string[]).map((s) => s.trim()).filter(Boolean) : []);

    // §3i — optional firstRoasting block: prefill the "Erste Röstung" section.
    // Keys = exact BeanCreate field names. Section stays open + active either
    // way; only present-but-invalid values are reported (soft ignore).
    // `remainingG` (and any unknown sub-keys) are silently dropped — remaining
    // is always derived (= full bag).
    const decNum = (v: unknown): string => {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(v);
      if (typeof v === "string" && v.trim() !== "" && Number(v) > 0) return String(Number(v));
      return "";
    };
    setRoastingOpen(true);
    const fr = (o.firstRoasting ?? {}) as Record<string, unknown>;

    if (fr.roastDate === undefined) setRRoastDate("");
    else if (typeof fr.roastDate === "string" && DATE_RE.test(fr.roastDate.trim())) setRRoastDate(fr.roastDate.trim());
    else { setRRoastDate(""); ignored.push("firstRoasting.roastDate"); }

    if (fr.bagSizeG === undefined) setRBagSize("");
    else { const b = decNum(fr.bagSizeG); setRBagSize(b); if (!b) ignored.push("firstRoasting.bagSizeG"); }

    if (fr.pricePerBagEur === undefined) setRPrice("");
    else { const p = decNum(fr.pricePerBagEur); setRPrice(p); if (!p) ignored.push("firstRoasting.pricePerBagEur"); }

    if (fr.status === undefined) setRStatus("stock");
    else if (typeof fr.status === "string" && BEAN_STATUS_SET.has(fr.status as BeanStatus)) setRStatus(fr.status as BeanStatus);
    else { setRStatus("stock"); ignored.push("firstRoasting.status"); }

    if (fr.isActive === undefined) setRActive(true);
    else if (typeof fr.isActive === "boolean") setRActive(fr.isActive);
    else { setRActive(true); ignored.push("firstRoasting.isActive"); }

    setErr(null);
    setImportErr(null);
    setImportOpen(false);
    setImportMsg(
      ignored.length
        ? `${t("coffee.importCoffee.applied")} ${t("coffee.importCoffee.ignored")} ${ignored.join(", ")}`
        : t("coffee.importCoffee.applied"),
    );
  }, [t]);

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = typeof reader.result === "string" ? reader.result : "";
      setImportText(txt);
      applyImport(txt);
    };
    reader.readAsText(f);
    e.target.value = "";
  }, [applyImport]);

  // §3i — dezent duplicate warning via the shared matcher (create mode only).
  const [dupes, setDupes] = useState<MatchCandidate[]>([]);
  const [hideDupes, setHideDupes] = useState(false);
  useEffect(() => {
    if (isEdit || !match) return;
    const n = name.trim();
    if (n.length < 2) { setDupes([]); return; }
    let off = false;
    const tmr = setTimeout(() => {
      match(n, roaster.trim() || null)
        .then((res) => {
          if (off) return;
          setDupes(res.filter((c) => c.verdict !== "kein-treffer").slice(0, 3));
          setHideDupes(false);
        })
        .catch(() => {});
    }, 400);
    return () => { off = true; clearTimeout(tmr); };
  }, [isEdit, match, name, roaster]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setErr(t("beans.fields.name") + " *"); return; }
    // §3.4b — atomic: an active first-roasting section requires a positive bag
    // size (else `remaining` is undefined). Block before any insert.
    const roastingActive = !isEdit && roastingOpen;
    const bagSizeNum = rBagSize ? parseFloat(rBagSize) : NaN;
    if (roastingActive && (!Number.isFinite(bagSizeNum) || bagSizeNum <= 0)) {
      setErr(t("coffee.firstRoasting.errBagSize")); return;
    }
    setSaving(true); setErr(null);
    try {
      const data: CoffeeCreatePayload = {
        name: name.trim(),
        roaster: roaster.trim() || null,
        country: country.trim() || null,
        region: region.trim() || null,
        farm: farm.trim() || null,
        variety: variety.trim() || null,
        processing: processing.trim() || null,
        altitudeMin: altMin ? parseInt(altMin, 10) : null,
        altitudeMax: altMax ? parseInt(altMax, 10) : null,
        roastLevel: (roastLevel as RoastLevel) || null,
        brewType: (brewType as BrewType) || null,
        flavorNotes,
        notes: notes.trim() || null,
        rating: (rating as BeanRating) || null,
        favourite,
      };
      if (roastingActive) {
        const firstRoasting: CoffeeFirstRoasting = {
          roastDate: rRoastDate || null,
          bagSizeG: bagSizeNum,
          pricePerBagEur: rPrice ? parseFloat(rPrice) : null,
          status: rStatus,
          isActive: rActive,
        };
        data.firstRoasting = firstRoasting;
      }
      await onSave(data);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [name, roaster, country, region, farm, variety, processing, altMin, altMax,
      roastLevel, brewType, flavorNotes, notes, rating, favourite, onSave, onClose, t,
      isEdit, roastingOpen, rRoastDate, rBagSize, rPrice, rStatus, rActive]);

  const ROAST_LEVELS: RoastLevel[] = ["light", "light-medium", "medium", "medium-dark", "dark"];
  const RATINGS: BeanRating[] = ["thumbs_up", "meh", "thumbs_down"];
  const BREW: { value: BrewType | ""; label: string }[] = [
    { value: "", label: t("beans.brewType.none") },
    { value: "espresso", label: t("beans.brewType.espresso") },
    { value: "filter", label: t("beans.brewType.filter") },
    { value: "omni", label: t("beans.brewType.omni") },
  ];

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 200 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 201,
        width: "min(640px, 96vw)", maxHeight: "90vh", overflowY: "auto", background: C.cardElev,
        border: `1px solid ${C.bdrL}`, borderRadius: 14, padding: "20px 24px 24px",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.txt }}>
            {isEdit ? t("coffee.editCoffee") : t("coffee.newCoffee")}
          </h2>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex" }}>
            <X size={18} />
          </button>
        </div>

        {!isEdit && (
          <div style={{ marginTop: 14 }}>
            {!importOpen ? (
              <button type="button" onClick={() => { setImportOpen(true); setImportMsg(null); }}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "transparent", border: `1px dashed ${C.bdr2}`, borderRadius: 8, padding: "7px 12px", color: C.txtS, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                <FileUp size={15} />{t("coffee.importCoffee.button")}
              </button>
            ) : (
              <div style={{ border: `1px solid ${C.bdr}`, borderRadius: 10, padding: 12, background: C.bg }}>
                <div style={{ fontSize: 12, color: C.mut, marginBottom: 8 }}>{t("coffee.importCoffee.hint")}</div>
                <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
                  placeholder={t("coffee.importCoffee.placeholder")}
                  style={{ ...inputStyle, minHeight: 110, fontFamily: MONO, fontSize: 12, resize: "vertical" }} />
                {importErr && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{importErr}</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                  <button type="button" onClick={() => applyImport(importText)} disabled={!importText.trim()}
                    style={{ background: C.accG2, border: `1px solid ${C.accB}`, borderRadius: 7, padding: "7px 14px", color: importText.trim() ? C.acc : C.mut, fontSize: 13, fontWeight: 600, cursor: importText.trim() ? "pointer" : "not-allowed", opacity: importText.trim() ? 1 : 0.6 }}>
                    {t("coffee.importCoffee.apply")}
                  </button>
                  <label style={{ background: "transparent", border: `1px solid ${C.bdr}`, borderRadius: 7, padding: "7px 12px", color: C.txtS, fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Upload size={14} />{t("coffee.importCoffee.file")}
                    <input type="file" accept="application/json,.json" onChange={onFile} style={{ display: "none" }} />
                  </label>
                  <button type="button" onClick={() => { setImportOpen(false); setImportErr(null); }}
                    style={{ marginLeft: "auto", background: "transparent", border: "none", color: C.mut, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    {t("coffee.cancel")}
                  </button>
                </div>
              </div>
            )}
            {importMsg && <div style={{ color: C.grn, fontSize: 12, marginTop: 8 }}>{importMsg}</div>}
          </div>
        )}

        {!isEdit && dupes.length > 0 && !hideDupes && (
          <div style={{ marginTop: 12, border: `1px solid ${C.org}55`, background: C.orgD, borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, color: C.org, fontSize: 12, fontWeight: 600 }}>
              <AlertTriangle size={14} />{t("coffee.importCoffee.dupWarn")}
              <button type="button" onClick={() => setHideDupes(true)} title={t("coffee.cancel")}
                style={{ marginLeft: "auto", background: "transparent", border: "none", color: C.mut, cursor: "pointer", display: "flex" }}>
                <X size={13} />
              </button>
            </div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {dupes.map((d) => (
                <div key={d.coffeeId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 13, color: C.txt, fontWeight: 600 }}>{d.name}</span>
                    {d.roaster && <span style={{ fontSize: 12, color: C.mut }}> · {d.roaster}</span>}
                    <span style={{ fontSize: 10, color: d.verdict === "sicher" ? C.grn : C.org, marginLeft: 6 }}>{d.verdict}</span>
                  </div>
                  {onJumpToCoffee && (
                    <button type="button" onClick={() => onJumpToCoffee(d.coffeeId)}
                      style={{ background: "transparent", border: `1px solid ${C.bdr}`, borderRadius: 6, padding: "4px 10px", color: C.acc, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
                      {t("coffee.importCoffee.dupAppend")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={sectionStyle}>{t("beans.sections.identification")}</div>
        <Field label={`${t("beans.fields.name")} *`}>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("beans.fields.namePlaceholder")} />
        </Field>
        <Field label={t("beans.fields.roaster")}>
          <input style={inputStyle} value={roaster} onChange={(e) => setRoaster(e.target.value)} placeholder={t("beans.fields.roasterPlaceholder")} />
        </Field>

        <div style={sectionStyle}>{t("beans.sections.origin")}</div>
        <TwoCol>
          <Field label={t("beans.fields.country")}><input style={inputStyle} value={country} onChange={(e) => setCountry(e.target.value)} /></Field>
          <Field label={t("beans.fields.region")}><input style={inputStyle} value={region} onChange={(e) => setRegion(e.target.value)} /></Field>
          <Field label={t("beans.fields.farm")}><input style={inputStyle} value={farm} onChange={(e) => setFarm(e.target.value)} /></Field>
          <Field label={t("beans.fields.variety")}><input style={inputStyle} value={variety} onChange={(e) => setVariety(e.target.value)} /></Field>
        </TwoCol>
        <Field label={t("beans.fields.processing")}>
          <input style={inputStyle} value={processing} onChange={(e) => setProcessing(e.target.value)} placeholder={t("beans.fields.processingPlaceholder")} />
        </Field>
        <TwoCol>
          <Field label={t("beans.fields.altitudeMin")}><input style={{ ...inputStyle, fontFamily: MONO }} type="number" value={altMin} onChange={(e) => setAltMin(e.target.value)} /></Field>
          <Field label={t("beans.fields.altitudeMax")}><input style={{ ...inputStyle, fontFamily: MONO }} type="number" value={altMax} onChange={(e) => setAltMax(e.target.value)} /></Field>
        </TwoCol>

        <div style={sectionStyle}>{t("beans.sections.roast")}</div>
        <Field label={t("beans.fields.roastLevel")}>
          <select style={inputStyle} value={roastLevel} onChange={(e) => setRoastLevel(e.target.value as RoastLevel | "")}>
            <option value="">—</option>
            {ROAST_LEVELS.map((rl) => <option key={rl} value={rl}>{t(`beans.roastLevel.${rl}`)}</option>)}
          </select>
        </Field>
        <Field label={t("beans.fields.brewType")}>
          <Segmented options={BREW} value={brewType} onChange={setBrewType} />
        </Field>

        <div style={sectionStyle}>{t("beans.sections.aroma")}</div>
        <Field label={t("beans.fields.flavorNotes")}>
          <div style={{ display: "flex", gap: 6 }}>
            <input style={{ ...inputStyle, flex: 1 }} value={flavorInput} onChange={(e) => setFlavorInput(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); addFlavor(); } }}
              placeholder={t("beans.fields.flavorNotesPlaceholder")} />
            <button onClick={addFlavor} style={{ background: C.accG2, border: `1px solid ${C.accB}`, borderRadius: 7, padding: "0 10px", cursor: "pointer", color: C.acc, display: "flex", alignItems: "center" }}>
              <Plus size={14} />
            </button>
          </div>
          {flavorNotes.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {flavorNotes.map((n) => (
                <button key={n} onClick={() => setFlavorNotes((p) => p.filter((x) => x !== n))} title={t("beans.removeTag")}
                  style={{ fontSize: 11, padding: "3px 8px", borderRadius: 10, background: C.accG, color: C.acc, border: `1px solid ${C.accB}`, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                  {n}<X size={9} />
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label={t("beans.fields.notes")}>
          <textarea style={{ ...inputStyle, minHeight: 64, resize: "vertical" }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("beans.fields.notesPlaceholder")} />
        </Field>

        <div style={sectionStyle}>{t("beans.sections.rating")}</div>
        <TwoCol>
          <Field label={t("beans.rating.label")}>
            <select style={inputStyle} value={rating} onChange={(e) => setRating(e.target.value as BeanRating | "")}>
              <option value="">—</option>
              {RATINGS.map((r) => <option key={r} value={r}>{t(`beans.rating.${r}`)}</option>)}
            </select>
          </Field>
          <Field label={t("beans.fields.favourite")}>
            <div style={{ paddingTop: 6 }}><Toggle checked={favourite} onChange={setFavourite} /></div>
          </Field>
        </TwoCol>

        {/* §3.4b — Erste Röstung (Anlage-Modus): default aufgeklappt + aktiv,
            wegklappbar. Weggeklappt → Sorte-only. */}
        {!isEdit && (
          <>
            <button
              type="button"
              onClick={() => setRoastingOpen((v) => !v)}
              style={{
                ...sectionStyle, display: "flex", alignItems: "center", gap: 6, width: "100%",
                background: "transparent", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
              }}
            >
              {roastingOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {t("coffee.firstRoasting.title")}
            </button>
            {roastingOpen && (
              <>
                <div style={{ fontSize: 11, color: C.mut, marginBottom: 10, marginTop: -4 }}>
                  {t("coffee.firstRoasting.hint")}
                </div>
                <TwoCol>
                  <RoastDateField value={rRoastDate} onChange={setRRoastDate} />
                  <BagSizeField value={rBagSize} onChange={setRBagSize} />
                </TwoCol>
                <TwoCol>
                  <PriceField value={rPrice} onChange={setRPrice} />
                  <StatusField value={rStatus} onChange={setRStatus} />
                </TwoCol>
                <ActiveSourceField value={rActive} onChange={setRActive} />
              </>
            )}
          </>
        )}

        {err && <div style={{ color: C.red, fontSize: 12, margin: "8px 0" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
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
