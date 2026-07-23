import assert from "node:assert/strict";
import test from "node:test";
import { AuditMetadataError, fingerprintRequest, IdempotencyConflictError, validateAuditMetadata } from "../src/transactions.ts";

test("request fingerprints are stable, SHA-256 shaped, and independent of object member order", () => {
  const first = fingerprintRequest({ operation: "course.create", payload: { a: 1, b: [true, null] } });
  const reordered = fingerprintRequest({ payload: { b: [true, null], a: 1 }, operation: "course.create" });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, fingerprintRequest({ operation: "course.create", payload: { a: 2, b: [true, null] } }));
});

test("request fingerprints reject non-JSON and cyclic values", () => {
  assert.throws(() => fingerprintRequest({ invalid: Number.NaN }), /finite JSON numbers/);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => fingerprintRequest(cyclic), /cyclic values/);
});

test("idempotency conflict remains an explicit safe error", () => {
  assert.equal(new IdempotencyConflictError().name, "IdempotencyConflictError");
});

test("audit metadata permits only enumerated operational values and opaque IDs", () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(validateAuditMetadata({
    reason: "human_follow_up",
    source: "api",
    outcome: "queued",
    requestId,
    count: 2,
    attempt: 1,
    retryable: true,
  }), {
    reason: "human_follow_up",
    source: "api",
    outcome: "queued",
    requestId,
    count: 2,
    attempt: 1,
    retryable: true,
  });
});

test("audit metadata rejects free text, names, email addresses, secrets, URLs, and non-operational values", () => {
  const corpus: Array<[unknown, string]> = [
    [{ token: "not-allowed" }, "key-not-allowed"],
    [{ reason: "Maya Chen asked for a second attempt." }, "enum-value-not-allowed"],
    [{ source: "maya.chen@example.edu" }, "enum-value-not-allowed"],
    [{ outcome: "https://student-content.example.test/artifact" }, "enum-value-not-allowed"],
    [{ requestId: "Bearer secret-value" }, "invalid-opaque-id"],
    [{ requestId: "not-an-opaque-id" }, "invalid-opaque-id"],
    [{ reason: { transcript: "raw learner answer" } }, "enum-value-not-allowed"],
    [{ count: Number.NaN }, "invalid-operational-number"],
    [{ count: 1.5 }, "invalid-operational-number"],
    [{ retryable: "yes" }, "must-be-boolean"],
  ];
  for (const [metadata, code] of corpus) {
    assert.throws(() => validateAuditMetadata(metadata), (error: unknown) => error instanceof AuditMetadataError && error.code === code);
  }
});
