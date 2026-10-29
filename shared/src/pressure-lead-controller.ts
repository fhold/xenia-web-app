/**
 * Druckregelung der App-Druckstufen.
 *
 * Was die App von der Maschine sieht (Replay von 25 App-Bezuegen #254–#295 gegen ein
 * Streckenmodell, 26.10.2026):
 * - Der Druckwert ist nur etwa alle 0,5 s frisch (bei schnell wechselndem Druck
 *   liefert jede dritte Abfrage denselben Wert) und auf 0,1 bar gerundet; ein
 *   Pumpenbefehl wirkt nach ~0,2–0,4 s. Die Firmware regelt dagegen direkt am
 *   Sensor im schnellen Takt (/api/v2/pump/pid: P 0,03 · I 0,0008 · D 10).
 * - Die Nachgiebigkeit faellt mit dem Druck wie bei einem Luftpolster,
 *   C(p) ≈ vAir/(1+p)² mit vAir ~12–30 ml: bei 1 bar ~5 ml/bar, bei 9 bar ~0,2.
 *   Ein PI mit fester Verstaerkung ist deshalb bei 9 bar zu scharf und bei 1 bar zu
 *   traege; beim ersten Fuellen schluckt das Benetzen noch 15–55 ml/bar dazu. Der
 *   alte Druck-PI zog dort auf und schoss beim Steifwerden ueber (#295: 5,3 statt
 *   1,1 bar), und eine kurze 9-bar-Stufe erreichte er nicht (#295: 7,4 bar).
 *
 * Dieser Regler rechnet in Wasser statt in Prozent:
 *
 *   erwarteter Druck = gemessen + Steigung · leadS
 *   Zulauf           = Abfluss (Waage) + fehlendes Volumen bis zum Soll / tauS
 *   Leistung         = Kennlinie(erwarteter Druck, Zulauf) + Integral
 *
 * Das fehlende Volumen kommt aus C(p) — so ist die Verstaerkung bei 1 bar gross und
 * bei 9 bar klein, wie die Strecke es verlangt. Unter dem Soll darf er schneller
 * zulaufen lassen, aber nur so schnell, dass ein ploetzlich steifer Puck (Benetzen
 * fertig) hoechstens dpOk ueber das Soll laeuft, bevor die Korrektur wirkt (safeS).
 * Das Integral gleicht den Versatz der Kennlinie je Bezug aus (±1–3 %; die Fehlmenge
 * ueber 7 bar steckt seit 27.10. in der Kennlinie selbst); es rechnet mit dem
 * erwarteten Druck, damit es beim Anfahren nicht auflaeuft, und nur nahe am Soll —
 * oder wenn der Druck ueber dem Soll stehen bleibt: bei steifem Puck nimmt der
 * Vorhalt je bar Abweichung nur ~2 % zurueck, ein Kennlinien-Versatz von 3 % blieb so
 * als 1,5 bar zu viel stehen, ausserhalb des Bands (#307: 9,4 statt 7,8 bar, 4 s lang).
 * Unter dem Soll bewusst nicht: beim Fuellen steht der Druck sekundenlang knapp ueber 0.
 */

import { powerForInflow, type PumpCurve } from "./pump-curve.js";

export interface PressureLeadConfig {
  /** Zeit (s), in der das fehlende Volumen zulaufen soll. */
  tauS: number;
  /** Vorhalt (s): so weit rechnet der Regler die Steigung voraus. Messalter + Pumpenverzug
   *  waeren ~0,55 s, aber die Steigung (Ausgleichsgerade ueber slopeWinMs) ist selbst schon
   *  ~0,5 s alt — beim Abflachen vor dem Haltedruck verlaengerte 0,5 s die alte Steigung
   *  (#298: erwartet 9,8 bar bei gemessen 8,6, zurueckgenommen, blieb bei 8,66). */
  leadS: number;
  /** Luftpolster (ml) und steife Restnachgiebigkeit (ml/bar) des Modells C(p). */
  vAir: number;
  cMin: number;
  /** Unter dem Soll: so weit (bar) darf ein ploetzlich steifer Puck ueberschiessen … */
  dpOk: number;
  /** … bis die Korrektur nach so vielen Sekunden greift. */
  safeS: number;
  /** Integral (%/(bar·s)), nur innerhalb max(iBand, iBandRel · Soll) um das Soll, begrenzt auf ±iMax %. */
  ki: number;
  iBand: number;
  iBandRel: number;
  iMax: number;
  /** Ueber dem Soll rechnet das Integral auch ausserhalb des Bands, solange der Druck
   *  steht (|Steigung| unter so viel bar/s). */
  stillSlope: number;
  /** Fenster (ms) fuer die Steigung des Drucks. */
  slopeWinMs: number;
  /** Leistungsgrenzen (%). */
  outMin: number;
  outMax: number;
}

export const DEFAULT_PRESSURE_LEAD: PressureLeadConfig = {
  tauS: 1.2,
  leadS: 0.35,
  vAir: 15,
  cMin: 0.1,
  dpOk: 0.4,
  safeS: 0.5,
  ki: 3,
  iBand: 0.6,
  iBandRel: 0.15,
  iMax: 12,
  stillSlope: 0.5,
  slopeWinMs: 1000,
  outMin: 15,
  outMax: 100,
};

/** So weit (ms) schaut der Treiber auf der Sollkurve voraus (`sollAhead`): ein Befehl wirkt
 *  nach Messalter + Pumpenverzug (~0,5 s), und die Sollkurve ist — anders als die
 *  gemessene Steigung (leadS) — exakt bekannt. Mit 0,35 s wie leadS schoss der Druck im
 *  Simulator bei Rampen ins Halten deutlich oefter ueber. */
export const SOLL_LOOKAHEAD_MS = 500;

export interface PressureLeadStep {
  output: number;
  /** Erwarteter Druck nach dem Vorhalt (bar). */
  predicted: number;
  /** Steigung des gemessenen Drucks (bar/s). */
  slope: number;
}

export class PressureLeadController {
  private hist: { t: number; p: number }[] = [];
  private integral = 0;

  constructor(
    private readonly curve: PumpCurve,
    private readonly cfg: PressureLeadConfig,
  ) {}

  /** Wasser (ml), das bis zum Druck p im Modell gespeichert ist. */
  private stored(p: number): number {
    const x = Math.max(0, p);
    return this.cfg.cMin * x + this.cfg.vAir * (1 - 1 / (1 + x));
  }

  /** Steigung als Ausgleichsgerade ueber das Fenster — der Druckwert ist nur alle ~0,5 s
   *  frisch, zwei aufeinanderfolgende Abfragen sagen nichts. null = noch zu wenig Werte. */
  private slope(nowMs: number): number | null {
    const w = this.hist.filter((h) => h.t >= nowMs - this.cfg.slopeWinMs);
    if (w.length < 3 || w[w.length - 1]!.t - w[0]!.t < this.cfg.slopeWinMs / 2) return null;
    const mt = w.reduce((a, h) => a + h.t, 0) / w.length;
    const mp = w.reduce((a, h) => a + h.p, 0) / w.length;
    let num = 0, den = 0;
    for (const h of w) { num += (h.t - mt) * (h.p - mp); den += (h.t - mt) ** 2; }
    return den > 0 ? (num / den) * 1000 : 0;
  }

  update(i: { nowMs: number; pressureBar: number; outflowMlS: number; soll: number; sollAhead: number; dtS: number }): PressureLeadStep {
    const c = this.cfg;
    this.hist.push({ t: i.nowMs, p: i.pressureBar });
    while (this.hist[0]!.t < i.nowMs - c.slopeWinMs) this.hist.shift();
    const measured = this.slope(i.nowMs);
    const slope = measured ?? 0;
    const predicted = Math.max(0, i.pressureBar + slope * c.leadS);
    const qOut = Math.max(0, i.outflowMlS);
    const gap = i.sollAhead - predicted;
    let q = qOut + (this.stored(i.sollAhead) - this.stored(predicted)) / c.tauS;
    if (gap > 0) {
      // Bis dpOk unter dem Soll voll ausschoepfen, auf dem Soll selbst nichts mehr dazu.
      const reserve = Math.min(c.dpOk, gap);
      q = Math.max(q, qOut + (this.stored(i.sollAhead + reserve) - this.stored(predicted)) / c.safeS);
    }
    // Ein negativer Zulauf heisst: weniger Leistung, als den Druck haelt — er faellt schneller.
    const raw = powerForInflow(this.curve, predicted, q) + this.integral;
    const output = Math.min(c.outMax, Math.max(c.outMin, raw));
    const err = i.soll - predicted;
    const near = Math.abs(err) < Math.max(c.iBand, c.iBandRel * i.soll);
    const stuckAbove = err < 0 && measured !== null && Math.abs(measured) < c.stillSlope;
    if ((near || stuckAbove) && output === raw) {
      this.integral = Math.max(-c.iMax, Math.min(c.iMax, this.integral + c.ki * err * i.dtS));
    }
    return { output, predicted, slope };
  }
}
