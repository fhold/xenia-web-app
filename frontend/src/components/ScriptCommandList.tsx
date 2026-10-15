/**
 * ScriptCommandList — die Befehle eines Skripts als bearbeitbare Liste.
 *
 * Jede Zeile: Griff zum Verschieben, Name, Werte mit Einheit (bar/s/% statt
 * mbar/ms), Hilfe (?) und Loeschen. Start und Ende stehen fest am Rand.
 *
 * Verschieben per Pointer statt HTML5-Drag-and-Drop: das native DnD geht auf
 * Touch-Geraeten (Tablet an der Maschine) nicht.
 */

import { useEffect, useRef, useState } from "react";
import { GripVertical, HelpCircle, Trash2, Lock } from "lucide-react";
import type { ParsedCmd } from "@shared/types.js";
import { CMD_HELP, CMD_ARGS, type ArgField, type CmdHelp } from "@shared/script-help.js";
import { editableRange } from "@shared/script-edit.js";
import theme from "../theme.js";

const C = theme;
const MONO = "'JetBrains Mono', monospace";

const SOURCE_LABEL: Record<CmdHelp["source"], { text: string; color: string }> = {
  gemessen: { text: "an dieser Maschine gemessen", color: C.grn },
  xenia: { text: "laut Xenia", color: C.acc },
  "nicht erprobt": { text: "hier nicht erprobt", color: C.org },
};

export function HelpBody({ help }: { help: CmdHelp }) {
  const src = SOURCE_LABEL[help.source];
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.5, color: C.txtS }}>
      <div style={{ color: C.txt, marginBottom: help.details.length ? 6 : 0 }}>{help.summary}</div>
      {help.details.length > 0 && (
        <ul style={{ margin: "0 0 6px", paddingLeft: 18 }}>
          {help.details.map((d, i) => <li key={i} style={{ marginBottom: 3 }}>{d}</li>)}
        </ul>
      )}
      <span style={{ fontSize: 10.5, color: src.color }}>● {src.text}</span>
    </div>
  );
}

/** Zahlenfeld mit Einheit; nimmt Komma und Punkt, uebernimmt beim Verlassen. */
function ArgInput({ field, raw, onChange }: { field: ArgField; raw: number; onChange: (raw: number) => void }) {
  const shown = raw / field.scale;
  const fmt = (v: number) => String(Number(v.toFixed(3))).replace(".", ",");
  const [text, setText] = useState(fmt(shown));
  useEffect(() => { setText(fmt(shown)); }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v)) { setText(fmt(shown)); return; }
    const clamped = Math.max(field.min, field.max !== undefined ? Math.min(field.max, v) : v);
    const next = Math.round(clamped * field.scale * 1000) / 1000;
    if (next !== raw) onChange(field.scale >= 1000 ? Math.round(next) : next);
    else setText(fmt(shown));
  };
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }} onClick={(e) => e.stopPropagation()}>
      <span style={{ fontSize: 10.5, color: C.mut }}>{field.label}</span>
      <input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{
          width: 58, padding: "5px 6px", borderRadius: 6, background: C.bg, border: `1px solid ${C.bdrL}`,
          color: C.txt, fontSize: 13, fontFamily: MONO, textAlign: "right", outline: "none",
        }}
      />
      <span style={{ fontSize: 11, color: C.mut, minWidth: 18 }}>{field.unit}</span>
    </label>
  );
}

interface Props {
  cmds: ParsedCmd[];
  selected: number | null;
  /** Pumpenbefehle ohne Warten danach — laufen nie. */
  overridden: Set<number>;
  onSelect: (i: number | null) => void;
  onArg: (i: number, argIndex: number, raw: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (i: number) => void;
}

interface DragState { from: number; pointerId: number; mids: { i: number; mid: number }[]; to: number }

export function ScriptCommandList({ cmds, selected, overridden, onSelect, onArg, onMove, onRemove }: Props) {
  const { first, last } = editableRange(cmds);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [helpOpen, setHelpOpen] = useState<number | null>(null);

  // Ausgewaehlte Zeile (z. B. aus der Kurve) in Sicht holen.
  useEffect(() => {
    if (selected === null) return;
    rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const startDrag = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const mids: { i: number; mid: number }[] = [];
    for (let k = first; k <= last; k++) {
      const r = rowRefs.current.get(k)?.getBoundingClientRect();
      if (r) mids.push({ i: k, mid: r.top + r.height / 2 });
    }
    setDrag({ from: i, pointerId: e.pointerId, mids, to: i });
    onSelect(i);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // Endplatz = erster bearbeitbarer Platz + Zahl der anderen Zeilen, deren
    // Mitte ueber dem Zeiger liegt (genau der Index, den moveCmd erwartet).
    const above = drag.mids.filter((m) => m.i !== drag.from && m.mid < e.clientY).length;
    setDrag({ ...drag, to: first + above });
  };
  const endDrag = () => {
    if (!drag) return;
    if (drag.to !== drag.from) onMove(drag.from, drag.to);
    setDrag(null);
  };

  // Einfuege-Linie: vor Zeile `to` (nach unten verschoben: hinter `to`).
  const lineBefore = drag && drag.to !== drag.from ? (drag.to < drag.from ? drag.to : drag.to + 1) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Schmal: Hilfe/Loeschen neben den Namen, die Werte in die zweite Zeile. */}
      <style>{`@media (max-width: 640px) {
        .scr-actions { order: 1; margin-left: auto; }
        .scr-fields { order: 2; flex-basis: 100%; padding-left: 30px; }
        .scr-help { order: 3; }
      }`}</style>
      {cmds.map((c, i) => {
        const help = CMD_HELP[c.cmd];
        const fixed = i < first || i > last;
        const fields = CMD_ARGS[c.cmd] ?? [];
        const sel = selected === i;
        const dragging = drag?.from === i;
        const isOver = overridden.has(i);
        return (
          <div key={i}>
            {lineBefore === i && <div style={{ height: 3, background: C.acc, borderRadius: 2, margin: "1px 0" }} />}
            <div
              ref={(el) => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i); }}
              onClick={() => onSelect(fixed ? null : i)}
              style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                padding: "7px 8px", borderRadius: 9, marginBottom: 3,
                background: sel ? C.accG : fixed ? "transparent" : C.card,
                border: `1px solid ${sel ? C.accB : fixed ? "transparent" : C.bdr}`,
                opacity: dragging ? 0.5 : 1, cursor: fixed ? "default" : "pointer",
              }}
            >
              {fixed ? (
                <span style={{ width: 22, display: "inline-flex", justifyContent: "center", color: C.dim }}><Lock size={13} /></span>
              ) : (
                <span
                  onPointerDown={(e) => startDrag(e, i)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: 22, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center", color: C.mut, cursor: "grab", touchAction: "none" }}
                  aria-label="Verschieben"
                >
                  <GripVertical size={17} />
                </span>
              )}
              <span style={{
                flex: "1 1 130px", minWidth: 0, fontSize: 13.5, fontWeight: fixed ? 500 : 600,
                color: fixed ? C.mut : isOver ? C.mut : C.txt, textDecoration: isOver ? "line-through" : "none",
              }}>
                {help?.title ?? `Befehl ${c.cmd}`}
                {isOver && <span style={{ fontSize: 10, color: C.org, fontWeight: 600, marginLeft: 6, textDecoration: "none", display: "inline-block" }}>läuft nie — kein Warten danach</span>}
              </span>
              {fields.length > 0 && (
                <span className="scr-fields" style={{ display: "inline-flex", flexWrap: "wrap", gap: 10 }}>
                  {fields.map((f, a) => (
                    <ArgInput key={a} field={f} raw={Number(c.args[a] ?? 0)} onChange={(raw) => onArg(i, a, raw)} />
                  ))}
                </span>
              )}
              <span className="scr-actions" style={{ display: "inline-flex" }}>
              {help && (
                <button
                  onClick={(e) => { e.stopPropagation(); setHelpOpen(helpOpen === i ? null : i); }}
                  aria-label="Hilfe"
                  style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer", color: helpOpen === i ? C.acc : C.mut, display: "inline-flex" }}
                >
                  <HelpCircle size={16} />
                </button>
              )}
              {!fixed && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(i); }}
                  aria-label="Löschen"
                  style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer", color: C.mut, display: "inline-flex" }}
                >
                  <Trash2 size={15} />
                </button>
              )}
              </span>
              {helpOpen === i && help && (
                <div className="scr-help" style={{ flexBasis: "100%", margin: "4px 0 2px 30px", padding: "9px 11px", background: C.sunken, borderRadius: 8, border: `1px solid ${C.bdr2}` }}>
                  <HelpBody help={help} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
