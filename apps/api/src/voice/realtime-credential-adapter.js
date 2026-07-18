import { VOICE_POLICY, VoicePolicyError } from "./policy.js";

/**
 * Server-only seam around the realtime provider. The issuer can use a provider
 * API secret, but this adapter returns only a narrow, short-lived browser token
 * and never persists either credential.
 */
export class RealtimeCredentialAdapter {
  #issue; #clock; #ttlMs; #model;

  constructor({ issueEphemeralCredential, model = "gpt-realtime", clock = () => Date.now(), ttlMs = VOICE_POLICY.credentialTtlMs }) {
    if (typeof issueEphemeralCredential !== "function") throw new Error("A server-side realtime credential issuer is required.");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > VOICE_POLICY.maxCredentialTtlMs) {
      throw new Error("Realtime credential TTL must be short and bounded.");
    }
    this.#issue = issueEphemeralCredential;
    this.#clock = clock;
    this.#ttlMs = ttlMs;
    this.#model = model;
  }

  async mintForBrowser() {
    const expiresAt = new Date(this.#clock() + this.#ttlMs).toISOString();
    let issued;
    try {
      // No artifact, transcript, tools, web access, or learner identity is sent.
      issued = await this.#issue({ model: this.#model, expiresAt, modalities: ["audio", "text"] });
    } catch {
      throw new VoicePolicyError("Voice is temporarily unavailable. Continue with text.", "realtime_credential_unavailable");
    }
    if (typeof issued?.ephemeralToken !== "string" || issued.ephemeralToken.length < 16) {
      throw new VoicePolicyError("Voice is temporarily unavailable. Continue with text.", "realtime_credential_unavailable");
    }
    return Object.freeze({ ephemeralToken: issued.ephemeralToken, expiresAt, transport: "webrtc" });
  }
}
