# Script-Editor — Keystone Discovery (SE-1)

**Auftrag:** SE-1 (V2-Phase-2, Skript-Editor Fundament-Schritt). **Modus:** strikt
read-only auf der Maschine — kein `scripts/create`, kein Write, kein Execute.
**Datum:** 2026-06-17. **Maschine:** Xenia DBL, **FW 4.133 / ESP 3.58**
(Auftrag nannte 4.25; aktueller Stand laut Deployment ist 4.133 — `list`/`read`-Vertrag
unverändert, siehe §Q2-Probe).

Dieser Report beantwortet die fünf Discovery-Fragen, soweit ohne Maschinen-Write möglich.
Die Maschinen-Seite des Round-Trips (Q3) bleibt **bewusst OFFEN** → Folgeschritt
(Live-Write). Geliefert wird ruhender Code (Serializer + Validator + Tests), den zur
Laufzeit noch nichts aufruft.

---

## Schritt 0 — Inventur (App-Code, nicht `tech-spike/`)

| Baustein | Pfad | Anmerkung |
|---|---|---|
| **Skript-Parser** | `shared/src/script-parser.ts` | `parseScript(content) → ParsedScript`; nie throw, sammelt `unknownCmds`. Helfer: `categorizeScript`, `extractWeightTargets`, `detectSafetyTimer`, `hasCmd27`. |
| **Parsed-Struktur (Serializer-Input)** | `shared/src/types.ts:235–251` | `ParsedCmd { cmd:number; args:(number\|string)[]; meaning; argLabels }`, `ParsedScript { commands; unknownCmds; error? }`. |
| **Sync (§3.5)** | `backend/src/xenia/script-sync.ts` | `syncAllScripts` / `syncSingleScript` → `buildScript()` parst `content` und füllt `XeniaScript`. |
| **Cache-Tabelle** | `xenia_script` via `backend/src/db/script-repo.ts` | Spalte `content` = roher Token-String; `parsed_cmds` = JSON-Dump. |
| **API-Client** | `backend/src/xenia/client.ts` | POST-Quirk in `post()` (165–208) und `postControl()` (215–258). **Kein `scriptsCreate` vorhanden** — der Write-Pfad ist noch ungebaut. |
| **Routes** | `backend/src/routes/scripts.ts` | list / `:id` / refresh / execute / delete-orphaned. Kein create. |

**Neu in diesem Auftrag (ruhender Code):**
- `shared/src/script-serializer.ts` — `serializeScript(parsed) → string` (exakte Inverse zu `parseScript`).
- `shared/src/script-validator.ts` — `validateScript(parsed) → { ok, errors[], warnings[] }`.
- `shared/test/script-serializer.test.ts`, `shared/test/script-validator.test.ts` (Node-`node:test`-Runner, **kein** Vitest-Install — Entscheidung Flavio, da `shared/` kein `node_modules` hat).

**Fixtures = die echten Cache-Strings:** read-only `SELECT … FROM xenia_script` (immutable-Mode)
lieferte alle 14 `content`-Strings; sie sind **byte-identisch** mit der Live-`read`-Antwort
(siehe §Q2). Diese 14 Strings sind die Round-Trip-Fixtures.

---

## Q1 — `Edit:"Enabled"`-Semantik (neu vs. in-place Update)

**Quelle:** Knoedelauflauf `API_DOCUMENTATION.md` (`Knoedelauflauf/xenia-home`, branch `main`),
Abschnitt `/api/v2/scripts/create`. Wörtlich:

> **Create new script:**
> ```json
> { "script_id": null, "Edit": "Disabled", "switch": null, "script": "none", "name": "My Script", "instruction": "1;13;27 40;7;" }
> ```
> **Update existing script:**
> ```json
> { "script_id": 10, "Edit": "Enabled", "switch": null, "script": "none", "name": "My Script", "instruction": "1;13;27 45;7;" }
> ```
> Method: POST · Content-Type: `application/x-www-form-urlencoded`

**Befund:**
- `Edit:"Enabled"` **+ `script_id` = bestehende ID** ⇒ **In-place-Update** des Slots.
- `Edit:"Disabled"` **+ `script_id` = `null`** ⇒ **Neuanlage** (kein in-place).
- Das Feld `Edit` ist also **immer gesetzt**; „ohne Edit" gibt es nicht — die Frage
  „neu vs. in-place" wird über `Edit` **plus** `script_id` (null vs. int) entschieden.

⚠️ **Korrektur der Auftrags-Hypothese.** Die vermutete Payload `{"<NAME>":"1;…;7;"}` ist
**falsch** (durch die Doku widerlegt). Der Body hat **feste Feldnamen**: der Skript-Body
gehört in **`instruction`**, der Titel in **`name`**; dazu `script_id`, `Edit`, `switch`,
`script`. Der Handoff (§2.8 Z.274, §V2-Ausblick Z.922) beschrieb nur grob „`Edit:Enabled`
+ gleiche ID überschreibt" — konsistent, aber unvollständig; die genaue Feldstruktur ist
erst hier belegt.

---

## Q2 — ID- / FILE_NAME-Verhalten

**Drei verschiedene ID-Kodierungen je Endpoint** (wichtig für den Editor):

| Endpoint | ID-Feld | Form | Beleg |
|---|---|---|---|
| `scripts/read` | `FILE_NAME` | String, **zero-padded 3-stellig** (`10`→`"010"`) | `client.ts:276` `id.toString().padStart(3,"0")`; Handoff Z.55/268 |
| `scripts/execute` | `ID` | **Integer** (nicht String) | `client.ts:328` `{ ID: id }` |
| `scripts/create` | `script_id` | **Integer** (Update) oder **`null`** (Neu) | Doku (Q1) |

**Read-only Live-Probe (FW 4.133):**
- `GET /api/v2/scripts/list` → `index_list` (14 IDs) + paralleles `title_list`. ✓
- `POST /api/v2/scripts/read` mit `{"FILE_NAME":"010"|"013"|"026"}` → korrekte `Content`/`Title`.
  Die zurückgegebenen `Content`-Strings sind **byte-identisch** mit dem `xenia_script`-Cache.

**ID-Vergabe bei „neu":** Die Doku zeigt `script_id: null` für Neuanlage, macht aber
**keine explizite Aussage**, *wie* die neue ID vergeben wird (vermutlich Maschinen-seitig
zugewiesen, im nächsten freien Slot). → **OFFEN**, erst durch einen Live-Write + `list`-Vergleich
verifizierbar.

---

## Q3 — Verlustfreier Round-Trip

### Unsere Seite — **BEWIESEN** (offline)

`serializeScript()` ist die exakte Inverse von `parseScript()` für die **Canonical-Form**.
Round-Trip-Test (`node --test`, Output im Testlauf sichtbar):

```
--- Round-trip report (14 live scripts) ---
  PASS  #10 … #28   (alle 14)
--- 14/14 PASS ---
```

`serialize(parse(raw)) === raw` gilt **byte-exakt für alle 14 echten Skripte**.

### Canonical-Form-Entscheidung (bewusst)

`serializeScript` emittiert **immer** genau diese Form — verifiziert gegen Live-Maschine
und Cache:

- Tokens mit **einem** `;` verbunden, **ein** trailing `;` am Ende,
- **genau ein** ASCII-Space zwischen Cmd-ID und jedem Arg,
- Zahlen via JS `String()` (**kein** Zero-Padding, **keine** erzwungenen Dezimalstellen):
  `9000→"9000"`, `2.5→"2.5"`.

`parseScript` ist **lossy** (trimmt Whitespace, verwirft Leertokens + trailing `;`,
`Number()`-coerced Args). Der Round-Trip ist daher byte-exakt **nur** für bereits
kanonische Eingaben — alle 14 echten Skripte sind kanonisch. Nicht-kanonische Eingaben
normalisieren bewusst (durch Tests belegt): `"1;13;7;;;"→"1;13;7;"`,
irreguläre Spaces → Single-Space, `"27 05"→"27 5"`, `"5 2.50 8000"→"5 2.5 8000"`.
Keiner dieser Fälle kommt in den Live-Daten vor; die Maschine selbst nutzt die Canonical-Form.

### Maschinen-Seite — **OFFEN** (→ Folgeschritt Live-Write)

Wir haben **nicht** geschrieben. Ob die Maschine ein via `instruction` geschriebenes Skript
**verbatim** zurückspeichert oder re-normalisiert (z.B. trailing `;` ergänzt/entfernt, Args
reformatiert), ist ungeklärt. **Nächster Schritt:** kontrollierter Live-Write in einen
Wegwerf-Slot, danach `read` und Byte-Vergleich gegen die geschriebene `instruction`.

---

## Q4 — POST-Quirk bei `create`

`create` nutzt **dieselbe** POST-Konvention wie `machine/control` und `execute` (Handoff §2.3):

- **Content-Type:** `application/x-www-form-urlencoded` (von der Doku bestätigt, Q1),
- **Body:** ein **JSON-String** (kein echtes URL-encoded Form) — `JSON.stringify(body)`.

Im Client wäre das `client.post()` (`client.ts:169`, JSON-Antwort) bzw. `client.postControl()`
(`client.ts:215`, leere Antwort). **OFFEN:** ob `create` einen JSON-Body oder einen leeren
Body (`Content-Length: 0`) zurückgibt — entscheidet `post` vs. `postControl` — erst beim
ersten echten Write feststellbar.

---

## Q5 — Validierungs- / Safety-Regeln (codifiziert)

`validateScript(parsed) → { ok, errors[], warnings[] }` (reine Funktion, `shared/src/script-validator.ts`).
`ok === (errors.length === 0)`. Warnings blockieren nicht.

### Errors (würden einen späteren Write blockieren)

| Code | Regel | Quelle |
|---|---|---|
| `EMPTY_SCRIPT` | keine Befehle | — |
| `MISSING_SCRIPT_START` | beginnt nicht mit Cmd `1` | Handoff §2.8 Z.266 |
| `MISSING_SCRIPT_END` | endet nicht mit Cmd `7` | Handoff §2.8 Z.266 |
| `UNKNOWN_CMD` | `unknownCmds` nicht leer | Parser |
| `NO_STOP_MECHANISM` | **weder** Cmd `17` **noch** Safety-Timer (Cmd `12` > **20 000 ms** direkt vor Cmd `7`) | §2.10 / S5 — BBW-Skripte lassen Cmd 17 weg → Safety-Timer Pflicht |

### Warnings (erlaubt, markiert)

| Code | Regel | Quelle |
|---|---|---|
| `CMD27_NO_TARA_WAIT` | Cmd `27` vorhanden, aber erster Wirk-Befehl ist kein `wait ~1s` (Cmd `12`, **500–1500 ms**) | §2.10 Bookoo-Tara-Bug, Empfehlung Xenia-Support |
| `CMD27_NEEDS_BOOKOO` | Info: Cmd `27` wirkt nur mit angeschlossener Bookoo-Waage | §2.10 (im Skript nicht prüfbar) |
| `PUMP_POWER_RANGE` | Cmd `3` Leistung außerhalb 0–100 % | Dictionary |
| `BOILER_POWER_RANGE` | Cmd `8`/`9` außerhalb 0–100 % | Dictionary |
| `PRESSURE_RANGE` | Cmd `4` Druck außerhalb 0–12 000 mbar (12 bar) | Dictionary |
| `DURATION_NONPOSITIVE` | Dauer-Arg (Cmd 3/4/5/12) ≤ 0 ms | Plausibilität |

**Schwellen-Begründung:** Safety-Timer-Grenze **20 000 ms** spiegelt `detectSafetyTimer()`
(`script-parser.ts:134`); Flavios offene-Ende-Skripte (#13/#17/#25) nutzen 30–60 s → klar darüber.
Tara-Wait-Fenster **500–1500 ms** um die „~1 s" des Xenia-Supports; das echte Cmd-27-Skript #11 (`1;12 1000;…`)
trifft es → kein False-Positive. Druck-Ceiling **12 bar**: Flavios Skripte gehen bis 9 bar
(9000 mbar) → komfortabler Headroom. **Gegen alle 14 echten Skripte: 0 Errors** (Test
„all 14 live scripts are valid").

---

## Delete — ~~kein Endpoint~~ **WIDERLEGT (SE-2)**

Die ursprüngliche Aussage „es gibt keinen `scripts/delete`-Endpoint" war aus der
Knoedelauflauf-Doku geschlossen, nicht aus dem Maschinen-Code. **`POST /api/v2/scripts/delete`
existiert** und wird von der Maschinen-eigenen `modeler.js` benutzt. Siehe SE-2 unten.

---

## SE-2 — Live-Write verifiziert (2026-08-02, FW 4.133, MA_STATUS 0)

Kontrollierter Write mit `probe.js script-write`: inertes Testskript `1;12 30000;7;`
(kein Ventil, keine Pumpe) anlegen → lesen → in-place updaten → löschen. Alle 14
Originalskripte danach unverändert (Skript 19 byte-gleich mit dem DB-Cache).

**Endpoint-Inventar aus dem Maschinen-Code.** Alle 22 Seiten der Xenia-Oberfläche +
ihre `js/*_combined.js` read-only gezogen und jeden `$.post` extrahiert. Der einzige
Aktuator-Write der gesamten offiziellen UI ist `paddle/pumppower`
(`PU_SET_LEVEL_PW_CONTROL`). **Es gibt keinen Live-Druck-Sollwert** — `paddle/press`
und `modeler/press` sind GETs für die Charts. Druck ist ausschließlich über
Skript-Cmd 4 erreichbar.

| Frage | Antwort |
|---|---|
| **Q3 Round-Trip Maschine** | **verbatim.** `read` liefert die gesendete `instruction` byte-exakt zurück, keine Re-Normalisierung. |
| **Q2 ID-Vergabe** | **Nicht der nächste freie Slot.** Frei waren 21–24/27, vergeben wurde **150**, beim zweiten Skript **151**. Nach `delete` von 150 wurde 150 wiederverwendet ⇒ eigener ID-Raum, niedrigste freie ID **≥ 150**. |
| **Q4 create-Response** | `HTTP 200`, `Content-Type: application/json`, Body `{}` (2 Byte) ⇒ **`post()`**, kein Sonderfall. `403` = kein Slot frei. |
| **Q1 in-place Update** | `Edit:"Enabled"` + `script_id:<int>` ⇒ gleicher Slot, neuer Inhalt, kein neuer Eintrag. Doku bestätigt. |
| **Delete** | `{"scr_file_name":"150.S","title_file_name":"150.T"}` → 200, Slot weg, `list` exakt wie vorher. |

**Payload-Korrektur gegenüber der Doku:** die Maschine selbst (`modeler.js`, `paddle.js`)
schickt bei Neuanlage `Edit:""` und `script_id:""` als **leere Strings** — nicht
`"Disabled"`/`null`. Beides wurde live akzeptiert; wir folgen dem Maschinen-Code.

**Fallstrick `scripts/list`:** `index_list` und `title_list` sind parallel, aber die
**Reihenfolge ist zwischen zwei Aufrufen nicht stabil** (live beobachtet). Immer über
die ID zuordnen, nie über die Position.

**Namensregel** (`isScriptNameValid` aus dem Maschinen-Code):
`/^(?! )[A-Za-z0-9\-_# ]*(?<! )$/` — kein führendes/abschließendes Leerzeichen,
nur ASCII-Alphanumerik plus `- _ #` und Space.

**Offen geblieben:** Bedeutung der Felder `switch` und `script` (wir senden `""` bzw.
`"modeler"`, wie die Maschinen-UI — akzeptiert, Semantik unbekannt).

Architektur-/Editier-Modell-Entscheidungen (Ambition des Editors) bleiben bewusst offen und
gehören in den Claude.ai-Chat, nicht in diesen Discovery-Schritt.
