/**
 * Farbschema beim Start setzen — bevor die übrigen Module laden (main.tsx),
 * denn mehrere lesen ihre Farben beim Laden. Die Wahl liegt im Backend
 * (`ui_theme`, `ui_color_schemes`) und als Kopie im Browser, damit die erste
 * Darstellung schon stimmt. Weicht der Server ab (anderes Gerät hat
 * umgestellt), wird einmal neu geladen.
 */

import { applyTheme, buildTheme } from "./theme.js";
import { parseColorSchemes, UI_THEME_PATTERN } from "@shared/color-scheme.js";
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
  } catch { /* privates Fenster o. Ä. — dann dunkel */ }
  return { ui: "dark", schemes: [] };
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

/** Nach dem Start mit dem Server abgleichen; weicht er ab, einmal neu laden. */
export async function syncThemeFromServer(): Promise<void> {
  try {
    const data = (await fetch("/api/settings").then((r) => r.json())) as Record<string, string | undefined>;
    const ui = data["ui_theme"] && UI_THEME_PATTERN.test(data["ui_theme"]) ? data["ui_theme"] : "dark";
    const server: ThemeChoice = { ui, schemes: parseColorSchemes(data["ui_color_schemes"]) };
    if (JSON.stringify(server) !== JSON.stringify(readCache())) useThemeChoice(server);
  } catch { /* offline: die Kopie gilt */ }
}
