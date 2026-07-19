import { sha256, validateBytes, type ArtifactStorage, type ScanResult } from "@evidence-loop/artifact-pipeline";

export type ArtifactClaim = Readonly<{ id: string; organization_id: string; aggregate_id: string; attempt_count: number }>;
export type ClaimedArtifact = Readonly<{ artifact_id: string; quarantine_key: string; declared_extension: string; declared_content_type: string; byte_size: number; digest: string; status: string }>;
export type TerminalStatus = "rejected" | "blocked" | "failed";
export type TerminalEvent = "scan_rejected" | "scan_blocked" | "parse_blocked" | "parse_failed";
export type ClaimStore = Readonly<{
  load(claim: ArtifactClaim): Promise<ClaimedArtifact | undefined>;
  terminal(claim: ArtifactClaim, status: TerminalStatus, reason: string, event: TerminalEvent): Promise<void>;
}>;
type Scanner = Readonly<{ scan(bytes: Buffer): Promise<ScanResult> }>;
type Parser = Readonly<{ parse(): Promise<unknown> }>;

/**
 * Processes only a worker-held claim. A clean scan still ends blocked until a
 * separately approved isolated parser is provided; this function cannot write
 * clean/derived objects or fragments.
 */
export async function processArtifactClaim(
  claim: ArtifactClaim,
  dependencies: Readonly<{ store: ClaimStore; storage: ArtifactStorage; scanner: Scanner; parser: Parser }>,
): Promise<Readonly<{ ok: boolean; reason?: string }>> {
  try {
    const artifact = await dependencies.store.load(claim);
    if (!artifact || ["ready", "rejected", "blocked", "deleted"].includes(artifact.status)) return { ok: true };
    let bytes: Buffer;
    try {
      bytes = await dependencies.storage.readQuarantine(artifact.quarantine_key);
    } catch (error) {
      if (error instanceof Error && error.message === "storage_absent") {
        await dependencies.store.terminal(claim, "rejected", "upload_mismatch", "scan_rejected");
        return { ok: true };
      }
      return { ok: false, reason: "storage_unavailable" };
    }
    try {
      validateBytes(artifact.declared_extension, bytes);
      if (bytes.length !== artifact.byte_size || sha256(bytes) !== artifact.digest) throw new Error("upload_mismatch");
    } catch {
      await dependencies.store.terminal(claim, "rejected", "upload_mismatch", "scan_rejected");
      return { ok: true };
    }
    let scan: ScanResult;
    try {
      scan = await dependencies.scanner.scan(bytes);
    } catch {
      await dependencies.store.terminal(claim, "blocked", "scanner_error", "scan_blocked");
      return { ok: true };
    }
    if (scan.verdict === "infected") {
      await dependencies.store.terminal(claim, "rejected", "malware_detected", "scan_rejected");
      return { ok: true };
    }
    if (scan.verdict !== "clean") {
      await dependencies.store.terminal(claim, "blocked", scan.reason ?? "scanner_unavailable", "scan_blocked");
      return { ok: true };
    }
    try {
      await dependencies.parser.parse();
    } catch {
      await dependencies.store.terminal(claim, "blocked", "parser_unavailable", "parse_blocked");
      return { ok: true };
    }
    // There is intentionally no positive path until the parser sandbox is approved.
    await dependencies.store.terminal(claim, "blocked", "parser_unavailable", "parse_blocked");
    return { ok: true };
  } catch {
    return { ok: false, reason: "worker_error" };
  }
}
