/**
 * useRatingFieldSettings — welche Felder der Bewertungsdialog zeigt. Bis der
 * Abruf da ist (oder bei Fehler) gelten die Vorgaben: alles sichtbar.
 *
 * Gleiches Muster wie usePreShotFieldSettings.
 */

import { useEffect, useState } from "react";

export interface RatingFieldSettings {
  acidity: boolean;
  bitterness: boolean;
  taste: boolean;
  /** Extraktion „zu gering“ / „zu hoch“ — Channeling ist immer da. */
  extraction: boolean;
  grindNote: boolean;
  /** Kennzahlen des Bezugs im Kopf (Dosis → Ausbeute, Ratio, Zeit, Temperatur). */
  facts: boolean;
}

export const RATING_FIELD_DEFAULTS: RatingFieldSettings = {
  acidity: true,
  bitterness: true,
  taste: true,
  extraction: true,
  grindNote: true,
  facts: true,
};

export function useRatingFieldSettings(): RatingFieldSettings {
  const [settings, setSettings] = useState<RatingFieldSettings>(RATING_FIELD_DEFAULTS);
  useEffect(() => {
    fetch("/api/settings/rating-fields")
      .then((r) => (r.ok ? (r.json() as Promise<RatingFieldSettings>) : RATING_FIELD_DEFAULTS))
      .then(setSettings)
      .catch(() => { /* Vorgaben behalten */ });
  }, []);
  return settings;
}
