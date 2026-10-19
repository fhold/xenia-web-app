/**
 * Hilfe je Skript-Befehl — was er tut, was seine Werte bedeuten, worauf man
 * achten muss. Angezeigt hinter dem (?) jeder Zeile im Skript-Editor.
 *
 * ⚠ Jeder Eintrag sagt, woher sein Wissen kommt (`source`). Die offizielle
 * Xenia-Doku beschreibt die Befehle kaum; vieles hier ist an dieser Maschine
 * gemessen (FW 4.133), einiges stammt vom Xenia-Support bzw. aus dem
 * Kaffee-Netz-Thread, und manche Befehle standen nie in einem Skript, das hier
 * lief. Die sind als „nicht erprobt" markiert statt mit erfundener Sicherheit
 * beschrieben.
 */

export type HelpSource = "gemessen" | "xenia" | "nicht erprobt";

export interface CmdHelp {
  /** Kurzname in der Liste. */
  title: string;
  /** Gruppe im Einfuegen-Menue. */
  group: "Pumpe" | "Zeit" | "Ventile" | "Temperatur" | "Waage" | "Sonstiges";
  /** Ein Satz: was der Befehl tut. */
  summary: string;
  /** Was man wissen muss — kurz, je Punkt ein Gedanke. */
  details: string[];
  source: HelpSource;
  /** Start/Ende: nicht einfuegbar, nicht verschiebbar. */
  fixed?: boolean;
}

/** Wie ein Skript ueberhaupt laeuft — steht ueber allen Einzelhilfen. */
export const SCRIPT_MODEL_HELP: string[] = [
  "Befehle laufen von oben nach unten.",
  "Nur Warte-Befehle halten an. Ein Pumpenbefehl gilt, bis der nächste kommt.",
  "Ohne Warten danach läuft ein Pumpenbefehl nie, deshalb fügt der Editor eins mit ein.",
];

/*
 * Hilfetexte: eine kurze Zeile, was der Befehl tut, und hoechstens ein Zusatz,
 * wenn er einen Fehler verhindert (Flavio, 2026-10-16: „zu umfangreich, nicht
 * leicht verstaendlich“). Hintergrund — Messungen, Firmware, Auskunft von
 * Xenia, welche Skripte was nutzen — steht in der Spec, nicht hier.
 */
export const CMD_HELP: Record<number, CmdHelp> = {
  1: {
    title: "Start", group: "Sonstiges", fixed: true, source: "xenia",
    summary: "Anfang des Skripts, bleibt immer oben.",
    details: [],
  },
  7: {
    title: "Ende", group: "Sonstiges", fixed: true, source: "xenia",
    summary: "Ende des Skripts, bleibt immer unten.",
    details: ["Danach stoppt die Maschine Pumpe und Ventile selbst."],
  },
  2: {
    title: "Pumpe an", group: "Pumpe", source: "nicht erprobt",
    summary: "Schaltet die Pumpe ohne Sollwert ein.",
    details: ["Nicht nötig: Druck und Leistung schalten sie selbst ein."],
  },
  3: {
    title: "Pumpenleistung", group: "Pumpe", source: "gemessen",
    summary: "Pumpe läuft mit fester Leistung, den Druck macht der Puck. Übergang = Zeit bis zum Ziel.",
    details: ["Unter ~50 % fördert sie aus dem Stand nicht."],
  },
  4: {
    title: "Pumpendruck", group: "Pumpe", source: "gemessen",
    summary: "Regelt auf den Druck. Übergang = Zeit bis zum Ziel.",
    details: ["Wie lange er gilt, bestimmt das Warten danach."],
  },
  5: {
    title: "Flussrate (Waage)", group: "Pumpe", source: "nicht erprobt",
    summary: "Regelt auf eine Flussrate, gemessen an der Waage.",
    details: ["Nur mit Waage."],
  },
  6: {
    title: "Pumpe aus", group: "Pumpe", source: "gemessen",
    summary: "Pumpe aus, Ventil bleibt offen: der Druck baut sich ab (Pause, Bloom).",
    details: [],
  },
  8: {
    title: "Heizleistung Brühkessel", group: "Temperatur", source: "nicht erprobt",
    summary: "Begrenzt das Nachheizen des Brühkessels.",
    details: [],
  },
  9: {
    title: "Heizleistung Brühgruppe", group: "Temperatur", source: "nicht erprobt",
    summary: "Begrenzt das Nachheizen der Brühgruppe.",
    details: [],
  },
  12: {
    title: "Warten", group: "Zeit", source: "xenia",
    summary: "Wartet die Zeit ab, erst dann kommt der nächste Befehl.",
    details: ["Das letzte Warten ist die Notbremse: mindestens 20 s."],
  },
  13: {
    title: "Bezugsventil auf", group: "Ventile", source: "xenia",
    summary: "Öffnet den Weg zur Brühgruppe. Steht am Anfang jedes Bezugs.",
    details: [],
  },
  14: {
    title: "Bezugsventil zu", group: "Ventile", source: "xenia",
    summary: "Schließt den Weg zur Brühgruppe.",
    details: ["Am Ende macht das die Maschine selbst."],
  },
  15: {
    title: "Ablassventil auf", group: "Ventile", source: "xenia",
    summary: "Lässt den Druck über dem Puck in die Abtropfschale ab.",
    details: [],
  },
  16: {
    title: "Ablassventil zu", group: "Ventile", source: "xenia",
    summary: "Schließt das Ablassventil wieder.",
    details: ["Vor dem nächsten Druckaufbau nötig."],
  },
  17: {
    title: "Entleeren & Beenden", group: "Ventile", source: "xenia",
    summary: "Beendet den Bezug an dieser Stelle: Pumpe aus, Druck ab.",
    details: [],
  },
  20: {
    title: "Signalton", group: "Sonstiges", source: "xenia",
    summary: "Piept: Anzahl und Dauer je Ton.",
    details: [],
  },
  25: {
    title: "Warten bis °C", group: "Temperatur", source: "nicht erprobt",
    summary: "Setzt eine Temperatur und wartet, bis sie erreicht ist.",
    details: ["„Solltemperatur zurück“ stellt die alte wieder her."],
  },
  26: {
    title: "Warten bis Druck", group: "Pumpe", source: "xenia",
    summary: "Wartet, bis der Druck erreicht ist. Die Pumpe läuft weiter.",
    details: [],
  },
  27: {
    title: "Warten bis Gewicht", group: "Waage", source: "gemessen",
    summary: "Wartet, bis das Gewicht in der Tasse ist. Nur mit Waage.",
    details: ["Davor ~1 s warten, damit die Waage tariert."],
  },
  28: {
    title: "Eco an", group: "Sonstiges", source: "nicht erprobt",
    summary: "Schaltet in den Eco-Modus.",
    details: [],
  },
  29: {
    title: "Druckbegrenzung", group: "Pumpe", source: "nicht erprobt",
    summary: "Obergrenze für den Druck bei Leistung oder Fluss.",
    details: [],
  },
  30: {
    title: "Flussbegrenzung", group: "Pumpe", source: "nicht erprobt",
    summary: "Obergrenze für den Fluss bei Druck oder Leistung.",
    details: ["Nur mit Waage."],
  },
  31: {
    title: "Solltemperatur zurück", group: "Temperatur", source: "nicht erprobt",
    summary: "Stellt die Temperatur von vor „Warten bis °C“ wieder her.",
    details: [],
  },
  32: {
    title: "Totvolumen Flowmeter 1×", group: "Sonstiges", source: "xenia",
    summary: "Totvolumen des Durchflusszählers, Einzelsieb.",
    details: ["Ohne Wirkung: der Zähler liefert keine Werte mehr."],
  },
  33: {
    title: "Totvolumen Flowmeter 2×", group: "Sonstiges", source: "xenia",
    summary: "Totvolumen des Durchflusszählers, Doppelsieb.",
    details: ["Ohne Wirkung: der Zähler liefert keine Werte mehr."],
  },
  34: {
    title: "Dampfboiler aus", group: "Sonstiges", source: "xenia",
    summary: "Schaltet den Dampfboiler aus.",
    details: [],
  },
};

/** Einheiten und Umrechnung der Argumente fuer die Eingabefelder. */
export interface ArgField {
  label: string;
  unit: string;
  /** Anzeige = roh / scale (z. B. mbar → bar: 1000, ms → s: 1000). */
  scale: number;
  step: number;
  min: number;
  max?: number;
}

export const CMD_ARGS: Record<number, ArgField[]> = {
  3: [
    { label: "Leistung", unit: "%", scale: 1, step: 1, min: 0, max: 100 },
    { label: "Übergang", unit: "s", scale: 1000, step: 0.1, min: 0 },
  ],
  4: [
    { label: "Druck", unit: "bar", scale: 1000, step: 0.1, min: 0, max: 12 },
    { label: "Übergang", unit: "s", scale: 1000, step: 0.1, min: 0 },
  ],
  5: [
    { label: "Fluss", unit: "ml/s", scale: 1, step: 0.1, min: 0, max: 10 },
    { label: "Übergang", unit: "s", scale: 1000, step: 0.1, min: 0 },
  ],
  8: [{ label: "Leistung", unit: "%", scale: 1, step: 1, min: 0, max: 100 }],
  9: [{ label: "Leistung", unit: "%", scale: 1, step: 1, min: 0, max: 100 }],
  12: [{ label: "Dauer", unit: "s", scale: 1000, step: 0.1, min: 0.1 }],
  20: [
    { label: "Anzahl", unit: "×", scale: 1, step: 1, min: 1, max: 10 },
    { label: "Dauer", unit: "s", scale: 1000, step: 0.1, min: 0.1 },
  ],
  25: [{ label: "Temperatur", unit: "°C", scale: 1, step: 0.5, min: 60, max: 100 }],
  26: [{ label: "Druck", unit: "bar", scale: 1000, step: 0.1, min: 0, max: 10 }],
  27: [{ label: "Gewicht", unit: "g", scale: 1, step: 0.5, min: 1, max: 500 }],
  29: [{ label: "Druck", unit: "bar", scale: 1, step: 0.1, min: 0, max: 12 }],
  30: [{ label: "Fluss", unit: "ml/s", scale: 1, step: 0.1, min: 0, max: 10 }],
  32: [{ label: "Totvolumen", unit: "ml", scale: 1, step: 0.1, min: 0 }],
  33: [{ label: "Totvolumen", unit: "ml", scale: 1, step: 0.1, min: 0 }],
};

/** Befehle, die man einfuegen kann, in Menue-Reihenfolge. */
export const INSERTABLE_CMDS: number[] = [4, 3, 6, 12, 13, 14, 15, 16, 17, 27, 26, 25, 31, 8, 9, 20, 29, 30, 5, 2, 28, 34];
