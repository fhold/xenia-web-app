/**
 * CoffeePicker — modal target picker for Merge (coffee→coffee) and Move
 * (roasting→coffee). Shows matching-component suggestions on top (§3.4b
 * /api/coffees/match) plus the full searchable coffee list.
 */

import { useEffect, useMemo, useState } from "react";
import { X, Check } from "lucide-react";
import { useTranslation } from "../i18n/index.js";
import type { Coffee, MatchCandidate } from "@shared/types.js";
import theme from "../theme.js";

const C = theme;

interface Props {
  title: string;
  hint: string;
  confirmLabel: string;
  /** Name/roaster used to query suggestions. */
  queryName: string;
  queryRoaster: string | null;
  /** Coffees to pick from (already excludes the source where relevant). */
  coffees: Coffee[];
  match: (name: string, roaster: string | null) => Promise<MatchCandidate[]>;
  onPick: (coffeeId: number) => Promise<void>;
  onClose: () => void;
}

export function CoffeePicker({ title, hint, confirmLabel, queryName, queryRoaster, coffees, match, onPick, onClose }: Props) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<MatchCandidate[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = useMemo(() => new Set(coffees.map((c) => c.id)), [coffees]);

  useEffect(() => {
    let off = false;
    match(queryName, queryRoaster)
      .then((res) => { if (!off) setSuggestions(res.filter((c) => c.verdict !== "kein-treffer" && allowed.has(c.coffeeId)).slice(0, 4)); })
      .catch(() => {});
    return () => { off = true; };
  }, [match, queryName, queryRoaster, allowed]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return coffees.filter((c) =>
      q === "" || c.name.toLowerCase().includes(q) || (c.roaster ?? "").toLowerCase().includes(q),
    );
  }, [coffees, search]);

  const confirm = async () => {
    if (selected === null) return;
    setBusy(true);
    try { await onPick(selected); onClose(); } catch { setBusy(false); }
  };

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", width: "100%",
    background: active ? C.accG : "transparent", border: `1px solid ${active ? C.accB : "transparent"}`,
    borderRadius: 9, cursor: "pointer", textAlign: "left", fontFamily: "inherit",
  });

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 210 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 211,
        width: "min(440px, 96vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
        background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 14, padding: "18px 18px 18px",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.txt }}>{title}</h2>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.mut, display: "flex" }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: C.mut, margin: "6px 0 12px" }}>{hint}</div>

        <input
          autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("coffee.search")}
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: C.bg, border: `1px solid ${C.bdr}`, color: C.txt, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none", marginBottom: 10 }}
        />

        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {search.trim() === "" && suggestions.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.acc, textTransform: "uppercase", margin: "2px 4px 6px" }}>
                {t("coffee.suggestions")}
              </div>
              {suggestions.map((s) => (
                <button key={`s${s.coffeeId}`} onClick={() => setSelected(s.coffeeId)} style={rowStyle(selected === s.coffeeId)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                    {s.roaster && <div style={{ fontSize: 12, color: C.mut }}>{s.roaster}</div>}
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6,
                    color: s.verdict === "sicher" ? C.grn : C.org,
                    background: s.verdict === "sicher" ? C.grnD : C.orgD,
                    border: `1px solid ${s.verdict === "sicher" ? C.grn : C.org}40`,
                  }}>{s.verdict === "sicher" ? t("ui.coffeeMatch.sure") : t("ui.coffeeMatch.unclear")}</span>
                  {selected === s.coffeeId && <Check size={16} color={C.acc} />}
                </button>
              ))}
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.mut, textTransform: "uppercase", margin: "12px 4px 6px" }}>
                {t("coffee.allSorten")}
              </div>
            </>
          )}
          {filtered.map((c) => (
            <button key={c.id} onClick={() => setSelected(c.id)} style={rowStyle(selected === c.id)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                {c.roaster && <div style={{ fontSize: 12, color: C.mut }}>{c.roaster}</div>}
              </div>
              {selected === c.id && <Check size={16} color={C.acc} />}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.bdr}`, borderRadius: 8, padding: "8px 16px", color: C.mut, fontSize: 13, cursor: "pointer" }}>{t("coffee.cancel")}</button>
          <button onClick={() => void confirm()} disabled={selected === null || busy}
            style={{ background: C.accG2, border: `1px solid ${C.accB}`, borderRadius: 8, padding: "8px 18px", color: selected === null ? C.mut : C.acc, fontSize: 13, fontWeight: 600, cursor: selected === null ? "not-allowed" : "pointer", opacity: selected === null ? 0.6 : 1 }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
