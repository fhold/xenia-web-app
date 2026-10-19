/**
 * Profiles view — eine Liste: Favoriten farbig abgesetzt oben, dann die
 * übrigen Profile, Wartungsprofile unten hinter einem Trenner, ganz am Ende
 * Skripte an der Maschine, die kein Profil benutzt.
 *
 * Sortieren per Ziehen am Griff (Pointer statt HTML5-Drag-and-Drop, das auf dem
 * Tablet nicht geht — dasselbe Muster wie die Befehlsliste im Skript-Editor).
 * Gespeichert wird die ganze Reihenfolge über POST /api/profiles/order; die
 * Reihenfolge der Favoriten ist die der Dashboard-Chips.
 */

import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2, Plus, RefreshCw, Star, Copy, Download, MoreHorizontal, History as HistoryIcon, GripVertical, FlaskConical } from "lucide-react";
import type { Basket, Profile, ProfileCreate, ProfileVariant, XeniaScript } from "@shared/types.js";
import { effectiveCategory } from "@shared/bbw-arming.js";
import { startVariants, variantInputs, variantRunsInApp } from "@shared/profile-slots.js";
import type { UseProfilesReturn } from "../hooks/useProfiles.js";
import { ProfileEditorView } from "../components/ProfileEditorView.js";
import type { UseScriptsReturn } from "../hooks/useScripts.js";
import { ProfileSparkline } from "../components/ProfileSparkline.js";
import { useBaskets } from "../hooks/useBaskets.js";
import type { ShotFilters } from "../hooks/useShots.js";
import { Modal, modalTitle, modalText } from "../components/ScriptInsertMenu.js";

import theme, { alpha } from '../theme';
const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

const LABEL: React.CSSProperties = {
  fontSize: 10,
  color: C.mut,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 1.5,
};

/** The editable content of a profile — for "duplizieren". Die Kopie bleibt Versuch, wenn das Original einer ist. */
function profilePayload(p: Profile): ProfileCreate {
  return {
    name: p.name,
    kind: p.kind,
    isTrial: p.isTrial,
    scriptIdSingle: p.scriptIdSingle,
    scriptIdDouble: p.scriptIdDouble,
    yieldTargetSingleG: p.yieldTargetSingleG,
    yieldTargetDoubleG: p.yieldTargetDoubleG,
    targetTempC: p.targetTempC,
    notes: p.notes,
    brewSteps: p.brewSteps,
    brewStepsDouble: p.brewStepsDouble,
  };
}

/**
 * JSON-Export v2 (Schnitt 3e): Varianten mit Sieb (Name + Typ), Yield und
 * Kurve — Skripte mit Titel und Inhalt, nicht nur ihrer Nummer. So bleibt die
 * Datei ohne diese Datenbank und diese Maschine lesbar.
 */
function exportProfile(p: Profile, scripts: XeniaScript[], baskets: Basket[]): void {
  const list = startVariants(p);
  const profile = {
    name: p.name,
    kind: p.kind,
    isTrial: p.isTrial,
    targetTempC: p.targetTempC,
    notes: p.notes,
    variants: list.map((v) => {
      const basket = baskets.find((b) => b.id === v.defaultBasketId);
      const script = v.scriptId !== null ? scripts.find((s) => s.id === v.scriptId) : undefined;
      return {
        name: v.name,
        basket: basket ? { name: basket.name, type: basket.type } : null,
        yieldG: v.yieldG,
        // „wie Variante X“ — per Name, IDs gelten nur in dieser Datenbank.
        sameAs: v.sameAsId !== null ? (list.find((x) => x.id === v.sameAsId)?.name ?? null) : null,
        script: script ? { title: script.title, content: script.content } : null,
        phaseNames: v.phaseNames,
        brewSteps: v.brewSteps,
      };
    }),
  };
  const blob = new Blob(
    [JSON.stringify({ kind: "xenia-profile", version: 2, profile }, null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `profil-${p.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const fmtG = (g: number) => (Number.isInteger(g) ? String(g) : g.toFixed(1)).replace(".", ",");

interface ProfilesProps {
  profiles: Profile[];
  scripts: XeniaScript[];
  profileActions: Pick<UseProfilesReturn,
    "createProfile" | "updateProfile" | "deleteProfile" | "reorderProfiles">;
  /** Start einer Variante (null = die erste) — oeffnet „Bezug vorbereiten“. */
  onExecute: (profile: Profile, variantId: number | null) => void;
  /** Start a flow-hold drive for a variant that runs in the app (step sequence). */
  onExecuteDrive?: (profile: Profile, variantId: number | null) => void;
  /** Whether a new shot may be started right now (machine ready + no active
   *  shot). Same readiness logic as the Dashboard chips (shared helper). */
  canStartShot?: boolean;
  /** Klick auf einen gesperrten Start — die App sagt, WARUM gesperrt ist. */
  onBlockedStart?: () => void;
  mobile?: boolean;
  scriptsSyncing?: boolean;
  onEditorOpen?: () => void;
  /** „Alle Bezüge“: die Historie, gefiltert auf dieses Profil. */
  onOpenHistory?: (profileId: number) => void;
  /** Ein Skript ohne Profil an der Maschine löschen. */
  onDeleteScript?: (scriptId: number) => Promise<void>;
  /** Schnitt 4, Reiter „Lief mit“: Historie mit Filtern, Sorte oeffnen. */
  onOpenHistoryWith?: (filters: Partial<ShotFilters>) => void;
  onOpenCoffee?: (coffeeId: number) => void;
  /** Skripte an der Maschine anlegen/ueberschreiben/loeschen — fuer den vereinten Editor. */
  scriptActions: Pick<UseScriptsReturn, "createScript" | "updateScript" | "deleteScript">;
  /** Offener Editor (Profil-Id, neues Profil oder keiner) — steht im Verlauf der App. */
  editorId?: number | "new" | null;
  onOpenEditor: (id: number | "new") => void;
  /** Editor zu (Zurueck, Verwerfen, nach dem Speichern) — fuehrt dorthin, woher er kam. */
  onCloseEditor: () => void;
}

/** Ein Eintrag im Zeilen-Menü. Bewusst lokal: der einzige andere Ort mit
 *  demselben Muster (Sorten-Detail) hat seinen eigenen, und eine geteilte
 *  Komponente für zwei Aufrufer waere Abstraktion auf Verdacht. */
function RowMenuItem({ icon, label, danger, onClick }: {
  icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => { setHover(true); }}
      onMouseLeave={() => { setHover(false); }}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
        fontFamily: "inherit", fontSize: 13, textAlign: "left",
        background: hover ? (danger ? alpha(C.red, 0.10) : C.cardHover) : "transparent",
        color: danger ? C.red : C.txtS,
      }}
    >
      {icon}{label}
    </button>
  );
}

type Group = "fav" | "norm" | "test";
interface DragState { group: Group; from: number; to: number; pointerId: number; mids: number[] }

export function Profiles({
  profiles,
  scripts,
  profileActions,
  onExecute,
  onExecuteDrive,
  canStartShot = true,
  onBlockedStart,
  mobile = false,
  scriptsSyncing,
  onEditorOpen,
  onOpenHistory,
  onDeleteScript,
  onOpenHistoryWith,
  onOpenCoffee,
  scriptActions,
  editorId = null,
  onOpenEditor,
  onCloseEditor,
}: ProfilesProps) {
  // Vereinter Editor (volle Ansicht). Welcher offen ist, sagt der Verlauf der
  // App (`editorId`); hier liegt der Stand des Profils beim Oeffnen — ein
  // spaeteres Nachladen der Liste setzt den Editor nicht zurueck. Ein gerade
  // angelegtes Profil oeffnet, sobald es in der Liste steht.
  const [editorProfile, setEditorProfile] = useState<Profile | null | "new">(null);
  useEffect(() => {
    if (editorId === null) { setEditorProfile(null); return; }
    if (editorId === "new") { setEditorProfile("new"); return; }
    setEditorProfile((cur) => (cur !== null && cur !== "new" && cur.id === editorId)
      ? cur
      : (profiles.find((x) => x.id === editorId) ?? null));
  }, [editorId, profiles]);
  // Beim Oeffnen gleicht der Editor die Skripte der Maschine ab.
  const openedFor = useRef<number | "new" | null>(null);
  useEffect(() => {
    if (editorId !== null && editorId !== openedFor.current) onEditorOpen?.();
    openedFor.current = editorId;
  }, [editorId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busyId, setBusyId] = useState<number | null>(null);
  /** Offenes Zeilen-Menue (Profil-Id) — immer nur eines. */
  const [menuId, setMenuId] = useState<number | null>(null);
  /** Profil loeschen: Rueckfrage, welche seiner Skripte an der Maschine mit weg sollen (keins vorgewaehlt). */
  const [deleting, setDeleting] = useState<{ profile: Profile; own: XeniaScript[]; pick: Set<number> } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Gezogene Reihenfolge gilt sofort, bis die Liste vom Server zurueckkommt.
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  useEffect(() => { setLocalOrder(null); }, [profiles]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  const { baskets } = useBaskets();
  const scriptById = new Map(scripts.map((s) => [s.id, s]));
  const isMaintenance = (p: Profile): boolean => p.kind === "maintenance";

  const ordered = localOrder
    ? [...profiles].sort((a, b) => localOrder.indexOf(a.id) - localOrder.indexOf(b.id))
    : profiles;
  // Messlauf-Profile stehen in einer eigenen Gruppe ganz unten, auch als Favorit.
  const isTest = (p: Profile): boolean => p.kind === "test";
  const favorites = ordered.filter((p) => p.isFavorite && !isTest(p));
  const others = ordered.filter((p) => !p.isFavorite && !isMaintenance(p) && !isTest(p));
  const maintenance = ordered.filter((p) => !p.isFavorite && isMaintenance(p));
  const tests = ordered.filter(isTest);
  const groupIds: Record<Group, number[]> = { fav: favorites.map((p) => p.id), norm: others.map((p) => p.id), test: tests.map((p) => p.id) };

  // Skripte an der Maschine, die kein Profil benutzt (die Liste kennt nur
  // nicht verwaiste Skripte — geloeschte bleiben fuer die Historie in der DB).
  const used = new Set<number>();
  for (const p of profiles) {
    if (p.scriptIdSingle !== null) used.add(p.scriptIdSingle);
    if (p.scriptIdDouble !== null) used.add(p.scriptIdDouble);
    for (const v of p.variants ?? []) if (v.scriptId !== null) used.add(v.scriptId);
  }
  const loose = scripts.filter((s) => !used.has(s.id));

  async function run(id: number | null, fn: () => Promise<unknown>) {
    setBusyId(id);
    setRowError(null);
    try {
      await fn();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  // A copy is never a favourite — it would land in the ordered favourites list
  // next to its original without the user asking for it.
  // Die Kopie bekommt die Varianten als neue (ohne IDs).
  const duplicate = (p: Profile) => run(p.id, () =>
    profileActions.createProfile({
      ...profilePayload(p), name: `${p.name} (Kopie)`, isFavorite: false,
      variants: variantInputs(p).map((v) => ({ ...v, id: null })),
    }));

  // Die Art schlaegt die Kategorie des Skripts vor (Uebersteuerung vor Automatik).
  const adoptScript = (s: XeniaScript) => run(null, async () => {
    const created = await profileActions.createProfile({
      name: s.title, scriptIdSingle: s.id, scriptIdDouble: null,
      kind: effectiveCategory({ categoryAuto: s.categoryAuto, categoryOverride: s.categoryOverride }) === "maintenance" ? "maintenance" : "brew",
      yieldTargetSingleG: null, yieldTargetDoubleG: null, isFavorite: false,
    });
    onOpenEditor(created.id);
  });

  // Nur Skripte, die kein anderes Profil faehrt, stehen zur Wahl — und nur, wenn sie an der Maschine sind.
  const askDelete = (p: Profile) => {
    const mine = new Set((p.variants ?? []).map((v) => v.scriptId).filter((id): id is number => id !== null));
    const others = new Set(profiles.filter((x) => x.id !== p.id).flatMap((x) => (x.variants ?? []).map((v) => v.scriptId)));
    const own = scripts.filter((s) => mine.has(s.id) && !others.has(s.id));
    setDeleting({ profile: p, own: onDeleteScript ? own : [], pick: new Set() });
  };
  const confirmDelete = () => {
    if (!deleting) return;
    const { profile: p, pick } = deleting;
    setDeleting(null);
    void run(p.id, async () => {
      await profileActions.deleteProfile(p.id);
      for (const id of pick) await onDeleteScript!(id);
    });
  };

  const deleteScript = (s: XeniaScript) => {
    if (!onDeleteScript) return;
    if (!window.confirm(`Skript #${s.id} „${s.title}“ an der Maschine löschen? Das lässt sich nicht rückgängig machen.`)) return;
    void run(null, () => onDeleteScript(s.id));
  };

  // --- Ziehen -----------------------------------------------------------------

  const startDrag = (e: React.PointerEvent, group: Group, index: number) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const mids = groupIds[group].map((id) => {
      const r = rowRefs.current.get(id)?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : 0;
    });
    setDrag({ group, from: index, to: index, pointerId: e.pointerId, mids });
    setMenuId(null);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // Zielplatz = Zahl der anderen Zeilen, deren Mitte ueber dem Zeiger liegt.
    const to = drag.mids.filter((m, i) => i !== drag.from && m < e.clientY).length;
    if (to !== drag.to) setDrag({ ...drag, to });
  };
  const endDrag = () => {
    if (!drag) return;
    const { group, from, to } = drag;
    setDrag(null);
    if (to === from) return;
    const ids = [...groupIds[group]];
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    const fav = group === "fav" ? ids : groupIds.fav;
    const norm = group === "norm" ? ids : groupIds.norm;
    const test = group === "test" ? ids : groupIds.test;
    const full = [...fav, ...norm, ...maintenance.map((p) => p.id), ...test];
    setLocalOrder(full);
    void run(null, async () => {
      try {
        await profileActions.reorderProfiles(full);
      } catch (err) {
        setLocalOrder(null);
        throw err;
      }
    });
  };

  // --- Bausteine --------------------------------------------------------------

  const iconBtn: React.CSSProperties = {
    width: 36, height: 36, flexShrink: 0, borderRadius: 9, border: `1px solid ${C.bdrL}`,
    background: "transparent", color: C.mut, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  };

  // Start je Variante. Zwei Zustaende: startbereit; gesperrt, weil die Maschine
  // gerade nicht kann — bleibt lesbar und anklickbar, der Klick sagt warum.
  const startButton = (key: string, label: string, yieldG: number | null, onTap: () => void, warm = false) => {
    const ready = canStartShot;
    return (
      <button
        key={key}
        onClick={() => { if (ready) onTap(); else onBlockedStart?.(); }}
        title={ready ? undefined : "Maschine nicht bereit oder Bezug läuft"}
        style={{
          // Handy: so breit wie die Variante es braucht („Doppel“ nie „Dop…“) — gekuerzt wird der Profilname.
          ...(mobile ? { minWidth: 64, maxWidth: 120, padding: "0 4px" } : { width: 94 }), height: 42, boxSizing: "border-box", flexShrink: 0,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
          borderRadius: 10, border: `1px solid ${ready ? C.bdr2 : C.bdr}`,
          background: ready ? C.sunken : "transparent", cursor: "pointer", fontFamily: "inherit",
        }}
      >
        <span style={{ maxWidth: "100%", padding: "0 6px", boxSizing: "border-box", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600, color: ready ? (warm ? C.org : C.acc) : C.mut }}>{label}</span>
        {yieldG !== null && <span style={{ ...MONO, fontSize: 10.5, color: C.mut }}>{fmtG(yieldG)} g</span>}
      </button>
    );
  };

  const engineChip = (text: string, color: string) => !mobile && (
    <span style={{
      width: 56, flexShrink: 0, fontSize: 11, color, textAlign: "center",
      border: `1px solid ${C.bdrL}`, borderRadius: 6, padding: "3px 0",
    }}>
      {text}
    </span>
  );

  const menu = (p: Profile) => (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => { setMenuId(menuId === p.id ? null : p.id); }}
        title="Weitere Aktionen"
        aria-label="Weitere Aktionen"
        style={iconBtn}
      >
        {busyId === p.id ? <RefreshCw size={13} /> : <MoreHorizontal size={15} />}
      </button>
      {menuId === p.id && (
        <>
          <div onClick={() => { setMenuId(null); }} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{
            position: "absolute", top: 40, right: 0, zIndex: 41,
            background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 12,
            padding: 5, minWidth: 210, boxShadow: `0 22px 56px ${alpha(C.black, 0.55)}`,
          }}>
            <RowMenuItem icon={<Pencil size={15} />} label="Bearbeiten"
              onClick={() => { setMenuId(null); onOpenEditor(p.id); }} />
            {onOpenHistory && (
              <RowMenuItem icon={<HistoryIcon size={15} />} label="Alle Bezüge"
                onClick={() => { setMenuId(null); onOpenHistory(p.id); }} />
            )}
            <RowMenuItem icon={<Star size={15} />} label={p.isFavorite ? "Aus Favoriten entfernen" : "Zu Favoriten"}
              onClick={() => { setMenuId(null); void run(p.id, () => profileActions.updateProfile(p.id, { isFavorite: !p.isFavorite })); }} />
            <RowMenuItem icon={<FlaskConical size={15} />} label={p.isTrial ? "Versuch beendet" : "Als Versuch markieren"}
              onClick={() => { setMenuId(null); void run(p.id, () => profileActions.updateProfile(p.id, { isTrial: !p.isTrial })); }} />
            <RowMenuItem icon={<Copy size={15} />} label="Duplizieren"
              onClick={() => { setMenuId(null); void duplicate(p); }} />
            <RowMenuItem icon={<Download size={15} />} label="Als JSON exportieren"
              onClick={() => { setMenuId(null); exportProfile(p, scripts, baskets); }} />
            <div style={{ height: 1, background: C.bdr, margin: "5px 4px" }} />
            <RowMenuItem icon={<Trash2 size={15} />} label="Löschen" danger
              onClick={() => { setMenuId(null); askDelete(p); }} />
          </div>
        </>
      )}
    </div>
  );

  const nameBlock = (p: Profile, meta: string) => (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      <button
        onClick={() => { onOpenEditor(p.id); }}
        style={{
          display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: 0, border: "none",
          background: "transparent", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
        }}
      >
        {p.isFavorite && <Star size={12} color={C.acc} fill={C.acc} style={{ flexShrink: 0 }} />}
        {p.isTrial && <FlaskConical size={13} color={C.org} aria-label="Versuch" style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: 15, fontWeight: 600, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.name}
        </span>
      </button>
      <span style={{ ...MONO, fontSize: 11, color: C.mut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta}</span>
    </div>
  );

  // Als Funktion, nicht als innere Komponente: eine neue Komponente je Render
  // wuerde die Zeilen beim Ziehen neu einhaengen und den Griff verlieren.
  const renderRow = (p: Profile, group: Group, index: number) => {
    const isFlow = p.brewSteps != null;
    // Startknoepfe je Variante, hoechstens zwei — weitere waehlt man im Start-Dialog.
    const shown = startVariants(p).slice(0, 2);
    const start = (v: ProfileVariant | null) =>
      (v !== null && variantRunsInApp(p, v) ? onExecuteDrive?.(p, v.id) : onExecute(p, v?.id ?? null));
    const dragging = drag?.group === group && drag.from === index;
    const meta = [`#${p.id}`, p.targetTempC !== null ? `${p.targetTempC.toFixed(1).replace(".", ",")} °C` : null]
      .filter(Boolean).join(" · ");
    return (
      <div
        key={p.id}
        ref={(el) => { if (el) rowRefs.current.set(p.id, el); else rowRefs.current.delete(p.id); }}
        style={{
          display: "flex", alignItems: "center", gap: mobile ? 8 : 12,
          minHeight: 52, boxSizing: "border-box", padding: mobile ? "4px 8px 4px 0" : "4px 12px 4px 0",
          background: p.isFavorite ? C.accG : C.card,
          border: `1px solid ${dragging ? C.acc : p.isFavorite ? C.accB : C.bdr}`,
          borderRadius: 12, opacity: dragging ? 0.6 : 1,
        }}
      >
        <span
          onPointerDown={(e) => startDrag(e, group, index)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label={`${p.name} verschieben`}
          role="button"
          style={{
            width: 32, alignSelf: "stretch", flexShrink: 0, display: "flex", alignItems: "center",
            justifyContent: "center", color: C.node, cursor: "grab", touchAction: "none",
          }}
        >
          <GripVertical size={16} />
        </span>
        {nameBlock(p, meta)}
        {!mobile && (
          <span style={{ width: 120, display: "flex", justifyContent: "center", flexShrink: 0 }}>
            <ProfileSparkline profile={p} script={p.scriptIdSingle !== null ? scriptById.get(p.scriptIdSingle) : undefined} />
          </span>
        )}
        {engineChip(isFlow ? "App" : "Skript", isFlow ? C.blu : C.txtS)}
        <div style={{ display: "flex", gap: 8, width: mobile ? undefined : 196, justifyContent: "flex-end", flexShrink: 0 }}>
          {shown.length > 0
            ? shown.map((v) => startButton(`v${v.id}`, v.name, v.yieldG, () => start(v)))
            : startButton("start", "Start", p.yieldTargetSingleG, () => start(null))}
        </div>
        {menu(p)}
      </div>
    );
  };

  /** Einfuege-Linie beim Ziehen: vor Zeile `to` (nach unten verschoben: hinter `to`). */
  const lineBefore = (group: Group): number | null => {
    if (!drag || drag.group !== group || drag.to === drag.from) return null;
    return drag.to < drag.from ? drag.to : drag.to + 1;
  };
  const dropLine = <div style={{ height: 3, background: C.acc, borderRadius: 2, margin: "-1px 0" }} />;

  const renderGroup = (group: Group, list: Profile[]) => {
    const line = lineBefore(group);
    return list.map((p, i) => (
      <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {line === i && dropLine}
        {renderRow(p, group, i)}
        {line === list.length && i === list.length - 1 && dropLine}
      </div>
    ));
  };

  if (editorProfile !== null) {
    const p = editorProfile === "new" ? null : editorProfile;
    return (
      <ProfileEditorView
        profile={p}
        profiles={profiles}
        scripts={scripts}
        scriptsSyncing={scriptsSyncing}
        scriptActions={scriptActions}
        onSaveProfile={async (data) => {
          if (p === null) await profileActions.createProfile(data);
          else await profileActions.updateProfile(p.id, data);
        }}
        onClose={onCloseEditor}
        mobile={mobile}
        onOpenHistory={onOpenHistoryWith}
        onOpenCoffee={onOpenCoffee}
      />
    );
  }

  return (
    <div>
      {deleting && (
        <Modal onClose={() => setDeleting(null)}>
          <h3 style={modalTitle}>Profil „{deleting.profile.name}“ löschen?</h3>
          <p style={modalText}>Die Bezüge bleiben in der Historie.{deleting.own.length > 0 && " Diese Skripte nutzt sonst kein Profil — an der Maschine mit löschen?"}</p>
          {deleting.own.map((s) => (
            <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32, fontSize: 13, color: C.txtS, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={deleting.pick.has(s.id)}
                onChange={() => {
                  const pick = new Set(deleting.pick);
                  if (pick.has(s.id)) pick.delete(s.id); else pick.add(s.id);
                  setDeleting({ ...deleting, pick });
                }}
              />
              Skript #{s.id} „{s.title}“
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
            <button onClick={() => setDeleting(null)} style={dialogBtn(false)}>Abbrechen</button>
            <button onClick={confirmDelete} style={dialogBtn(true)}>Löschen</button>
          </div>
        </Modal>
      )}
      {rowError && (
        <div
          style={{
            fontSize: 12,
            color: C.red,
            background: C.redD,
            border: `1px solid ${C.red}30`,
            borderRadius: 8,
            padding: "8px 12px",
            marginBottom: 10,
          }}
        >
          {rowError}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ ...LABEL, flex: 1 }}>Profile</div>
        <button onClick={() => { onOpenEditor("new"); }} style={headerBtn}>
          <Plus size={14} /> Neues Profil
        </button>
      </div>

      {profiles.length === 0 && (
        <div style={{ fontSize: 13, color: C.mut, paddingTop: 16, textAlign: "center" }}>
          Noch keine Profile. Erstelle dein erstes Profil.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {renderGroup("fav", favorites)}
        {renderGroup("norm", others)}

        {(maintenance.length > 0 || loose.length > 0) && (
          <div style={{ height: 1, background: C.bdrL, margin: "4px 0" }} />
        )}
        {maintenance.map((p) => {
          const scriptTitle = p.scriptIdSingle !== null ? scriptById.get(p.scriptIdSingle)?.title : undefined;
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", gap: mobile ? 8 : 12, minHeight: 46, boxSizing: "border-box",
              padding: mobile ? "4px 8px 4px 40px" : "4px 12px 4px 44px",
              background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 12,
            }}>
              {nameBlock(p, [`#${p.id}`, scriptTitle ? `Skript „${scriptTitle}“` : null].filter(Boolean).join(" · "))}
              {engineChip("Wartung", C.org)}
              <div style={{ display: "flex", width: mobile ? undefined : 196, justifyContent: "flex-end", flexShrink: 0 }}>
                {startButton("start", "Start", null, () => onExecute(p, startVariants(p)[0]?.id ?? null), true)}
              </div>
              {menu(p)}
            </div>
          );
        })}
        {tests.length > 0 && (
          <div style={{ height: 1, background: C.bdrL, margin: "4px 0" }} />
        )}
        {renderGroup("test", tests)}
        {loose.map((s) => (
          <div key={`s${s.id}`} style={{
            display: "flex", alignItems: "center", gap: mobile ? 8 : 12, minHeight: 46, boxSizing: "border-box",
            padding: mobile ? "4px 8px 4px 40px" : "4px 12px 4px 44px",
            border: `1px dashed ${C.bdr2}`, borderRadius: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.mut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
              <span style={{ ...MONO, fontSize: 11, color: C.mut }}>Skript #{s.id} · {mobile ? "ohne Profil" : "an der Maschine, ohne Profil"}</span>
            </div>
            <button onClick={() => { void adoptScript(s); }} style={{ ...headerBtn, color: C.acc, height: 36 }}>
              Als Profil übernehmen
            </button>
            {onDeleteScript && (
              <button onClick={() => deleteScript(s)} aria-label="An der Maschine löschen" title="An der Maschine löschen" style={iconBtn}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const headerBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, height: 36, padding: "0 12px",
  background: "transparent", border: `1px solid ${C.bdr2}`, borderRadius: 9, cursor: "pointer",
  color: C.txtS, fontSize: 13, fontFamily: "inherit", flexShrink: 0,
};

function dialogBtn(danger: boolean): React.CSSProperties {
  return {
    height: 36, padding: "0 14px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: danger ? 600 : 500,
    border: `1px solid ${danger ? C.red : C.bdr2}`, background: "transparent", color: danger ? C.red : C.txtS,
  };
}
