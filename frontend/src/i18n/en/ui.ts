/** Übersetzungen (en) für den Bereich „ui“ — eingebunden in ../en.ts. */
export const ui = {
  common: {
    cancel: "Cancel",
    loading: "Loading…",
  },
  app: {
    menu: "Menu",
    comingSoon: "Coming soon",
    ratingSaveFailed: "Rating not saved (HTTP {status})",
  },
  stop: {
    title: "Stop shot",
    button: "Stop",
    busy: "Stopping…",
    failedHttp: "Shot not stopped (HTTP {status})",
    failed: "Shot not stopped: {error}",
  },
  machine: {
    state: {
      disconnected: "OFFLINE",
      off: "OFF",
      heating: "HEATING",
      ready: "READY",
      eco: "ECO",
      brewing: "BREWING",
      draining: "DRAINING",
    },
    powerOn: "ON",
    powerOff: "OFF",
    steamHot: "Hot",
    steamCold: "Cold",
  },
  sidebar: {
    nav: {
      dashboard: "Dashboard",
      profiles: "Profiles",
      history: "History",
      beans: "Beans",
      settings: "Settings",
    },
    expand: "Expand sidebar",
    collapse: "Collapse sidebar",
  },
  readiness: {
    noConnection: "No connection to the machine.",
    finishing: "The last shot is still being finished (drip and analysis). Possible again shortly.",
    notReady: "Machine not ready. Please wait a moment.",
  },
  series: {
    pressure: "Pressure",
    flow: "Flow",
    weight: "Weight",
    temp: "Temp",
    tempBg: "Temp BG",
    pump: "Pump",
  },
  chart: {
    live: "LIVE",
    shotEnded: "SHOT FINISHED",
    extraction: "Extraction",
  },
  dashboard: {
    stageKind: {
      preinfusion: "Pre-infusion",
      flow: "Flow",
      pressure: "Pressure",
      power: "Power",
    },
    goal: {
      ramp: "{from} → {to} {unit} in {s} s",
      hold: "{to} {unit}",
      adopted: "holds {to} {unit} from the puck",
      fill: "filling",
      fillFast: "filling fast",
      left: "{s} s left",
      atWeight: "ends at {v} g",
      atPressure: "ends at {v} bar",
      belowPressure: "ends below {v} bar",
      belowFlow: "ends below {v} g/s",
      aboveFlow: "ends above {v} g/s",
      arrived: "ends when coffee arrives",
    },
    steam: "Steam",
    duration: "Time",
  },
  setpoint: {
    brewGroup: "Brew group temperature",
    brewBoiler: "Brew boiler temperature",
    current: "Current: {v} °C",
    set: "Set",
  },
  settings: {
    invalidValue: "Invalid value",
    min: "Minimum: {v}",
    max: "Maximum: {v}",
    loadError: "Settings could not be loaded.",
  },
  beans: {
    actions: "Actions",
  },
  coffeeMatch: {
    sure: "certain",
    unclear: "unclear",
  },
  image: {
    readFailed: "Image could not be read",
    noCanvas: "Canvas not available",
    encodeFailed: "Image could not be encoded",
  },
  history: {
    ratedNoStars: "rated without stars",
  },
  preshot: {
    grindFiner: "Grind finer",
    grindCoarser: "Grind coarser",
  },
  grinder: {
    nameRequired: "Name is required.",
  },
  machineError: {
    dismiss: "Dismiss message",
  },
  scripts: {
    conflict: "Conflict",
  },
};
