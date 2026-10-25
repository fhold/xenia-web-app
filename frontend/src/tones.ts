/**
 * Töne übers Tablet. Ein Browser spielt Ton erst, nachdem die Seite berührt
 * wurde — iOS sogar nur aus einem Kontext, der in einer Berührung anlief. Deshalb
 * gibt es einen Kontext für die ganze App, den jede Berührung entsperrt: ein Ton,
 * der später ohne Berührung kommt (Phasenende, Bezugsende), klingt dann trotzdem.
 * Alles best effort — die Anzeige bleibt die verlässliche Rückmeldung.
 */

let ctx: AudioContext | null = null;

function unlock(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    // Kein Ton auf diesem Gerät.
  }
}

/** Einmal beim Start der App; gibt das Abmelden zurück. */
export function installAudioUnlock(): () => void {
  document.addEventListener("pointerdown", unlock, { passive: true });
  return () => document.removeEventListener("pointerdown", unlock);
}

function beep(offset: number, freq: number): void {
  unlock();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + offset;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.2);
  } catch {
    // best effort
  }
}

/** Zwei fallende Töne — der Bezug endete mit eingefrorener oder verlorener Waage. */
export function playAlertBeep(): void {
  beep(0, 880);
  beep(0.24, 620);
}

/** Ein Ton — eine Phase mit Ton ist zu Ende (BrewStep.tone). */
export function playPhaseTone(): void {
  beep(0, 988);
}
