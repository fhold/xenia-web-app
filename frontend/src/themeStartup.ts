/**
 * Farbschema beim Start setzen — bevor die übrigen Module laden (main.tsx),
 * denn mehrere lesen ihre Farben beim Laden. Die Darstellung wählt jedes Gerät
 * selbst (nur im Browser; Handy hell, Tablet dunkel); die eigenen Farbschemata
 * liegen im Backend (`ui_color_schemes`) und gelten auf allen Geräten — der
 * Browser hält eine Kopie, damit die erste Darstellung schon stimmt. Weichen die
 * Schemata des Servers ab, wird einmal neu geladen.
 */

import { applyTheme, buildTheme } from "./theme.js";
import { parseColorSchemes } from "@shared/color-scheme.js";
import type { ColorScheme, SchemeBase } from "@shared/color-scheme.js";

const KEY = "xenia_theme";

export interface ThemeChoice {
  /** Wert von ui_theme: dark | light | system | scheme:<id> */
  ui: string;
  schemes: ColorScheme[];
}

const prefersLight = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches === true;

/** Basis und Farben, die für diese Wahl gelten. */
export function resolveChoice(c: ThemeChoice): { base: SchemeBase; colors: ColorScheme["colors"] } {
  if (c.ui === "light") return { base: "light", colors: {} };
  if (c.ui === "system") return { base: prefersLight() ? "light" : "dark", colors: {} };
  if (c.ui.startsWith("scheme:")) {
    const s = c.schemes.find((x) => x.id === c.ui.slice(7));
    if (s) return { base: s.base, colors: s.colors };
  }
  return { base: "dark", colors: {} };
}

function readCache(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const c = JSON.parse(raw) as ThemeChoice;
      if (typeof c.ui === "string" && Array.isArray(c.schemes)) return c;
    }
  } catch { /* privates Fenster o. Ä. — dann wie das System */ }
  return { ui: "system", schemes: [] };
}

/** Die Wahl dieses Geräts (für die Einstellungen). */
export function deviceThemeChoice(): ThemeChoice {
  return readCache();
}

/** Beim Start, vor dem Laden der App. */
export function startTheme(): void {
  const choice = readCache();
  const { base, colors } = resolveChoice(choice);
  applyTheme(buildTheme(base, colors), base);
  // „Wie System“: wechselt das System, folgt die App (einmal neu laden).
  if (choice.ui === "system") {
    window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => location.reload());
  }
}

/** Wahl merken und anwenden (Neuladen) — nach dem Speichern in den Einstellungen. */
export function useThemeChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(KEY, JSON.stringify(choice)); } catch { /* ohne Kopie: nächster Start holt es vom Server */ }
  location.reload();
}

/** Nach dem Start die Farbschemata mit dem Server abgleichen; weichen sie ab, einmal
 *  neu laden. Die Darstellung selbst bleibt die dieses Geräts. */
export async function syncThemeFromServer(): Promise<void> {
  try {
    const data = (await fetch("/api/settings").then((r) => r.json())) as Record<string, string | undefined>;
    const local = readCache();
    const schemes = parseColorSchemes(data["ui_color_schemes"]);
    if (JSON.stringify(schemes) !== JSON.stringify(local.schemes)) useThemeChoice({ ui: local.ui, schemes });
  } catch { /* offline: die Kopie gilt */ }
}
