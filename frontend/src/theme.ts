/**
 * Design tokens — single source of truth for all colours.
 *
 * Usage (destructure the subset you need):
 *   import theme from '../theme';
 *   const { bg, card, txt, acc } = theme;
 *
 * Farbschemata (Einstellungen → Oberfläche, Flavio 22.10.): `theme` ist ein
 * Objekt, dessen Werte beim Start der App einmal gesetzt werden (themeStartup.ts),
 * bevor die übrigen Module laden — mehrere lesen ihre Farben beim Laden. Ein
 * Wechsel lädt die Seite neu. Basis sind die Paletten DARK und LIGHT; ein eigenes
 * Schema ändert nur Grundfarben (shared/color-scheme.ts), buildTheme rechnet die
 * abhängigen Töne daraus. index.html liest Hintergrund und Scrollbalken über
 * CSS-Variablen, die applyTheme setzt.
 */

import type { ColorScheme, EditableColor, SchemeBase } from "@shared/color-scheme.js";

const DARK = {
  // ---------------------------------------------------------------------------
  // Backgrounds
  // ---------------------------------------------------------------------------
  /** Page / body background */
  bg:        '#0B0D11',
  /** Sidebar, cards, gauge row */
  card:      '#12151B',
  /** Hover state for interactive cards (profile pills) */
  cardHover: '#171B23',
  /** Elevated layer — modals, dropdowns */
  cardElev:  '#1A1F2A',
  /** Full-screen modal overlay */
  overlay:   'rgba(0,0,0,0.65)',

  // ---------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------
  /** Primary — main content */
  txt:       '#F0F2F7',
  /** Secondary — labels, sub-text (replaces lbl + txtS, same hex) */
  txtS:      '#C8CCD6',
  /** Muted — supporting text, button labels (WCAG AA ≥4.5:1 on card bg) */
  mut:       '#8A91A6',
  /** Disabled / dimmed — placeholders, inactive states (replaces dim + gry) */
  dim:       '#3A4055',

  // ---------------------------------------------------------------------------
  // Borders
  // ---------------------------------------------------------------------------
  /** Default border */
  bdr:       '#1C2030',
  /** Strong border — inputs, separators */
  bdrL:      '#252A38',
  /** Visible inactive border — selectable controls (rating dots/chips/nodes) */
  bdr2:      '#2C3444',
  /** Stronger inactive border / inner ring */
  bdr3:      '#374159',
  /** Sunken inactive fill (inactive control surface) */
  sunken:    '#161C26',
  /** Inner dot of an inactive node (still visibly interactive) */
  node:      '#525B70',

  // ---------------------------------------------------------------------------
  // Accent
  // ---------------------------------------------------------------------------
  /** Slate-blue accent */
  acc:       '#7B9FCC',
  /** Accent ghost 10% — active nav bg, pill bg */
  accG:      'rgba(123,159,204,0.10)',
  /** Accent ghost 18% — button fills */
  accG2:     'rgba(123,159,204,0.18)',
  /** Accent border — rgba colour only, prepend "1px solid " where needed */
  accB:      'rgba(123,159,204,0.25)',

  // ---------------------------------------------------------------------------
  // Status colours
  // ---------------------------------------------------------------------------
  grn:       '#4ADE80',
  grnD:      'rgba(74,222,128,0.10)',
  org:       '#FBBF24',
  orgD:      'rgba(251,191,36,0.10)',
  red:       '#F87171',
  redD:      'rgba(248,113,113,0.10)',
  blu:       '#60A5FA',
  bluD:      'rgba(96,165,250,0.10)',
  prp:       '#C084FC',
  prpD:      'rgba(192,132,252,0.10)',

  // ---------------------------------------------------------------------------
  // Messreihen — Kurven, Phasen-Baender, Ablese-Werte. Eigene Familie, damit
  // eine Kurve nie zufaellig "wie der Akzent" oder "wie ein Status" aussieht
  // und sich jede Reihe an einer Stelle aendern laesst. Werte vorerst gleich
  // den bisherigen (Druck = rot, Fluss = blau, Temp = lila); Gewicht sandfarben,
  // damit Blau nur noch Fluss und Bedienung bedeutet (Flavio, 2026-10-01).
  // ---------------------------------------------------------------------------
  seriesPressure: '#F87171',
  seriesFlow:     '#60A5FA',
  seriesWeight:   '#D8BDA8',
  seriesTemp:     '#C084FC',
  /** Pumpenleistung (Power-Phasen, Pumpenkurve). */
  seriesPower:    '#FBBF24',
  /** Soll-Kurve (kommandiert) — hellgruen, von allen Messreihen verschieden. */
  seriesTarget:   '#86EFAC',
  /** Tatsaechliche Stufen-Wechsel eines Flow-Bezugs — kraeftigeres Gruen. */
  seriesStage:    '#4ADE80',
  /** Bezuege vergleichen: der zweite Bezug (B) in eigener Familie — gegen rot,
   *  blau und sand klar verschieden. Soll, Stufen, Pumpe und Temperatur zeigt
   *  der Vergleich nicht, ihre Farben stehen dort also nicht im Weg. */
  seriesPressureB: '#FACC15',
  seriesFlowB:     '#34D399',
  seriesWeightB:   '#A78BFA',

  // ---------------------------------------------------------------------------
  // Bewertung
  // ---------------------------------------------------------------------------
  rateAcidity:    '#E8B84B',
  rateBitter:     '#B5734A',
  /** Gefuellter Bewertungspunkt — Verlauf oben/unten. */
  rateDotTop:     '#8fb0d8',
  rateDotBottom:  '#6f93c2',
  /** "Mahlgrad passt" — helles Gruen auf Gruen-Hintergrund. */
  rateOk:         '#9af0b8',

  // ---------------------------------------------------------------------------
  // Akzent-Varianten und Text auf Statusflaechen
  // ---------------------------------------------------------------------------
  /** Heller Akzent — Text auf Akzentflaeche. */
  accLight:       '#cfe0f5',
  /** Gefuellter Primaerknopf: Verlauf oben/unten und Schrift darauf. */
  accTop:         '#8aabd4',
  accBottom:      '#7194c4',
  onAcc:          '#0A1018',
  /** Schrift fuer Gefaehrliches (Loeschen, Archivieren) — heller als red. */
  redText:        '#fca5a5',
  /** Weicher Warnton (Waage nicht verbunden). */
  warnSoft:       '#E0A96D',
  /** Warmer Ton der Rueckspuel-Flaeche. */
  maintWarm:      '#CB965A',

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------
  /** Schwarz — nur fuer Schatten und Abdunkelungen, ueber alpha(). */
  black:     '#000000',
  /** Pure white — toggle knobs, etc. */
  white:     '#FFFFFF',
  /** dim (#3A4055) at 15% opacity — power-button OFF background */
  dimG:      'rgba(58,64,85,0.15)',

  // ---------------------------------------------------------------------------
  // Safe area (single source of truth — see index.html viewport-fit=cover)
  // ---------------------------------------------------------------------------
  /** Top inset for notch / Dynamic Island. 0 on devices without one. Used for
   *  the mobile top bar and the top padding of every full-screen modal. */
  safeTop:   'env(safe-area-inset-top)',
};

export type ThemeTokens = typeof DARK;

/** Hell: dieselben Rollen, für weißen Grund — Kurven kräftiger, Text dunkel. */
const LIGHT: ThemeTokens = {
  bg:        '#F3F4F7',
  card:      '#FFFFFF',
  cardHover: '#F1F3F7',
  cardElev:  '#FFFFFF',
  overlay:   'rgba(20,24,33,0.40)',

  txt:       '#151922',
  txtS:      '#363D4C',
  mut:       '#5D6577',
  dim:       '#B5BBC8',

  bdr:       '#E1E4EB',
  bdrL:      '#D5D9E1',
  bdr2:      '#C7CCD6',
  bdr3:      '#AEB5C3',
  sunken:    '#EEF0F4',
  node:      '#9AA2B1',

  acc:       '#3E6CA8',
  accG:      'rgba(62,108,168,0.10)',
  accG2:     'rgba(62,108,168,0.16)',
  accB:      'rgba(62,108,168,0.32)',

  grn:       '#15803D',
  grnD:      'rgba(21,128,61,0.10)',
  org:       '#B45309',
  orgD:      'rgba(180,83,9,0.10)',
  red:       '#DC2626',
  redD:      'rgba(220,38,38,0.09)',
  blu:       '#2563EB',
  bluD:      'rgba(37,99,235,0.09)',
  prp:       '#9333EA',
  prpD:      'rgba(147,51,234,0.09)',

  seriesPressure: '#DC2626',
  seriesFlow:     '#2563EB',
  seriesWeight:   '#9A7254',
  seriesTemp:     '#9333EA',
  seriesPower:    '#D97706',
  seriesTarget:   '#22A55A',
  seriesStage:    '#15803D',
  seriesPressureB: '#CA8A04',
  seriesFlowB:     '#0D9488',
  seriesWeightB:   '#7C3AED',

  rateAcidity:    '#C99417',
  rateBitter:     '#9A5A32',
  rateDotTop:     '#5A86C2',
  rateDotBottom:  '#3E6CA8',
  rateOk:         '#15803D',

  accLight:       '#1F3B63',
  accTop:         '#4A79B6',
  accBottom:      '#3863A0',
  onAcc:          '#FFFFFF',
  redText:        '#B91C1C',
  warnSoft:       '#B7791F',
  maintWarm:      '#9C6428',

  black:     '#000000',
  white:     '#FFFFFF',
  dimG:      'rgba(181,187,200,0.20)',

  safeTop:   'env(safe-area-inset-top)',
};

export const PALETTES: Record<SchemeBase, ThemeTokens> = { dark: DARK, light: LIGHT };

/**
 * Ein Token mit Deckkraft — fuer Flaechen, Raender und Schatten, die aus einer
 * Grundfarbe abgeleitet sind, statt die rgba-Werte von Hand zu wiederholen.
 * alpha(theme.seriesFlow, 0.1) → "rgba(96,165,250,0.1)".
 */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
/** Zwischen zwei Farben: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return hex(x.map((v, i) => v + (y[i]! - v) * t));
}
/** Relative Leuchtdichte (WCAG). */
function lum(c: string): number {
  return rgb(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i]!, 0);
}
/** Kontrastverhältnis zweier Farben (1 … 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/**
 * Das fertige Farbset eines Schemas. Unveränderte Grundfarben behalten die Töne
 * ihrer Palette (Dunkel bleibt dadurch Wert für Wert wie bisher); ändert ein
 * Schema eine Grundfarbe, werden die davon abhängigen Töne aus ihr gerechnet.
 */
export function buildTheme(base: SchemeBase, colors: ColorScheme["colors"] = {}): ThemeTokens {
  const p: ThemeTokens = { ...PALETTES[base] };
  const has = (...k: EditableColor[]) => k.some((x) => colors[x] !== undefined);
  for (const [k, v] of Object.entries(colors)) if (v) (p as Record<string, string>)[k] = v;
  if (has("card", "cardElev")) { p.cardHover = mix(p.card, p.cardElev, 0.6); p.sunken = mix(p.card, p.cardElev, 0.5); }
  if (has("txt", "mut")) p.txtS = mix(p.txt, p.mut, 0.35);
  if (has("mut", "card")) { p.dim = mix(p.mut, p.card, 0.6); p.node = mix(p.mut, p.card, 0.4); p.dimG = alpha(p.dim, 0.15); }
  if (has("bdr", "mut")) { p.bdrL = mix(p.bdr, p.mut, 0.12); p.bdr2 = mix(p.bdr, p.mut, 0.22); p.bdr3 = mix(p.bdr, p.mut, 0.35); }
  if (has("acc", "txt")) p.accLight = mix(p.acc, p.txt, 0.6);
  if (has("acc")) {
    p.accG = alpha(p.acc, 0.10); p.accG2 = alpha(p.acc, 0.18); p.accB = alpha(p.acc, 0.28);
    p.accTop = mix(p.acc, p.white, 0.1); p.accBottom = mix(p.acc, p.black, 0.08);
    p.rateDotTop = mix(p.acc, p.white, 0.15); p.rateDotBottom = p.acc;
    p.onAcc = contrast(p.acc, "#0A1018") >= contrast(p.acc, "#FFFFFF") ? "#0A1018" : "#FFFFFF";
  }
  if (has("grn")) { p.grnD = alpha(p.grn, 0.10); p.rateOk = mix(p.grn, base === "dark" ? p.white : p.black, 0.35); }
  if (has("org")) p.orgD = alpha(p.org, 0.10);
  if (has("red", "txt")) p.redText = mix(p.red, p.txt, 0.35);
  if (has("red")) p.redD = alpha(p.red, 0.10);
  return p;
}

/** Das gerade gültige Farbset — beim Start gesetzt (themeStartup.ts). */
const theme: ThemeTokens = { ...DARK };

/** Farbset übernehmen: Werte in `theme`, dazu Seite und Browser-Elemente (index.html). */
export function applyTheme(t: ThemeTokens, base: SchemeBase): void {
  Object.assign(theme, t);
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--bg", t.bg);
  // Dunkel behält den Grundtext von index.html (#E2E4EA) — sonst wäre es nicht mehr pixelgleich.
  if (base === "light" || t.txt !== DARK.txt) root.style.setProperty("--txt", t.txt);
  root.style.setProperty("--scroll", t.bdr2);
  root.style.setProperty("--scroll-hover", t.dim);
  root.style.colorScheme = base;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", base === "light" ? t.card : t.acc);
}

export type Theme = ThemeTokens;
export default theme;
