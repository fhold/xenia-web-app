/** Übersetzungen (de) für den Bereich „ui“ — eingebunden in ../de.ts. */
export const ui = {
  common: {
    cancel: "Abbrechen",
    loading: "Lade…",
  },
  app: {
    menu: "Menü",
    comingSoon: "Coming soon",
    ratingSaveFailed: "Bewertung nicht gespeichert (HTTP {status})",
  },
  stop: {
    title: "Bezug stoppen",
    button: "Stoppen",
    busy: "Stoppe…",
    failedHttp: "Bezug nicht gestoppt (HTTP {status})",
    failed: "Bezug nicht gestoppt: {error}",
  },
  machine: {
    state: {
      disconnected: "OFFLINE",
      off: "AUS",
      heating: "HEIZT",
      ready: "BEREIT",
      eco: "ECO",
      brewing: "BEZUG",
      draining: "ENTLEEREN",
    },
    powerOn: "ON",
    powerOff: "OFF",
    steamHot: "Hot",
    steamCold: "Cold",
  },
  sidebar: {
    nav: {
      dashboard: "Dashboard",
      profiles: "Profile",
      history: "History",
      beans: "Bohnen",
      settings: "Settings",
    },
    expand: "Sidebar ausklappen",
    collapse: "Sidebar einklappen",
  },
  readiness: {
    noConnection: "Keine Verbindung zur Maschine.",
    finishing: "Der laufende Bezug wird noch abgeschlossen (Nachlauf und Auswertung). Gleich wieder möglich.",
    notReady: "Maschine nicht bereit. Bitte kurz warten.",
  },
  series: {
    pressure: "Druck",
    flow: "Flow",
    weight: "Gewicht",
    temp: "Temp",
    tempBg: "Temp BG",
    pump: "Pumpe",
  },
  chart: {
    live: "LIVE",
    shotEnded: "BEZUG BEENDET",
    extraction: "Extraktion",
  },
  dashboard: {
    stageKind: {
      preinfusion: "Preinfusion",
      flow: "Fluss",
      pressure: "Druck",
      power: "Leistung",
    },
    steam: "Dampf",
    duration: "Dauer",
  },
  setpoint: {
    brewGroup: "Brühgruppe Temperatur",
    brewBoiler: "Brühboiler Temperatur",
    current: "Ist: {v} °C",
    set: "Setzen",
  },
  settings: {
    invalidValue: "Ungültiger Wert",
    min: "Minimum: {v}",
    max: "Maximum: {v}",
    loadError: "Einstellungen konnten nicht geladen werden.",
  },
  beans: {
    actions: "Aktionen",
  },
  coffeeMatch: {
    sure: "sicher",
    unclear: "unklar",
  },
  image: {
    readFailed: "Bild konnte nicht gelesen werden",
    noCanvas: "Canvas nicht verfügbar",
    encodeFailed: "Bild konnte nicht kodiert werden",
  },
  history: {
    ratedNoStars: "bewertet ohne Note",
  },
  preshot: {
    grindFiner: "Mahlgrad feiner",
    grindCoarser: "Mahlgrad gröber",
  },
  grinder: {
    nameRequired: "Name ist erforderlich.",
  },
  machineError: {
    dismiss: "Meldung schließen",
  },
  scripts: {
    conflict: "Konflikt",
  },
};
