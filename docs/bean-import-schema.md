# Bohnen-Import-Schema (JSON Paste)

In Step 8 wird ein JSON-Import für Bohnen gebaut. Flavio nutzt
dazu einen CustomGPT, der ein Foto vom Bohnen-Bag analysiert und
das JSON in genau diesem Format liefert.

## Schema

```json
{
  "name": "Ethiopia Yirgacheffe",
  "roaster": "Nordic Roast",
  "bagSizeG": 250,
  "pricePerBagEur": 19.50,
  "roastDate": "2026-04-29",
  "notes": "Florale Noten, Bergamotte. Ideal für Filter und Espresso.",

  "origin": "Ethiopia",
  "region": "Yirgacheffe",
  "varietal": "Heirloom",
  "process": "Washed",
  "altitude": "1800-2100m",
  "roastLevel": "light",
  "brewType": "omni",
  "flavorNotes": ["bergamotte", "florale Noten", "schwarzer Tee"]
}
```

## Felder

### Pflichtfeld
- `name` (string)

### Optionale Felder
- `roaster` (string)
- `bagSizeG` (number, in Gramm)
- `pricePerBagEur` (number, in Euro, Float erlaubt)
- `roastDate` (ISO 8601 date: YYYY-MM-DD)
- `notes` (string, multi-line)
- `origin` (string, Land)
- `region` (string)
- `varietal` (string)
- `process` (string, z.B. "Washed", "Natural", "Honey", "Anaerobic Natural")
- `altitude` (string, z.B. "1800-2100m")
- `roastLevel` (enum: "light", "light-medium", "medium", "medium-dark", "dark")
- `brewType` (enum: "espresso", "filter", "omni") — vorgesehene Zubereitungsart
- `flavorNotes` (array of strings)

## Verhalten beim Import

- `name` fehlt → Import-Fehler mit klarer Meldung
- Unbekannte Felder im JSON → werden silently verworfen (Forward-Compat für V2)
- `roastLevel` mit unbekanntem Wert → null setzen, Warning loggen
- `brewType` mit unbekanntem Wert → null setzen, Warning loggen
- `bagSizeG` gesetzt → `remaining_g` wird auf denselben Wert initialisiert (Tüte ist voll bei Anlage)
- `bagSizeG` NICHT gesetzt → `remaining_g` bleibt null (Bestand-Tracking deaktiviert für diese Bohne)

## Bestand-Tracking

Aktiv nur wenn `bagSizeG` gesetzt ist. Bei jedem Shot mit dieser Bohne wird `remaining_g` um die
Dose (`dose_g`) reduziert. Im UI sichtbar als "Verbleibend: X / Y g". Bei null-Wert für `bagSizeG`:
Hinweis "Bestand wird nicht getrackt".

## Storage

Aktuell (Step 8): Pflicht- und ausgewählte optionale Felder als Einzelspalten in der bean-Tabelle.
Unbekannte/extra Felder werden verworfen.

Zukunft (V2): JSON-Blob als metadata-Spalte für volle Schema-Flexibilität, wenn KI direkt
integriert wird.
