/**
 * Scripts view (SE-2) — script list + detail; editing opens ScriptEditor.
 *
 * Master/detail list of all xenia_script rows. Detail shows a plain-text
 * command breakdown, the commanded setpoint curve (scriptToTimeline) and a
 * manual category override control. Read-only against the machine — the override
 * writes ONLY local app metadata; no /scripts/create, no execute.
 */

import { useState, useEffect } from "react";
import { ChevronLeft, Info, Pencil, Copy, Plus, Trash2 } from "lucide-react";
import { useScripts } from "../hooks/useScripts.js";
import { useProfiles } from "../hooks/useProfiles.js";
import { ScriptEditor } from "../components/ScriptEditor.js";
import { useTranslation } from "../i18n/index.js";
import { scriptToTimeline, describeCmdLine } from "@shared/script-timeline.js";
import type { PumpMode } from "@shared/script-timeline.js";
import type { XeniaScript } from "@shared/types.js";
import { ScriptTimelineChart } from "../components/ScriptTimelineChart.js";
import theme from "../theme.js";

const C = theme;
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

type EffCat = "brew" | "maintenance" | "unknown";

function effectiveCat(s: XeniaScript): EffCat {
  return (s.categoryOverride ?? s.categoryAuto ?? "unknown") as EffCat;
}

const CAT_STYLE: Record<EffCat, { fg: string; bg: string }> = {
  brew:        { fg: C.grn, bg: C.grnD },
  maintenance: { fg: C.org, bg: C.orgD },
  unknown:     { fg: C.mut, bg: C.accG },
};

function CategoryBadge({ s, overriddenHint }: { s: XeniaScript; overriddenHint: string }) {
  const eff = effectiveCat(s);
  const st = CAT_STYLE[eff];
  const label = eff === "brew" ? "Bezug" : eff === "maintenance" ? "Wartung" : "—";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: st.fg, background: st.bg, padding: "1px 6px", borderRadius: 6 }}>
        {label}
      </span>
      {s.categoryOverride !== null && (
        <span style={{ fontSize: 9, color: C.mut, fontStyle: "italic" }}>{overriddenHint}</span>
      )}
    </span>
  );
}

export function Scripts({
  mobile = false,
  initialScriptId = null,
  onInitialApplied,
}: {
  mobile?: boolean;
  /** Preselect this script (jump from a profile to its brew-script detail). */
  initialScriptId?: number | null;
  onInitialApplied?: () => void;
}) {
  const { t } = useTranslation();
  const { scripts, loading, refreshList, syncScript, setCategoryOverride, createScript, updateScript, deleteScript } = useScripts();
  const { profiles } = useProfiles();
  const [selectedId, setSelectedId] = useState<number | null>(initialScriptId);
  // Editor: bestehendes Skript bearbeiten, oder neu (optional als Kopie).
  const [editing, setEditing] = useState<
    { script: XeniaScript } | { template?: { title: string; content: string } } | null
  >(null);
  const usedBy = (id: number) =>
    profiles.filter((p) => p.scriptIdSingle === id || p.scriptIdDouble === id).map((p) => p.name);

  // On open: shallow list-sync from the machine (ids + titles) so new/renamed
  // scripts appear. Light on the ESP — content is fetched lazily per script.
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Apply a deep-link preselect (from the Profiles jump) once it arrives.
  useEffect(() => {
    if (initialScriptId !== null) {
      setSelectedId(initialScriptId);
      onInitialApplied?.();
    }
  }, [initialScriptId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = scripts.find((s) => s.id === selectedId) ?? null;
  // Desktop/tablet: auto-select the first script for an immediate detail view.
  const effectiveSelected = selected ?? (!mobile ? scripts[0] ?? null : null);

  // When a script is opened: re-read its content fresh from the machine so the
  // breakdown/curve always reflect the current script body (e.g. after an edit).
  const openId = effectiveSelected?.id ?? null;
  useEffect(() => {
    if (openId !== null) void syncScript(openId);
  }, [openId, syncScript]);

  const showList = mobile ? effectiveSelected === null : true;
  const showDetail = effectiveSelected !== null;

  if (editing !== null) {
    const script = "script" in editing ? editing.script : null;
    return (
      <div style={{ maxWidth: 1100, overflowY: "auto" }}>
        <ScriptEditor
          script={script}
          template={"template" in editing ? editing.template : undefined}
          usedBy={script ? usedBy(script.id) : []}
          onCreate={createScript}
          onUpdate={updateScript}
          onDone={(saved) => {
            setEditing(null);
            if (saved) setSelectedId(saved.id);
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.txt }}>{t("scripts.title")}</div>
          <div style={{ fontSize: 12, color: C.mut, marginTop: 2 }}>{t("scripts.subtitle")}</div>
        </div>
        <button onClick={() => setEditing({})} style={actionBtn}>
          <Plus size={15} /> {t("scripts.new")}
        </button>
      </div>

      {loading ? (
        <div style={{ color: C.mut, fontSize: 13 }}>{t("scripts.loading")}</div>
      ) : scripts.length === 0 ? (
        <div style={{ color: C.mut, fontSize: 13 }}>{t("scripts.empty")}</div>
      ) : (
        <div style={{ display: "flex", gap: 14, flex: 1, minHeight: 0 }}>
          {/* List */}
          {showList && (
            <div
              style={{
                width: mobile ? "100%" : 280,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                overflowY: "auto",
              }}
            >
              {scripts.map((s) => {
                const active = effectiveSelected?.id === s.id && !mobile;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: active ? C.cardHover : C.card,
                      border: `1px solid ${active ? C.accB : C.bdr}`,
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                      width: "100%",
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: C.txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title}
                    </span>
                    <CategoryBadge s={s} overriddenHint={t("scripts.overriddenHint")} />
                  </button>
                );
              })}
            </div>
          )}

          {/* Detail */}
          {showDetail && effectiveSelected && (
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
              {/* Mobile back */}
              {mobile && (
                <button
                  onClick={() => setSelectedId(null)}
                  style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: C.mut, cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: 0 }}
                >
                  <ChevronLeft size={16} /> {t("scripts.title")}
                </button>
              )}

              <ScriptDetail
                script={effectiveSelected}
                usedBy={usedBy(effectiveSelected.id)}
                onSetOverride={setCategoryOverride}
                onEdit={() => setEditing({ script: effectiveSelected })}
                onDuplicate={() => setEditing({ template: { title: copyTitle(effectiveSelected.title), content: effectiveSelected.content } })}
                onDelete={async () => { await deleteScript(effectiveSelected.id); setSelectedId(null); }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const actionBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8,
  background: "transparent", border: `1px solid ${C.bdr2}`, color: C.txtS, cursor: "pointer",
  fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, flexShrink: 0,
};

/** Name fuer eine Kopie — innerhalb der Namensregel der Maschine (max. 40). */
function copyTitle(title: string): string {
  return `${title.slice(0, 33).trimEnd()} Kopie`;
}

function ScriptDetail({
  script,
  usedBy,
  onSetOverride,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  script: XeniaScript;
  usedBy: string[];
  onSetOverride: (id: number, override: "brew" | "maintenance" | null) => Promise<void>;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [showCurveNote, setShowCurveNote] = useState(false); // UP-7: note behind (i)
  const timeline = script.parsedCmds ? scriptToTimeline(script.parsedCmds) : null;
  const hasCurve = timeline !== null && (timeline.phases.length > 0 || timeline.waits.length > 0);

  // UP-6: hide the Script-start (Cmd 1) / Script-end (Cmd 7) pseudo-commands —
  // by TYPE, not position — keeping the original index for the overridden lookup.
  const cmds = (script.parsedCmds?.commands ?? [])
    .map((c, origIdx) => ({ c, origIdx }))
    .filter(({ c }) => c.cmd !== 1 && c.cmd !== 7);

  // Commands whose phase is overridden (noWait) — they never run on the machine
  // (Xenia: a pump command without a Wait before the next is immediately
  // overridden). The breakdown flags them; the curve shows them as markers.
  const overriddenIdx = new Set((timeline?.phases ?? []).filter((p) => p.noWait).map((p) => p.cmdIndex));

  // Legend from the modes that actually appear in the phases (+ temp annotation).
  const modes = new Set<PumpMode>((timeline?.phases ?? []).map((p) => p.mode));
  const MODE_COLOR: Record<PumpMode, string> = { pressure: C.seriesPressure, flow: C.seriesFlow, power: C.seriesPower };
  const legendItems: { c: string; label: string }[] = [];
  if (modes.has("pressure")) legendItems.push({ c: MODE_COLOR.pressure, label: t("scripts.legend.pressure") });
  if (modes.has("flow")) legendItems.push({ c: MODE_COLOR.flow, label: t("scripts.legend.flow") });
  if (modes.has("power")) legendItems.push({ c: MODE_COLOR.power, label: t("scripts.legend.power") });
  if ((timeline?.tempSetpoints.length ?? 0) > 0) legendItems.push({ c: C.acc, label: t("scripts.legend.temp") });

  const cardStyle: React.CSSProperties = {
    background: C.card,
    border: `1px solid ${C.bdr}`,
    borderRadius: 12,
    padding: "14px 16px",
  };
  const sectionLabel: React.CSSProperties = {
    fontSize: 9, color: C.mut, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8,
  };

  return (
    <>
      {/* Header + category control */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.txt, flex: "1 1 160px", minWidth: 0 }}>
            {script.title} <span style={{ ...MONO, fontSize: 11, color: C.mut, fontWeight: 500 }}>#{script.id}</span>
          </div>
          <button onClick={onEdit} style={actionBtn}><Pencil size={14} /> {t("scripts.edit")}</button>
          <button onClick={onDuplicate} style={actionBtn}><Copy size={14} /> {t("scripts.duplicate")}</button>
          <button onClick={() => { setDeleteErr(null); setConfirmDelete(true); }} style={{ ...actionBtn, color: C.mut }} aria-label={t("scripts.delete")}><Trash2 size={14} /></button>
        </div>
        {confirmDelete && (
          <div style={{ background: C.sunken, border: `1px solid ${C.bdr2}`, borderRadius: 9, padding: "10px 12px", marginBottom: 10, fontSize: 12.5, color: C.txtS }}>
            {usedBy.length > 0 ? (
              <>{t("scripts.deleteBlocked")} <b style={{ color: C.txt }}>{usedBy.join(", ")}</b></>
            ) : (
              <>{t("scripts.deleteConfirm")}</>
            )}
            {deleteErr && <div style={{ color: C.red, marginTop: 6 }}>{deleteErr}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmDelete(false)} style={actionBtn}>{t("scripts.cancel")}</button>
              {usedBy.length === 0 && (
                <button
                  onClick={() => { onDelete().catch((e: unknown) => setDeleteErr(e instanceof Error ? e.message : String(e))); }}
                  style={{ ...actionBtn, color: C.red, borderColor: C.red }}
                >
                  {t("scripts.delete")}
                </button>
              )}
            </div>
          </div>
        )}
        <div style={sectionLabel}>{t("scripts.categoryLabel")}</div>
        <SegmentedCategory
          value={script.categoryOverride}
          auto={(script.categoryAuto ?? "unknown") as EffCat}
          onChange={(v) => { void onSetOverride(script.id, v); }}
          labels={{
            auto: t("scripts.catAuto"),
            brew: t("scripts.catBrew"),
            maintenance: t("scripts.catMaintenance"),
          }}
        />
      </div>

      {/* Curve */}
      {hasCurve && timeline && (
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ ...sectionLabel, marginBottom: 0 }}>{t("scripts.curve")}</span>
            <button
              onClick={() => setShowCurveNote((v) => !v)}
              title={t("scripts.curveNote")}
              aria-label="Info"
              style={{
                display: "inline-flex", background: "transparent", border: "none",
                color: showCurveNote ? C.acc : C.mut, cursor: "pointer", padding: 0,
              }}
            >
              <Info size={13} />
            </button>
          </div>
          {showCurveNote && (
            <div style={{ fontSize: 10.5, color: C.mut, marginBottom: 8, lineHeight: 1.4 }}>{t("scripts.curveNote")}</div>
          )}
          {legendItems.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 6 }}>
              {legendItems.map((l) => (
                <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.txtS }}>
                  <span style={{ width: 14, height: 2.5, background: l.c, borderRadius: 2 }} />
                  {l.label}
                </span>
              ))}
            </div>
          )}
          <ScriptTimelineChart timeline={timeline} />
        </div>
      )}

      {/* Breakdown */}
      <div style={cardStyle}>
        <div style={sectionLabel}>{t("scripts.breakdown")}</div>
        {overriddenIdx.size > 0 && (
          <div style={{ fontSize: 11, color: C.org, marginBottom: 8, lineHeight: 1.4 }}>
            ⚠ {t("scripts.overriddenWarning")}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {cmds.map(({ c, origIdx }, i) => {
            const d = describeCmdLine(c);
            const overridden = overriddenIdx.has(origIdx);
            return (
              <div key={origIdx} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", borderBottom: i < cmds.length - 1 ? `1px solid ${C.bdr}` : "none", opacity: overridden ? 0.55 : 1 }}>
                <span style={{ ...MONO, fontSize: 10, color: C.mut, width: 22, flexShrink: 0, textAlign: "right" }}>{i + 1}</span>
                <span style={{ fontSize: 12.5, color: overridden ? C.mut : C.txtS, flex: 1, minWidth: 0, textDecoration: overridden ? "line-through" : "none" }}>{d.label}</span>
                {d.detail && <span style={{ ...MONO, fontSize: 12.5, color: overridden ? C.mut : C.txt, flexShrink: 0, textDecoration: overridden ? "line-through" : "none" }}>{d.detail}</span>}
                {overridden && <span style={{ fontSize: 9, color: C.org, flexShrink: 0, fontWeight: 600 }}>{t("scripts.overriddenTag")}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function SegmentedCategory({
  value,
  auto,
  onChange,
  labels,
}: {
  value: "brew" | "maintenance" | null;
  auto: EffCat;
  onChange: (v: "brew" | "maintenance" | null) => void;
  labels: { auto: string; brew: string; maintenance: string };
}) {
  const opts: { key: "auto" | "brew" | "maintenance"; label: string }[] = [
    { key: "auto", label: auto === "brew" || auto === "maintenance" ? `${labels.auto} (${auto === "brew" ? labels.brew : labels.maintenance})` : labels.auto },
    { key: "brew", label: labels.brew },
    { key: "maintenance", label: labels.maintenance },
  ];
  const current: "auto" | "brew" | "maintenance" = value ?? "auto";
  return (
    <div style={{ display: "inline-flex", background: C.sunken, border: `1px solid ${C.bdr2}`, borderRadius: 9, padding: 2, gap: 2 }}>
      {opts.map((o) => {
        const active = current === o.key;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key === "auto" ? null : o.key)}
            style={{
              padding: "6px 12px",
              borderRadius: 7,
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: active ? 700 : 500,
              background: active ? C.accG2 : "transparent",
              color: active ? C.acc : C.mut,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
