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
import { Pencil, Trash2, Plus, RefreshCw, Star, Copy, Download, Upload, MoreHorizontal, History as HistoryIcon, GripVertical, FlaskConical, Archive, ArchiveRestore } from "lucide-react";
import type { Basket, Profile, ProfileCreate, ProfileFit, ProfileVariant, XeniaScript } from "@shared/types.js";
import { PROFILE_FITS } from "@shared/types.js";
import { effectiveCategory } from "@shared/bbw-arming.js";
import { startVariants, variantInputs, variantRunsInApp } from "@shared/profile-slots.js";
import { buildProfileFile, profileFileName } from "@shared/profile-file.js";
import type { UseProfilesReturn } from "../hooks/useProfiles.js";
import { ProfileEditorView } from "../components/ProfileEditorView.js";
import type { UseScriptsReturn } from "../hooks/useScripts.js";
import { ProfileSparkline } from "../components/ProfileSparkline.js";
import { useBaskets } from "../hooks/useBaskets.js";
import type { ShotFilters } from "../hooks/useShots.js";
import { Modal, modalTitle, modalText } from "../components/ScriptInsertMenu.js";
import { ProfileImportDialog } from "../components/ProfileImportDialog.js";
import { HoverTip } from "../components/HoverTip.js";
import { useTranslation } from "../i18n/index.js";

import theme, { alpha } from '../theme';
import { dec } from "../lib/num.js";
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
    fit: p.fit,
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
 * Profil als Datei (Format in shared/profile-file.ts): Varianten mit Sieb,
 * Yield und Kurve — Skripte mit Titel und Text, nicht nur ihrer Nummer. So
 * laesst sich die Datei auf einer anderen Maschine importieren.
 */
function exportProfile(p: Profile, scripts: XeniaScript[], baskets: Basket[]): void {
  const blob = new Blob([JSON.stringify(buildProfileFile(p, scripts, baskets), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = profileFileName(p.name);
  a.click();
  URL.revokeObjectURL(url);
}

const fmtG = (g: number) => dec(Number.isInteger(g) ? String(g) : g.toFixed(1));

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
  scriptActions: Pick<UseScriptsReturn, "createScript" | "updateScript" | "deleteScript" | "refetch">;
  /** Offener Editor (Profil-Id, neues Profil oder keiner) — steht im Verlauf der App. */
  editorId?: number | "new" | null;
  /** Variante, in der der Editor oeffnet (Sprung aus einem Bezug). */
  editorVariantId?: number | null;
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
  editorVariantId = null,
  onOpenEditor,
  onCloseEditor,
}: ProfilesProps) {
  const { t } = useTranslation();
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
  // Profil importieren: der Text der gewaehlten Datei, solange der Dialog offen ist.
  const [importText, setImportText] = useState<string | null>(null);
  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    void f.text().then(setImportText);
  };
  const [rowError, setRowError] = useState<string | null>(null);

  // Gezogene Reihenfolge gilt sofort, bis die Liste vom Server zurueckkommt.
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  useEffect(() => { setLocalOrder(null); }, [profiles]);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Filter nach Einordnung (Flavio 24.10.): nur Bezugsprofile; Reihenfolge bleibt,
  // Ziehen geht dann nicht (die gefilterte Liste ist nicht die ganze Gruppe).
  const [fitFilter, setFitFilter] = useState<ProfileFit | null>(null);
  const shows = (p: Profile): boolean => fitFilter === null || p.fit.includes(fitFilter);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  const { baskets } = useBaskets();
  const scriptById = new Map(scripts.map((s) => [s.id, s]));
  const isMaintenance = (p: Profile): boolean => p.kind === "maintenance";

  // Archivierte Profile stehen nur unter „Archiv anzeigen“ (Flavio 25.10.).
  const ordered = (localOrder
    ? [...profiles].sort((a, b) => localOrder.indexOf(a.id) - localOrder.indexOf(b.id))
    : profiles).filter((p) => !p.isArchived);
  const archived = profiles.filter((p) => p.isArchived);
  const [showArchive, setShowArchive] = useState(false);
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
      ...profilePayload(p), name: t("profileList.list.copyName", { name: p.name }), isFavorite: false,
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
    if (!window.confirm(t("profileList.list.deleteScriptConfirm", { id: s.id, title: s.title }))) return;
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
        title={ready ? undefined : t("profileList.list.notReady")}
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
        title={t("profileList.list.moreActions")}
        aria-label={t("profileList.list.moreActions")}
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
            <RowMenuItem icon={<Pencil size={15} />} label={t("profileList.list.menu.edit")}
              onClick={() => { setMenuId(null); onOpenEditor(p.id); }} />
            {onOpenHistory && (
              <RowMenuItem icon={<HistoryIcon size={15} />} label={t("profileList.list.menu.allShots")}
                onClick={() => { setMenuId(null); onOpenHistory(p.id); }} />
            )}
            <RowMenuItem icon={<Star size={15} />} label={p.isFavorite ? t("profileList.list.menu.favRemove") : t("profileList.list.menu.favAdd")}
              onClick={() => { setMenuId(null); void run(p.id, () => profileActions.updateProfile(p.id, { isFavorite: !p.isFavorite })); }} />
            <RowMenuItem icon={<FlaskConical size={15} />} label={p.isTrial ? t("profileList.list.menu.trialEnd") : t("profileList.list.menu.trialMark")}
              onClick={() => { setMenuId(null); void run(p.id, () => profileActions.updateProfile(p.id, { isTrial: !p.isTrial })); }} />
            <RowMenuItem icon={<Copy size={15} />} label={t("profileList.list.menu.duplicate")}
              onClick={() => { setMenuId(null); void duplicate(p); }} />
            <RowMenuItem icon={<Download size={15} />} label={t("profileList.list.menu.export")}
              onClick={() => { setMenuId(null); exportProfile(p, scripts, baskets); }} />
            {/* Archivieren nimmt den Favoriten mit — sonst stuende ein unsichtbares Profil auf dem Dashboard. */}
            <RowMenuItem icon={p.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              label={p.isArchived ? t("profileList.list.menu.restore") : t("profileList.list.menu.archive")}
              onClick={() => { setMenuId(null); void run(p.id, () => profileActions.updateProfile(p.id, p.isArchived ? { isArchived: false } : { isArchived: true, isFavorite: false })); }} />
            <div style={{ height: 1, background: C.bdr, margin: "5px 4px" }} />
            <RowMenuItem icon={<Trash2 size={15} />} label={t("profileList.list.menu.delete")} danger
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
        {p.isTrial && <FlaskConical size={13} color={C.org} aria-label={t("profileList.list.trial")} style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: 15, fontWeight: 600, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.name}
        </span>
      </button>
      <span style={{ ...MONO, fontSize: 11, color: C.mut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta}</span>
    </div>
  );

  // Knopfspalte so breit wie das Profil mit den meisten Varianten (mindestens
  // zwei Knoepfe), damit die Knoepfe aller Zeilen untereinander stehen.
  const maxStarts = Math.max(2, ...profiles.map((p) => startVariants(p).length));
  const startColumnW = maxStarts * 94 + (maxStarts - 1) * 8;

  // Als Funktion, nicht als innere Komponente: eine neue Komponente je Render
  // wuerde die Zeilen beim Ziehen neu einhaengen und den Griff verlieren.
  const renderRow = (p: Profile, group: Group, index: number) => {
    const isFlow = p.brewSteps != null;
    // Ein Startknopf je Variante (Flavio 22.10.: „Step-Down“ fehlte als dritte).
    const shown = startVariants(p);
    const start = (v: ProfileVariant | null) =>
      (v !== null && variantRunsInApp(p, v) ? onExecuteDrive?.(p, v.id) : onExecute(p, v?.id ?? null));
    const dragging = drag?.group === group && drag.from === index;
    // Handy: mehr als zwei Knoepfe verdraengen den Namen — dann in eine eigene Zeile darunter.
    const startsBelow = mobile && shown.length > 2;
    const meta = [`#${p.id}`, p.targetTempC !== null ? `${dec(p.targetTempC.toFixed(1))} °C` : null]
      .filter(Boolean).join(" · ");
    return (
      <div
        key={p.id}
        ref={(el) => { if (el) rowRefs.current.set(p.id, el); else rowRefs.current.delete(p.id); }}
        style={{
          display: "flex", alignItems: "center", gap: mobile ? 8 : 12, flexWrap: startsBelow ? "wrap" : "nowrap", rowGap: 6,
          minHeight: 52, boxSizing: "border-box", padding: mobile ? (startsBelow ? "4px 8px 8px 0" : "4px 8px 4px 0") : "4px 12px 4px 0",
          background: p.isFavorite ? C.accG : C.card,
          border: `1px solid ${dragging ? C.acc : p.isFavorite ? C.accB : C.bdr}`,
          borderRadius: 12, opacity: dragging ? 0.6 : 1,
        }}
      >
        {fitFilter !== null ? <span style={{ width: 32, alignSelf: "stretch", flexShrink: 0 }} /> : <span
          onPointerDown={(e) => startDrag(e, group, index)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label={t("profileList.list.move", { name: p.name })}
          role="button"
          style={{
            width: 32, alignSelf: "stretch", flexShrink: 0, display: "flex", alignItems: "center",
            justifyContent: "center", color: C.node, cursor: "grab", touchAction: "none",
          }}
        >
          <GripVertical size={16} />
        </span>}
        {nameBlock(p, meta)}
        {!mobile && (
          <span style={{ width: 120, display: "flex", justifyContent: "center", flexShrink: 0 }}>
            <ProfileSparkline profile={p} script={p.scriptIdSingle !== null ? scriptById.get(p.scriptIdSingle) : undefined} />
          </span>
        )}
        {engineChip(isFlow ? t("profileList.list.engine.app") : t("profileList.list.engine.script"), isFlow ? C.blu : C.txtS)}
        <div style={{
          display: "flex", gap: 8, width: mobile ? undefined : startColumnW, justifyContent: "flex-end", flexShrink: 0,
          ...(startsBelow ? { order: 2, flexBasis: "100%", paddingLeft: 40 } : {}),
        }}>
          {shown.length > 0
            ? shown.map((v) => startButton(`v${v.id}`, v.name, v.yieldG, () => start(v)))
            : startButton("start", t("profileList.list.start"), p.yieldTargetSingleG, () => start(null))}
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

  const fitChip = (value: ProfileFit | null, label: string) => {
    const on = fitFilter === value;
    return (
      <button
        key={value ?? "all"}
        aria-pressed={on}
        onClick={() => setFitFilter(value)}
        style={{
          height: 30, padding: "0 12px", borderRadius: 15, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, flexShrink: 0,
          border: `1px solid ${on ? C.accB : C.bdr2}`, background: on ? C.accG2 : "transparent", color: on ? C.acc : C.mut,
        }}
      >
        {label}
      </button>
    );
  };
  const fitChips = (
    <div role="group" aria-label={t("profileList.list.fit.label")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {fitChip(null, t("profileList.list.fit.all"))}
      {PROFILE_FITS.map((f) => fitChip(f, t(`profileList.list.fit.${f}`)))}
    </div>
  );

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
        initialVariantId={editorVariantId}
        onOpenHistory={onOpenHistoryWith}
        onOpenCoffee={onOpenCoffee}
      />
    );
  }

  return (
    <div>
      {importText !== null && (
        <ProfileImportDialog
          text={importText}
          onClose={() => setImportText(null)}
          onImported={() => { void scriptActions.refetch(); }}
          onOpenProfile={(id) => { setImportText(null); onOpenEditor(id); }}
        />
      )}
      {deleting && (
        <Modal onClose={() => setDeleting(null)}>
          <h3 style={modalTitle}>{t("profileList.list.deleteDialog.title", { name: deleting.profile.name })}</h3>
          <p style={modalText}>{t("profileList.list.deleteDialog.shotsKept")}{deleting.own.length > 0 && ` ${t("profileList.list.deleteDialog.ownScripts")}`}</p>
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
              {t("profileList.list.deleteDialog.script", { id: s.id, title: s.title })}
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
            <button onClick={() => setDeleting(null)} style={dialogBtn(false)}>{t("profileList.list.deleteDialog.cancel")}</button>
            <button onClick={confirmDelete} style={dialogBtn(true)}>{t("profileList.list.deleteDialog.delete")}</button>
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
        <div style={{ ...LABEL, ...(mobile ? { flex: 1 } : {}) }}>{t("profileList.list.header")}</div>
        {!mobile && fitChips}
        {!mobile && <span style={{ flex: 1 }} />}
        <HoverTip
          content={
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, maxWidth: 320 }}>
              <span>{t("profileList.list.importTip.appFile")}</span>
              <span>{t("profileList.list.importTip.decentFile")}</span>
              <span>{t("profileList.list.importTip.decentTrial")}</span>
              <span>{t("profileList.list.importTip.preview")}</span>
            </div>
          }
          style={{ display: "inline-flex" }}
        >
          <label style={headerBtn}>
            <Upload size={14} /> {t("profileList.list.import")}
            {/* Profil-Datei der App oder Decent-Profil (.tcl / JSON von de1app bzw. visualizer.coffee) */}
            <input type="file" accept="application/json,.json,.tcl,text/plain" onChange={onImportFile} style={{ display: "none" }} />
          </label>
        </HoverTip>
        <button onClick={() => { onOpenEditor("new"); }} style={headerBtn}>
          <Plus size={14} /> {t("profileList.list.newProfile")}
        </button>
      </div>

      {mobile && <div style={{ marginBottom: 12 }}>{fitChips}</div>}

      {profiles.length === 0 && (
        <div style={{ fontSize: 13, color: C.mut, paddingTop: 16, textAlign: "center" }}>
          {t("profileList.list.empty")}
        </div>
      )}
      {fitFilter !== null && !favorites.some(shows) && !others.some(shows) && (
        <div style={{ fontSize: 13, color: C.mut, paddingTop: 16, textAlign: "center" }}>
          {t("profileList.list.fit.none")}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {renderGroup("fav", favorites.filter(shows))}
        {renderGroup("norm", others.filter(shows))}

        {fitFilter === null && (maintenance.length > 0 || loose.length > 0) && (
          <div style={{ height: 1, background: C.bdrL, margin: "4px 0" }} />
        )}
        {fitFilter === null && maintenance.map((p) => {
          const scriptTitle = p.scriptIdSingle !== null ? scriptById.get(p.scriptIdSingle)?.title : undefined;
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", gap: mobile ? 8 : 12, minHeight: 46, boxSizing: "border-box",
              padding: mobile ? "4px 8px 4px 40px" : "4px 12px 4px 44px",
              background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 12,
            }}>
              {nameBlock(p, [`#${p.id}`, scriptTitle ? t("profileList.list.maintenanceScript", { title: scriptTitle }) : null].filter(Boolean).join(" · "))}
              {engineChip(t("profileList.list.engine.maintenance"), C.org)}
              <div style={{ display: "flex", width: mobile ? undefined : 196, justifyContent: "flex-end", flexShrink: 0 }}>
                {startButton("start", t("profileList.list.start"), null, () => onExecute(p, startVariants(p)[0]?.id ?? null), true)}
              </div>
              {menu(p)}
            </div>
          );
        })}
        {fitFilter === null && tests.length > 0 && (
          <div style={{ height: 1, background: C.bdrL, margin: "4px 0" }} />
        )}
        {fitFilter === null && renderGroup("test", tests)}
        {fitFilter === null && loose.map((s) => (
          <div key={`s${s.id}`} style={{
            display: "flex", alignItems: "center", gap: mobile ? 8 : 12, minHeight: 46, boxSizing: "border-box",
            padding: mobile ? "4px 8px 4px 40px" : "4px 12px 4px 44px",
            border: `1px dashed ${C.bdr2}`, borderRadius: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.mut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
              <span style={{ ...MONO, fontSize: 11, color: C.mut }}>{t("profileList.list.loose.script", { id: s.id })} · {mobile ? t("profileList.list.loose.noProfile") : t("profileList.list.loose.atMachineNoProfile")}</span>
            </div>
            <button onClick={() => { void adoptScript(s); }} style={{ ...headerBtn, color: C.acc, height: 36 }}>
              {t("profileList.list.loose.adopt")}
            </button>
            {onDeleteScript && (
              <button onClick={() => deleteScript(s)} aria-label={t("profileList.list.loose.deleteAtMachine")} title={t("profileList.list.loose.deleteAtMachine")} style={iconBtn}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        {fitFilter === null && archived.length > 0 && (
          <button
            onClick={() => setShowArchive((v) => !v)}
            style={{ alignSelf: "flex-start", background: "transparent", border: "none", padding: "6px 2px", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, color: C.mut, textDecoration: "underline" }}
          >
            {showArchive ? t("profileList.list.archive.hide") : t("profileList.list.archive.show", { n: archived.length })}
          </button>
        )}
        {fitFilter === null && showArchive && archived.map((p) => (
          <div key={`a${p.id}`} style={{
            display: "flex", alignItems: "center", gap: mobile ? 8 : 12, minHeight: 46, boxSizing: "border-box",
            padding: mobile ? "4px 8px 4px 40px" : "4px 12px 4px 44px",
            border: `1px dashed ${C.bdr2}`, borderRadius: 12, opacity: 0.8,
          }}>
            {nameBlock(p, `#${p.id}`)}
            <button
              onClick={() => { void run(p.id, () => profileActions.updateProfile(p.id, { isArchived: false })); }}
              style={{ height: 34, padding: "0 12px", borderRadius: 9, border: `1px solid ${C.bdr2}`, background: "transparent", color: C.txtS, fontSize: 12.5, fontFamily: "inherit", cursor: "pointer", flexShrink: 0 }}
            >
              {t("profileList.list.archive.restore")}
            </button>
            {menu(p)}
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
