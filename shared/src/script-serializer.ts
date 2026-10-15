/**
 * Xenia script serializer — the inverse of parseScript() (script-parser.ts).
 *
 * Turns a ParsedScript back into the semicolon-separated token string the
 * Xenia machine stores and the `/api/v2/scripts/create` endpoint expects in its
 * `instruction` field (Knoedelauflauf API_DOCUMENTATION.md).
 *
 * Single responsibility: ParsedScript -> token string. Nothing else.
 * Pure function, no runtime imports (the type import below is erased).
 *
 * ---------------------------------------------------------------------------
 * Canonical form (deliberate decision — see docs/script-editor-discovery.md §3)
 * ---------------------------------------------------------------------------
 * Verified byte-for-byte against the live machine (FW 4.133) and the cached
 * `xenia_script` rows: every real script uses exactly this shape, so the
 * serializer emits it unconditionally —
 *
 *   - tokens joined by a single ";"
 *   - exactly one ASCII space between a Cmd id and each of its args
 *   - one trailing ";" after the final token
 *   - integers and floats rendered by JS String() (no zero-padding, no forced
 *     decimals): 9000 -> "9000", 2.5 -> "2.5"
 *
 * Because parseScript() is lossy (it trims whitespace, drops empty tokens and
 * a trailing ";", and coerces numeric args with Number()), a byte-exact
 * round-trip `serialize(parse(raw)) === raw` holds ONLY for input already in
 * this canonical form. All 14 of Flavio's real scripts are canonical, so they
 * round-trip exactly (proven in script-serializer.test.ts). Inputs that are
 * NOT canonical normalize on the way through — known, intentional cases:
 *   - "1;13;7;;;"        (extra trailing ";")      -> "1;13;7;"
 *   - "1;  13 ;3  70 ..."(irregular whitespace)    -> "1;13;3 70 ..."
 *   - "27 05" / "4 070"  (zero-padded args)        -> "27 5" / "4 70"
 *   - "5 2.50 8000"      (trailing-zero decimals)  -> "5 2.5 8000"
 * None of these appear in the live data; the machine's own canonical form is
 * what this serializer produces.
 */

import type { ParsedScript } from "./types.js";

/**
 * Serialize a ParsedScript into its canonical Xenia token string.
 *
 * Returns "" for an empty script (no commands) — the inverse of parseScript("")
 * which yields `{ commands: [] }`. A non-empty script always ends with ";".
 */
export function serializeScript(parsed: ParsedScript): string {
  if (!parsed || parsed.commands.length === 0) return "";

  const tokens = parsed.commands.map((c) =>
    [c.cmd, ...c.args].map((part) => String(part)).join(" "),
  );

  // Trailing ";" matches the machine's canonical form (see header).
  return tokens.join(";") + ";";
}
