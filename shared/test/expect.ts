/**
 * The handful of `expect` matchers the shared tests use, on top of node:assert.
 *
 * Two test files were written against vitest, which `shared/` cannot resolve —
 * it has no node_modules by project rule, and the backend does not depend on
 * vitest. They therefore ran nowhere and could rot unnoticed. Everything else in
 * this repo runs on node:test, so the runner stays node:test and only the
 * assertion vocabulary is bridged here — no second runner, no new dependency.
 */

import assert from "node:assert/strict";

export interface Expectation<T> {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toHaveLength(length: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  /** Only the negations the shared tests actually use. */
  not: { toBeNull(): void };
}

export function expect<T>(actual: T): Expectation<T> {
  const num = () => {
    assert.equal(typeof actual, "number", `expected a number, got ${typeof actual}`);
    return actual as number;
  };
  return {
    toBe: (expected) => { assert.strictEqual(actual, expected); },
    toEqual: (expected) => { assert.deepStrictEqual(actual, expected); },
    toBeNull: () => { assert.strictEqual(actual, null); },
    toBeDefined: () => { assert.notStrictEqual(actual, undefined); },
    toBeUndefined: () => { assert.strictEqual(actual, undefined); },
    // vitest semantics: equal to `digits` decimal places (default 2).
    toBeCloseTo: (expected, digits = 2) => {
      const diff = Math.abs(num() - expected);
      assert.ok(diff < Math.pow(10, -digits) / 2, `${actual} not close to ${expected} (${digits} digits)`);
    },
    toHaveLength: (length) => {
      assert.strictEqual((actual as { length?: number } | null)?.length, length);
    },
    toBeGreaterThan: (expected) => {
      assert.ok(num() > expected, `${actual} is not > ${expected}`);
    },
    toBeGreaterThanOrEqual: (expected) => {
      assert.ok(num() >= expected, `${actual} is not >= ${expected}`);
    },
    toBeLessThan: (expected) => {
      assert.ok(num() < expected, `${actual} is not < ${expected}`);
    },
    not: {
      toBeNull: () => { assert.notStrictEqual(actual, null); },
    },
  };
}
