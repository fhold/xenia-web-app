/**
 * ScriptEditor — ein Maschinen-Skript bearbeiten oder neu anlegen.
 *
 * Kurve und Liste zeigen denselben Stand: an der Kurve ziehen aendert die
 * Werte in der Liste und umgekehrt; ein Befehl ist in beiden zugleich
 * ausgewaehlt. Rueckgaengig/Wiederholen ueber eine Liste von Staenden (die
 * Bearbeitungs-Operationen in shared/script-edit.ts sind unveraenderlich).
 *
 * Speichern:
 *   - „Als neues Skript" legt es auf dem kleinsten freien, in der Xenia-
 *     Oberflaeche sichtbaren Platz an — geht immer.
 *   - „Speichern" ueberschreibt das bestehende, nach Rueckfrage mit den
 *     Profilen, die es benutzen. Hat jemand das Skript inzwischen an der
 *     Maschine geaendert, wird nichts geschrieben (409) und der Editor bietet
 *     an, den Maschinenstand zu laden oder als neues Skript zu speichern.
 *   - Fehler der Pruefung (validateScript) sperren beides; Warnungen stehen
 *     in der Rueckfrage.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Undo2, Redo2, Plus, HelpCircle, X, AlertTriangle } from "lucide-react";
import type { ParsedCmd, XeniaScript } from "@shared/types.js";
import { parseScript } from "@shared/script-parser.js";
import { serializeScript } from "@shared/script-serializer.js";
import { scriptToTimeline } from "@shared/script-timeline.js";
import { validateScript } from "@shared/script-validator.js";
import {
  moveCmd, removeCmd, setArg, makeCmd, defaultArgs, editableRange, insertWithWait, defaultInsertIndex,
} from "@shared/script-edit.js";
import { CMD_HELP, INSERTABLE_CMDS, SCRIPT_MODEL_HELP } from "@shared/script-help.js";
import { ScriptCurveEditor } from "./ScriptCurveEditor.js";
import { ScriptCommandList, HelpBody } from "./ScriptCommandList.js";
import { ScriptConflict } from "../hooks/useScripts.js";
import theme from "../theme.js";

const C = theme;

/** Namensregel der Maschine (modeler.js): keine Umlaute, kein Leerzeichen am Rand. */
const NAME_RE = /^(?! )[A-Za-z0-9\-_# ]*(?<! )$/;

const NEW_SCRIPT = "1;13;4 2000 2000;12 8000;4 9000 3000;12 60000;17;7;";

export interface ScriptEditorProps {
  /** null = neues Skript. */
  script: XeniaScript | null;
  /** Vorlage fuer ein neues Skript (Duplizieren); sonst ein schlichtes Grundskript. */
  template?: { title: string; content: string };
  /** Profile, die das Skript benutzen (fuer die Rueckfrage beim Ueberschreiben). */
  usedBy: string[];
  onCreate: (title: string, content: string) => Promise<XeniaScript>;
  onUpdate: (id: number, title: string, content: string, expectedContent: string) => Promise<XeniaScript>;
  onDone: (saved: XeniaScript | null) => void;
}

type Dialog =
  | { kind: "overwrite" }
  | { kind: "conflict"; machineContent: string }
  | { kind: "insert" }
  | { kind: "model" }
  | { kind: "discard" };

const card: React.CSSProperties = { background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: "14px 16px" };
const sectionLabel: React.CSSProperties = { fontSize: 9, color: C.mut, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" };
const iconBtn = (enabled: boolean): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 10px", borderRadius: 8,
  background: "transparent", border: `1px solid ${C.bdr2}`, color: enabled ? C.txtS : C.dim,
  cursor: enabled ? "pointer" : "default", fontFamily: "inherit", fontSize: 12.5,
});
const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  padding: "9px 16px", borderRadius: 9, border: `1px solid ${enabled ? C.acc : C.bdr2}`,
  background: enabled ? C.accG2 : "transparent", color: enabled ? C.acc : C.dim,
  cursor: enabled ? "pointer" : "default", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
});
const secondaryBtn = (enabled: boolean): React.CSSProperties => ({
  padding: "9px 16px", borderRadius: 9, border: `1px solid ${C.bdr2}`, background: "transparent",
  color: enabled ? C.txtS : C.dim, cursor: enabled ? "pointer" : "default", fontFamily: "inherit", fontSize: 13,
});

export function ScriptEditor({ script, template, usedBy, onCreate, onUpdate, onDone }: ScriptEditorProps) {
  const origin = script?.content ?? template?.content ?? NEW_SCRIPT;
  const [expected, setExpected] = useState(script?.content ?? "");
  const [title, setTitle] = useState(script?.title ?? template?.title ?? "Neues Skript");
  const [history, setHistory] = useState<ParsedCmd[][]>(() => [parseScript(origin).commands]);
  const [pos, setPos] = useState(0);
  const [preview, setPreview] = useState<ParsedCmd[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const committed = history[pos]!;
  const cmds = preview ?? committed;
  const parsed = useMemo(() => ({ commands: cmds, unknownCmds: [] as number[] }), [cmds]);
  const timeline = useMemo(() => scriptToTimeline(parsed), [parsed]);
  const validation = useMemo(() => validateScript({ commands: committed, unknownCmds: [] }), [committed]);
  const content = serializeScript({ commands: committed, unknownCmds: [] });
  const overridden = useMemo(
    () => new Set(timeline.phases.filter((p) => p.noWait).map((p) => p.cmdIndex)),
    [timeline],
  );

  const originTitle = script?.title ?? template?.title ?? "Neues Skript";
  const dirty = content !== serializeScript(parseScript(origin)) || title !== originTitle || script === null;
  const nameOk = title.length > 0 && NAME_RE.test(title);
  const canSave = validation.ok && nameOk && !busy;

  const commit = useCallback((next: ParsedCmd[]) => {
    setPreview(null);
    if (next === history[pos]) return;
    setHistory([...history.slice(0, pos + 1), next]);
    setPos(pos + 1);
  }, [history, pos]);

  const undo = () => { if (pos > 0) { setPos(pos - 1); setSelected(null); } };
  const redo = () => { if (pos < history.length - 1) { setPos(pos + 1); setSelected(null); } };

  // Tastatur: Strg/Cmd+Z, Strg/Cmd+Umschalt+Z (nicht in Eingabefeldern).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Pumpenbefehle bringen ihr Warten mit (insertWithWait), damit sie laufen.
  const insert = (cmd: number) => {
    const { last } = editableRange(committed);
    const at = selected !== null && selected <= last ? selected + 1 : defaultInsertIndex(committed);
    const r = insertWithWait(committed, at, makeCmd(cmd, defaultArgs(cmd)));
    commit(r.cmds);
    setSelected(r.index);
    setDialog(null);
  };

  const saveNew = async () => {
    setBusy(true); setErr(null);
    try {
      const saved = await onCreate(title, content);
      onDone(saved);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setDialog(null);
    }
  };

  const saveOverwrite = async () => {
    if (!script) return;
    setBusy(true); setErr(null);
    try {
      const saved = await onUpdate(script.id, title, content, expected);
      onDone(saved);
    } catch (e) {
      if (e instanceof ScriptConflict) setDialog({ kind: "conflict", machineContent: e.machineContent });
      else { setErr(e instanceof Error ? e.message : String(e)); setDialog(null); }
    } finally {
      setBusy(false);
    }
  };

  const loadMachine = (machineContent: string) => {
    setHistory([parseScript(machineContent).commands]);
    setPos(0);
    setExpected(machineContent);
    setSelected(null);
    setDialog(null);
  };

  const totalS = Math.round(timeline.totalMs / 1000);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Kopf: Name, Rueckgaengig, Speichern */}
      <div style={{ ...card, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ ...sectionLabel, marginBottom: 4 }}>{script ? `Skript ${script.id} bearbeiten` : "Neues Skript"}</div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={40}
            style={{
              width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 8, background: C.bg,
              border: `1px solid ${nameOk ? C.bdrL : C.red}`, color: C.txt, fontSize: 15, fontWeight: 600, fontFamily: "inherit", outline: "none",
            }}
          />
          {!nameOk && (
            <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>
              Die Maschine erlaubt nur Buchstaben ohne Umlaute, Ziffern, - _ # und Leerzeichen (nicht am Rand).
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={undo} disabled={pos === 0} style={iconBtn(pos > 0)} title="Rückgängig (Strg+Z)"><Undo2 size={15} /></button>
          <button onClick={redo} disabled={pos >= history.length - 1} style={iconBtn(pos < history.length - 1)} title="Wiederholen"><Redo2 size={15} /></button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => (dirty && script ? setDialog({ kind: "discard" }) : onDone(null))} style={secondaryBtn(true)}>Abbrechen</button>
          {script && (
            <button onClick={() => void saveNew()} disabled={!canSave} style={secondaryBtn(canSave)}>Als neues Skript</button>
          )}
          <button
            onClick={() => (script ? setDialog({ kind: "overwrite" }) : void saveNew())}
            disabled={!canSave || (script !== null && !dirty)}
            style={primaryBtn(canSave && (script === null || dirty))}
          >
            {script ? "Speichern" : "Anlegen"}
          </button>
        </div>
        {err && <div style={{ flexBasis: "100%", fontSize: 12, color: C.red }}>{err}</div>}
      </div>

      {/* Pruefung */}
      {(validation.errors.length > 0 || validation.warnings.length > 0 || overridden.size > 0) && (
        <div style={{ ...card, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          {validation.errors.map((e) => (
            <div key={e.code} style={{ fontSize: 12.5, color: C.red, display: "flex", gap: 6 }}><AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />{e.message}</div>
          ))}
          {validation.warnings.map((w) => (
            <div key={w.code} style={{ fontSize: 12.5, color: C.org }}>⚠ {w.message}</div>
          ))}
          {overridden.size > 0 && (
            <div style={{ fontSize: 12.5, color: C.org }}>⚠ Ein Pumpenbefehl ohne „Warten“ danach wird sofort vom nächsten überschrieben und läuft nie.</div>
          )}
        </div>
      )}

      {/* Kurve */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <span style={sectionLabel}>Soll-Kurve · {totalS} s</span>
          <span style={{ fontSize: 11, color: C.mut }}>● ziehen: Zielwert und Übergang · ▮ ziehen: Dauer der Stufe</span>
          <button onClick={() => setDialog({ kind: "model" })} style={{ marginLeft: "auto", ...iconBtn(true), padding: "4px 8px" }}>
            <HelpCircle size={14} /> So laufen Skripte
          </button>
        </div>
        <ScriptCurveEditor
          cmds={cmds}
          timeline={timeline}
          selected={selected}
          onSelect={setSelected}
          onPreview={setPreview}
          onCommit={commit}
        />
      </div>

      {/* Befehle */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <span style={sectionLabel}>Befehle</span>
          <button onClick={() => setDialog({ kind: "insert" })} style={{ marginLeft: "auto", ...iconBtn(true) }}>
            <Plus size={15} /> Befehl {selected !== null ? "danach " : ""}einfügen
          </button>
        </div>
        <ScriptCommandList
          cmds={cmds}
          selected={selected}
          overridden={overridden}
          onSelect={setSelected}
          onArg={(i, a, raw) => commit(setArg(committed, i, a, raw))}
          onMove={(from, to) => { commit(moveCmd(committed, from, to)); setSelected(to); }}
          onRemove={(i) => { commit(removeCmd(committed, i)); setSelected(null); }}
        />
      </div>

      {dialog && (
        <Modal onClose={() => !busy && setDialog(null)}>
          {dialog.kind === "insert" && <InsertMenu onPick={insert} />}
          {dialog.kind === "model" && (
            <>
              <h3 style={modalTitle}>So laufen Skripte</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55, color: C.txtS }}>
                {SCRIPT_MODEL_HELP.map((t, i) => <li key={i} style={{ marginBottom: 6 }}>{t}</li>)}
              </ul>
            </>
          )}
          {dialog.kind === "overwrite" && script && (
            <>
              <h3 style={modalTitle}>„{script.title}“ überschreiben?</h3>
              <p style={modalText}>
                Das Skript auf Platz {script.id} wird an der Maschine ersetzt.
                {usedBy.length > 0
                  ? <> Benutzt von: <b style={{ color: C.txt }}>{usedBy.join(", ")}</b> — diese Profile brühen ab jetzt die neue Fassung.</>
                  : " Kein Profil benutzt es."}
              </p>
              <p style={modalText}>Die alte Fassung bleibt an den bisherigen Bezügen als Profilversion lesbar.</p>
              {validation.warnings.length > 0 && (
                <div style={{ fontSize: 12.5, color: C.org, marginBottom: 10 }}>
                  {validation.warnings.map((w) => <div key={w.code}>⚠ {w.message}</div>)}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setDialog(null)} style={secondaryBtn(!busy)} disabled={busy}>Zurück</button>
                <button onClick={() => void saveOverwrite()} style={primaryBtn(!busy)} disabled={busy}>{busy ? "Schreibe…" : "Überschreiben"}</button>
              </div>
            </>
          )}
          {dialog.kind === "conflict" && (
            <>
              <h3 style={modalTitle}>An der Maschine geändert</h3>
              <p style={modalText}>
                Das Skript wurde geändert, seit du es hier geöffnet hast — vermutlich in der Xenia-Oberfläche.
                Überschrieben wurde nichts.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button onClick={() => loadMachine(dialog.machineContent)} style={secondaryBtn(true)}>Maschinenstand laden</button>
                <button onClick={() => void saveNew()} style={primaryBtn(canSave)} disabled={!canSave}>Meine Fassung als neues Skript</button>
              </div>
            </>
          )}
          {dialog.kind === "discard" && (
            <>
              <h3 style={modalTitle}>Änderungen verwerfen?</h3>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setDialog(null)} style={secondaryBtn(true)}>Weiter bearbeiten</button>
                <button onClick={() => onDone(null)} style={{ ...secondaryBtn(true), color: C.red, borderColor: C.red }}>Verwerfen</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

const modalTitle: React.CSSProperties = { margin: "0 0 10px", fontSize: 15, fontWeight: 600, color: C.txt };
const modalText: React.CSSProperties = { margin: "0 0 10px", fontSize: 13, lineHeight: 1.5, color: C.txtS };

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 220 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 221,
        width: "min(460px, 94vw)", maxHeight: "86vh", overflowY: "auto", background: C.cardElev,
        border: `1px solid ${C.bdrL}`, borderRadius: 14, padding: 18,
      }}>
        <button onClick={onClose} aria-label="Schließen" style={{ position: "absolute", top: 12, right: 12, background: "transparent", border: "none", color: C.mut, cursor: "pointer", display: "flex" }}>
          <X size={17} />
        </button>
        {children}
      </div>
    </>
  );
}

function InsertMenu({ onPick }: { onPick: (cmd: number) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const groups = ["Pumpe", "Zeit", "Ventile", "Waage", "Temperatur", "Sonstiges"] as const;
  return (
    <>
      <h3 style={modalTitle}>Befehl einfügen</h3>
      {groups.map((g) => {
        const items = INSERTABLE_CMDS.filter((id) => CMD_HELP[id]?.group === g);
        if (!items.length) return null;
        return (
          <div key={g} style={{ marginBottom: 10 }}>
            <div style={{ ...sectionLabel, marginBottom: 5 }}>{g}</div>
            {items.map((id) => {
              const h = CMD_HELP[id]!;
              return (
                <div key={id} style={{ marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      onClick={() => onPick(id)}
                      style={{
                        flex: 1, textAlign: "left", padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.bdr}`,
                        background: C.card, color: C.txt, cursor: "pointer", fontFamily: "inherit",
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {h.title}
                        {h.source === "nicht erprobt" && <span style={{ fontSize: 10, color: C.org, fontWeight: 500, marginLeft: 6 }}>nicht erprobt</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.mut, marginTop: 2 }}>{h.summary}</div>
                    </button>
                    <button onClick={() => setOpen(open === id ? null : id)} aria-label="Hilfe"
                      style={{ background: "transparent", border: "none", color: open === id ? C.acc : C.mut, cursor: "pointer", padding: 4, display: "flex" }}>
                      <HelpCircle size={16} />
                    </button>
                  </div>
                  {open === id && (
                    <div style={{ margin: "4px 28px 6px 4px", padding: "9px 11px", background: C.sunken, borderRadius: 8, border: `1px solid ${C.bdr2}` }}>
                      <HelpBody help={h} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
