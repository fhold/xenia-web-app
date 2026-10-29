/**
 * Netz Profil ↔ Bohne (Schnitt 4).
 *
 * CoffeeProfiles — in der Sorten-Ansicht „Mit diesen Profilen“: je Sieb und
 * Muehle eine Zeile je Profil mit Bezuegen, Mahlgrad-Spanne, Bewertung (Schnitt
 * mit Anzahl), zuletzt, Channeling, Datum und Startknopf. Nur Siebe mit
 * Bezuegen — den Startpunkt fuer ein neues Sieb gibt der Start-Dialog.
 *
 * ProfileRanWith — im Editor der Reiter „Lief mit“: je Muehle die Sorten der
 * gewaehlten Variante, mit Referenz (★).
 *
 * Die Bezuege-Zahlen springen in die Historie (gefiltert). Gerechnet wird im
 * Backend (shared/src/network.ts); hier nur Anzeige.
 */

import { useEffect, useState } from "react";
import type { Profile } from "@shared/types.js";
import type { CoffeeNetwork, NetChanneling, NetRow, ProfileNetwork } from "@shared/network.js";
import { halfStars } from "@shared/network.js";
import { startVariants } from "@shared/profile-slots.js";
import type { ShotFilters } from "../hooks/useShots.js";
import { useBaskets } from "../hooks/useBaskets.js";
import { useGrinders } from "../hooks/useGrinders.js";
import { t, useTranslation } from "../i18n/index.js";
import { formatDay } from "../lib/dates.js";
import theme from "../theme.js";
import { dec } from "../lib/num.js";

const C = theme;
const MONO = "'JetBrains Mono', monospace";

const num = (v: number) => dec(String(Math.round(v * 10) / 10));
const range = (a: number | null, b: number | null) => (a === null || b === null ? "–" : a === b ? num(a) : `${num(a)}–${num(b)}`);
const day = (ms: number) => formatDay(ms, { style: "numeric" });

const CHAN: Record<NetChanneling, { word: () => string; color: string }> = {
  none: { word: () => t("profileList.network.chan.none"), color: C.mut },
  light: { word: () => t("profileList.network.chan.light"), color: C.org },
  strong: { word: () => t("profileList.network.chan.strong"), color: C.red },
  yes: { word: () => t("profileList.network.chan.yes"), color: C.org },
};

/** Fuenf Punkte wie in der Historie, auf halbe gerundet, Anzahl der bewerteten in Klammern. */
function Rating({ avg, rated, size = 9 }: { avg: number | null; rated: number; size?: number }) {
  if (avg === null) return <span style={{ fontSize: 12, color: C.mut }}>–</span>;
  const r = halfStars(avg);
  return (
    <span role="img" aria-label={t("profileList.network.ratingAria", { avg: num(avg), n: rated })} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const full = n <= r;
        const half = !full && n - 0.5 === r;
        return (
          <span key={n} style={{
            width: size, height: size, boxSizing: "border-box", borderRadius: "50%", flexShrink: 0,
            border: `1px solid ${full || half ? C.acc : C.bdr2}`,
            background: full ? C.acc : half ? `linear-gradient(90deg, ${C.acc} 50%, transparent 50%)` : "transparent",
          }} />
        );
      })}
      <span style={{ marginLeft: 4, fontFamily: MONO, fontSize: 11, color: C.mut }}>({rated})</span>
    </span>
  );
}

const linkBtn: React.CSSProperties = {
  padding: 0, border: "none", background: "transparent", textAlign: "left", cursor: "pointer",
  fontFamily: MONO, fontSize: 13, color: C.accLight, textDecoration: "underline dotted",
};
const colHead: React.CSSProperties = { fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: C.mut };
/** Sieb und Muehle einer Gruppe — die Ueberschrift, also lesbar und etwas groesser als die Spaltenkoepfe. */
const groupHead: React.CSSProperties = { ...colHead, fontSize: 11.5, fontWeight: 600, color: C.txtS };

function useNetwork<T>(url: string | null): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (url === null) return;
    let off = false;
    setData(null);
    fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).then((d) => { if (!off) setData(d); }).catch(() => { /* Netz ist Anzeige */ });
    return () => { off = true; };
  }, [url]);
  return data;
}

// ---------------------------------------------------------------------------
// Sorte: „Mit diesen Profilen“
// ---------------------------------------------------------------------------

export function CoffeeProfiles({ coffeeId, mobile, profiles, onStart, onOpenHistory, onOpenProfile }: {
  coffeeId: number;
  mobile: boolean;
  profiles: Profile[];
  onStart: (profile: Profile, variantId: number, basketId: number | null) => void;
  onOpenHistory: (filters: Partial<ShotFilters>) => void;
  onOpenProfile: (profileId: number) => void;
}) {
  const { t } = useTranslation();
  const { baskets } = useBaskets();
  const { grinders } = useGrinders();
  const data = useNetwork<CoffeeNetwork>(`/api/network/coffee/${coffeeId}`);
  if (!data) return null;
  const basketName = (id: number | null) => (id === null ? t("profileList.network.noBasket") : baskets.find((b) => b.id === id)?.name ?? t("profileList.network.basketN", { id }));
  const grinderName = (id: number | null) => (id === null ? t("profileList.network.noGrinder") : grinders.find((g) => g.id === id)?.name ?? t("profileList.network.grinderN", { id }));
  const noteWord = (n: NetRow["last"]["note"]) =>
    n === "finer" ? t("shotRating.grindFiner") : n === "coarser" ? t("shotRating.grindCoarser") : n === "ok" ? t("shotRating.grindOk") : null;
  const total = data.groups.reduce((a, g) => a + g.n, 0);
  const profileCount = new Set(data.groups.flatMap((g) => g.rows.map((r) => r.key))).size;

  /** Startknopf: die zuletzt mit diesem Sieb gelaufene Variante, sonst die mit diesem Vorgabe-Sieb. */
  const startButton = (p: Profile | undefined, variantId: number | null, basketId: number | null) => {
    if (!p || p.kind !== "brew") return <span style={{ width: 100 }} />;
    const vs = startVariants(p);
    const v = vs.find((x) => x.id === variantId) ?? vs.find((x) => x.defaultBasketId === basketId) ?? vs[0];
    if (!v) return <span style={{ width: 100 }} />;
    return (
      <button
        onClick={() => onStart(p, v.id, basketId)}
        style={{
          width: 100, height: 44, flexShrink: 0, boxSizing: "border-box", borderRadius: 10, border: `1px solid ${C.bdr2}`, background: C.sunken,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: C.accLight, maxWidth: 90, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.name}</span>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.mut }}>{v.yieldG !== null ? `${num(v.yieldG)} g` : "—"}</span>
      </button>
    );
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: C.mut }}>{t("profileList.network.heading")}</h2>
        {total > 0 && <span style={{ fontSize: 12, color: C.mut }}>{t("profileList.network.summary", { shots: total, profiles: profileCount })}</span>}
      </div>
      {data.groups.length === 0 && (
        <div style={{ fontSize: 13, color: C.mut }}>{t("profileList.network.noShotsCoffee")}</div>
      )}

      {data.groups.map((g) => (
        <div key={`${g.basketId}|${g.grinderId}`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ minHeight: 18, display: "flex", alignItems: "center", gap: 14, padding: "0 14px", marginTop: 4 }}>
            <span style={{ ...groupHead, flex: 1 }}>{basketName(g.basketId)} · {grinderName(g.grinderId)}</span>
            {!mobile && <>
              <span style={{ ...colHead, width: 44 }}>{t("profileList.network.col.shots")}</span>
              <span style={{ ...colHead, width: 70 }}>{t("profileList.network.col.grind")}</span>
              <span style={{ ...colHead, width: 104 }}>{t("profileList.network.col.rating")}</span>
              <span style={{ ...colHead, width: 126 }}>{t("profileList.network.col.last")}</span>
              <span style={{ ...colHead, width: 80 }}>{t("profileList.network.col.channeling")}</span>
              <span style={{ ...colHead, width: 44 }}>{t("profileList.network.col.date")}</span>
              <span style={{ width: 100 }} />
            </>}
          </div>
          {g.rows.map((r) => {
            const p = r.id !== null ? profiles.find((x) => x.id === r.id) : undefined;
            const chan = r.last.channeling ? CHAN[r.last.channeling] : null;
            const note = noteWord(r.last.note);
            return (
              <div key={r.key} style={{
                minHeight: 54, boxSizing: "border-box", display: "flex", flexWrap: mobile ? "wrap" : "nowrap", alignItems: "center", gap: 14, padding: "5px 14px",
                background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 12,
              }}>
                <div style={{ flex: mobile ? "1 1 100%" : 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  {r.id !== null && p ? (
                    <button onClick={() => onOpenProfile(r.id!)} style={{ padding: 0, border: "none", background: "transparent", textAlign: "left", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, color: C.txt, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.label}
                    </button>
                  ) : <span style={{ fontSize: 14, fontWeight: 600, color: C.txtS }}>{r.label}</span>}
                  {p && <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.mut }}>#{p.id}{p.targetTempC !== null ? ` · ${num(p.targetTempC)} °C` : ""}</span>}
                </div>
                <span style={{ width: 44 }}>
                  <button
                    aria-label={t("profileList.network.showInHistory", { n: r.n, label: r.label })}
                    onClick={() => onOpenHistory({ profileId: r.id, coffeeId, basketId: g.basketId })}
                    style={linkBtn}
                  >{r.n}×</button>
                </span>
                <span style={{ width: 70, fontFamily: MONO, fontSize: 13, color: C.txt }}>{range(r.grindMin, r.grindMax)}</span>
                <span style={{ width: 104 }}><Rating avg={r.ratingAvg} rated={r.rated} /></span>
                {!mobile && <span style={{ width: 126, fontSize: 12.5, color: C.txtS, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.last.grind !== null ? t("profileList.network.grindShort", { v: num(r.last.grind) }) : "–"}{note ? ` · ${note.toLowerCase()}` : ""}
                </span>}
                {!mobile && <span style={{ width: 80, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: chan?.color ?? C.mut }}>
                  {chan ? <><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: chan.color }} />{chan.word()}</> : "–"}
                </span>}
                {!mobile && <span style={{ width: 44, fontFamily: MONO, fontSize: 11.5, color: C.mut }}>{day(r.last.at)}</span>}
                {startButton(p, r.last.variantId, g.basketId)}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Profil: „Lief mit“
// ---------------------------------------------------------------------------

export function ProfileRanWith({ profileId, variantId, variantName, onOpenHistory, onOpenCoffee }: {
  profileId: number;
  /** Die gewaehlte, gespeicherte Variante; null = neu, noch ohne Bezug. */
  variantId: number | null;
  variantName: string;
  onOpenHistory?: (filters: Partial<ShotFilters>) => void;
  onOpenCoffee?: (coffeeId: number) => void;
}) {
  const { t } = useTranslation();
  const { grinders } = useGrinders();
  const data = useNetwork<ProfileNetwork>(`/api/network/profile/${profileId}`);
  if (!data) return null;
  const groups = data.groups.filter((g) => variantId !== null && g.variantId === variantId);
  if (groups.length === 0) return <div style={{ fontSize: 13, color: C.mut, padding: "6px 0" }}>{t("profileList.network.noShotsVariant")}</div>;
  const grinderName = (id: number | null) => (id === null ? t("profileList.network.noGrinder") : grinders.find((g) => g.id === id)?.name ?? t("profileList.network.grinderN", { id }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {groups.map((g) => (
        <div key={g.grinderId ?? "-"} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12.5 }}>
          <div style={{ minHeight: 28, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={groupHead}>{variantName} · {grinderName(g.grinderId)}</span>
            <span style={{ flex: 1 }} />
            {onOpenHistory && (
              <button
                onClick={() => onOpenHistory({ profileId, variantId })}
                style={{ height: 28, padding: "0 10px", border: `1px solid ${C.bdr2}`, borderRadius: 7, background: "transparent", color: C.accLight, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
              >{t("profileList.network.inHistory", { n: g.n })}</button>
            )}
          </div>
          {g.rows.map((r) => (
            <div key={r.key} style={{ minHeight: 30, display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.bdr}` }}>
              <span style={{ width: 200, color: r.id !== null ? C.txt : C.txtS, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
              <span style={{ width: 44 }}>
                {r.id !== null && onOpenHistory
                  ? <button aria-label={t("profileList.network.showInHistory", { n: r.n, label: r.label })} onClick={() => onOpenHistory({ profileId, variantId, coffeeId: r.id })} style={{ ...linkBtn, fontSize: 12.5 }}>{r.n}×</button>
                  : <span style={{ fontFamily: MONO, color: C.txtS }}>{r.n}×</span>}
              </span>
              <span style={{ width: 100, fontFamily: MONO, color: C.txtS }}>{r.grindMin !== null ? t("profileList.network.grindShort", { v: range(r.grindMin, r.grindMax) }) : "–"}</span>
              <span style={{ width: 104 }}><Rating avg={r.ratingAvg} rated={r.rated} size={8} /></span>
              <span style={{ flex: 1 }} />
              {r.id !== null && onOpenCoffee && (
                <button onClick={() => onOpenCoffee(r.id!)} style={{ padding: "0 4px", height: 28, border: "none", background: "transparent", color: C.accLight, fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>{t("profileList.network.coffee")}</button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

