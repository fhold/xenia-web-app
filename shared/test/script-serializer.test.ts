/**
 * Round-trip proof for serializeScript() — our side of the lossless round-trip
 * (SE-1 Discovery Q3). Uses Node's built-in test runner (`node --test`), no
 * external dependency. Run from the shared/ dir:
 *
 *   node --test test/script-serializer.test.ts
 *
 * The fixtures are the raw `content` strings of all 14 scripts, captured
 * byte-for-byte from the live machine (FW 4.133, POST /api/v2/scripts/read) and
 * identical to the cached xenia_script rows. They are the canonical form, so
 * serialize(parse(raw)) === raw must hold byte-exactly for every one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScript } from "../src/script-parser.ts";
import { serializeScript } from "../src/script-serializer.ts";

// --- Live/cached fixtures: { id, raw } captured from a real machine -----------
const LIVE_SCRIPTS: { id: number; raw: string }[] = [
  { id: 10, raw: "1;13;4 9000 3000;12 6000;3 20 35000;12 60000;17;7;" },
  { id: 11, raw: "1;12 1000;13;4 2000 10000;27 20;17;7;" },
  { id: 12, raw: "1;25 80;9 0;8 0;13;4 9000 5000;12 45000;17;7;" },
  { id: 13, raw: "1;13;4 6000 2000;12 60000;7;" },
  { id: 14, raw: "1;25 93;13;4 2500 13000;4 6500 8000;4 5000 12000;4 4000 30000;31;12 60000;17;7;" },
  { id: 15, raw: "1;13;3 100 10000;12 12000;14;17;7;" },
  { id: 16, raw: "1;13;4 6000 5000;12 40000;17;7;" },
  { id: 17, raw: "1;13;4 700 20000;12 60000;7;" },
  { id: 18, raw: "1;13;4 6000 3000;12 9000;6;12 30000;4 8000 3000;12 35000;17;7;" },
  { id: 19, raw: "1;13;4 1100 1000;12 15000;4 9000 2000;12 5000;4 4000 45000;12 60000;17;7;" },
  { id: 20, raw: "1;13;4 9000 1000;12 60000;17;7;" },
  { id: 25, raw: "1;13;4 400 15000;12 15000;6;12 30000;7;" },
  { id: 26, raw: "1;13;4 9000 1000;12 20000;6;15;12 20000;16;4 9000 1000;12 15000;6;15;12 20000;16;4 9000 1000;12 15000;6;15;12 20000;16;4 9000 1000;12 15000;6;15;12 20000;16;4 9000 1000;12 20000;6;15;12 20000;16;4 9000 1000;12 20000;17;20 1 1000;20 1 1000;7;" },
  { id: 28, raw: "1;13;4 3000 1000;12 20000;4 9000 2000;12 10000;4 4000 45000;12 60000;17;7;" },
];

/** First differing byte offset, or -1 if equal. */
function firstDiff(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

test("round-trip: serialize(parse(raw)) === raw for all live scripts", () => {
  const lines: string[] = [];
  const failures: string[] = [];

  for (const { id, raw } of LIVE_SCRIPTS) {
    const out = serializeScript(parseScript(raw));
    if (out === raw) {
      lines.push(`  PASS  #${id}  (${raw.length} bytes)`);
    } else {
      const at = firstDiff(raw, out);
      const detail =
        `  DIFF  #${id}  at byte ${at}\n` +
        `        raw: ${JSON.stringify(raw)}\n` +
        `        got: ${JSON.stringify(out)}`;
      lines.push(detail);
      failures.push(detail);
    }
  }

  // Round-trip diff report — visible in `node --test` output.
  console.log(
    `\n--- Round-trip report (${LIVE_SCRIPTS.length} live scripts) ---\n` +
      lines.join("\n") +
      `\n--- ${LIVE_SCRIPTS.length - failures.length}/${LIVE_SCRIPTS.length} PASS ---\n`,
  );

  assert.equal(failures.length, 0, `${failures.length} script(s) failed round-trip`);
});

// ---------------------------------------------------------------------------
// Deliberate normalization (parseScript is lossy) — these document, with
// executable assertions, the cases where serialize(parse(x)) !== x by design.
// See script-serializer.ts header + discovery report §3.
// ---------------------------------------------------------------------------

test("normalizes extra trailing semicolons to one", () => {
  assert.equal(serializeScript(parseScript("1;13;7;;;")), "1;13;7;");
});

test("normalizes irregular whitespace to single spaces", () => {
  assert.equal(
    serializeScript(parseScript("1;   13  ;  3  70  5000  ;  7 ;")),
    "1;13;3 70 5000;7;",
  );
});

test("normalizes zero-padded args (Number coercion in parser)", () => {
  assert.equal(serializeScript(parseScript("1;27 05;4 070 100;7;")), "1;27 5;4 70 100;7;");
});

test("normalizes trailing-zero decimals", () => {
  assert.equal(serializeScript(parseScript("1;5 2.50 8000;7;")), "1;5 2.5 8000;7;");
});

test("empty script serializes to empty string", () => {
  assert.equal(serializeScript(parseScript("")), "");
});

test("missing trailing semicolon in input is canonicalized", () => {
  // parser accepts "1;13;7" (no trailing ;); serializer always emits one.
  assert.equal(serializeScript(parseScript("1;13;7")), "1;13;7;");
});
