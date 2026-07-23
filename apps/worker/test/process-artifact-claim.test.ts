import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sha256, type ScanResult } from "@evidence-loop/artifact-pipeline";
import { processArtifactClaim, type ArtifactClaim, type ClaimedArtifact } from "../src/artifact-handler.ts";

const bytes = Buffer.from("EICAR test bytes");
const claim: ArtifactClaim = { id: randomUUID(), organization_id: randomUUID(), aggregate_id: randomUUID(), attempt_count: 1 };
const artifact: ClaimedArtifact = { artifact_id: claim.aggregate_id, quarantine_key: "q/opaque", declared_extension: ".txt", declared_content_type: "text/plain", byte_size: bytes.length, digest: sha256(bytes), status: "uploaded" };
function dependencies(scan: ScanResult, parser: () => Promise<unknown> = async () => { throw new Error("unavailable"); }) {
  const terminals: unknown[] = [];
  let cleanWrites = 0;
  return {
    terminals,
    cleanWrites: () => cleanWrites,
    value: {
      store: { load: async () => artifact, terminal: async (_claim: ArtifactClaim, status: string, reason: string, event: string) => { terminals.push({ status, reason, event }); } },
      storage: { readQuarantine: async () => bytes, deleteQuarantine: async () => undefined, putQuarantine: async () => undefined, putClean: async () => { cleanWrites += 1; }, putDerived: async () => { cleanWrites += 1; } },
      scanner: { scan: async () => scan },
      parser: { parse: parser },
    },
  };
}
for (const [name, scan, expected] of [
  ["EICAR/infected", { verdict: "infected", reason: "malware_detected" } as ScanResult, { status: "rejected", reason: "malware_detected", event: "scan_rejected" }],
  ["scanner unavailable", { verdict: "blocked", reason: "scanner_unavailable" } as ScanResult, { status: "blocked", reason: "scanner_unavailable", event: "scan_blocked" }],
  ["scanner timeout", { verdict: "blocked", reason: "scanner_timeout" } as ScanResult, { status: "blocked", reason: "scanner_timeout", event: "scan_blocked" }],
  ["scanner error", { verdict: "blocked", reason: "scanner_error" } as ScanResult, { status: "blocked", reason: "scanner_error", event: "scan_blocked" }],
] as const) {
  test(`${name} never promotes or parses`, async () => {
    const fake = dependencies(scan);
    const result = await processArtifactClaim(claim, fake.value);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(fake.terminals, [expected]);
    assert.equal(fake.cleanWrites(), 0);
  });
}
test("a transient quarantine storage failure retries without a terminal artifact event", async () => {
  const fake = dependencies({ verdict: "clean" });
  fake.value.storage = { ...fake.value.storage, readQuarantine: async () => { throw new Error("storage_unavailable"); } };
  const result = await processArtifactClaim(claim, fake.value);
  assert.deepEqual(result, { ok: false, reason: "storage_unavailable" });
  assert.deepEqual(fake.terminals, []);
  assert.equal(fake.cleanWrites(), 0);
});

test("an absent quarantine object is a deterministic upload mismatch", async () => {
  const fake = dependencies({ verdict: "clean" });
  fake.value.storage = { ...fake.value.storage, readQuarantine: async () => { throw new Error("storage_absent"); } };
  const result = await processArtifactClaim(claim, fake.value);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fake.terminals, [{ status: "rejected", reason: "upload_mismatch", event: "scan_rejected" }]);
  assert.equal(fake.cleanWrites(), 0);
});

test("a thrown scanner failure is terminally blocked without retrying through a parsing path", async () => {
  const fake = dependencies({ verdict: "clean" });
  fake.value.scanner = { scan: async () => { throw new Error("raw scanner failure"); } };
  const result = await processArtifactClaim(claim, fake.value);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fake.terminals, [{ status: "blocked", reason: "scanner_error", event: "scan_blocked" }]);
  assert.equal(fake.cleanWrites(), 0);
});

test("clean scan blocks when parser is unavailable and duplicate terminal delivery stays inaccessible", async () => {
  const fake = dependencies({ verdict: "clean" });
  await processArtifactClaim(claim, fake.value);
  await processArtifactClaim(claim, fake.value);
  assert.deepEqual(fake.terminals, [
    { status: "blocked", reason: "parser_unavailable", event: "parse_blocked" },
    { status: "blocked", reason: "parser_unavailable", event: "parse_blocked" },
  ]);
  assert.equal(fake.cleanWrites(), 0);
});
