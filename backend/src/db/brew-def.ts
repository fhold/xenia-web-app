/**
 * Content-addressed brew definitions.
 *
 * A shot used to reference its brew definition indirectly: `script_id` for a
 * script shot, `profile_id` for a flow-hold one. Both targets are mutable —
 * `xenia_script.content` is overwritten by the next sync from the machine — so
 * editing a script silently rewrote what every past shot claims to have run.
 * Hashing the content and storing it once makes the reference immutable, and
 * makes "did these two shots run the same definition?" a hash comparison.
 *
 * The hash covers `kind` too, so a script token string and a step JSON can
 * never collide.
 *
 * Step JSON is hashed in canonical form (`canonicalBrewDef`): only what decides
 * the brew counts. The freetext phase names do not — renaming "Füllen" to
 * "Preinfusion" used to mint a new profile version and split the ghost cloud
 * (idea taken from decaid, 2026-09-26). Key order is sorted for the same
 * reason. The stored `content` is the canonical form; the shot keeps its own
 * named copy in `shot.brew_steps`.
 */

import { createHash } from "node:crypto";

export type BrewDefKind = "script" | "steps";

/** Stable short hash of a brew definition. */
export function brewDefHash(kind: BrewDefKind, content: string): string {
  return createHash("sha256").update(`${kind}\n${content}`).digest("hex").slice(0, 16);
}

/** Keys whose value does not change what the machine does. */
const NON_EXECUTING_STEP_KEYS = new Set(["name"]);

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
  );
}

/**
 * The part of a definition that decides the brew. Scripts pass through
 * unchanged; step JSON loses the phase names and gets sorted keys.
 */
export function canonicalBrewDef(kind: BrewDefKind, content: string): string {
  if (kind === "script") return content;
  const def = JSON.parse(content) as { steps?: Record<string, unknown>[] };
  if (Array.isArray(def.steps)) {
    def.steps = def.steps.map((step) =>
      Object.fromEntries(Object.entries(step).filter(([k]) => !NON_EXECUTING_STEP_KEYS.has(k))),
    );
  }
  return JSON.stringify(sortKeys(def));
}
