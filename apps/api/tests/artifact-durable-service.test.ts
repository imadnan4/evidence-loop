import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DurableArtifactService, ArtifactHttpError } from "../src/artifacts/durable-service.ts";

const organizationId = randomUUID();
const ownerId = randomUUID();
const otherLearnerId = randomUUID();
const staffId = randomUUID();
const submissionId = randomUUID();
const artifactId = randomUUID();
const courseId = randomUUID();

function fakeClient(role: "learner" | "instructor", actorId: string) {
  const transaction: any = async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("set_config")) return [];
    if (query.includes("FROM submissions s JOIN course_memberships m")) {
      return [{ id: submissionId, course_id: courseId, learner_id: ownerId, state: "uploading" }];
    }
    if (query.includes("SELECT role FROM course_memberships")) return [{ role }];
    if (query.includes("SELECT id,status,failure_code,created_at,updated_at FROM artifacts")) {
      return [{ id: artifactId, status: "blocked", failure_code: "scanner_unavailable", created_at: new Date(0), updated_at: new Date(0) }];
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  transaction.begin = async (work: (tx: any) => Promise<unknown>) => work(transaction);
  return transaction;
}

const storage = { putQuarantine: async () => undefined, readQuarantine: async () => Buffer.alloc(0), deleteQuarantine: async () => undefined, putClean: async () => undefined, putDerived: async () => undefined };
function principal(userId: string) { return { organizationId, userId, subject: "synthetic", correlationId: randomUUID() }; }

test("a same-course learner cannot observe another learner's artifact status", async () => {
  const service = new DurableArtifactService(fakeClient("learner", otherLearnerId), storage, "synthetic-test-secret");
  await assert.rejects(
    () => service.status(principal(otherLearnerId), submissionId, artifactId),
    (error: unknown) => error instanceof ArtifactHttpError && error.statusCode === 404 && error.code === "not_found",
  );
});

test("scoped staff receives only safe blocked status metadata", async () => {
  const service = new DurableArtifactService(fakeClient("instructor", staffId), storage, "synthetic-test-secret");
  const result = await service.status(principal(staffId), submissionId, artifactId);
  assert.deepEqual(result, {
    artifact_id: artifactId,
    status: "blocked",
    reason_code: "scanner_unavailable",
  });
  assert.ok(!("quarantine_key" in result) && !("clean_key" in result) && !("derived_key" in result));
});
