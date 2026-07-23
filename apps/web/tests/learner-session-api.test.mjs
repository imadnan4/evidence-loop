import assert from "node:assert/strict";
import test from "node:test";

import { F04aSessionApi, SessionApiError } from "../public/demo/assets/learner-session-api.js";

function response(body, options = {}) {
  return new Response(JSON.stringify(body), { status: options.status ?? 200, headers: { "Content-Type": "application/json" } });
}

test("F04a browser client sends only session operation inputs to the BFF", async () => {
  const requests = [];
  const client = new F04aSessionApi(async (path, options) => {
    requests.push({ path, options });
    return response({ contract_version: "v1", request_id: "request-1", data: { ok: true } });
  });
  const input = { sessionId: "session-1", policyVersionId: "policy-1", mode: "text", idempotencyKey: "key-1" };
  assert.deepEqual(await client.showPolicy({ sessionId: "session-1", idempotencyKey: "key-0" }), { ok: true });
  assert.deepEqual(await client.acknowledgePolicy({ sessionId: "session-1", policyVersionId: "policy-1", idempotencyKey: "key-a" }), { ok: true });
  assert.deepEqual(await client.start(input), { ok: true });
  assert.deepEqual(await client.submitTextResponse({ sessionId: "session-1", questionId: "question-1", canonicalText: "My response", editedText: null, idempotencyKey: "key-b" }), { ok: true });
  assert.deepEqual(await client.pause({ sessionId: "session-1", idempotencyKey: "key-c" }), { ok: true });
  assert.deepEqual(await client.resume({ sessionId: "session-1", idempotencyKey: "key-d" }), { ok: true });
  assert.deepEqual(await client.requestHumanFollowUp({ sessionId: "session-1", idempotencyKey: "key-e" }), { ok: true });
  assert.deepEqual(await client.getReceipt("session-1"), { ok: true });

  assert.deepEqual(requests.map(({ path }) => path), [
    "/check-ins/session-1/policy-shown",
    "/check-ins/session-1/policy-acknowledgements",
    "/check-ins/session-1/start",
    "/check-ins/session-1/answers",
    "/check-ins/session-1/pause",
    "/check-ins/session-1/resume",
    "/check-ins/session-1/human-follow-up",
    "/check-ins/session-1/receipt",
  ]);
  assert.equal(requests[2].options.headers["Idempotency-Key"], "key-1");
  assert.deepEqual(JSON.parse(requests[2].options.body), input);
  assert.equal(requests[7].options.method, "GET");
});

test("F04a browser client exposes safe API errors and rejects unexpected payloads", async () => {
  const forbidden = new F04aSessionApi(async () => response({ contract_version: "v1", request_id: "request-1", error: { code: "forbidden", message: "Not authorized", field_issues: null } }, { status: 403 }));
  await assert.rejects(() => forbidden.getReceipt("session-1"), (error) => error instanceof SessionApiError && error.code === "forbidden" && error.status === 403);

  const malformed = new F04aSessionApi(async () => response({ session: {} }));
  await assert.rejects(() => malformed.getReceipt("session-1"), (error) => error instanceof SessionApiError && error.code === "invalid_response");
});
