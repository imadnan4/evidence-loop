export class SessionApiError extends Error {
  constructor(message, code = "internal", status = 0) {
    super(message);
    this.name = "SessionApiError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Browser adapter for the frozen F04a session service. The BFF authenticates
 * every request and resolves policy, objectives, provenance, and session state
 * server-side; this client only submits F04a operation inputs and renders the
 * returned, session-scoped representation.
 */
export class F04aSessionApi {
  constructor(fetchImplementation = globalThis.fetch) {
    if (typeof fetchImplementation !== "function") throw new TypeError("A browser fetch implementation is required.");
    this.fetch = (...args) => fetchImplementation(...args);
  }

  showPolicy(input) { return this.#post(input.sessionId, "policy-shown", input); }
  acknowledgePolicy(input) { return this.#post(input.sessionId, "policy-acknowledgements", input); }
  start(input) { return this.#post(input.sessionId, "start", input); }
  pause(input) { return this.#post(input.sessionId, "pause", input); }
  resume(input) { return this.#post(input.sessionId, "resume", input); }
  submitTextResponse(input) { return this.#post(input.sessionId, "answers", input); }
  requestHumanFollowUp(input) { return this.#post(input.sessionId, "human-follow-up", input); }

  async getReceipt(sessionId) {
    return this.#request(`/check-ins/${encodeURIComponent(sessionId)}/receipt`, { method: "GET" });
  }

  async #post(sessionId, operation, input) {
    return this.#request(`/check-ins/${encodeURIComponent(sessionId)}/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  async #request(path, options) {
    let response;
    try {
      response = await this.fetch(path, { ...options, credentials: "same-origin", headers: { Accept: "application/json", ...options.headers } });
    } catch {
      throw new SessionApiError("We could not reach your check-in. Your current typed draft remains in this browser. Please try again.", "network_error");
    }

    let body = null;
    try { body = await response.json(); } catch { /* Error text is intentionally not treated as trusted API content. */ }
    if (!response.ok) {
      const error = body?.error;
      throw new SessionApiError(error?.message || "We could not complete that check-in action. Please try again.", error?.code || "internal", response.status);
    }
    if (body?.contract_version === "v1" && Object.hasOwn(body, "data")) return body.data;
    throw new SessionApiError("The check-in returned an unexpected response. Please try again.", "invalid_response", response.status);
  }
}
