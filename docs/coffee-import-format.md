# Sorten-Import-Format (Einzel-JSON) — §3i

Im **Anlage-Screen für eine neue Sorte** (CoffeeEditor) gibt es oben den Einstieg
**„Import (JSON)"**: ein JSON einfügen (Paste) oder als Datei wählen → die
Sorten-Felder werden **vorbefüllt** → prüfen + über den normalen Anlage-Flow
speichern. **Einzel-Import** (ein JSON = eine Sorte), kein Bulk.

Die Top-Level-Keys sind exakt die **`CoffeeCreate`-Feldnamen** aus
`shared/src/types.ts` (Stammdaten der Sorte). **Zusätzlich** kann ein optionaler
genesteter Block **`firstRoasting`** die **erste Röstung** mitliefern (§3.4b, 3p) —
er befüllt die Sektion „Erste Röstung" im Anlage-Screen vor, die zusammen mit der
Sorte **atomar** angelegt wird. Fehlt der Block, wird (wie bisher) nur die Sorte
angelegt; die Sektion behält ihre Defaults (Status `frozen`, aktiv an, leere Felder).
Die `firstRoasting`-Keys sind exakt die **`BeanCreate`-Feldnamen**.

## Beispiel

```json
{
  "name": "Deepwood Espresso Blend",
  "roaster": "van Gülpen",
  "country": "Brasilien / Äthiopien",
  "region": "Cerrado / Yirgacheffe",
  "farm": "diverse",
  "variety": "Catuaí, Heirloom",
  "processing": "Washed / Natural",
  "altitudeMin": 1100,
  "altitudeMax": 2100,
  "roastLevel": "medium-dark",
  "brewType": "espresso",
  "flavorNotes": ["Schokolade", "Haselnuss", "Orange"],
  "notes": "8 Tage ruhen lassen. Blend.",
  "firstRoasting": {
    "roastDate": "2026-06-04",
    "bagSizeG": 250,
    "pricePerBagEur": 30.75,
    "status": "frozen",
    "isActive": true
  }
}
```

Der `firstRoasting`-Block ist **optional** und vollständig **rückwärtskompatibel** —
alte Stammdaten-only-JSONs ohne ihn funktionieren unverändert.

## Felder

### Pflichtfeld
- `name` (string, nicht leer)

### Optionale Felder
| Key | Typ | Hinweis |
|---|---|---|
| `roaster` | string | Röster |
| `country` | string | Herkunftsland |
| `region` | string | Region |
| `farm` | string | Farm / Produzent |
| `variety` | string | Varietät |
| `processing` | string | Aufbereitung (z. B. „Washed", „Natural", „Honey") |
| `altitudeMin` | number | Höhe min (m); numerischer String wird akzeptiert, gerundet |
| `altitudeMax` | number | Höhe max (m); numerischer String wird akzeptiert, gerundet |
| `roastLevel` | enum | `light` · `light-medium` · `medium` · `medium-dark` · `dark` |
| `brewType` | enum | `espresso` · `filter` · `omni` |
| `flavorNotes` | array of strings | Aromen-Liste |
| `notes` | string | Freitext-Notiz zur Sorte |

### Nicht importierbar
`rating` und `favourite` werden vom Import **nicht** gesetzt (bewusst manuell).

## `firstRoasting` (optionale erste Röstung) — §3.4b / 3p

Genesteter Block; Keys = **`BeanCreate`-Feldnamen**. Alle Felder optional:

| Key | Typ | Hinweis |
|---|---|---|
| `roastDate` | string | Röstdatum, ISO `YYYY-MM-DD` (Format des Röstdatum-Inputs) |
| `bagSizeG` | number | Tütengröße in g; muss > 0 sein (Pflicht, sobald die Sektion aktiv gespeichert wird — sonst ist `remaining` undefiniert) |
| `pricePerBagEur` | number | Preis pro Tüte (€) |
| `status` | enum | `stock` · `frozen` · `thawed` · `archived` (Default **`frozen`**) |
| `isActive` | boolean | „Aktiv (Quelle)" für neue Bezüge (Default **`true`**) |

**Nicht im `firstRoasting`-Block:**
- `remainingG` — wird **immer** server-seitig `= bagSizeG` (volle Tüte) gesetzt;
  im JSON mitgeschickt → **still ignoriert**.
- `frozenDate` / `thawDate` — server-seitig aus `status` abgeleitet (bei
  frozen/thawed auf heute gestempelt), nicht importierbar.
- Unbekannte Sub-Keys → still verworfen (Forward-Compat).

## Verhalten beim Import

- **Kaputtes JSON** → klare Inline-Fehlermeldung, kein Crash, keine Vorbefüllung.
- JSON ist **kein Objekt** (Array/Zahl/null) → Fehlermeldung.
- **`name` fehlt/leer** → Fehlermeldung (Pflichtfeld).
- **`flavorNotes` ist keine Liste von Strings** → Fehlermeldung (kein Teil-Import).
- **`roastLevel` / `brewType` mit ungültigem Enum-Wert** → Feld wird ignoriert
  (leer gelassen), **nicht** hart abgelehnt; die ignorierten Feldnamen werden im
  Erfolgs-Hinweis genannt.
- **Unbekannte Keys** → still verworfen (Forward-Compat).
- Leere Strings in optionalen Feldern → wie „nicht gesetzt" behandelt.
- **`firstRoasting` vorhanden, aber kein Objekt** (Array/String/Zahl) → **harter
  Inline-Fehler**, kein Teil-Import (analog `flavorNotes`).
- **`firstRoasting.status` ungültiger Enum-Wert** → ignoriert → Default `frozen`;
  im Hinweis genannt. **`isActive` nicht boolean** → ignoriert → Default `true`.
- **`bagSizeG` / `pricePerBagEur` nicht-numerisch oder ≤ 0** → Feld bleibt leer;
  bei vorhandenem-aber-ungültigem Wert im Hinweis genannt (fehlt ganz → einfach
  leer, kein Hinweis). **`roastDate` nicht `YYYY-MM-DD`** → Feld leer + genannt.
- Nach erfolgreicher Übernahme werden die Formularfelder vorbefüllt; der User
  prüft und speichert. `brewType` wird dabei **tatsächlich gesetzt** und beim
  Speichern persistiert (behebt den früher geparkten Import-Bug, bei dem
  `brew_type` nie gefüllt wurde → NULL).

## Dubletten-Warnung

Während der Eingabe/nach dem Import prüft der geteilte Matcher
(`GET /api/coffees/match?name=&roaster=`) auf bestehende Sorten. Bei einem
„sicher"- oder „unklar"-Treffer erscheint ein dezenter Hinweis mit der Option,
**zur bestehenden Sorte zu springen** (dort als Röstung „Nachkaufen" statt eine
zweite Sorte anzulegen) — oder die Warnung zu schließen und bewusst neu anzulegen.
