# Xenia Mock Server

Standalone HTTP server that mimics the Xenia DBL API for offline development.
Runs on `localhost:3099`. No database — state lives entirely in memory and
resets when the server restarts.

## Wann benutzen

Wenn die echte Maschine nicht erreichbar ist (unterwegs, Wartung, etc.).
Der Mock simuliert Brewing-Verhalten gut genug für:

- Frontend-UI-Entwicklung (Step 7+)
- Strukturellen Test des Brew-by-Weight-Algorithmus
- Shot-Recording-Flow (Arm → Start → Samples → Finalize)

## Starten

```bash
# Im backend/-Verzeichnis:
npm run mock
```

Mock läuft auf `http://localhost:3099`. Der Output zeigt den exakten
SQL-Command zum Umschalten.

## Auf Mock umschalten

```sql
-- In backend/data/xenia.db (z.B. mit sqlite3 CLI oder einem GUI-Tool):
UPDATE settings SET value='localhost:3099' WHERE key='machine_ip';
```

Dann Backend neu starten:
```bash
npm run dev
```

## Zurück zur echten Maschine

```sql
UPDATE settings SET value='<IP deiner Xenia>' WHERE key='machine_ip';
```

Backend neu starten.

## Mock-Skripte

| ID | Titel | Dauer | Cmd27 |
|----|-------|-------|-------|
| 1 | Mock Espresso 1x | ~33s | nein |
| 2 | Mock Spülen | ~10s | nein |
| 3 | Mock mit Cmd27 | ~35s | ja, Stop bei 20g |

Für BbW-Tests: Skript #1 oder #2 nehmen (kein Cmd27), Profil mit
`yield_target_g` anlegen, `brew_by_weight_active=true` setzen.

## Simuliertes Verhalten

**Maschinen-States** (`MA_STATUS`):
- `off` (0) → nach Power-Off-Command
- `on` (1) → nach Power-On; Temps steigen langsam auf Setpoints zu (~0.12°C/250ms)
- `eco` (2) → nach ECO-Command; Temps driften auf 75% der Setpoints
- `brewing` (3) → während Skript läuft
- `draining` (4) → 2s nach Ende/Stop des Skripts, dann zurück zu `on`

**Temperatur-Simulation:**
- Maschine startet kalt (22°C) — wie nach einem Kaltstart
- Aufheizzeit bis zu Setpoints (z.B. 93°C): je nach Setpoint ca. 1–3 Min

**Brewing-Simulation:**
- 0–3s: Flow rampt linear von 0 auf `targetFlowGPerS` hoch
- 3s bis Skript-Ende: konstanter Flow + ±5% Gaussian-Noise
- `targetFlowGPerS`: 1.3–1.8 g/s, zufällig pro Bezug (Variation)
- Pump-Druck: 0→9 bar während Ramp-up, dann ~9 bar ± 0.3 bar Noise
- `SCALE_WEIGHT` startet bei 0 für jeden neuen Bezug
- `PU_SENS_FLOW_METER_ML`: kumulativ über Maschinen-Lifetime

**Cmd27-Emulation (Skript #3):**
- Flow stoppt sobald `SCALE_WEIGHT >= cmd27TargetG`
- Sofort Draining-Phase

**Steam Boiler:**
- Druck baut sich langsam auf wenn `SB_STATUS=1`

## Was NICHT simuliert wird

- **Physikalisch korrekter Druck-Verlauf** — Druck bleibt auf ~9 bar
  Plateau (kein Kam-Druck-Peak wie bei echter Lever-Maschine)
- **MA_EXTRACTIONS Increment** — Zähler bleibt konstant bei 42
- **MA_LAST_EXTRACTION_ML** — statisch "36"
- **Wasser-Tank-Level** — statisch 1 (voll)
- **ECO-Mode Setpoints** — liefert gleiche Setpoints wie On-Mode,
  nur `MA_STATUS` unterscheidet sich
- **FW-Updates / Multi-Boiler-Variants** — MA_TYPE fest = 4 (DBL)

## BbW-Test Schritt für Schritt

```sql
-- 1. Mock aktivieren
UPDATE settings SET value='localhost:3099' WHERE key='machine_ip';

-- 2. BbW einschalten
UPDATE settings SET value='true' WHERE key='brew_by_weight_active';
```

```bash
# 3. Mock starten (Terminal 1)
npm run mock

# 4. Backend starten mit BbW-Debug-Output (Terminal 2)
DEBUG_BBW=1 npm run dev
```

5. Im Frontend: Profil anlegen das Skript #1 verwendet, `yield_target_g` z.B. 25g
6. Bezug starten
7. Im Backend-Log erscheint alle ~500ms: `[bbw] sample=N weight=...g slope=...g/s projected=...g`
8. Wenn projected >= 25g: `[bbw] Stop triggered` → `[mock] script-stop received`
9. Shot endet mit `stop_mode='app'` in der DB
