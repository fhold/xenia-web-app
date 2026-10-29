/**
 * Script routes — Phase 1 Step 4a/4b.
 *
 * GET    /api/scripts                 — list non-orphaned scripts (?include_orphaned=true for all)
 * GET    /api/scripts/:id             — single script by ID
 * POST   /api/scripts/refresh         — trigger full sync from Xenia
 * POST   /api/scripts/execute         — execute a profile's script (Step 4b)
 * DELETE /api/scripts/orphaned        — hard-delete orphaned scripts (admin, unblocked only)
 * POST   /api/scripts                 — write a NEW script to the machine (SE-2)
 * PUT    /api/scripts/:id             — overwrite an existing machine script (SE-2);
 *                                        body.expectedContent = the state the edit started from (409 if the machine differs)
 * DELETE /api/scripts/:id             — delete a script from the machine (SE-2)
 */

import type { FastifyInstance } from "fastify";
import type { XeniaClient } from "../xenia/client.js";
import type { ScriptRepo } from "../db/script-repo.js";
import type { ProfileRepo } from "../db/profile-repo.js";
import type { SettingsRepo } from "../db/settings-repo.js";
import type { ShotRecorder } from "../shots/recorder.js";
import {
  syncAllScripts,
  syncSingleScript,
  syncScriptList,
  createScriptOnMachine,
  overwriteScriptOnMachine,
  ScriptConflictError,
} from "../xenia/script-sync.js";
import { checkMachineReadyToStart } from "../lib/start-gate.js";
import { executeBody } from "../lib/body-schemas.js";
import { XeniaError } from "../xenia/client.js";
import { parseScript, hasPumpAction } from "../../../shared/src/script-parser.js";
import { serializeScript } from "../../../shared/src/script-serializer.js";
import { validateScript } from "../../../shared/src/script-validator.js";
import { resolveStart } from "../db/variant-repo.js";
import { SqliteBasketRepo } from "../db/basket-repo.js";
import type {
  ApiResponse,
  ExecuteRequest,
  ExecuteResult,
  LiveFrame,
} from "../../../shared/src/types.js";
import { L } from "../../../shared/src/shared-lang.js";

/** The machine's own name rule (modeler.js): no leading/trailing blank,
 *  only letters, digits, "-", "_", "#" and spaces. */
const NAME_RE = /^(?! )[A-Za-z0-9\-_# ]*(?<! )$/;

export type WriteBody = { title?: unknown; content?: unknown };

/**
 * Shared gate for both write routes: title against the machine's name rule,
 * content through parse → validate → serialize. Returns the canonical token
 * string, so what we send is exactly what the round-trip test covers.
 */
export function checkWrite(
  body: WriteBody,
): { ok: true; title: string; instruction: string } | { ok: false; error: string } {
  const title = typeof body.title === "string" ? body.title : "";
  const content = typeof body.content === "string" ? body.content : "";

  if (title === "") return { ok: false, error: L("Name fehlt", "Name missing") };
  if (!NAME_RE.test(title)) {
    return {
      ok: false,
      error:
        "Name ungültig — erlaubt sind Buchstaben, Ziffern, - _ # und Leerzeichen (nicht am Rand)",
    };
  }

  const parsed = parseScript(content);
  const validation = validateScript(parsed);
  if (!validation.ok) {
    return { ok: false, error: validation.errors.map((e) => e.message).join("; ") };
  }
  return { ok: true, title, instruction: serializeScript(parsed) };
}

/** Ein Bezug oder eine Wartung laeuft — dann schreibt niemand Skripte an die Maschine. */
export function scriptWriteBlocked(recorder: ShotRecorder, frame: LiveFrame | null): boolean {
  return (recorder.activeShotId !== null && frame?.machineStatus === 3) || recorder.isMaintenanceActive;
}

export function registerScriptRoutes(
  app: FastifyInstance,
  client: XeniaClient,
  scriptRepo: ScriptRepo,
  profileRepo: ProfileRepo,
  settingsRepo: SettingsRepo,
  recorder: ShotRecorder,
  getLastFrame: () => LiveFrame | null,
  getGateFrame: () => Promise<LiveFrame | null>,
): void {
  // ---------------------------------------------------------------------------
  // GET /api/scripts — list scripts (orphaned excluded by default)
  // ---------------------------------------------------------------------------
  app.get("/api/scripts", async (req) => {
    const { include_orphaned } = req.query as { include_orphaned?: string };
    return scriptRepo.listAll(include_orphaned === "true");
  });

  // ---------------------------------------------------------------------------
  // POST /api/scripts/refresh — full sync from Xenia
  // Must be before /:id so Fastify matches "refresh" statically
  // ---------------------------------------------------------------------------
  app.post("/api/scripts/refresh", async (_req, reply) => {
    try {
      const result = await syncAllScripts(client, scriptRepo);
      return result;
    } catch (err) {
      reply.status(502);
      const msg = err instanceof XeniaError ? err.message : String(err);
      const res: ApiResponse = { ok: false, error: msg };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/scripts/refresh-list — shallow sync (ids + titles only) for the
  // Scripts view on open (SE-2b). Light on the ESP — 1 /scripts/list request,
  // content fetched lazily per script. Must be before /:id (static segment).
  // ---------------------------------------------------------------------------
  app.post("/api/scripts/refresh-list", async (_req, reply) => {
    try {
      return await syncScriptList(client, scriptRepo);
    } catch (err) {
      reply.status(502);
      const msg = err instanceof XeniaError ? err.message : String(err);
      const res: ApiResponse = { ok: false, error: msg };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/scripts/execute — execute a profile script
  //
  // Flow:
  //   1. Resolve profile + script ID from { profileId, shotSize }
  //   2. Pre-brew sync (syncSingleScript) — ensures fresh Cmd-27 detection
  //      even if user edited the script in Xenia's web UI (Handoff 3.5)
  //   3. executeScript(id) → POST /api/v2/scripts/execute { ID: integer }
  //   4. Determine stopMode for the caller:
  //      'cmd27' → Xenia stops via Cmd 27 (machine-native, weight-based)
  //      'app'   → App will stop (brew-by-weight active + yield target set)
  //      'none'  → script runs to end or user stops manually
  // ---------------------------------------------------------------------------
  app.post("/api/scripts/execute", { schema: { body: executeBody } }, async (req, reply) => {
    // Guard (authoritative): refuse a new start while a shot is already active
    // AND the machine is still brewing (MA_STATUS=3). Prevents a second execute
    // reaching the Xenia and a second shot superseding the recorder mid-brew.
    // "active shot" = recorder.activeShotId (shot.ended_at IS NULL) — unrelated
    // to xenia_script.orphaned_at.
    // ÄW-B: also reject while a suppressed maintenance run is in progress — it
    // creates no shot row (activeShotId stays null), so the brew guard alone
    // would let a second start slip through during MA_STATUS=3.
    if (
      (recorder.activeShotId !== null && getLastFrame()?.machineStatus === 3) ||
      recorder.isMaintenanceActive
    ) {
      reply.status(409);
      const res: ApiResponse = {
        ok: false,
        error: L("Es läuft bereits ein Bezug. Bitte zuerst beenden.", "A brew is already running. Please finish it first."),
      };
      return res;
    }

    // H-1: the machine state decides, and it decides fail-closed — the recorder
    // guard above cannot see a brew that this process never started.
    const gate = checkMachineReadyToStart(await getGateFrame());
    if (!gate.ok) {
      reply.status(409);
      const res: ApiResponse = { ok: false, error: gate.error };
      return res;
    }

    const {
      profileId,
      shotSize: requestedSize,
      variantId,
      basketId,
      beanId,
      beanLabel,
      grinderId,
      grindSetting,
      grinderRpm,
      doseG,
      notes,
      yieldTargetOverrideG,
    } = req.body as ExecuteRequest;

    const profile = profileRepo.findById(profileId);
    if (!profile) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: L(`Profil ${profileId} nicht gefunden`, `Profile ${profileId} not found`) };
      return res;
    }

    // Schnitt 3d: mit Variante kommen Skript und Yield aus ihr, shot_size folgt
    // dem Siebtyp. Ohne Variante wie bisher der Platz aus shotSize.
    const start = resolveStart(profile.variants ?? [], (id) => new SqliteBasketRepo().findById(id)?.type, { variantId, basketId, shotSize: requestedSize });
    if (!start.ok) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: start.error };
      return res;
    }
    const shotSize = start.shotSize;
    const scriptId = start.fromVariant
      ? start.scriptId
      : requestedSize === "single" ? profile.scriptIdSingle : profile.scriptIdDouble;
    if (!scriptId) {
      reply.status(400);
      const res: ApiResponse = {
        ok: false,
        error: start.fromVariant
          ? L("Diese Variante läuft in der App, nicht als Skript.", "This variant runs in the app, not as a script.")
          : L("Für dieses Profil ist kein 2×-Skript eingerichtet", "No double script configured for this profile"),
      };
      return res;
    }

    let armToken: number | null = null;
    try {
      // Pre-brew sync — fresh Cmd-27 detection before execution
      const script = await syncSingleScript(scriptId, client, scriptRepo);

      const profileYield = start.fromVariant
        ? start.yieldG
        : requestedSize === "single"
          ? profile.yieldTargetSingleG
          : profile.yieldTargetDoubleG;
      // Per-shot override wins over the profile default (recording + BbW stop).
      // Validation (Task 3): a target ≤ 0 or non-numeric is invalid and falls
      // back to the profile default (like an empty input) — never accepted as a
      // BBW target (a 0/negative target would otherwise fire the stop instantly).
      // No upper bound: large legitimate targets (e.g. 150 g) pass through.
      const overrideValid =
        typeof yieldTargetOverrideG === "number" &&
        Number.isFinite(yieldTargetOverrideG) &&
        yieldTargetOverrideG > 0;
      const yieldTarget = overrideValid ? yieldTargetOverrideG : profileYield;

      // Arm the recorder BEFORE sending the execute command to Xenia.
      // The recorder will start recording when the next MA_STATUS=3 frame arrives.
      // The pre-shot fields (Step 9) ride along in the armed state and are
      // written into the shot record once recording starts.
      armToken = recorder.armForExecute({
        profileId,
        variantId: start.variantId,
        basketId: start.basketId,
        profileName: profile.name ?? null,
        scriptId,
        shotSize,
        // Schnitt 3: Bezug oder Wartung sagt das Profil; das Skript nur, ob es
        // die Pumpe ansteuert (BBW-Schranke §4.12).
        category: profile.kind,
        hasPumpAction: hasPumpAction(parseScript(script.content)),
        hasCmd27: script.hasCmd27,
        cmd27Value: script.cmd27Value,
        yieldTargetG: yieldTarget ?? null,
        // Messlauf: aufgezeichnet, aber ohne Bohne/Muehle — er zaehlt nirgends.
        ...(profile.kind === "test"
          ? { beanId: null, beanLabel: null, grinderId: null, grindSetting: null, grinderRpm: null, doseG: null }
          : {
            beanId: beanId ?? null,
            beanLabel: beanLabel ?? null,
            grinderId: grinderId ?? null,
            grindSetting: grindSetting ?? null,
            grinderRpm: grinderRpm ?? null,
            doseG: doseG ?? null,
          }),
        notes: notes ?? null,
        // Freeze the token string just synced from the machine — the next sync
        // overwrites xenia_script.content, and this shot must keep pointing at
        // what it actually ran.
        scriptContent: script.content,
      });

      await client.executeScript(scriptId);

      // Persist active bean/grinder so the next pre-shot dialog can prefill
      // them. Written directly via the repo — these keys are intentionally
      // not in the PUT whitelist (not user-editable via the settings UI).
      // Only persist a real id: a null selection ("no bean" / "no grinder")
      // must NOT clear the stored active id — otherwise the convenience
      // prefill of the genuinely last-used bean/grinder would be lost.
      if (profile.kind !== "test" && beanId !== undefined && beanId !== null) {
        settingsRepo.set("active_bean_id", String(beanId));
      }
      if (profile.kind !== "test" && grinderId !== undefined && grinderId !== null) {
        settingsRepo.set("active_grinder_id", String(grinderId));
      }

      const bbwActive = settingsRepo.get("brew_by_weight_active") === "true";

      const stopMode: ExecuteResult["stopMode"] = script.hasCmd27
        ? "cmd27"
        : bbwActive && yieldTarget !== null
          ? "app"
          : "none";

      const result: ExecuteResult = {
        ok: true,
        scriptId,
        hasCmd27: script.hasCmd27,
        cmd27Value: script.cmd27Value,
        stopMode,
      };
      return result;
    } catch (err) {
      // The arm must not outlive the failed start: an external brew begun within
      // the 5s window would otherwise be recorded with this start's metadata.
      if (armToken !== null) recorder.disarmIfCurrent(armToken);
      reply.status(502);
      const msg = err instanceof XeniaError ? err.message : String(err);
      const res: ApiResponse = { ok: false, error: msg };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/scripts/orphaned — hard-delete all orphaned scripts that have
  // no referencing shots or profiles. Admin tool, not exposed in UI.
  // Must be before /:id so Fastify matches "orphaned" statically.
  // ---------------------------------------------------------------------------
  app.delete("/api/scripts/orphaned", async () => {
    return scriptRepo.deleteOrphaned();
  });

  // ---------------------------------------------------------------------------
  // Machine writes (SE-2) — POST /api/scripts, PUT/DELETE /api/scripts/:id.
  //
  // These write the machine's flash, not just our DB. They are refused while a
  // brew is running: the flash write is not a brew command, but rewriting the
  // script under a running execute has no defined behaviour on the ESP.
  // ---------------------------------------------------------------------------
  const brewActive = (): boolean => scriptWriteBlocked(recorder, getLastFrame());

  // POST /api/scripts — create a NEW script; the machine picks the slot, the
  // sync helper discovers it by diffing scripts/list. Returns the synced script.
  app.post("/api/scripts", async (req, reply) => {
    if (brewActive()) {
      reply.status(409);
      const res: ApiResponse = {
        ok: false,
        error: L("Es läuft ein Bezug — Skripte können erst danach geschrieben werden.", "A brew is running — scripts can only be written afterwards."),
      };
      return res;
    }
    const checked = checkWrite((req.body ?? {}) as WriteBody);
    if (!checked.ok) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: checked.error };
      return res;
    }
    try {
      return await createScriptOnMachine(
        client,
        scriptRepo,
        checked.title,
        checked.instruction,
      );
    } catch (err) {
      // 403 = no free slot on the machine; everything else is a transport fault.
      const status = err instanceof XeniaError && err.statusCode === 403 ? 507 : 502;
      reply.status(status);
      const res: ApiResponse = {
        ok: false,
        error:
          status === 507
            ? "Kein freier Skript-Platz auf der Maschine"
            : (err as Error).message,
      };
      return res;
    }
  });

  // PUT /api/scripts/:id — overwrite an existing slot in place (Edit=Enabled).
  app.put("/api/scripts/:id", async (req, reply) => {
    const numId = parseInt((req.params as { id: string }).id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: L("Ungültige Skript-ID", "Invalid script ID") };
      return res;
    }
    if (brewActive()) {
      reply.status(409);
      const res: ApiResponse = {
        ok: false,
        error: L("Es läuft ein Bezug — Skripte können erst danach geschrieben werden.", "A brew is running — scripts can only be written afterwards."),
      };
      return res;
    }
    const body = (req.body ?? {}) as WriteBody & { expectedContent?: unknown };
    const checked = checkWrite(body);
    if (!checked.ok) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: checked.error };
      return res;
    }
    // Nie blind ueberschreiben: der Stand, von dem aus bearbeitet wurde, muss mit.
    if (typeof body.expectedContent !== "string") {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: L("expectedContent fehlt", "expectedContent is missing") };
      return res;
    }
    try {
      return await overwriteScriptOnMachine(
        client, scriptRepo, numId, checked.title, checked.instruction, body.expectedContent,
      );
    } catch (err) {
      if (err instanceof ScriptConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, conflict: true, machineContent: err.machineContent };
      }
      reply.status(502);
      const res: ApiResponse = { ok: false, error: (err as Error).message };
      return res;
    }
  });

  // DELETE /api/scripts/:id — remove the script from the machine's flash.
  // The DB row survives and is marked orphaned by the following list sync, so
  // shots that reference it keep their provenance.
  app.delete("/api/scripts/:id", async (req, reply) => {
    const numId = parseInt((req.params as { id: string }).id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: L("Ungültige Skript-ID", "Invalid script ID") };
      return res;
    }
    if (brewActive()) {
      reply.status(409);
      const res: ApiResponse = {
        ok: false,
        error: L("Es läuft ein Bezug — Skripte können erst danach gelöscht werden.", "A brew is running — scripts can only be deleted afterwards."),
      };
      return res;
    }
    const users = profileRepo
      .listAll()
      .filter((p) => p.scriptIdSingle === numId || p.scriptIdDouble === numId || p.variants?.some((v) => v.scriptId === numId));
    if (users.length > 0) {
      reply.status(409);
      const res: ApiResponse = {
        ok: false,
        error: L(`Skript wird von Profil(en) benutzt: ${users.map((p) => p.name).join(", ")}`, `The script is used by profile(s): ${users.map((p) => p.name).join(", ")}`),
      };
      return res;
    }
    try {
      await client.scriptDelete(numId);
      await syncScriptList(client, scriptRepo);
      const res: ApiResponse = { ok: true };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = { ok: false, error: (err as Error).message };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/scripts/:id/category-override — set/clear the manual category (SE-2)
  // Writes ONLY the local app metadata column; never touches the machine script.
  // body: { override: 'brew' | 'maintenance' | null }   (null = back to auto)
  // ---------------------------------------------------------------------------
  app.post("/api/scripts/:id/category-override", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: L("Ungültige Skript-ID", "Invalid script ID") };
      return res;
    }
    const { override } = (req.body ?? {}) as { override?: unknown };
    if (override !== "brew" && override !== "maintenance" && override !== null) {
      reply.status(400);
      const res: ApiResponse = {
        ok: false,
        error: L("override muss 'brew', 'maintenance' oder leer sein", "override must be 'brew', 'maintenance' or null"),
      };
      return res;
    }
    if (!scriptRepo.findById(numId)) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: L(`Skript ${id} nicht gefunden`, `Script ${id} not found`) };
      return res;
    }
    scriptRepo.setCategoryOverride(numId, override);
    return scriptRepo.findById(numId);
  });

  // ---------------------------------------------------------------------------
  // POST /api/scripts/:id/sync — re-read ONE script's content from the machine
  // (SE-2b), so opening a script in the viewer always shows its current body
  // (e.g. after editing it in the Xenia web UI). Returns the fresh script.
  // ---------------------------------------------------------------------------
  app.post("/api/scripts/:id/sync", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: L("Ungültige Skript-ID", "Invalid script ID") };
      return res;
    }
    try {
      return await syncSingleScript(numId, client, scriptRepo);
    } catch (err) {
      reply.status(502);
      const msg = err instanceof XeniaError ? err.message : String(err);
      const res: ApiResponse = { ok: false, error: msg };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/scripts/:id — single script
  // ---------------------------------------------------------------------------
  app.get("/api/scripts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: L("Ungültige Skript-ID", "Invalid script ID") };
      return res;
    }
    const script = scriptRepo.findById(numId);
    if (!script) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: L(`Skript ${id} nicht gefunden`, `Script ${id} not found`) };
      return res;
    }
    return script;
  });
}
