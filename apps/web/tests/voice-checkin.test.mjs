import assert from "node:assert/strict";
import test from "node:test";

import { F07aVoiceApi, RealtimeVoiceTransport, VoiceTransportError } from "../public/demo/assets/voice-checkin.js";

function response(body, options = {}) {
  return new Response(JSON.stringify(body), { status: options.status ?? 200, headers: { "Content-Type": "application/json" } });
}

function success(data) { return { contract_version: "v1", request_id: "voice-test", data }; }

test("F07a browser client keeps the credential scoped and persists only transcript text", async () => {
  const requests = [];
  const client = new F07aVoiceApi(async (path, options) => {
    requests.push({ path, options });
    return response(success({ ok: true }));
  });

  await client.requestRealtimeCredential({ sessionId: "session-1", idempotencyKey: "credential-key" });
  await client.recordFallback({ sessionId: "session-1", connectionId: "voice-1", reason: "microphone_unavailable", idempotencyKey: "fallback-key" });
  await client.recordIntentionalExit({ sessionId: "session-1", connectionId: "voice-1", reason: "switch_to_text", idempotencyKey: "exit-key" });
  await client.persistTranscript({ sessionId: "session-1", connectionId: "voice-1", questionId: "question-1", transcript: "A spoken answer.", editedTranscript: "An edited answer.", idempotencyKey: "transcript-key" });

  assert.deepEqual(requests.map(({ path }) => path), [
    "/check-ins/session-1/voice/realtime-credential",
    "/check-ins/session-1/voice/fallback",
    "/check-ins/session-1/voice/intentional-exit",
    "/check-ins/session-1/voice/transcript",
  ]);
  assert.equal(requests[0].options.headers["Idempotency-Key"], "credential-key");
  assert.deepEqual(JSON.parse(requests[1].options.body), { connectionId: "voice-1", reason: "microphone_unavailable", idempotencyKey: "fallback-key" });
  assert.deepEqual(JSON.parse(requests[2].options.body), { connectionId: "voice-1", reason: "switch_to_text", idempotencyKey: "exit-key" });
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    connectionId: "voice-1", questionId: "question-1", transcript: "A spoken answer.", editedTranscript: "An edited answer.", idempotencyKey: "transcript-key",
  });
  assert.equal(JSON.stringify(requests).includes("providerSecret"), false);
});

test("voice transport reports microphone denial without negotiating or retaining media", async () => {
  let requested = false;
  const transport = new RealtimeVoiceTransport({
    mediaDevices: { getUserMedia: async () => { requested = true; throw new DOMException("Denied", "NotAllowedError"); } },
    PeerConnection: class {},
    fetchImplementation: async () => { throw new Error("must not negotiate"); },
  });

  await assert.rejects(
    () => transport.connect({ ephemeralToken: "ephemeral-browser-token-123456", onTranscript: () => {} }),
    (error) => error instanceof VoiceTransportError && error.code === "microphone_unavailable",
  );
  assert.equal(requested, true);
  assert.equal(transport.stream, null);
  assert.equal(transport.peerConnection, null);
});

test("voice transport releases microphone tracks when realtime negotiation fails", async () => {
  let stopped = false;
  let closed = false;
  const track = { enabled: true, stop: () => { stopped = true; } };
  class FakePeerConnection {
    addTrack() {}
    createDataChannel() { return { addEventListener() {} }; }
    addEventListener() {}
    async createOffer() { return { sdp: "offer" }; }
    async setLocalDescription() {}
    close() { closed = true; }
  }
  const transport = new RealtimeVoiceTransport({
    mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) },
    PeerConnection: FakePeerConnection,
    fetchImplementation: async () => { throw new Error("offline"); },
  });

  await assert.rejects(
    () => transport.connect({ ephemeralToken: "ephemeral-browser-token-123456", onTranscript: () => {} }),
    (error) => error instanceof VoiceTransportError && error.code === "connection_failed",
  );
  assert.equal(stopped, true);
  assert.equal(closed, true);
  assert.equal(transport.stream, null);
  assert.equal(transport.peerConnection, null);
});
