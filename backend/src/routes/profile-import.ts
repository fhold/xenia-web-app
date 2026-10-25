/**
 * Profil-Import (2026-10-20) — die Datei aus „Exportieren“ (Format v1–v3) oder
 * ein Decent-Profil (.tcl / v2-JSON), das dabei uebersetzt wird (decent-profile.ts).
 *
 * POST /api/profiles/import/preview  { text } | { file }          → ImportPreview, schreibt nichts
 * POST /api/profiles/import          { text | file, choices }      → das angelegte Profil + was mit den Skripten geschah
 *
 * Optional `lang` ("de" | "en", sonst "de"): Sprache der Texte aus shared/ —
 * Uebersetzungsbericht, Notiz und Meldungen beim Lesen und Pruefen der Datei.
 * Die eigenen Meldungen dieser Route bleiben deutsch.
 *
 * Skripte: liegt ein Skript mit identischem Text auf der Maschine, wird es
 * verwendet; fehlt es, wird es angelegt (kleinster freier Platz ab 10, nie
 * ueberschrieben); gleicher Titel mit anderem Text → der Nutzer waehlt je
 * Variante: choices[i] = "reuse" (das vorhandene) | "create" (neu, Titel mit Zaehler).
 * Geprueft wird alles vor dem ersten Schreibbefehl — mit denselben Pruefungen
 * wie beim Speichern im Editor.
 */

import type { FastifyInstance } from "fastify";
import type { XeniaClient } from "../xenia/client.js";
import { XeniaError } from "../xenia/client.js";
import type { ScriptRepo } from "../db/script-repo.js";
import type { ProfileRepo } from "../db/profile-repo.js";
import type { ShotRecorder } from "../shots/recorder.js";
import { SqliteBasketRepo } from "../db/basket-repo.js";
import { checkVariants } from "../db/variant-repo.js";
import { createScriptOnMachine, syncAllScripts } from "../xenia/script-sync.js";
import { checkWrite, scriptWriteBlocked } from "./scripts.js";
import { kindError, trialError } from "./profiles.js";
import { parseTargetTempC } from "../../../shared/src/profile-temp.js";
import { validateBrewProfile } from "../../../shared/src/brew-steps.js";
import {
  canonicalScript,
  planProfileImport,
  readProfileFile,
  type ImportPlan,
  type ImportPreview,
  type ProfileFileProfile,
  type ProfileImportResult,
} from "../../../shared/src/profile-file.js";
import { translateDecent } from "../../../shared/src/decent-profile.js";
import { withSharedLang, type SharedLang } from "../../../shared/src/shared-lang.js";
import type { ApiResponse, LiveFrame, ProfileCreate, ProfileVariantInput } from "../../../shared/src/types.js";

type Choice = "reuse" | "create";

/** Ein Skript, das der Import anlegen wird — bis dahin steht in der Variante ein Platzhalter (< 0). */
interface PendingScript {
  placeholder: number;
  title: string;
  instruction: string;
}

/** Titel mit Zaehler, damit ein zweites Skript gleichen Namens unterscheidbar bleibt. */
function freeTitle(title: string, taken: Set<string>): string {
  if (!taken.has(title)) return title;
  for (let n = 2; ; n++) if (!taken.has(`${title} ${n}`)) return `${title} ${n}`;
}

export function registerProfileImportRoutes(
  app: FastifyInstance,
  client: XeniaClient,
  scriptRepo: ScriptRepo,
  profileRepo: ProfileRepo,
  recorder: ShotRecorder,
  getLastFrame: () => LiveFrame | null,
  onProfilesChanged: () => void,
): void {
  const baskets = new SqliteBasketRepo();

  const fail = (reply: { status: (n: number) => unknown }, status: number, error: string): ApiResponse => {
    reply.status(status);
    return { ok: false, error };
  };

  const plan = (profile: ProfileFileProfile): ImportPlan =>
    planProfileImport(profile, {
      scripts: scriptRepo.listAll(),
      baskets: baskets.listAll(),
      profileNames: profileRepo.listAll().map((p) => p.name),
    });

  /**
   * Das Profil zum Anlegen, Skripte die es noch nicht gibt als Platzhalter.
   * Gibt die erste Pruefungsmeldung zurueck, wenn etwas nicht stimmt.
   */
  const build = (profile: ProfileFileProfile, p: ImportPlan, choices: Record<string, unknown>):
    { ok: true; create: ProfileCreate; pending: PendingScript[]; reused: { id: number; title: string }[] } | { ok: false; error: string } => {
    const pending: PendingScript[] = [];
    const reused: { id: number; title: string }[] = [];
    const byText = new Map<string, PendingScript>();
    const titles = new Set(scriptRepo.listAll().filter((s) => s.orphanedAt === null).map((s) => s.title));
    const names = profile.variants.map((v) => v.name);
    const variants: ProfileVariantInput[] = [];

    for (const [i, v] of profile.variants.entries()) {
      const vp = p.variants[i]!;
      let scriptId: number | null = null;
      if (v.script && vp.script) {
        const sp = vp.script;
        const choice = sp.status === "conflict" ? choices[String(i)] : null;
        if (sp.status === "conflict" && choice !== "reuse" && choice !== "create") {
          return { ok: false, error: `„${v.name}“: Ein anderes Skript „${sp.title}“ gibt es schon — vorhandenes verwenden oder neu anlegen?` };
        }
        if (sp.status === "same" || (sp.status === "conflict" && choice === "reuse")) {
          const id = sp.scriptId;
          scriptId = id;
          if (!reused.some((r) => r.id === id)) reused.push({ id, title: sp.title });
        } else {
          // Zweimal derselbe Text in einer Datei wird nur einmal angelegt.
          const key = canonicalScript(v.script.content);
          let ps = byText.get(key);
          if (!ps) {
            const title = freeTitle(v.script.title, titles);
            const checked = checkWrite({ title, content: v.script.content });
            if (!checked.ok) return { ok: false, error: `„${v.name}“, Skript „${title}“: ${checked.error}` };
            titles.add(title);
            ps = { placeholder: -(pending.length + 1), title, instruction: checked.instruction };
            pending.push(ps);
            byText.set(key, ps);
          }
          scriptId = ps.placeholder;
        }
      }
      const sameAs = v.sameAs !== null ? names.indexOf(v.sameAs) : null;
      if (sameAs === -1) return { ok: false, error: `„${v.name}“: „wie ${v.sameAs}“ — diese Variante fehlt in der Datei.` };
      variants.push({
        name: v.name,
        defaultBasketId: vp.basketId,
        yieldG: v.yieldG,
        scriptId,
        brewSteps: v.brewSteps,
        sameAs,
        phaseNames: v.phaseNames,
      });
    }

    const create: ProfileCreate = {
      name: p.name,
      kind: profile.kind,
      isTrial: profile.isTrial,
      fit: profile.fit,
      scriptIdSingle: null,
      targetTempC: profile.targetTempC,
      notes: profile.notes,
      variants,
    };
    const temp = parseTargetTempC(create.targetTempC);
    if (!temp.ok) return { ok: false, error: temp.error };
    const error = kindError(create.kind, variants) ?? trialError(create.isTrial) ?? checkVariants(variants, {
      basket: (id) => baskets.findById(id) !== undefined,
      script: (id) => id < 0 || scriptRepo.findById(id) !== undefined,
      validSteps: (bp) => {
        const check = validateBrewProfile(bp);
        return check.ok ? null : check.error;
      },
    });
    return error ? { ok: false, error } : { ok: true, create, pending, reused };
  };

  /** Profil-Datei der App (als Objekt oder Text) oder Decent-Profil (Text, wird uebersetzt). */
  const readImport = (body: unknown):
    { ok: true; profile: ProfileFileProfile; translation: ImportPreview["translation"] } | { ok: false; error: string } => {
    const b = (body ?? {}) as { file?: unknown; text?: unknown };
    let file = b.file;
    if (typeof b.text === "string") {
      try { file = JSON.parse(b.text); } catch { file = undefined; }
      const own = typeof file === "object" && file !== null && (file as { kind?: unknown }).kind === "xenia-profile";
      if (!own) {
        const t = translateDecent(b.text);
        return t.ok ? { ok: true, profile: t.profile, translation: { title: t.title, rows: t.rows, hints: t.hints } } : t;
      }
    }
    const read = readProfileFile(file);
    return read.ok ? { ok: true, profile: read.profile, translation: null } : read;
  };

  /** Sprache der shared-Texte dieser Anfrage. withSharedLang ist synchron — nur um
   *  synchrone Schritte (Lesen/Uebersetzen, Pruefen), nie ueber ein await hinweg. */
  const langOf = (body: unknown): SharedLang => ((body as { lang?: unknown } | null)?.lang === "en" ? "en" : "de");

  /** Liest die Datei; mit Skripten vorher die Liste der Maschine frisch holen. */
  const prepare = async (body: unknown, reply: { status: (n: number) => unknown }):
    Promise<{ ok: true; profile: ProfileFileProfile; translation: ImportPreview["translation"] } | { ok: false; res: ApiResponse }> => {
    const read = withSharedLang(langOf(body), () => readImport(body));
    if (!read.ok) return { ok: false, res: fail(reply, 400, read.error) };
    if (read.profile.variants.some((v) => v.script)) {
      if (scriptWriteBlocked(recorder, getLastFrame())) {
        return { ok: false, res: fail(reply, 409, "Es läuft ein Bezug — Profile mit Skript erst danach importieren.") };
      }
      try {
        await syncAllScripts(client, scriptRepo);
      } catch {
        return { ok: false, res: fail(reply, 502, "Die Maschine antwortet nicht — die Skripte lassen sich nicht abgleichen.") };
      }
    }
    return { ok: true, profile: read.profile, translation: read.translation };
  };

  app.post("/api/profiles/import/preview", async (req, reply) => {
    const prep = await prepare(req.body, reply);
    if (!prep.ok) return prep.res;
    const p = plan(prep.profile);
    // Fehler in der Datei zeigt schon die Vorschau — Konflikte zaehlen hier noch nicht.
    const all: Record<string, Choice> = {};
    p.variants.forEach((v, i) => { if (v.script?.status === "conflict") all[String(i)] = "reuse"; });
    const built = withSharedLang(langOf(req.body), () => build(prep.profile, p, all));
    if (!built.ok) return fail(reply, 400, built.error);
    const preview: ImportPreview = { ...p, profile: prep.profile, translation: prep.translation };
    return preview;
  });

  app.post("/api/profiles/import", async (req, reply) => {
    const prep = await prepare(req.body, reply);
    if (!prep.ok) return prep.res;
    const p = plan(prep.profile);
    const choices = (req.body as { choices?: unknown }).choices;
    const built = withSharedLang(langOf(req.body), () =>
      build(prep.profile, p, typeof choices === "object" && choices !== null ? choices as Record<string, unknown> : {}));
    if (!built.ok) return fail(reply, 400, built.error);

    const created: { id: number; title: string }[] = [];
    for (const ps of built.pending) {
      try {
        const script = await createScriptOnMachine(client, scriptRepo, ps.title, ps.instruction);
        created.push({ id: script.id, title: script.title });
        for (const v of built.create.variants!) if (v.scriptId === ps.placeholder) v.scriptId = script.id;
      } catch (err) {
        const done = created.map((s) => `#${s.id} „${s.title}“`).join(", ");
        const noSlot = err instanceof XeniaError && err.statusCode === 403;
        return fail(
          reply,
          noSlot ? 507 : 502,
          `Skript „${ps.title}“ ließ sich nicht anlegen: ${noSlot ? "kein freier Skript-Platz" : (err as Error).message}.`
            + (done ? ` Schon angelegt: ${done} — ein neuer Import verwendet sie.` : ""),
        );
      }
    }

    const id = profileRepo.insert(built.create);
    onProfilesChanged();
    const result: ProfileImportResult = {
      profile: profileRepo.findById(id)!,
      createdScripts: created,
      reusedScripts: built.reused,
      missingBaskets: [...new Set(p.variants.map((v) => v.missingBasket).filter((n): n is string => n !== null))],
    };
    return result;
  });
}
