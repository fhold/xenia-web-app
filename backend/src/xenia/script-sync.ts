/**
 * Script sync — Handoff 3.5.
 *
 * syncAllScripts(): full sync on backend start or manual refresh.
 * syncSingleScript(): used pre-brew to get a fresh Cmd-27 read before execution.
 */

import type { SyncResult, XeniaScript } from "../../../shared/src/types.js";
import {
  parseScript,
  categorizeScript,
  hasCmd27,
  extractWeightTargets,
} from "../../../shared/src/script-parser.js";
import { serializeScript } from "../../../shared/src/script-serializer.js";
import type { XeniaClient } from "./client.js";
import type { ScriptRepo } from "../db/script-repo.js";

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

export async function syncAllScripts(
  client: XeniaClient,
  repo: ScriptRepo,
): Promise<SyncResult> {
  const result: SyncResult = { added: 0, updated: 0, orphaned: 0, errors: [] };

  // Fetch script list — if this fails, propagate (caller decides how to handle)
  const fresh = await client.scriptsList();

  for (let i = 0; i < fresh.index_list.length; i++) {
    const id = fresh.index_list[i];
    const title = fresh.title_list[i] ?? `Script ${id}`;

    try {
      const raw = await client.scriptRead(id);
      const script = buildScript(id, title, raw.Content);

      const isNew = repo.findById(id) === undefined;
      repo.upsert(script);
      if (isNew) {
        result.added++;
      } else {
        result.updated++;
      }
    } catch (err) {
      result.errors.push({ id, error: (err as Error).message });
    }
  }

  // Orphan detection: IDs in DB (non-orphaned) that are no longer on the machine
  const orphanedIds = repo.findIdsNotIn(fresh.index_list);
  for (const id of orphanedIds) {
    repo.markOrphaned(id, Date.now());
    result.orphaned++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Shallow list sync (SE-2b) — refresh ids + titles on opening the Scripts view,
// WITHOUT reading every script's content (one /scripts/list request). Content is
// fetched lazily per script via syncSingleScript when it is opened. Only a
// genuinely NEW script is read immediately so the list has a category badge.
// ---------------------------------------------------------------------------

export async function syncScriptList(
  client: XeniaClient,
  repo: ScriptRepo,
): Promise<SyncResult> {
  const result: SyncResult = { added: 0, updated: 0, orphaned: 0, errors: [] };
  const fresh = await client.scriptsList();

  for (let i = 0; i < fresh.index_list.length; i++) {
    const id = fresh.index_list[i];
    const title = fresh.title_list[i] ?? `Script ${id}`;
    const existing = repo.findById(id);
    if (existing) {
      if (existing.title !== title || existing.orphanedAt !== null) {
        repo.updateTitle(id, title); // title change / un-orphan; content untouched
        result.updated++;
      }
    } else {
      // New script → read its content once so the list shows a category badge.
      try {
        const raw = await client.scriptRead(id);
        repo.upsert(buildScript(id, title, raw.Content));
        result.added++;
      } catch (err) {
        result.errors.push({ id, error: (err as Error).message });
      }
    }
  }

  const orphanedIds = repo.findIdsNotIn(fresh.index_list);
  for (const id of orphanedIds) {
    repo.markOrphaned(id, Date.now());
    result.orphaned++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single-script sync (pre-brew)
// ---------------------------------------------------------------------------

/**
 * Fetch and re-parse a single script from the machine.
 * Used directly before /scripts/execute to ensure Cmd-27 detection is current
 * even if the user edited the script in the Xenia web interface.
 * Title is preserved from existing DB entry when available.
 */
export async function syncSingleScript(
  id: number,
  client: XeniaClient,
  repo: ScriptRepo,
): Promise<XeniaScript> {
  const raw = await client.scriptRead(id);
  // Prefer title from repo (user may have renamed via app); fall back to machine title
  const existing = repo.findById(id);
  const title = existing?.title ?? raw.Title ?? `Script ${id}`;
  const script = buildScript(id, title, raw.Content);
  repo.upsert(script);
  // Preserve the local category override (the upsert doesn't touch that column);
  // re-attach it so callers (e.g. the pre-brew arming gate) see the effective category.
  script.categoryOverride = existing?.categoryOverride ?? null;
  return script;
}

// ---------------------------------------------------------------------------
// Write-back (SE-2) — create a script on the machine and pull it into the DB
// ---------------------------------------------------------------------------

/** Kleinste Nummer, die die Maschine fuer eigene Skripte nutzt (ihre liegen bei 10–28). */
export const FIRST_SCRIPT_SLOT = 10;
/**
 * Ab hier zeigt die Xenia-Weboberflaeche Skripte NICHT mehr an (gemessen
 * 2026-09-23: 150–152 unsichtbar, 29–31 sichtbar). Wo genau dazwischen die
 * Grenze liegt, ist unbekannt — deshalb wird immer die KLEINSTE freie Nummer
 * genommen, nie eine hohe.
 */
export const INVISIBLE_FROM_SLOT = 150;

/**
 * Kleinste freie Skriptnummer im sichtbaren Bereich, oder null.
 * Nur Nummern, die NICHT in `used` stehen — ein bestehendes Skript wird nie
 * ueberschrieben.
 */
export function nextFreeScriptId(used: readonly number[]): number | null {
  const taken = new Set(used);
  for (let id = FIRST_SCRIPT_SLOT; id < INVISIBLE_FROM_SLOT; id++) {
    if (!taken.has(id)) return id;
  }
  return null;
}

/**
 * Create a NEW script on the machine and return the synced DB entry.
 *
 * Ohne Nummer waehlt die Maschine selbst — und nimmt dabei nicht die naechste
 * freie niedrige, sondern den Bereich ab 150 (beobachtet: 21–24 frei, sie nahm
 * 150). Dort zeigt die Xenia-Weboberflaeche Skripte nicht an; man kann sie am
 * Geraet weder sehen noch auf einen Knopf legen. Deshalb wird die kleinste
 * freie Nummer selbst bestimmt und mit `Edit: "Enabled"` dorthin geschrieben —
 * gemessen 2026-09-23: auf einem FREIEN Platz legt das ein neues Skript an.
 *
 * Danach muss in scripts/list genau diese eine Nummer neu sein; das Skript
 * braucht ~1 s, bis es dort auftaucht, daher die Wiederholung. Jede Abweichung
 * (nichts neu, anderer Platz, mehrere neu) wirft — eine gleichzeitige Aenderung
 * an der Maschine liesse uns sonst den falschen Platz uebernehmen.
 */
export async function createScriptOnMachine(
  client: XeniaClient,
  repo: ScriptRepo,
  title: string,
  content: string,
): Promise<XeniaScript> {
  const used = (await client.scriptsList()).index_list;
  const id = nextFreeScriptId(used);
  if (id === null) {
    throw new Error(
      `Kein freier Skriptplatz zwischen ${FIRST_SCRIPT_SLOT} und ${INVISIBLE_FROM_SLOT - 1}`,
    );
  }
  const before = new Set(used);
  await client.scriptCreate({ scriptId: id, name: title, instruction: content });

  let added: number[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    added = (await client.scriptsList()).index_list.filter((n) => !before.has(n));
    if (added.length > 0) break;
  }

  if (added.length !== 1 || added[0] !== id) {
    throw new Error(
      added.length === 0
        ? `Skript auf Platz ${id} geschrieben, taucht aber nicht in der Liste auf`
        : `Skript sollte auf Platz ${id} landen, neu in der Liste: ${added.join(", ")}`,
    );
  }
  const script = await syncSingleScript(id, client, repo);
  // The machine reuses freed slots, so a stale DB row can still sit on this ID —
  // and syncSingleScript prefers the DB title. The name we just wrote wins.
  repo.updateTitle(script.id, title);
  script.title = title;
  return script;
}

/** Das Skript wurde an der Maschine geaendert, seit der Editor es geladen hat. */
export class ScriptConflictError extends Error {
  constructor(readonly machineContent: string) {
    super("Das Skript wurde an der Maschine geändert, seit du es geöffnet hast");
    this.name = "ScriptConflictError";
  }
}

/**
 * Ein bestehendes Skript an Ort und Stelle ueberschreiben — aber nur, wenn es
 * an der Maschine noch so aussieht wie beim Oeffnen im Editor.
 *
 * Flavio bearbeitet Skripte auch in der Xenia-Oberflaeche. Ohne diesen
 * Abgleich wuerde ein Speichern im Editor eine dortige Aenderung still
 * ueberschreiben. Verglichen wird in kanonischer Form (parse → serialize), so
 * zaehlt nur ein echter Unterschied im Ablauf, nicht Leerraum.
 */
export async function overwriteScriptOnMachine(
  client: XeniaClient,
  repo: ScriptRepo,
  id: number,
  title: string,
  content: string,
  expectedContent: string,
): Promise<XeniaScript> {
  const canonical = (s: string) => serializeScript(parseScript(s));
  const onMachine = (await client.scriptRead(id)).Content;
  if (canonical(onMachine) !== canonical(expectedContent)) {
    throw new ScriptConflictError(onMachine);
  }
  await client.scriptCreate({ scriptId: id, name: title, instruction: content });
  const script = await syncSingleScript(id, client, repo);
  // syncSingleScript keeps the DB title (it assumes the app is authoritative
  // for names), so a rename would otherwise be dropped here.
  repo.updateTitle(id, title);
  script.title = title;
  return script;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function buildScript(id: number, title: string, content: string): XeniaScript {
  const parsed = parseScript(content);
  const weightTargets = extractWeightTargets(parsed);
  return {
    id,
    title,
    content,
    parsedCmds: parsed,
    hasCmd27: hasCmd27(parsed),
    cmd27Value:
      weightTargets.length > 0
        ? weightTargets[weightTargets.length - 1]
        : null,
    categoryAuto: categorizeScript(title, parsed),
    // SE-2: local override is managed separately and preserved across syncs (the
    // upsert never writes this column). Default null here; syncSingleScript
    // re-attaches the existing value so the arming gate sees the effective category.
    categoryOverride: null,
    fetchedAt: Date.now(),
    orphanedAt: null,
  };
}
