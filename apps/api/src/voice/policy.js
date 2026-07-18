/** Voice is optional transport; only a text transcript is retained. */
export const VOICE_POLICY = Object.freeze({
  credentialTtlMs: 5 * 60 * 1_000,
  maxCredentialTtlMs: 10 * 60 * 1_000,
  maxTranscriptCharacters: 20_000,
});

export const VOICE_FALLBACK_REASONS = Object.freeze([
  "realtime_unavailable", "connection_failed", "microphone_unavailable", "credential_expired",
]);

export class VoicePolicyError extends Error {
  constructor(message, code = "voice_policy_violation") {
    super(message);
    this.name = "VoicePolicyError";
    this.code = code;
  }
}

export function assertTranscript(text, field = "transcript") {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new VoicePolicyError(`A ${field} is required before submitting.`, "transcript_required");
  }
  if (text.length > VOICE_POLICY.maxTranscriptCharacters) {
    throw new VoicePolicyError("This transcript is too long for one response. Continue using the text route.", "transcript_too_long");
  }
  return text;
}

export function assertFallbackReason(reason) {
  if (!VOICE_FALLBACK_REASONS.includes(reason)) {
    throw new VoicePolicyError("The voice connection state is not recognized.", "invalid_fallback_reason");
  }
  return reason;
}
