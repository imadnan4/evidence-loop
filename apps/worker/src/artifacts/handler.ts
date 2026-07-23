import type { ScanResult } from "@evidence-loop/artifact-pipeline";

export type TerminalArtifactOutcome = Readonly<{
  status: "rejected" | "blocked";
  reason: "malware_detected" | "scanner_unavailable" | "scanner_timeout" | "scanner_error" | "scanner_invalid" | "parser_unavailable" | "parser_timeout" | "parser_error";
  event: "scan_rejected" | "scan_blocked" | "parse_blocked";
  promote: false;
}>;

/** Maps only terminal fail-closed worker outcomes. No branch can promote data. */
export function failClosedOutcome(scan: ScanResult, parserAvailable: boolean): TerminalArtifactOutcome | null {
  if (scan.verdict === "infected") return { status: "rejected", reason: "malware_detected", event: "scan_rejected", promote: false };
  if (scan.verdict !== "clean") {
    const reason = scan.reason === "scanner_timeout" || scan.reason === "scanner_error" || scan.reason === "scanner_invalid"
      ? scan.reason
      : "scanner_unavailable";
    return { status: "blocked", reason, event: "scan_blocked", promote: false };
  }
  if (!parserAvailable) return { status: "blocked", reason: "parser_unavailable", event: "parse_blocked", promote: false };
  return null;
}
