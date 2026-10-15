import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseScript,
  categorizeScript,
  extractWeightTargets,
  detectSafetyTimer,
  hasCmd27,
} from "../src/script-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): { id: number; title: string; content: string } {
  const path = resolve(__dirname, "fixtures", name);
  return JSON.parse(readFileSync(path, "utf8")) as { id: number; title: string; content: string };
}

// ---------------------------------------------------------------------------
// parseScript()
// ---------------------------------------------------------------------------

describe("parseScript()", () => {
  it("parses handoff 2.8 example script", () => {
    const result = parseScript("1;13;3 70 5000;27 45;17;7;");
    expect(result.commands).toHaveLength(6);
    expect(result.commands[0].cmd).toBe(1);
    expect(result.commands[0].meaning).toBe("Script start");
    expect(result.commands[2].cmd).toBe(3);
    expect(result.commands[2].args).toEqual([70, 5000]);
    expect(result.commands[2].meaning).toBe("Leistung Pumpe %");
    expect(result.commands[3].cmd).toBe(27);
    expect(result.commands[3].args).toEqual([45]);
    expect(result.commands[5].cmd).toBe(7);
    expect(result.unknownCmds).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("parses brew-multi-phase fixture (Cmd 4 + Cmd 3, no Cmd 27)", () => {
    const f = loadFixture("brew-multi-phase.json");
    const result = parseScript(f.content);
    expect(result.commands).toHaveLength(8);
    expect(result.commands[2].cmd).toBe(4);
    expect(result.commands[2].args).toEqual([9000, 3000]);
    expect(result.commands[4].cmd).toBe(3);
    expect(result.unknownCmds).toEqual([]);
  });

  it("parses brew-with-cmd27 fixture (Cmd 27 = 20g)", () => {
    const f = loadFixture("brew-with-cmd27.json");
    const result = parseScript(f.content);
    const cmd27 = result.commands.find((c) => c.cmd === 27);
    expect(cmd27).toBeDefined();
    expect(cmd27!.args[0]).toBe(20);
    expect(cmd27!.argLabels).toEqual(["grams"]);
  });

  it("parses brew-safety-timer fixture (short script, safety timer pattern)", () => {
    const f = loadFixture("brew-safety-timer.json");
    const result = parseScript(f.content);
    // 1;13;4 6000 2000;12 60000;7;  → 5 commands
    expect(result.commands).toHaveLength(5);
    expect(result.commands[3].cmd).toBe(12);
    expect(result.commands[3].args).toEqual([60000]);
    expect(result.commands[4].cmd).toBe(7);
  });

  it("handles trailing semicolons", () => {
    const result = parseScript("1;13;7;;;");
    expect(result.commands).toHaveLength(3);
  });

  it("handles missing trailing semicolon", () => {
    const result = parseScript("1;13;7");
    expect(result.commands).toHaveLength(3);
  });

  it("handles whitespace variations", () => {
    const result = parseScript("1;   13  ;  3  70  5000  ;  7 ;");
    expect(result.commands).toHaveLength(4);
    expect(result.commands[2].args).toEqual([70, 5000]);
  });

  it("handles float args (Cmd 5 rate)", () => {
    const result = parseScript("1;5 2.5 8000;7;");
    expect(result.commands[1].args).toEqual([2.5, 8000]);
  });

  it("collects unknown Cmd IDs without throwing", () => {
    const f = loadFixture("brew-unknown-cmd.json");
    const result = parseScript(f.content);
    expect(result.unknownCmds).toEqual([99]);
    const unknownCmd = result.commands.find((c) => c.cmd === 99);
    expect(unknownCmd?.meaning).toBe("UNKNOWN");
    expect(unknownCmd?.argLabels).toEqual([]);
    // Known commands still parsed correctly
    expect(result.commands.find((c) => c.cmd === 3)).toBeDefined();
  });

  it("deduplicates repeated unknown Cmd IDs", () => {
    const result = parseScript("1;99 1;99 2;7;");
    expect(result.unknownCmds).toEqual([99]);
  });

  it("returns error for empty string", () => {
    const result = parseScript("");
    expect(result.error).toBe("Empty or non-string content");
    expect(result.commands).toEqual([]);
  });

  it("returns error for non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = parseScript(null as any);
    expect(result.error).toBe("Empty or non-string content");
  });

  it("parses maintenance-backflush fixture (complex multi-phase, 6 cycles)", () => {
    const f = loadFixture("maintenance-backflush.json");
    const result = parseScript(f.content);
    expect(result.unknownCmds).toEqual([]);
    // Should have many commands — 6 cycles + signals + bookend
    expect(result.commands.length).toBeGreaterThan(20);
    // Last command is Cmd 7
    expect(result.commands[result.commands.length - 1].cmd).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// categorizeScript()
// ---------------------------------------------------------------------------

describe("categorizeScript()", () => {
  it("categorizes Spülen → maintenance (title keyword)", () => {
    const f = loadFixture("maintenance-spuelen.json");
    const parsed = parseScript(f.content);
    expect(categorizeScript(f.title, parsed)).toBe("maintenance");
  });

  it("categorizes 6xRückspülen → maintenance (title keyword)", () => {
    const f = loadFixture("maintenance-backflush.json");
    const parsed = parseScript(f.content);
    expect(categorizeScript(f.title, parsed)).toBe("maintenance");
  });

  it("categorizes Backflush → maintenance (case-insensitive)", () => {
    const parsed = parseScript("1;3 60 5000;7;");
    expect(categorizeScript("Backflush", parsed)).toBe("maintenance");
  });

  it("categorizes Rinse → maintenance", () => {
    const parsed = parseScript("1;3 60 5000;7;");
    expect(categorizeScript("Rinse", parsed)).toBe("maintenance");
  });

  it("categorizes brew by Cmd 4 → brew", () => {
    const f = loadFixture("brew-multi-phase.json");
    const parsed = parseScript(f.content);
    expect(categorizeScript(f.title, parsed)).toBe("brew");
  });

  it("categorizes brew by Cmd 3 → brew", () => {
    const parsed = parseScript("1;13;3 70 25000;17;7;");
    expect(categorizeScript("Turbo Shot", parsed)).toBe("brew");
  });

  it("title keyword overrides pump action (Spülen with Cmd 3 → maintenance)", () => {
    const parsed = parseScript("1;13;3 100 10000;14;17;7;");
    expect(categorizeScript("Spülen", parsed)).toBe("maintenance");
  });

  it("script without pump action → unknown", () => {
    const parsed = parseScript("1;12 1000;7;");
    expect(categorizeScript("Mystery", parsed)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// extractWeightTargets()
// ---------------------------------------------------------------------------

describe("extractWeightTargets()", () => {
  it("extracts single weight target from brew-with-cmd27 fixture", () => {
    const f = loadFixture("brew-with-cmd27.json");
    const parsed = parseScript(f.content);
    expect(extractWeightTargets(parsed)).toEqual([20]);
  });

  it("extracts multiple weight targets (pre-infusion + final)", () => {
    const parsed = parseScript("1;13;27 5;3 70 5000;27 36;17;7;");
    expect(extractWeightTargets(parsed)).toEqual([5, 36]);
  });

  it("returns empty array when no Cmd 27", () => {
    const f = loadFixture("brew-multi-phase.json");
    const parsed = parseScript(f.content);
    expect(extractWeightTargets(parsed)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectSafetyTimer()
// ---------------------------------------------------------------------------

describe("detectSafetyTimer()", () => {
  it("detects safety timer in brew-safety-timer fixture (60s timer)", () => {
    const f = loadFixture("brew-safety-timer.json");
    const parsed = parseScript(f.content);
    const st = detectSafetyTimer(parsed);
    expect(st).not.toBeNull();
    expect(st!.hasSafetyTimer).toBe(true);
    expect(st!.durationMs).toBe(60000);
  });

  it("does not flag short Cmd 12 as safety timer (<= 20s)", () => {
    const parsed = parseScript("1;13;3 70 25000;12 5000;7;");
    const st = detectSafetyTimer(parsed);
    expect(st).not.toBeNull();
    expect(st!.hasSafetyTimer).toBe(false);
    expect(st!.durationMs).toBe(5000);
  });

  it("returns null when last cmd is not 7", () => {
    const parsed = parseScript("1;13;3 70 25000;17;");
    expect(detectSafetyTimer(parsed)).toBeNull();
  });

  it("returns null when second-to-last is not Cmd 12 (e.g. Cmd 17 before Cmd 7)", () => {
    const f = loadFixture("brew-multi-phase.json");
    const parsed = parseScript(f.content);
    // ends with ...17;7; — second-to-last is Cmd 17, not Cmd 12
    expect(detectSafetyTimer(parsed)).toBeNull();
  });

  it("returns null on too-short script", () => {
    const parsed = parseScript("1;");
    expect(detectSafetyTimer(parsed)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasCmd27()
// ---------------------------------------------------------------------------

describe("hasCmd27()", () => {
  it("returns true for brew-with-cmd27 fixture", () => {
    const f = loadFixture("brew-with-cmd27.json");
    expect(hasCmd27(parseScript(f.content))).toBe(true);
  });

  it("returns false for brew-multi-phase fixture", () => {
    const f = loadFixture("brew-multi-phase.json");
    expect(hasCmd27(parseScript(f.content))).toBe(false);
  });
});
