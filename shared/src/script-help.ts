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
  "Die Maschine arbeitet die Befehle von oben nach unten ab, ohne auf sie zu warten: ein Pumpenbefehl setzt nur ein Ziel und die nächste Zeile kommt sofort dran.",
  "Die Uhr des Ablaufs sind die Warte-Befehle. Nur „Warten“, „Warten bis °C“ und „Warten bis Gewicht“ halten die Abarbeitung an.",
  "Die Übergangszeit eines Pumpenbefehls läuft deshalb parallel zur folgenden Wartezeit. Ist die Wartezeit kürzer, wird der Übergang abgeschnitten.",
  "Folgt auf einen Pumpenbefehl gar kein Warten, überschreibt ihn der nächste sofort — er läuft nie. Beim Einfügen bringt der Editor deshalb ein Warten mit, wenn keins folgt (mindestens 5 s, bei „Pumpe aus“ 10 s).",
];

export const CMD_HELP: Record<number, CmdHelp> = {
  1: {
    title: "Start", group: "Sonstiges", fixed: true, source: "xenia",
    summary: "Markiert den Anfang des Skripts.",
    details: ["Muss der erste Befehl sein; der Editor hält ihn fest."],
  },
  7: {
    title: "Ende", group: "Sonstiges", fixed: true, source: "xenia",
    summary: "Markiert das Ende des Skripts.",
    details: [
      "Muss der letzte Befehl sein; der Editor hält ihn fest.",
      "Die Maschine schließt am Ende auch ohne „Entleeren & Beenden“ das Bezugsventil, öffnet das Ablassventil und schaltet die Pumpe aus (Xenia).",
    ],
  },
  2: {
    title: "Pumpe an", group: "Pumpe", source: "nicht erprobt",
    summary: "Schaltet die Pumpe ohne eigenen Sollwert ein.",
    details: [
      "In keinem Skript hier verwendet — die Pumpenbefehle Leistung, Druck und Fluss schalten die Pumpe selbst ein.",
    ],
  },
  3: {
    title: "Pumpenleistung", group: "Pumpe", source: "gemessen",
    summary: "Fährt die Pumpe auf eine feste Leistung in Prozent, ohne auf den Druck zu schauen.",
    details: [
      "Übergangszeit: in dieser Zeit geht die Leistung vom aktuellen Wert gleitend auf das Ziel.",
      "Aus dem Stand fördert die Pumpe erst ab etwa 50 % (gemessen). Ob kleinere Werte aus laufendem Betrieb noch fördern, wie bei „Declining“ mit 20 %, ist nicht gemessen.",
      "Der Druck ergibt sich aus Leistung und Puck-Widerstand. In der Kurve steht Leistung deshalb nur als angenommenes bar-Äquivalent (75 % ≈ 9 bar, 100 % ≈ 10 bar).",
    ],
  },
  4: {
    title: "Pumpendruck", group: "Pumpe", source: "gemessen",
    summary: "Regelt die Pumpe auf einen Zieldruck in bar.",
    details: [
      "Übergangszeit: in dieser Zeit wird das Ziel vom aktuellen Druck aus gleitend angehoben oder abgesenkt.",
      "Der Befehl kehrt sofort zurück — wie lange der Druck gilt, bestimmt das folgende „Warten“.",
      "Druck braucht Widerstand: solange der Puck noch nicht gesättigt ist, bleibt der echte Druck hinter der Soll-Kurve zurück. Eine Rampe auf 9 bar in 1 s ist auf dem Papier möglich, am Puck nicht.",
      "Obergrenze im Editor 12 bar; die Maschine begrenzt real um 10 bar.",
    ],
  },
  5: {
    title: "Flussrate (Waage)", group: "Pumpe", source: "nicht erprobt",
    summary: "Regelt die Pumpe auf eine Flussrate in ml/s, gemessen an der Waage.",
    details: [
      "Hier nie in einem Skript gelaufen — Flussregelung macht die App selbst (Flow-Profile).",
      "Braucht eine angeschlossene Waage; die Maschine hat keinen eigenen Flussmesser mehr (FW 4.133).",
    ],
  },
  6: {
    title: "Pumpe aus", group: "Pumpe", source: "gemessen",
    summary: "Schaltet die Pumpe ab; das Bezugsventil bleibt offen.",
    details: [
      "Der Druck baut sich dann über den Puck ab — so entsteht eine Bloom-Pause (z. B. „Blooming Espresso“, „6bar Bloom KN“).",
      "Die Pause dauert so lange wie das folgende „Warten“.",
    ],
  },
  8: {
    title: "Heizleistung Brühkessel", group: "Temperatur", source: "nicht erprobt",
    summary: "Begrenzt die Heizleistung des Brühkessels in Prozent.",
    details: [
      "„80s“ setzt Brühkessel und Brühgruppe auf 0 % — dort heizt während des Bezugs nichts nach. Die Wirkung ist nicht gemessen.",
    ],
  },
  9: {
    title: "Heizleistung Brühgruppe", group: "Temperatur", source: "nicht erprobt",
    summary: "Begrenzt die Heizleistung der Brühgruppe in Prozent.",
    details: ["Siehe „Heizleistung Brühkessel“ — dieselbe Idee für die Gruppe."],
  },
  12: {
    title: "Warten", group: "Zeit", source: "xenia",
    summary: "Hält die Abarbeitung für eine feste Zeit an — das ist die Uhr des Skripts.",
    details: [
      "Alles, was vorher gestartet wurde (Druckrampe, Leistung), läuft währenddessen weiter.",
      "Eine lange Wartezeit direkt vor dem Ende ist bei Stopp nach Gewicht die Notbremse: die App stoppt vorher, sonst endet das Skript hier (mindestens 20 s, sonst meldet die Prüfung einen fehlenden Stopp).",
    ],
  },
  13: {
    title: "Bezugsventil auf", group: "Ventile", source: "xenia",
    summary: "Öffnet das Ventil zur Brühgruppe — ohne das kommt kein Wasser zum Puck.",
    details: ["Steht deshalb fast immer als erster Befehl nach dem Start."],
  },
  14: {
    title: "Bezugsventil zu", group: "Ventile", source: "xenia",
    summary: "Schließt das Ventil zur Brühgruppe.",
    details: ["Am Skriptende erledigt das die Maschine selbst."],
  },
  15: {
    title: "Ablassventil auf", group: "Ventile", source: "xenia",
    summary: "Öffnet das Ablassventil: der Druck über dem Puck entweicht in die Abtropfschale.",
    details: ["Wird beim Rückspülen („Cleaning“) nach jedem Druckstoß benutzt."],
  },
  16: {
    title: "Ablassventil zu", group: "Ventile", source: "xenia",
    summary: "Schließt das Ablassventil wieder.",
    details: ["Vor dem nächsten Druckaufbau nötig, sonst läuft das Wasser in die Schale statt durch den Puck."],
  },
  17: {
    title: "Entleeren & Beenden", group: "Ventile", source: "xenia",
    summary: "Pumpe aus, Bezugsventil zu, Ablassventil auf — der Bezug ist vorbei.",
    details: [
      "Die Maschine führt diese Folge am Ende ohnehin aus (Xenia); der Befehl beendet den Bezug nur an genau dieser Stelle.",
      "Skripte mit Stopp nach Gewicht lassen ihn weg und enden mit einer langen Wartezeit als Notbremse.",
    ],
  },
  20: {
    title: "Signalton", group: "Sonstiges", source: "xenia",
    summary: "Piept: Anzahl und Dauer je Ton.",
    details: ["„Cleaning“ piept zweimal, wenn das Rückspülen fertig ist."],
  },
  25: {
    title: "Warten bis °C", group: "Temperatur", source: "nicht erprobt",
    summary: "Setzt eine Solltemperatur und wartet, bis sie erreicht ist.",
    details: [
      "Wie lange das dauert, weiß niemand vorher — die Kurve zeigt dafür ein Band fester Breite, nicht maßstäblich.",
      "„Solltemperatur wiederherstellen“ stellt die alte Temperatur zurück.",
    ],
  },
  27: {
    title: "Warten bis Gewicht", group: "Waage", source: "gemessen",
    summary: "Wartet, bis die Waage das Gewicht in Gramm zeigt; die Pumpe läuft solange weiter.",
    details: [
      "Funktioniert nur mit angeschlossener Bookoo-Waage.",
      "Die Waage tariert kurz nach dem Start — ein „Warten“ von etwa 1 s davor verhindert, dass der Rest vom letzten Bezug zählt (Xenia-Support).",
      "Die App stoppt nach Gewicht auch selbst und lernt dabei den Nachlauf — beides zusammen ist nicht nötig.",
    ],
  },
  28: {
    title: "Eco an", group: "Sonstiges", source: "nicht erprobt",
    summary: "Schaltet die Maschine in den Eco-Modus.",
    details: ["In keinem Skript hier verwendet."],
  },
  29: {
    title: "Druckbegrenzung", group: "Pumpe", source: "nicht erprobt",
    summary: "Obergrenze für den Brühdruck in bar.",
    details: ["Gedacht für Leistungs- oder Flussbefehle, die selbst nicht auf Druck regeln. Hier nie gelaufen."],
  },
  30: {
    title: "Flussbegrenzung", group: "Pumpe", source: "nicht erprobt",
    summary: "Obergrenze für die Flussrate in ml/s.",
    details: ["Gedacht für Druck- oder Leistungsbefehle. Hier nie gelaufen; braucht die Waage als Flussquelle."],
  },
  31: {
    title: "Solltemperatur zurück", group: "Temperatur", source: "nicht erprobt",
    summary: "Stellt die Solltemperatur zurück, die vor „Warten bis °C“ galt.",
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
  27: [{ label: "Gewicht", unit: "g", scale: 1, step: 0.5, min: 1, max: 500 }],
  29: [{ label: "Druck", unit: "bar", scale: 1, step: 0.1, min: 0, max: 12 }],
  30: [{ label: "Fluss", unit: "ml/s", scale: 1, step: 0.1, min: 0, max: 10 }],
};

/** Befehle, die man einfuegen kann, in Menue-Reihenfolge. */
export const INSERTABLE_CMDS: number[] = [4, 3, 6, 12, 13, 14, 15, 16, 17, 27, 25, 31, 8, 9, 20, 29, 30, 5, 2, 28];
