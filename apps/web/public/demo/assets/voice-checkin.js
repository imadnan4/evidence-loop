export class VoiceApiError extends Error {
  constructor(message, code = "internal", status = 0) {
    super(message);
    this.name = "VoiceApiError";
    this.code = code;
    this.status = status;
  }
}

export class VoiceTransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "VoiceTransportError";
    this.code = code;
  }
}

/**
 * Browser adapter for the frozen F07a voice boundary. The BFF authorizes the
 * active check-in and keeps the provider secret server-side. This adapter only
 * receives the short-lived browser credential and persists transcript text.
 */
export class F07aVoiceApi {
  constructor(fetchImplementation = globalThis.fetch) {
    if (typeof fetchImplementation !== "function") throw new TypeError("A browser fetch implementation is required.");
    this.fetch = (...args) => fetchImplementation(...args);
  }

  requestRealtimeCredential({ sessionId, idempotencyKey }) {
    return this.#post(sessionId, "realtime-credential", { idempotencyKey });
  }

  recordFallback({ sessionId, connectionId, reason, idempotencyKey }) {
    return this.#post(sessionId, "fallback", { connectionId, reason, idempotencyKey });
  }

  recordIntentionalExit({ sessionId, connectionId, reason, idempotencyKey }) {
    return this.#post(sessionId, "intentional-exit", { connectionId, reason, idempotencyKey });
  }

  persistTranscript({ sessionId, connectionId, questionId, transcript, editedTranscript, idempotencyKey }) {
    return this.#post(sessionId, "transcript", { connectionId, questionId, transcript, editedTranscript, idempotencyKey });
  }

  async #post(sessionId, operation, input) {
    let response;
    try {
      response = await this.fetch(`/check-ins/${encodeURIComponent(sessionId)}/voice/${operation}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(input),
      });
    } catch {
      throw new VoiceApiError("We could not reach voice services. You can continue with text without losing progress.", "network_error");
    }

    let body = null;
    try { body = await response.json(); } catch { /* Do not render untrusted response text. */ }
    if (!response.ok) {
      const error = body?.error;
      throw new VoiceApiError(error?.message || "Voice is unavailable. You can continue with text without losing progress.", error?.code || "internal", response.status);
    }
    if (body?.contract_version === "v1" && Object.hasOwn(body, "data")) return body.data;
    throw new VoiceApiError("Voice returned an unexpected response. You can continue with text without losing progress.", "invalid_response", response.status);
  }
}

/**
 * Minimal WebRTC transport. It sends microphone audio only to the realtime
 * provider using F07a's scoped credential; audio is never uploaded to this
 * application or retained by the browser adapter. Transcript events are text.
 */
export class RealtimeVoiceTransport {
  constructor({ fetchImplementation = globalThis.fetch, mediaDevices = globalThis.navigator?.mediaDevices, PeerConnection = globalThis.RTCPeerConnection } = {}) {
    this.fetch = fetchImplementation;
    this.mediaDevices = mediaDevices;
    this.PeerConnection = PeerConnection;
    this.peerConnection = null;
    this.stream = null;
    this.stopped = false;
  }

  async connect({ ephemeralToken, onTranscript, onConnectionState }) {
    if (typeof ephemeralToken !== "string" || ephemeralToken.length < 16) {
      throw new VoiceTransportError("Voice credential was unavailable.", "credential_expired");
    }
    if (!this.mediaDevices?.getUserMedia) {
      throw new VoiceTransportError("Microphone access is unavailable.", "microphone_unavailable");
    }
    if (typeof this.PeerConnection !== "function" || typeof this.fetch !== "function") {
      throw new VoiceTransportError("Voice connection is unavailable.", "connection_failed");
    }

    try {
      this.stream = await this.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      throw new VoiceTransportError("Microphone access is unavailable.", "microphone_unavailable");
    }

    try {
      const peerConnection = new this.PeerConnection();
      this.peerConnection = peerConnection;
      for (const track of this.stream.getAudioTracks()) peerConnection.addTrack(track, this.stream);
      const channel = peerConnection.createDataChannel("oai-events");
      channel.addEventListener("message", (event) => this.#readEvent(event.data, onTranscript));
      peerConnection.addEventListener("connectionstatechange", () => {
        if (this.stopped) return;
        const state = peerConnection.connectionState;
        if (state === "failed" || state === "disconnected") onConnectionState?.("connection_failed");
      });
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const answer = await this.fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${ephemeralToken}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!answer.ok) throw new Error("Realtime negotiation failed.");
      await peerConnection.setRemoteDescription({ type: "answer", sdp: await answer.text() });
      return this;
    } catch {
      this.stop();
      throw new VoiceTransportError("Voice connection could not be established.", "connection_failed");
    }
  }

  pause() { for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = false; }
  resume() { for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = true; }

  stop() {
    this.stopped = true;
    this.peerConnection?.close();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.peerConnection = null;
    this.stream = null;
  }

  #readEvent(raw, onTranscript) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event?.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
      onTranscript?.({ kind: "delta", text: event.delta });
    }
    if (event?.type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      onTranscript?.({ kind: "completed", text: event.transcript });
    }
  }
}
