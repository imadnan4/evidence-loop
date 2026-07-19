import assert from "node:assert/strict";
import test from "node:test";
import { failClosedOutcome } from "../src/artifacts/handler.ts";

test("EICAR/infected scanner verdict never promotes", () => {
  assert.deepEqual(failClosedOutcome({ verdict: "infected", reason: "malware_detected" }, true), {
    status: "rejected", reason: "malware_detected", event: "scan_rejected", promote: false,
  });
});
test("unavailable, timeout, and malformed scanner outcomes stay blocked", () => {
  for (const reason of ["scanner_unavailable", "scanner_timeout", "scanner_invalid"] as const) {
    assert.deepEqual(failClosedOutcome({ verdict: "blocked", reason }, true), {
      status: "blocked", reason, event: "scan_blocked", promote: false,
    });
  }
});
test("a clean scan with unavailable parser stays blocked without promotion", () => {
  assert.deepEqual(failClosedOutcome({ verdict: "clean" }, false), {
    status: "blocked", reason: "parser_unavailable", event: "parse_blocked", promote: false,
  });
});
