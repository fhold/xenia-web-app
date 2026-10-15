/**
 * Profiles view — Phase 1 Step 4b.
 *
 * Shows all profiles with 1×/2× execute buttons, edit, and delete.
 * The ProfileEditor modal handles create and edit.
 *
 * Top section: favorites with ▲▼ reorder buttons (2+ favorites) — changes
 * persist immediately via POST /api/profiles/favorites/order.
 */

import { useEffect, useState } from "react";
import { Pencil, Trash2, Plus, RefreshCw, ChevronUp, ChevronDown, FileText, ScrollText, Star, Copy, Download, MoreHorizontal } from "lucide-react";
import type { Profile, ProfileCreate, XeniaScript, ShotSize } from "@shared/types.js";
import type { UseProfilesReturn } from "../hooks/useProfiles.js";
import { ProfileEditor } from "../components/ProfileEditor.js";

import theme, { alpha } from '../theme';
const C = theme;

const LABEL: React.CSSProperties = {
  fontSize: 10,
  color: C.mut,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 1.5,
  marginBottom: 10,
};

/** The editable content of a profile — shared by "duplizieren" and JSON export. */
function profilePayload(p: Profile): ProfileCreate {
  return {
    name: p.name,
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

function exportProfile(p: Profile): void {
  const blob = new Blob(
    [JSON.stringify({ kind: "xenia-profile", version: 1, profile: profilePayload(p) }, null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `profil-${p.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

interface ProfilesProps {
  profiles: Profile[];
  scripts: XeniaScript[];
  profileActions: Pick<UseProfilesReturn,
    "createProfile" | "updateProfile" | "deleteProfile" | "reorderFavorites">;
  onExecute: (profile: Profile, shotSize: ShotSize) => void;
  /** Start a flow-hold drive for a profile that carries a step sequence
   *  (brewSteps). Wired to the 1×/2× buttons for flow profiles. */
  onExecuteDrive?: (profile: Profile, shotSize: ShotSize) => void;
  /** Whether a new shot may be started right now (machine ready + no active
   *  shot). Same readiness logic as the Dashboard chips (shared helper). When
   *  false, the 1×/2× start buttons are disabled. */
  canStartShot?: boolean;
  /** Klick auf einen gesperrten Start — die App sagt, WARUM gesperrt ist. */
  onBlockedStart?: () => void;
  mobile?: boolean;
  scriptsSyncing?: boolean;
  onEditorOpen?: () => void;
  /** SE-2b: open the script viewer — general list (no arg) or a script's detail. */
  onOpenScript?: (scriptId?: number) => void;
  /** Sprung aus der History-Detailansicht: dieses Profil gleich im Editor oeffnen. */
  initialProfileId?: number | null;
  onInitialApplied?: () => void;
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
  onOpenScript,
  initialProfileId = null,
  onInitialApplied,
}: ProfilesProps) {
  const [editorProfile, setEditorProfile] = useState<Profile | null | "new">(null);
  // Sprung aus der History: Editor fuer dieses Profil oeffnen, sobald die Liste
  // da ist. Gibt es das Profil nicht (mehr), den Sprung trotzdem verbrauchen.
  useEffect(() => {
    if (initialProfileId === null || profiles.length === 0) return;
    const p = profiles.find((x) => x.id === initialProfileId);
    if (p) { setEditorProfile(p); onEditorOpen?.(); }
    onInitialApplied?.();
  }, [initialProfileId, profiles]); // eslint-disable-line react-hooks/exhaustive-deps
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<number | null>(null);
  /** Offenes Zeilen-Menue (Profil-Id) — immer nur eines. */
  const [menuId, setMenuId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  // UP-9: ONE list — favorites first (by favoriteOrder), then the rest in their
  // existing order. No separate favorites section / no duplicated rows.
  const favorites = [...profiles.filter((p) => p.isFavorite)].sort((a, b) => {
    const ao = a.favoriteOrder ?? Infinity;
    const bo = b.favoriteOrder ?? Infinity;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
  const nonFavorites = profiles.filter((p) => !p.isFavorite);
  const ordered = [...favorites, ...nonFavorites];

  async function handleDelete(id: number) {
    setDeletingId(id);
    setRowError(null);
    try {
      await profileActions.deleteProfile(id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  // A copy is never a favourite — it would land in the ordered favourites list
  // next to its original without the user asking for it.
  async function handleDuplicate(p: Profile) {
    setDuplicatingId(p.id);
    setRowError(null);
    try {
      await profileActions.createProfile({
        ...profilePayload(p),
        name: `${p.name} (Kopie)`,
        isFavorite: false,
      });
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err));
    } finally {
      setDuplicatingId(null);
    }
  }

  async function handleMove(index: number, direction: "up" | "down") {
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= favorites.length) return;
    const newOrder = favorites.map((p) => p.id);
    [newOrder[index], newOrder[swapIndex]] = [newOrder[swapIndex], newOrder[index]];
    setReordering(true);
    try {
      await profileActions.reorderFavorites(newOrder);
    } finally {
      setReordering(false);
    }
  }

  const rowPad = mobile ? "10px 12px" : "10px 16px";

  // Shared icon-button style; accepts an optional color override.
  const iconBtn = (color: string = C.mut, disabled = false): React.CSSProperties => ({
    background: "transparent",
    border: `1px solid ${disabled ? C.bdr : C.bdr}`,
    color: disabled ? C.dim : color,
    borderRadius: 6,
    padding: "5px 7px",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    opacity: disabled ? 0.35 : 1,
    flexShrink: 0,
  });

  // Start 1×/2× — der haeufigste Griff in dieser Liste, deshalb gross genug
  // fuer den Finger. Drei Zustaende: startbereit; gesperrt, weil die Maschine
  // gerade nicht kann (bleibt lesbar und anklickbar, der Klick sagt warum);
  // nicht vorhanden (kein 2×-Platz, fehlende Verdrahtung) — blass.
  const startBtn = (state: "ready" | "blocked" | "none"): React.CSSProperties => ({
    minWidth: 48,
    height: 36,
    padding: "0 12px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    fontFamily: "inherit",
    background: state === "ready" ? C.accG : "transparent",
    border: `1px solid ${state === "ready" ? `${C.acc}30` : state === "blocked" ? C.bdr2 : C.bdr}`,
    color: state === "ready" ? C.acc : state === "blocked" ? C.mut : C.dim,
    opacity: state === "none" ? 0.4 : 1,
    cursor: state === "none" ? "not-allowed" : "pointer",
  });

  function ProfileRow({ p, fav = false, favIndex = 0, favTotal = 0 }: {
    p: Profile;
    fav?: boolean;
    favIndex?: number;
    favTotal?: number;
  }) {
    const isFlow = p.brewSteps != null;
    // A 2× slot exists for a script profile via scriptIdDouble, for a flow
    // profile via its own yield_double (mirrors the script model).
    const hasDouble = isFlow ? p.yieldTargetDoubleG !== null : p.scriptIdDouble !== null;
    const isDeleting = deletingId === p.id;
    // Same readiness/active-shot guard as the Dashboard chips (shared helper).
    // A flow profile also needs the drive handler wired.
    // Zwei Sperrgruende, die sich verschieden verhalten muessen: fehlende
    // Verdrahtung (bleibt tot) und "Maschine/Bezug noch nicht so weit" — der
    // muss anklickbar bleiben, sonst passiert auf dem Tablet gar nichts und es
    // sieht aus wie ein Absturz (kein Hover, also auch kein title).
    const wiringMissing = isFlow && !onExecuteDrive;
    const startDisabled = !canStartShot || wiringMissing;
    const singleDisabled = startDisabled;
    const doubleDisabled = !hasDouble || startDisabled;
    const tapStart = (size: "single" | "double") => {
      if (wiringMissing) return;
      if (!canStartShot) { onBlockedStart?.(); return; }
      start(size);
    };
    const notReadyTitle = "Maschine nicht bereit oder Bezug läuft";
    // Route the start to the flow-hold drive or the script execute.
    const start = (size: ShotSize) => {
      if (isFlow) onExecuteDrive?.(p, size);
      else onExecute(p, size);
    };

    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: rowPad,
          // Favourites carry the accent tint + star so they read as favourites
          // without having to spot the reorder arrows.
          background: p.isFavorite ? C.accG : C.card,
          borderRadius: 10,
          border: `1px solid ${p.isFavorite ? C.accB : C.bdr}`,
          marginBottom: 4,
        }}
      >
        {/* ▲▼ reorder buttons — only in the favorites section, only when ≥2 favs */}
        {fav && favTotal >= 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 1, flexShrink: 0 }}>
            <button
              onClick={() => { void handleMove(favIndex, "up"); }}
              disabled={favIndex === 0 || reordering}
              title="Nach oben"
              style={iconBtn(C.mut, favIndex === 0 || reordering)}
            >
              <ChevronUp size={12} />
            </button>
            <button
              onClick={() => { void handleMove(favIndex, "down"); }}
              disabled={favIndex === favTotal - 1 || reordering}
              title="Nach unten"
              style={iconBtn(C.mut, favIndex === favTotal - 1 || reordering)}
            >
              <ChevronDown size={12} />
            </button>
          </div>
        )}

        {/* Name + favorite badge */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {p.isFavorite && <Star size={12} color={C.acc} fill={C.acc} style={{ flexShrink: 0 }} />}
            <span style={{ fontSize: 13, fontWeight: 600, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.name}
            </span>
          </div>
          {/* Yield targets + profile target brew temp (PT-1) — mono, °C suffix.
              Each segment omitted when null; whole line hidden if all null. */}
          {(() => {
            // Profilnummer zuerst: sie ist die Kennung, ueber die ein Profil
            // benannt wird (Notizen, Bezugsvergleich) — bisher stand sie nirgends.
            const segs: string[] = [`#${p.id}`];
            if (p.yieldTargetSingleG !== null) segs.push(`1×: ${p.yieldTargetSingleG}g`);
            if (p.yieldTargetDoubleG !== null) segs.push(`2×: ${p.yieldTargetDoubleG}g`);
            if (p.targetTempC !== null) segs.push(`${p.targetTempC.toFixed(1)} °C`);
            return segs.length > 0 ? (
              <div style={{ fontSize: 10, color: C.mut, fontFamily: "'JetBrains Mono', monospace", marginTop: 1 }}>
                {segs.join(" · ")}
              </div>
            ) : null;
          })()}
        </div>

        {/* Execute buttons — 1×/2× for both kinds. A flow profile starts the
            app-side flow-hold drive; a script profile runs the Xenia script.
            2× is shown/enabled only when a 2× slot exists (double script or
            double yield). */}
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => { tapStart("single"); }}
            disabled={wiringMissing}
            title={singleDisabled ? notReadyTitle : undefined}
            style={startBtn(wiringMissing ? "none" : singleDisabled ? "blocked" : "ready")}
          >
            1×
          </button>
          <button
            onClick={() => { if (hasDouble) tapStart("double"); }}
            disabled={!hasDouble || wiringMissing}
            title={!hasDouble ? (isFlow ? "Kein 2× Yield" : "Kein Double-Skript") : (!canStartShot ? notReadyTitle : undefined)}
            style={startBtn(!hasDouble || wiringMissing ? "none" : doubleDisabled ? "blocked" : "ready")}
          >
            2×
          </button>
        </div>

        {/* Alles, was nicht Starten ist, liegt hinter einem Menü: fünf offene
            Icon-Knöpfe mal 16 Zeilen waren mehr Rahmen als Inhalt. */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <button
            onClick={() => { setMenuId(menuId === p.id ? null : p.id); }}
            title="Weitere Aktionen"
            aria-label="Weitere Aktionen"
            style={iconBtn()}
          >
            {duplicatingId === p.id || isDeleting ? <RefreshCw size={12} /> : <MoreHorizontal size={14} />}
          </button>
          {menuId === p.id && (
            <>
              <div onClick={() => { setMenuId(null); }} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
              <div style={{
                position: "absolute", top: 26, right: 0, zIndex: 41,
                background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 12,
                padding: 5, minWidth: 196, boxShadow: `0 22px 56px ${alpha(C.black, 0.55)}`,
              }}>
                {onOpenScript && p.scriptIdSingle != null && (
                  <RowMenuItem icon={<FileText size={15} />} label="Skript ansehen"
                    onClick={() => { setMenuId(null); onOpenScript(p.scriptIdSingle!); }} />
                )}
                <RowMenuItem icon={<Pencil size={15} />} label="Bearbeiten"
                  onClick={() => { setMenuId(null); setEditorProfile(p); onEditorOpen?.(); }} />
                <RowMenuItem icon={<Copy size={15} />} label="Duplizieren"
                  onClick={() => { setMenuId(null); void handleDuplicate(p); }} />
                <RowMenuItem icon={<Download size={15} />} label="Als JSON exportieren"
                  onClick={() => { setMenuId(null); exportProfile(p); }} />
                <div style={{ height: 1, background: C.bdr, margin: "5px 4px" }} />
                <RowMenuItem icon={<Trash2 size={15} />} label="Löschen" danger
                  onClick={() => { setMenuId(null); void handleDelete(p.id); }} />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
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

      {/* Header: section label + secondary "Skripte" button (UP-8).
          marginBottom gives the button clear space above the first profile card. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
        <div style={{ ...LABEL, marginBottom: 0 }}>Profile</div>
        {onOpenScript && (
          <button
            onClick={() => onOpenScript()}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "transparent", border: `1px solid ${C.bdr}`, cursor: "pointer",
              color: C.txtS, fontSize: 12, fontFamily: "inherit",
              padding: "5px 10px", borderRadius: 8, flexShrink: 0,
              transition: "border-color 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accB; e.currentTarget.style.color = C.txt; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.bdr; e.currentTarget.style.color = C.txtS; }}
          >
            <ScrollText size={14} /> Skripte
          </button>
        )}
      </div>

      {profiles.length === 0 && (
        <div style={{ fontSize: 13, color: C.mut, paddingTop: 16, textAlign: "center" }}>
          Noch keine Profile. Erstelle dein erstes Profil.
        </div>
      )}

      {/* UP-9: one list — favorites first (with FAV badge + inline ▲▼), then the rest. */}
      {ordered.map((p) =>
        p.isFavorite ? (
          <ProfileRow
            key={p.id}
            p={p}
            fav
            favIndex={favorites.findIndex((f) => f.id === p.id)}
            favTotal={favorites.length}
          />
        ) : (
          <ProfileRow key={p.id} p={p} />
        ),
      )}

      {/* Create button */}
      <button
        onClick={() => { setEditorProfile("new"); onEditorOpen?.(); }}
        style={{
          marginTop: 6,
          width: "100%",
          padding: "12px",
          borderRadius: 10,
          border: `1px dashed ${C.mut}`,
          background: "transparent",
          textAlign: "center",
          color: C.mut,
          fontSize: 11,
          cursor: "pointer",
          fontFamily: "inherit",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          transition: "color 0.15s, border-color 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = C.txtS;
          e.currentTarget.style.borderColor = C.txtS;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = C.mut;
          e.currentTarget.style.borderColor = C.mut;
        }}
      >
        <Plus size={14} /> Neues Profil
      </button>

      {/* ProfileEditor modal */}
      {editorProfile !== null && (
        <ProfileEditor
          profile={editorProfile === "new" ? undefined : editorProfile}
          scripts={scripts}
          scriptsSyncing={scriptsSyncing}
          onSave={async (data) => {
            if (editorProfile === "new") {
              await profileActions.createProfile(data as Parameters<typeof profileActions.createProfile>[0]);
            } else {
              await profileActions.updateProfile(editorProfile.id, data);
            }
          }}
          onClose={() => setEditorProfile(null)}
        />
      )}
    </div>
  );
}
