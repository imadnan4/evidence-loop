import { sha256, type ArtifactStorage } from "@evidence-loop/artifact-pipeline";

export type StaleUploadIntent = Readonly<{
  intent_id: string;
  quarantine_key: string;
  expected_byte_size: number;
  expected_sha256: string;
}>;

/** Reconciles only a worker-claimed server key; callers never provide a key. */
export async function reconcileStaleUploadIntent(
  intent: StaleUploadIntent,
  storage: ArtifactStorage,
  finish: (present: boolean, byteSize: number | null, digest: string | null) => Promise<void>,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await storage.readQuarantine(intent.quarantine_key);
  } catch (error) {
    // A transport/auth error leaves the lease to recover; only a definite 404
    // can expire a one-use intent.
    if (error instanceof Error && error.message === "storage_absent") await finish(false, null, null);
    return;
  }
  const digest = sha256(bytes);
  const matches = bytes.length === intent.expected_byte_size && digest === intent.expected_sha256;
  if (!matches) {
    try { await storage.deleteQuarantine(intent.quarantine_key); } catch { return; }
  }
  await finish(matches, bytes.length, digest);
}
