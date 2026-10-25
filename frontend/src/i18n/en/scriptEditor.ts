/** Übersetzungen (en) für den Bereich „scriptEditor“ — eingebunden in ../en.ts. */
export const scriptEditor = {
  modal: {
    close: "Close",
  },
  insertMenu: {
    title: "Insert command",
    untested: "untested",
    help: "Help",
    /** Anzeige der Gruppen aus shared/script-help.ts (Schlüssel = CmdHelp.group). */
    groups: {
      Pumpe: "Pump",
      Zeit: "Time",
      Ventile: "Valves",
      Waage: "Scale",
      Temperatur: "Temperature",
      Sonstiges: "Other",
    },
  },
  commandList: {
    source: {
      measured: "measured on this machine",
      xenia: "according to Xenia",
      untested: "untested here",
    },
    move: "Move",
    commandFallback: "Command {cmd}",
    neverRuns: "never runs — no wait after it",
    help: "Help",
    delete: "Delete",
  },
  curve: {
    /** Ziehblase am ● Griff: Zielwert mit Einheit · Rampe. */
    pointBubble: "{value} · ramp {s} s",
    /** Ziehblase am ▮ Griff (Skript). */
    waitBubble: "Wait {s} s",
    /** Ziehblase am ▮ Griff (App-Stufe). */
    afterBubble: "after {s} s",
    end: "End {s} s",
    endApprox: "End ≈ {s} s",
  },
};
