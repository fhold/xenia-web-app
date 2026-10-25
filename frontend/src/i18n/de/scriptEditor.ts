/** Übersetzungen (de) für den Bereich „scriptEditor“ — eingebunden in ../de.ts. */
export const scriptEditor = {
  modal: {
    close: "Schließen",
  },
  insertMenu: {
    title: "Befehl einfügen",
    untested: "nicht erprobt",
    help: "Hilfe",
    /** Anzeige der Gruppen aus shared/script-help.ts (Schlüssel = CmdHelp.group). */
    groups: {
      Pumpe: "Pumpe",
      Zeit: "Zeit",
      Ventile: "Ventile",
      Waage: "Waage",
      Temperatur: "Temperatur",
      Sonstiges: "Sonstiges",
    },
  },
  commandList: {
    source: {
      measured: "an dieser Maschine gemessen",
      xenia: "laut Xenia",
      untested: "hier nicht erprobt",
    },
    move: "Verschieben",
    commandFallback: "Befehl {cmd}",
    neverRuns: "läuft nie — kein Warten danach",
    help: "Hilfe",
    delete: "Löschen",
  },
  curve: {
    /** Ziehblase am ● Griff: Zielwert mit Einheit · Rampe. */
    pointBubble: "{value} · Rampe {s} s",
    /** Ziehblase am ▮ Griff (Skript). */
    waitBubble: "Warten {s} s",
    /** Ziehblase am ▮ Griff (App-Stufe). */
    afterBubble: "nach {s} s",
    end: "Ende {s} s",
    endApprox: "Ende ≈ {s} s",
  },
};
