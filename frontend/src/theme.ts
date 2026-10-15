/**
 * Design tokens — single source of truth for all colours.
 *
 * Usage (destructure the subset you need):
 *   import theme from '../theme';
 *   const { bg, card, txt, acc } = theme;
 *
 * index.html <style> body colours are hardcoded there and must stay in sync
 * manually — see the comment in index.html.
 */

const theme = {
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
} as const;

/**
 * Ein Token mit Deckkraft — fuer Flaechen, Raender und Schatten, die aus einer
 * Grundfarbe abgeleitet sind, statt die rgba-Werte von Hand zu wiederholen.
 * alpha(theme.seriesFlow, 0.1) → "rgba(96,165,250,0.1)".
 */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export type Theme = typeof theme;
export default theme;
