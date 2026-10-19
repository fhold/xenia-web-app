/**
 * Settings card for the backflush reminder (Rückspül-Reminder): enable toggle,
 * threshold in days, and a multi-select of which maintenance scripts count.
 * Self-contained — reads current values via useBackflush and writes via
 * PUT /api/settings, so it doesn't touch Settings.tsx's form machinery.
 */
import { useEffect, useState } from "react";
import { Toggle } from "./Toggle.js";
import { useBackflush } from "../hooks/useBackflush.js";
import { useProfiles } from "../hooks/useProfiles.js";
import { useTranslation } from "../i18n/index.js";
import theme from "../theme.js";

const C = theme;

async function putSetting(key: string, value: string): Promise<void> {
  try {
    await fetch(`/api/settings/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  } catch {
    // non-fatal
  }
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 0",
  borderBottom: `1px solid ${C.bdr}`,
};
const labelStyle: React.CSSProperties = { fontSize: 13, color: C.txt, fontWeight: 500 };
const descStyle: React.CSSProperties = { fontSize: 12, color: C.mut };

export function BackflushSettings() {
  const { t } = useTranslation();
  const { status, refetch } = useBackflush();
  const { profiles } = useProfiles();

  const enabled = status?.enabled ?? true;
  const selected = new Set(status?.profileIds ?? []);

  const [daysInput, setDaysInput] = useState("");
  useEffect(() => {
    if (status) setDaysInput(String(status.thresholdDays));
  }, [status?.thresholdDays]); // eslint-disable-line react-hooks/exhaustive-deps

  // Schnitt 3: Rueckspuelen zaehlt je Wartungsprofil, nicht mehr je Skript.
  const maintenanceProfiles = profiles.filter((p) => p.kind === "maintenance");

  const saveDays = async () => {
    const n = Math.max(1, Math.min(365, Math.round(parseFloat(daysInput) || 14)));
    setDaysInput(String(n));
    await putSetting("backflush_reminder_days", String(n));
    await refetch();
  };

  const toggleProfile = async (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    await putSetting("backflush_profile_ids", [...next].join(","));
    await refetch();
  };

  return (
    <>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: C.mut,
          fontWeight: 600,
          margin: "22px 0 4px",
        }}
      >
        {t("settings.backflush.title")}
      </div>

      <div style={rowStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={labelStyle}>{t("settings.backflush.enabled.label")}</div>
          <div style={descStyle}>{t("settings.backflush.enabled.description")}</div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(val) => { void putSetting("backflush_reminder_enabled", String(val)).then(refetch); }}
        />
      </div>

      <div style={rowStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={labelStyle}>{t("settings.backflush.days.label")}</div>
          <div style={descStyle}>{t("settings.backflush.days.description")}</div>
        </div>
        <input
          type="number"
          min={1}
          max={365}
          value={daysInput}
          onChange={(e) => setDaysInput(e.target.value)}
          onBlur={() => { void saveDays(); }}
          disabled={!enabled}
          style={{
            width: 72,
            padding: "6px 8px",
            borderRadius: 8,
            background: C.sunken,
            border: `1px solid ${C.bdr2}`,
            color: C.txt,
            fontSize: 13,
            fontFamily: "'JetBrains Mono', monospace",
            textAlign: "right",
            outline: "none",
          }}
        />
      </div>

      <div style={{ padding: "10px 0" }}>
        <div style={labelStyle}>{t("settings.backflush.profiles.label")}</div>
        <div style={{ ...descStyle, marginBottom: 8 }}>{t("settings.backflush.profiles.description")}</div>
        {maintenanceProfiles.length === 0 ? (
          <div style={{ fontSize: 12, color: C.mut }}>{t("settings.backflush.profiles.empty")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {maintenanceProfiles.map((p) => (
              <label
                key={p.id}
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: C.txt }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => { void toggleProfile(p.id); }}
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
        {status && status.daysAgo !== null && (
          <div style={{ fontSize: 11, color: C.mut, marginTop: 10 }}>
            {t("settings.backflush.lastRun").replace("{n}", String(status.daysAgo))}
          </div>
        )}
      </div>
    </>
  );
}
