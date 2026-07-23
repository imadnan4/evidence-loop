import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactNormalizationJob,
  ArtifactPolicyError,
  ArtifactService,
  DevelopmentOnlyScanner,
  InMemoryArtifactRepository,
  InMemoryPrivateObjectStorage,
  MvpParserSandbox,
} from "../src/artifacts/index.js";

function setup({ scanner = new DevelopmentOnlyScanner(), parserSandbox = new MvpParserSandbox() } = {}) {
  const repository = new InMemoryArtifactRepository();
  const storage = new InMemoryPrivateObjectStorage();
  const authorizer = { authorize: async ({ actorId, submissionId }) => actorId === "learner-1" && submissionId === "submission-1" };
  return {
    repository,
    storage,
    service: new ArtifactService({ repository, storage, authorizer, clock: () => Date.parse("2026-07-18T12:00:00Z") }),
    job: new ArtifactNormalizationJob({ repository, storage, scanner, parserSandbox }),
  };
}

async function uploadPython(system, source = "import os\n# this is untrusted data\nprint('never run')\n") {
  const bytes = Buffer.from(source);
  const intent = await system.service.createPrivateUploadIntent({
    actorId: "learner-1", submissionId: "submission-1", fileName: "analysis.py", contentType: "text/x-python", byteSize: bytes.length,
  });
  assert.equal("storageKey" in intent, false);
  assert.equal("readUrl" in intent, false);
  return system.service.acceptPrivateUpload({ actorId: "learner-1", uploadToken: intent.uploadToken, bytes });
}

test("private upload normalizes Python into immutable stable line citations without executing it", async () => {
  const system = setup();
  const uploaded = await uploadPython(system);
  const result = await system.job.run({ artifactId: uploaded.artifactId });
  assert.deepEqual(result.status, "ready");

  const artifact = await system.service.getArtifactForSubmission({ actorId: "learner-1", submissionId: "submission-1", artifactId: uploaded.artifactId });
  assert.equal(artifact.status, "ready");
  assert.match(artifact.checksum, /^[a-f0-9]{64}$/);
  assert.equal("storageKey" in artifact, false);
  const internalArtifact = await system.repository.getArtifact(uploaded.artifactId);
  assert.equal(system.storage.has(internalArtifact.storageKey), true);

  const fragments = await system.repository.listFragments(uploaded.artifactId);
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].locator, "lines:1-4");
  assert.equal(fragments[0].content.includes("never run"), true);
  assert.match(fragments[0].id, /^fragment_[a-f0-9]{24}$/);
  await assert.rejects(() => system.repository.insertFragments(uploaded.artifactId, []), /immutable/);
});

test("upload capabilities are one-use and bound to the authorized learner", async () => {
  const system = setup();
  const bytes = Buffer.from("x = 1\n");
  const intent = await system.service.createPrivateUploadIntent({
    actorId: "learner-1", submissionId: "submission-1", fileName: "x.py", contentType: "text/x-python", byteSize: bytes.length,
  });
  await assert.rejects(
    () => system.service.acceptPrivateUpload({ actorId: "learner-2", uploadToken: intent.uploadToken, bytes }),
    (error) => error instanceof ArtifactPolicyError && error.code === "upload_intent_forbidden",
  );
  await system.service.acceptPrivateUpload({ actorId: "learner-1", uploadToken: intent.uploadToken, bytes });
  await assert.rejects(
    () => system.service.acceptPrivateUpload({ actorId: "learner-1", uploadToken: intent.uploadToken, bytes }),
    (error) => error instanceof ArtifactPolicyError && error.code === "upload_intent_invalid",
  );
});

test("notebooks cite cells and ignore executable outputs", async () => {
  const system = setup();
  const notebook = Buffer.from(JSON.stringify({ cells: [{ cell_type: "code", source: ["answer = 42\n"], outputs: [{ text: "do not cite output" }] }] }));
  const intent = await system.service.createPrivateUploadIntent({
    actorId: "learner-1", submissionId: "submission-1", fileName: "work.ipynb", contentType: "application/x-ipynb+json", byteSize: notebook.length,
  });
  const uploaded = await system.service.acceptPrivateUpload({ actorId: "learner-1", uploadToken: intent.uploadToken, bytes: notebook });
  await system.job.run({ artifactId: uploaded.artifactId });
  const [cell] = await system.repository.listFragments(uploaded.artifactId);
  assert.match(cell.locator, /^cell:cell-1-/);
  assert.equal(cell.content, "answer = 42\n");
  assert.equal(cell.content.includes("do not cite output"), false);
});

test("CSV citations preserve logical records and their source line range", async () => {
  const system = setup();
  const csv = Buffer.from("feature,target\n1,\"two\nlines\"\n3,4\n");
  const intent = await system.service.createPrivateUploadIntent({
    actorId: "learner-1", submissionId: "submission-1", fileName: "sample.csv", contentType: "text/csv", byteSize: csv.length,
  });
  const uploaded = await system.service.acceptPrivateUpload({ actorId: "learner-1", uploadToken: intent.uploadToken, bytes: csv });
  await system.job.run({ artifactId: uploaded.artifactId });
  const [fragment] = await system.repository.listFragments(uploaded.artifactId);
  assert.equal(fragment.locator, "lines:1-4");
  assert.match(fragment.content, /\"two\nlines\"/);
});

test("PDF page citations are created only through an injected sandboxed extractor", async () => {
  const parserSandbox = new MvpParserSandbox({ pdfPageExtractor: { extractPages: async () => ["First page", "Second page"] } });
  const system = setup({ parserSandbox });
  const bytes = Buffer.from("%PDF-1.7\nsynthetic");
  const intent = await system.service.createPrivateUploadIntent({
    actorId: "learner-1", submissionId: "submission-1", fileName: "report.pdf", contentType: "application/pdf", byteSize: bytes.length,
  });
  const uploaded = await system.service.acceptPrivateUpload({ actorId: "learner-1", uploadToken: intent.uploadToken, bytes });
  assert.equal((await system.job.run({ artifactId: uploaded.artifactId })).status, "ready");
  assert.deepEqual((await system.repository.listFragments(uploaded.artifactId)).map((fragment) => fragment.locator), ["page:1", "page:2"]);
});

test("PDF normalization rejects more than the configured citation-fragment limit", async () => {
  const parserSandbox = new MvpParserSandbox({
    pdfPageExtractor: { extractPages: async () => Array.from({ length: 2_001 }, () => "synthetic page") },
  });
  await assert.rejects(
    () => parserSandbox.normalize({ artifact: { id: "artifact-pdf-limit", extension: ".pdf" }, bytes: Buffer.from("%PDF-1.7") }),
    (error) => error instanceof ArtifactPolicyError && error.code === "too_many_fragments",
  );
});

test("an infected upload is rejected and its private original is removed before parsing", async () => {
  const scanner = { scan: async () => ({ verdict: "infected", scanner: "test-av", signatureVersion: "1" }) };
  const system = setup({ scanner });
  const uploaded = await uploadPython(system);
  assert.deepEqual(await system.job.run({ artifactId: uploaded.artifactId }), { artifactId: uploaded.artifactId, status: "rejected" });
  const artifact = await system.repository.getArtifact(uploaded.artifactId);
  assert.equal(system.storage.has(artifact.storageKey), false);
  assert.equal((await system.repository.listFragments(uploaded.artifactId)).length, 0);
});
