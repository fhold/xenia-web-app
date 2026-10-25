/**
 * Profil importieren (2026-10-20): zeigt vor dem ersten Schreibbefehl, was
 * passiert — Name, je Variante die Kurve und was mit ihrem Skript geschieht
 * (vorhanden / wird angelegt / anderes gleichen Namens → Wahl), fehlende Siebe.
 * Bei einem Decent-Profil dazu der Bericht der Uebersetzung (umgedeutet /
 * weggefallen / pruefen, das Warum per Tooltip). Pruefen und Uebersetzen macht
 * das Backend; hier wird nur gezeigt und gewaehlt.
 */

import { useEffect, useState } from "react";
import { HelpCircle } from "lucide-react";
import type { ImportPreview, ProfileImportResult } from "@shared/profile-file.js";
import type { TranslationHint, TranslationRow } from "@shared/decent-profile.js";
import { endsWithoutYield } from "@shared/brew-steps.js";
import { Modal, modalTitle, modalText } from "./ScriptInsertMenu.js";
import { HoverTip } from "./HoverTip.js";
import { getCurrentLanguage, t, useTranslation } from "../i18n/index.js";
import theme from "../theme.js";
import { dec } from "../lib/num.js";

const C = theme;

type Choice = "reuse" | "create";
type State =
  | { phase: "loading" }
  | { phase: "preview"; plan: ImportPreview }
  | { phase: "applying"; plan: ImportPreview }
  | { phase: "done"; result: ProfileImportResult }
  | { phase: "error"; message: string };

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const line: React.CSSProperties = { fontSize: 13, lineHeight: 1.45, color: C.txtS, margin: "0 0 6px" };
const note: React.CSSProperties = { fontSize: 12, color: C.mut };

function btn(primary: boolean, disabled = false): React.CSSProperties {
  return {
    height: 36, padding: "0 14px", borderRadius: 9, fontFamily: "inherit", fontSize: 13, fontWeight: primary ? 600 : 500,
    border: `1px solid ${primary ? C.accB : C.bdr2}`, background: primary ? C.accG2 : "transparent",
    color: primary ? C.acc : C.txtS, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}

export function ProfileImportDialog({ text, onClose, onImported, onOpenProfile }: {
  /** Inhalt der gewaehlten Datei. */
  text: string;
  onClose: () => void;
  /** Nach dem Anlegen — Skriptliste neu laden (Profile kommen per WebSocket). */
  onImported: () => void;
  onOpenProfile: (id: number) => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const { t } = useTranslation();

  useEffect(() => {
    postJson<ImportPreview>("/api/profiles/import/preview", { text, lang: getCurrentLanguage() })
      .then((plan) => setState({ phase: "preview", plan }))
      .catch((e: Error) => setState({ phase: "error", message: e.message }));
  }, [text]);

  const close = () => { if (state.phase !== "applying") onClose(); };

  if (state.phase === "loading") {
    return <Modal onClose={close}><p style={modalText}>{t("profileList.import.checking")}</p></Modal>;
  }
  if (state.phase === "error") {
    return (
      <Modal onClose={close}>
        <h3 style={modalTitle}>{t("profileList.import.errorTitle")}</h3>
        <p style={{ ...modalText, color: C.red }}>{state.message}</p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={btn(false)}>{t("profileList.import.close")}</button>
        </div>
      </Modal>
    );
  }
  if (state.phase === "done") {
    const r = state.result;
    return (
      <Modal onClose={close}>
        <h3 style={modalTitle}>{t("profileList.import.doneTitle", { name: r.profile.name })}</h3>
        {r.createdScripts.map((s) => <p key={`c${s.id}`} style={line}>{t("profileList.import.scriptCreated", { id: s.id, title: s.title })}</p>)}
        {r.reusedScripts.map((s) => <p key={`r${s.id}`} style={line}>{t("profileList.import.scriptReused", { id: s.id, title: s.title })}</p>)}
        {r.missingBaskets.length > 0 && (
          <p style={line}>{t("profileList.import.missingBaskets", { list: r.missingBaskets.map((b) => t("profileList.import.quoted", { name: b })).join(", ") })}</p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <button onClick={onClose} style={btn(false)}>{t("profileList.import.done")}</button>
          <button onClick={() => onOpenProfile(r.profile.id)} style={btn(true)}>{t("profileList.import.open")}</button>
        </div>
      </Modal>
    );
  }

  const { plan } = state;
  const original = plan.profile;
  const open = plan.variants.some((v, i) => v.script?.status === "conflict" && !choices[i]);
  // Derselbe Text in zwei Varianten wird nur einmal angelegt.
  const writes = new Set(plan.variants
    .filter((v, i) => v.script?.status === "new" || (v.script?.status === "conflict" && choices[i] === "create"))
    .map((v) => original.variants[plan.variants.indexOf(v)]?.script?.content.trim() ?? v.script!.title)).size;
  const applying = state.phase === "applying";

  const apply = () => {
    setState({ phase: "applying", plan });
    postJson<ProfileImportResult>("/api/profiles/import", { text, choices, lang: getCurrentLanguage() })
      .then((result) => { onImported(); setState({ phase: "done", result }); })
      .catch((e: Error) => setState({ phase: "error", message: e.message }));
  };

  return (
    <Modal onClose={close} width={plan.translation ? 640 : 460}>
      <h3 style={modalTitle}>{t("profileList.import.title", { name: plan.name })}</h3>
      {plan.translation && <TranslationTable rows={plan.translation.rows} hints={plan.translation.hints} />}
      {plan.renamed && (
        <p style={modalText}>{t("profileList.import.renamed", { name: original.name })}</p>
      )}
      {!plan.translation && plan.variants.map((v, i) => {
        const sameAs = original.variants[i]?.sameAs;
        const s = v.script;
        // Ziel: aus der Datei; ohne Ziel endet eine App-Kurve mit ihrer letzten Phase.
        const fv = original.variants[i];
        const own = fv?.sameAs ? original.variants.find((x) => x.name === fv.sameAs) : fv;
        const target = fv?.yieldG != null ? `→ ${dec(String(fv.yieldG))} g`
          : endsWithoutYield(own?.brewSteps?.steps) ? t("profileList.import.endsWithLastStage") : null;
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <p style={{ ...line, margin: 0 }}>
              <span style={{ color: C.txt, fontWeight: 600 }}>{v.name}</span>
              {target && <span style={{ color: C.txt }}>{" · "}{target}</span>}
              {" · "}
              {v.curve === "steps" && t("profileList.import.stepsInApp")}
              {v.curve === "sameAs" && t("profileList.import.sameAs", { name: sameAs ?? t("profileList.import.otherVariant") })}
              {s?.status === "same" && t("profileList.import.scriptSame", { id: s.scriptId, title: s.title })}
              {s?.status === "new" && t("profileList.import.scriptNew", { title: s.title })}
              {s?.status === "conflict" && t("profileList.import.scriptConflict", { id: s.scriptId, title: s.title })}
            </p>
            {s?.status === "conflict" && (
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                {([["reuse", t("profileList.import.reuse")], ["create", t("profileList.import.create")]] as const).map(([value, label]) => {
                  const active = choices[i] === value;
                  return (
                    <button key={value} type="button" disabled={applying} onClick={() => setChoices({ ...choices, [i]: value })}
                      style={{
                        flex: 1, padding: "7px 4px", borderRadius: 7, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
                        background: active ? C.accG2 : C.bg, border: `1px solid ${active ? C.accB : C.bdr}`,
                        color: active ? C.acc : C.mut, fontWeight: active ? 600 : 400,
                      }}>{label}</button>
                  );
                })}
              </div>
            )}
            {v.missingBasket && <div style={note}>{t("profileList.import.missingBasket", { name: v.missingBasket })}</div>}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", marginTop: 12 }}>
        {writes > 0 && <span style={{ ...note, marginRight: "auto" }}>{writes === 1 ? t("profileList.import.writesOne") : t("profileList.import.writesMany", { n: writes })}</span>}
        <button onClick={onClose} disabled={applying} style={btn(false, applying)}>{t("profileList.import.cancel")}</button>
        <button onClick={apply} disabled={open || applying} style={btn(true, open || applying)}>
          {applying ? t("profileList.import.importing") : t("profileList.import.import")}
        </button>
      </div>
    </Modal>
  );
}

const STATUS: Record<TranslationRow["status"], { word: () => string; color: string }> = {
  same: { word: () => t("profileList.import.status.same"), color: C.mut },
  changed: { word: () => t("profileList.import.status.changed"), color: C.org },
  approx: { word: () => t("profileList.import.status.approx"), color: C.org },
  dropped: { word: () => t("profileList.import.status.dropped"), color: C.mut },
};

const head: React.CSSProperties = { fontSize: 10, color: C.mut, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1.2 };

function Why({ text }: { text: string }) {
  return (
    <HoverTip content={<div style={{ fontSize: 12, maxWidth: 320 }}>{text}</div>} style={{ display: "inline-flex", color: C.mut, cursor: "help", verticalAlign: "middle" }}>
      <HelpCircle size={12} aria-label={t("profileList.import.why")} />
    </HoverTip>
  );
}

/**
 * Decent-Profil → Xenia: je Schritt eine Zeile „Decent | Xenia“ mit Status
 * (gleich / angepasst / Annaeherung / entfaellt) und dem Warum als Tooltip,
 * danach Temperatur und Ziel, am Ende „Bitte prüfen“. Kompakt (eine Zeile je
 * Seite, wo es passt), damit auch ein V60 mit sieben Schritten nicht scrollt.
 * Schmal (Handy): untereinander, „Decent:“ / „Xenia:“ vorangestellt.
 */
/** Zahl und Einheit nicht trennen („25 s“, „3,8 bar“). */
const nb = (t: string) => t.replace(/(\d) (?=(?:s|bar|ml\/s|g\/s|g|ml|°C|W|%)(?![\p{L}]))/gu, "$1\u00a0");

function TranslationTable({ rows, hints }: { rows: TranslationRow[]; hints: TranslationHint[] }) {
  const narrow = typeof window !== "undefined" && window.innerWidth < 560;
  const cell: React.CSSProperties = { fontSize: 12, lineHeight: 1.35, color: C.txtS, minWidth: 0 };
  const status = (r: TranslationRow) => (
    <span style={{ color: STATUS[r.status].color, whiteSpace: "nowrap" }}>
      {" · "}{STATUS[r.status].word()}{r.why && <>{" "}<Why text={r.why} /></>}
    </span>
  );
  const line = (first: boolean): React.CSSProperties => ({ padding: "3px 0", borderTop: `1px solid ${first ? C.bdr2 : C.bdr}` });
  const row = (r: TranslationRow, k: number, first: boolean) => narrow ? (
    <div key={k} style={line(first)}>
      <div style={cell}><span style={{ color: C.txt, fontWeight: 600 }}>{r.name}</span> <span style={{ color: C.mut }}>Decent:</span> {nb(r.decent)}</div>
      <div style={{ ...cell, color: C.txt }}><span style={{ color: C.mut }}>Xenia:</span> {nb(r.xenia ?? "–")}{status(r)}</div>
    </div>
  ) : (
    <div key={k} style={{ ...line(first), display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <div style={cell}><span style={{ color: C.txt, fontWeight: 600 }}>{r.name}</span> {nb(r.decent)}</div>
      <div style={{ ...cell, color: C.txt }}>{nb(r.xenia ?? "–")}{status(r)}</div>
    </div>
  );
  const stepRows = rows.filter((r) => r.group === "step");
  const profileRows = rows.filter((r) => r.group === "profile");
  return (
    <div style={{ marginBottom: 8 }}>
      <p style={{ ...modalText, margin: "0 0 8px" }}>
        {t("profileList.import.intro")}
      </p>
      {!narrow && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, paddingBottom: 3 }}>
          <span style={head}>Decent</span><span style={head}>Xenia</span>
        </div>
      )}
      {stepRows.map((r, k) => row(r, k, k === 0))}
      {profileRows.map((r, k) => row(r, 100 + k, k === 0))}
      {hints.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...head, marginBottom: 2 }}>{t("profileList.import.checkHint")}</div>
          {hints.map((h) => (
            <div key={h.text} style={cell}>• {h.text} <Why text={h.why} /></div>
          ))}
        </div>
      )}
    </div>
  );
}
