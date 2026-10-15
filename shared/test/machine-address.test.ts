import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMachineAddress } from "../src/machine-address.js";

test("IPv4, Hostname und Port werden angenommen", () => {
  assert.equal(normalizeMachineAddress("192.168.1.100"), "192.168.1.100");
  assert.equal(normalizeMachineAddress("  10.0.0.7 "), "10.0.0.7");
  assert.equal(normalizeMachineAddress("Xenia.local"), "xenia.local");
  assert.equal(normalizeMachineAddress("localhost:3099"), "localhost:3099");
  assert.equal(normalizeMachineAddress("192.168.1.100:80"), "192.168.1.100:80");
});

test("Tippfehler und Fremdformate werden abgelehnt", () => {
  for (const bad of [
    "", "   ", "192.168.1.300", "192.168.1", "http://192.168.1.100", "192.168.1.100/api",
    "host:0", "host:70000", "host:", "a b", "-xenia", "xenia-", "192.168.1.100:abc",
  ]) {
    assert.equal(normalizeMachineAddress(bad), null, bad);
  }
});
