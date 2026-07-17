/**
 * Malware scanning boundary. Wire this to an isolated scanning service; never
 * run an uploaded file as part of scanning or normalization.
 */
export class MalwareScanner {
  async scan(_input) { throw new Error("Not implemented"); }
}

/** Explicit local-only scanner so tests cannot accidentally imply AV coverage. */
export class DevelopmentOnlyScanner extends MalwareScanner {
  async scan({ bytes }) {
    if (!Buffer.isBuffer(bytes)) throw new Error("Scanner received invalid bytes.");
    return { verdict: "clean", scanner: "development-noop", signatureVersion: "not-for-production" };
  }
}

export function assertCleanScan(result) {
  if (!result || !["clean", "infected", "error"].includes(result.verdict)) {
    throw new Error("Scanner returned an invalid verdict.");
  }
  return result.verdict === "clean";
}
