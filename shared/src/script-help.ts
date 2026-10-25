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

import { L, sharedLang } from "./shared-lang.js";

/** Feste Schluessel — das Frontend vergleicht dagegen und uebersetzt die Anzeige selbst. */
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

/** Liste, deren Eintraege beim Lesen die aktuelle Sprache waehlen (Modulkonstante, Sprache wechselt zur Laufzeit). */
function localizedList(pairs: [de: string, en: string][]): string[] {
  const out: string[] = [];
  pairs.forEach(([de, en], i) => Object.defineProperty(out, i, { get: () => L(de, en), enumerable: true }));
  return out;
}

/** Wie ein Skript ueberhaupt laeuft — steht ueber allen Einzelhilfen. */
export const SCRIPT_MODEL_HELP: string[] = localizedList([
  ["Befehle laufen von oben nach unten.",
    "Commands run from top to bottom."],
  ["Nur Warte-Befehle halten an. Ein Pumpenbefehl gilt, bis der nächste kommt.",
    "Only wait commands pause. A pump command holds until the next one."],
  ["Ohne Warten danach läuft ein Pumpenbefehl nie, deshalb fügt der Editor eins mit ein.",
    "Without a wait after it a pump command never runs, so the editor adds one."],
]);

interface HelpText { title: string; summary: string; details: string[] }

/** Titel, Zusammenfassung und Zusatz waehlen die Sprache beim Lesen; group/source bleiben feste Schluessel. */
function localizeHelp(table: Record<number, CmdHelp & { en: HelpText }>): Record<number, CmdHelp> {
  const out: Record<number, CmdHelp> = {};
  for (const [id, { en, title, summary, details, ...keys }] of Object.entries(table)) {
    out[Number(id)] = {
      ...keys,
      get title() { return L(title, en.title); },
      get summary() { return L(summary, en.summary); },
      get details() { return sharedLang() === "en" ? en.details : details; },
    };
  }
  return out;
}

/*
 * Hilfetexte: eine kurze Zeile, was der Befehl tut, und hoechstens ein Zusatz,
 * wenn er einen Fehler verhindert (Flavio, 2026-10-16: „zu umfangreich, nicht
 * leicht verstaendlich“). Hintergrund — Messungen, Firmware, Auskunft von
 * Xenia, welche Skripte was nutzen — steht in der Spec, nicht hier.
 */
export const CMD_HELP: Record<number, CmdHelp> = localizeHelp({
  1: {
    title: "Start", group: "Sonstiges", fixed: true, source: "xenia",
    summary: "Anfang des Skripts, bleibt immer oben.",
    details: [],
    en: {
      title: "Start", summary: "Beginning of the script, always stays at the top.",
      details: [],
    },
  },
  7: {
    title: "Ende", group: "Sonstiges", fixed: true, source: "xenia",
    summary: "Ende des Skripts, bleibt immer unten.",
    details: ["Danach stoppt die Maschine Pumpe und Ventile selbst."],
    en: {
      title: "End", summary: "End of the script, always stays at the bottom.",
      details: ["After it the machine stops pump and valves itself."],
    },
  },
  2: {
    title: "Pumpe an", group: "Pumpe", source: "nicht erprobt",
    summary: "Schaltet die Pumpe ohne Sollwert ein.",
    details: ["Nicht nötig: Druck und Leistung schalten sie selbst ein."],
    en: {
      title: "Pump on", summary: "Switches the pump on without a setpoint.",
      details: ["Not needed: pressure and power switch it on themselves."],
    },
  },
  3: {
    title: "Pumpenleistung", group: "Pumpe", source: "gemessen",
    summary: "Pumpe läuft mit fester Leistung, den Druck macht der Puck. Übergang = Zeit bis zum Ziel.",
    details: ["Unter ~50 % fördert sie aus dem Stand nicht."],
    en: {
      title: "Pump power", summary: "Pump runs at a fixed power, the puck makes the pressure. Ramp = time to the target.",
      details: ["Below ~50 % it does not deliver from a standstill."],
    },
  },
  4: {
    title: "Pumpendruck", group: "Pumpe", source: "gemessen",
    summary: "Regelt auf den Druck. Übergang = Zeit bis zum Ziel.",
    details: ["Wie lange er gilt, bestimmt das Warten danach."],
    en: {
      title: "Pump pressure", summary: "Controls to the pressure. Ramp = time to the target.",
      details: ["How long it holds is set by the wait after it."],
    },
  },
  5: {
    title: "Flussrate (Waage)", group: "Pumpe", source: "nicht erprobt",
    summary: "Regelt auf eine Flussrate, gemessen an der Waage.",
    details: ["Nur mit Waage."],
    en: {
      title: "Flow rate (scale)", summary: "Controls to a flow rate, measured by the scale.",
      details: ["Only with a scale."],
    },
  },
  6: {
    title: "Pumpe aus", group: "Pumpe", source: "gemessen",
    summary: "Pumpe aus, Ventil bleibt offen: der Druck baut sich ab (Pause, Bloom).",
    details: [],
    en: {
      title: "Pump off", summary: "Pump off, valve stays open: the pressure drops (pause, bloom).",
      details: [],
    },
  },
  8: {
    title: "Heizleistung Brühkessel", group: "Temperatur", source: "nicht erprobt",
    summary: "Begrenzt das Nachheizen des Brühkessels.",
    details: [],
    en: {
      title: "Brew boiler heating power", summary: "Limits the reheating of the brew boiler.",
      details: [],
    },
  },
  9: {
    title: "Heizleistung Brühgruppe", group: "Temperatur", source: "nicht erprobt",
    summary: "Begrenzt das Nachheizen der Brühgruppe.",
    details: [],
    en: {
      title: "Brew group heating power", summary: "Limits the reheating of the brew group.",
      details: [],
    },
  },
  12: {
    title: "Warten", group: "Zeit", source: "xenia",
    summary: "Wartet die Zeit ab, erst dann kommt der nächste Befehl.",
    details: ["Das letzte Warten ist die Notbremse: mindestens 20 s."],
    en: {
      title: "Wait", summary: "Waits out the time, only then does the next command run.",
      details: ["The last wait is the emergency stop: at least 20 s."],
    },
  },
  13: {
    title: "Bezugsventil auf", group: "Ventile", source: "xenia",
    summary: "Öffnet den Weg zur Brühgruppe. Steht am Anfang jedes Bezugs.",
    details: [],
    en: {
      title: "Open brew valve", summary: "Opens the path to the brew group. Comes at the start of every brew.",
      details: [],
    },
  },
  14: {
    title: "Bezugsventil zu", group: "Ventile", source: "xenia",
    summary: "Schließt den Weg zur Brühgruppe.",
    details: ["Am Ende macht das die Maschine selbst."],
    en: {
      title: "Close brew valve", summary: "Closes the path to the brew group.",
      details: ["At the end the machine does this itself."],
    },
  },
  15: {
    title: "Ablassventil auf", group: "Ventile", source: "xenia",
    summary: "Lässt den Druck über dem Puck in die Abtropfschale ab.",
    details: [],
    en: {
      title: "Open drain valve", summary: "Releases the pressure above the puck into the drip tray.",
      details: [],
    },
  },
  16: {
    title: "Ablassventil zu", group: "Ventile", source: "xenia",
    summary: "Schließt das Ablassventil wieder.",
    details: ["Vor dem nächsten Druckaufbau nötig."],
    en: {
      title: "Close drain valve", summary: "Closes the drain valve again.",
      details: ["Needed before the next pressure build-up."],
    },
  },
  17: {
    title: "Entleeren & Beenden", group: "Ventile", source: "xenia",
    summary: "Beendet den Bezug an dieser Stelle: Pumpe aus, Druck ab.",
    details: [],
    en: {
      title: "Drain & finish", summary: "Ends the brew at this point: pump off, pressure released.",
      details: [],
    },
  },
  20: {
    title: "Signalton", group: "Sonstiges", source: "xenia",
    summary: "Piept: Anzahl und Dauer je Ton.",
    details: [],
    en: {
      title: "Beep", summary: "Beeps: number of tones and length of each.",
      details: [],
    },
  },
  25: {
    title: "Warten bis °C", group: "Temperatur", source: "nicht erprobt",
    summary: "Setzt eine Temperatur und wartet, bis sie erreicht ist.",
    details: ["„Solltemperatur zurück“ stellt die alte wieder her."],
    en: {
      title: "Wait until °C", summary: "Sets a temperature and waits until it is reached.",
      details: ["“Restore target temperature” brings back the old one."],
    },
  },
  26: {
    title: "Warten bis Druck", group: "Pumpe", source: "xenia",
    summary: "Wartet, bis der Druck erreicht ist. Die Pumpe läuft weiter.",
    details: [],
    en: {
      title: "Wait until pressure", summary: "Waits until the pressure is reached. The pump keeps running.",
      details: [],
    },
  },
  27: {
    title: "Warten bis Gewicht", group: "Waage", source: "gemessen",
    summary: "Wartet, bis das Gewicht in der Tasse ist. Nur mit Waage.",
    details: ["Davor ~1 s warten, damit die Waage tariert."],
    en: {
      title: "Wait until weight", summary: "Waits until the weight is in the cup. Only with a scale.",
      details: ["Wait ~1 s before it so the scale can tare."],
    },
  },
  28: {
    title: "Eco an", group: "Sonstiges", source: "nicht erprobt",
    summary: "Schaltet in den Eco-Modus.",
    details: [],
    en: {
      title: "Eco on", summary: "Switches to eco mode.",
      details: [],
    },
  },
  29: {
    title: "Druckbegrenzung", group: "Pumpe", source: "nicht erprobt",
    summary: "Obergrenze für den Druck bei Leistung oder Fluss.",
    details: [],
    en: {
      title: "Pressure limit", summary: "Upper limit for the pressure under power or flow.",
      details: [],
    },
  },
  30: {
    title: "Flussbegrenzung", group: "Pumpe", source: "nicht erprobt",
    summary: "Obergrenze für den Fluss bei Druck oder Leistung.",
    details: ["Nur mit Waage."],
    en: {
      title: "Flow limit", summary: "Upper limit for the flow under pressure or power.",
      details: ["Only with a scale."],
    },
  },
  31: {
    title: "Solltemperatur zurück", group: "Temperatur", source: "nicht erprobt",
    summary: "Stellt die Temperatur von vor „Warten bis °C“ wieder her.",
    details: [],
    en: {
      title: "Restore target temperature", summary: "Restores the temperature from before “Wait until °C”.",
      details: [],
    },
  },
  32: {
    title: "Totvolumen Flowmeter 1×", group: "Sonstiges", source: "xenia",
    summary: "Totvolumen des Durchflusszählers, Einzelsieb.",
    details: ["Ohne Wirkung: der Zähler liefert keine Werte mehr."],
    en: {
      title: "Flowmeter dead volume 1×", summary: "Dead volume of the flowmeter, single basket.",
      details: ["No effect: the meter no longer delivers values."],
    },
  },
  33: {
    title: "Totvolumen Flowmeter 2×", group: "Sonstiges", source: "xenia",
    summary: "Totvolumen des Durchflusszählers, Doppelsieb.",
    details: ["Ohne Wirkung: der Zähler liefert keine Werte mehr."],
    en: {
      title: "Flowmeter dead volume 2×", summary: "Dead volume of the flowmeter, double basket.",
      details: ["No effect: the meter no longer delivers values."],
    },
  },
  34: {
    title: "Dampfboiler aus", group: "Sonstiges", source: "xenia",
    summary: "Schaltet den Dampfboiler aus.",
    details: [],
    en: {
      title: "Steam boiler off", summary: "Switches the steam boiler off.",
      details: [],
    },
  },
});

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

/** Feld, dessen Beschriftung beim Lesen die aktuelle Sprache waehlt. */
function field(de: string, en: string, f: Omit<ArgField, "label">): ArgField {
  return { ...f, get label() { return L(de, en); } };
}

export const CMD_ARGS: Record<number, ArgField[]> = {
  3: [
    field("Leistung", "Power", { unit: "%", scale: 1, step: 1, min: 0, max: 100 }),
    field("Übergang", "Ramp", { unit: "s", scale: 1000, step: 0.1, min: 0 }),
  ],
  4: [
    field("Druck", "Pressure", { unit: "bar", scale: 1000, step: 0.1, min: 0, max: 12 }),
    field("Übergang", "Ramp", { unit: "s", scale: 1000, step: 0.1, min: 0 }),
  ],
  5: [
    field("Fluss", "Flow", { unit: "ml/s", scale: 1, step: 0.1, min: 0, max: 10 }),
    field("Übergang", "Ramp", { unit: "s", scale: 1000, step: 0.1, min: 0 }),
  ],
  8: [field("Leistung", "Power", { unit: "%", scale: 1, step: 1, min: 0, max: 100 })],
  9: [field("Leistung", "Power", { unit: "%", scale: 1, step: 1, min: 0, max: 100 })],
  12: [field("Dauer", "Duration", { unit: "s", scale: 1000, step: 0.1, min: 0.1 })],
  20: [
    field("Anzahl", "Count", { unit: "×", scale: 1, step: 1, min: 1, max: 10 }),
    field("Dauer", "Duration", { unit: "s", scale: 1000, step: 0.1, min: 0.1 }),
  ],
  25: [field("Temperatur", "Temperature", { unit: "°C", scale: 1, step: 0.5, min: 60, max: 100 })],
  26: [field("Druck", "Pressure", { unit: "bar", scale: 1000, step: 0.1, min: 0, max: 10 })],
  27: [field("Gewicht", "Weight", { unit: "g", scale: 1, step: 0.5, min: 1, max: 500 })],
  29: [field("Druck", "Pressure", { unit: "bar", scale: 1, step: 0.1, min: 0, max: 12 })],
  30: [field("Fluss", "Flow", { unit: "ml/s", scale: 1, step: 0.1, min: 0, max: 10 })],
  32: [field("Totvolumen", "Dead volume", { unit: "ml", scale: 1, step: 0.1, min: 0 })],
  33: [field("Totvolumen", "Dead volume", { unit: "ml", scale: 1, step: 0.1, min: 0 })],
};

/** Befehle, die man einfuegen kann, in Menue-Reihenfolge. */
export const INSERTABLE_CMDS: number[] = [4, 3, 6, 12, 13, 14, 15, 16, 17, 27, 26, 25, 31, 8, 9, 20, 29, 30, 5, 2, 28, 34];
