import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { reconcileStaleUploadIntent } from "../src/reconciliation.ts";

const bytes = Buffer.from("expected", "utf8");
const intent = { intent_id: "opaque-intent", quarantine_key: "q/opaque/server-key", expected_byte_size: bytes.length, expected_sha256: createHash("sha256").update(bytes).digest("hex") };
function storage(value: Buffer | Error) {
  let deletes = 0;
  return {
    readQuarantine: async () => { if (value instanceof Error) throw value; return value; },
    deleteQuarantine: async () => { deletes += 1; },
    putQuarantine: async () => undefined,
    putClean: async () => undefined,
    putDerived: async () => undefined,
    deletes: () => deletes,
  };
}

test("matching expired server-key bytes are safely queued for recovery", async () => {
  const object = storage(bytes); const finishes: unknown[][] = [];
  await reconcileStaleUploadIntent(intent, object, async (...args) => { finishes.push(args); });
  assert.deepEqual(finishes, [[true, bytes.length, intent.expected_sha256]]);
  assert.equal(object.deletes(), 0);
});
test("missing or mismatched quarantine bytes expire instead of attaching arbitrary data", async () => {
  const absent = storage(new Error("storage_absent")); const absentFinishes: unknown[][] = [];
  await reconcileStaleUploadIntent(intent, absent, async (...args) => { absentFinishes.push(args); });
  assert.deepEqual(absentFinishes, [[false, null, null]]);
  const mismatch = storage(Buffer.from("other")); const mismatchFinishes: unknown[][] = [];
  await reconcileStaleUploadIntent(intent, mismatch, async (...args) => { mismatchFinishes.push(args); });
  assert.equal(mismatchFinishes[0]?.[0], false);
  assert.equal(mismatch.deletes(), 1);
});
test("storage failures retain the lease for a later safe retry", async () => {
  const unavailable = storage(new Error("storage_unavailable")); let finished = false;
  await reconcileStaleUploadIntent(intent, unavailable, async () => { finished = true; });
  assert.equal(finished, false);
});
