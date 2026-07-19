import { randomUUID } from "node:crypto";
import { createDatabase } from "@evidence-loop/db";
import { ClamAvSocketScanner, PrivateS3Storage, UnavailableScanner, UnavailableParser } from "@evidence-loop/artifact-pipeline";
import { processArtifactClaim, type ArtifactClaim } from "./artifact-handler.ts";
import { reconcileStaleUploadIntent, type StaleUploadIntent } from "./reconciliation.ts";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name}: required`); return value; };
const { client } = createDatabase(required("DATABASE_URL"));
const storage = new PrivateS3Storage({ endpoint: new URL(required("S3_ENDPOINT")), region: required("S3_REGION"), accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY"), buckets: { quarantine: required("S3_BUCKET_QUARANTINE"), clean: required("S3_BUCKET_CLEAN"), derived: required("S3_BUCKET_DERIVED") } });
const clamdSocket = process.env.CLAMD_SOCKET;
const clamdSignatureDirectory = process.env.CLAMD_SIGNATURE_DIRECTORY;
const clamdMaxSignatureAgeSeconds = Number(process.env.CLAMD_MAX_SIGNATURE_AGE_SECONDS ?? "86400");
const scanner = clamdSocket && clamdSignatureDirectory && Number.isSafeInteger(clamdMaxSignatureAgeSeconds)
  ? new ClamAvSocketScanner({ socketPath: clamdSocket, signatureDirectory: clamdSignatureDirectory, maxSignatureAgeMs: clamdMaxSignatureAgeSeconds * 1000 })
  : new UnavailableScanner();
const parser = new UnavailableParser(); // No parser exists until an approved isolated sandbox is deployed.
const workerName = `artifact-${randomUUID()}`;

async function processClaim(claim: ArtifactClaim) {
  return processArtifactClaim(claim, {
    storage,
    scanner,
    parser,
    store: {
      async load(heldClaim) {
        const rows = await client<{ artifact_id: string; quarantine_key: string; declared_extension: string; declared_content_type: string; byte_size: number; digest: string; status: string }[]>`SELECT * FROM load_claimed_artifact(${heldClaim.id},${workerName})`;
        return rows[0];
      },
      async terminal(heldClaim, status, reason, event) {
        await client`SELECT terminal_claimed_artifact(${heldClaim.id},${workerName},${status},${reason},${event})`;
      },
    },
  });
}
async function reconcileExpiredUploadIntents() {
  const intents = await client<(StaleUploadIntent & { artifact_id: string })[]>`SELECT * FROM claim_stale_artifact_upload_intents(${workerName},60)`;
  for (const intent of intents) {
    await reconcileStaleUploadIntent(intent, storage, async (present, byteSize, digest) => {
      await client`SELECT finish_stale_artifact_upload_intent(${intent.intent_id},${workerName},${present},${byteSize},${digest})`;
    });
  }
}

async function poll() {
  await reconcileExpiredUploadIntents();
  const claims = await client<ArtifactClaim[]>`SELECT * FROM claim_artifact_outbox(${workerName},60)`;
  for (const claim of claims) {
    const result = await processClaim(claim);
    await client`SELECT finish_artifact_outbox(${claim.id},${workerName},${result.ok},${result.reason ?? null})`;
  }
}
setInterval(() => { void poll().catch(() => undefined); }, 1000).unref();
await poll();
process.on("SIGTERM", async () => { await client.end({ timeout: 5 }); process.exit(0); });
process.on("SIGINT", async () => { await client.end({ timeout: 5 }); process.exit(0); });
