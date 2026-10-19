/**
 * Dialog-Rahmen und „Befehl einfügen“ fuer den Reiter Befehle im
 * Profil-Editor. Stammen aus dem alten Skript-Editor (entfernt mit Schnitt 2c),
 * unveraendert uebernommen.
 */

import { useState } from "react";
import { HelpCircle, X } from "lucide-react";
import { CMD_HELP, INSERTABLE_CMDS } from "@shared/script-help.js";
import { HelpBody } from "./ScriptCommandList.js";
import theme from "../theme.js";

const C = theme;
const sectionLabel: React.CSSProperties = { fontSize: 9, color: C.mut, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" };

export const modalTitle: React.CSSProperties = { margin: "0 0 10px", fontSize: 15, fontWeight: 600, color: C.txt };
export const modalText: React.CSSProperties = { margin: "0 0 10px", fontSize: 13, lineHeight: 1.5, color: C.txtS };

export function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
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

export function InsertMenu({ onPick }: { onPick: (cmd: number) => void }) {
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
