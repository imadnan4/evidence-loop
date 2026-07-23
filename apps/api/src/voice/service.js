import { randomUUID } from "node:crypto";

import { assertFallbackReason, assertIntentionalExitReason, assertTranscript, VoicePolicyError } from "./policy.js";

const FALLBACK_MESSAGES = Object.freeze({
  realtime_unavailable: "Voice is unavailable right now. You can continue with text without losing progress.",
  connection_failed: "The voice connection ended. You can continue with text without losing progress.",
  microphone_unavailable: "Microphone access is unavailable. You can continue with text without losing progress.",
  credential_expired: "The voice connection expired. You can continue with text without losing progress.",
});

const EXIT_MESSAGES = Object.freeze({
  switch_to_text: "Voice was stopped. You can continue with text without losing progress.",
  session_paused: "Voice was stopped while this check-in is paused.",
  human_follow_up: "Voice was stopped because you requested human follow-up.",
});

/**
 * Bounded voice transport. The injected F04 session access owns the only
 * canonical response write: it atomically persists raw/edited transcript,
 * canonical voice response, audit event, and finite session advancement.
 */
export class VoiceService {
  #repository; #sessionAccess; #credentialAdapter; #clock; #id;

  constructor({ repository, sessionAccess, credentialAdapter, clock = () => Date.now(), id = randomUUID }) {
    if (!repository || !credentialAdapter || typeof sessionAccess?.resolveVoiceSession !== "function" || typeof sessionAccess?.submitVoiceResponse !== "function") {
      throw new Error("VoiceService requires repository, credential adapter, and atomic authorized session access.");
    }
    this.#repository = repository;
    this.#sessionAccess = sessionAccess;
    this.#credentialAdapter = credentialAdapter;
    this.#clock = clock;
    this.#id = id;
  }

  async requestRealtimeCredential({ actorId, sessionId }) {
    const context = await this.#activeContext({ actorId, sessionId });
    const connectionId = `voice_${this.#id()}`;
    const createdAt = this.#timestamp();
    try {
      const credential = await this.#credentialAdapter.mintForBrowser();
      await this.#repository.createConnection({
        id: connectionId, actorId, sessionId: context.sessionId, submissionId: context.submissionId,
        state: "active", createdAt, expiresAt: credential.expiresAt, fallbackReason: null, exitReason: null,
        transcriptId: null, responseId: null,
      });
      return Object.freeze({ mode: "voice", connectionId, credential, textFallbackAvailable: true });
    } catch (error) {
      if (!(error instanceof VoicePolicyError) || error.code !== "realtime_credential_unavailable") throw error;
      await this.#repository.createConnection({
        id: connectionId, actorId, sessionId: context.sessionId, submissionId: context.submissionId,
        state: "fallback", createdAt, expiresAt: createdAt, fallbackReason: "realtime_unavailable", exitReason: null,
        transcriptId: null, responseId: null,
      });
      return this.#fallback(connectionId, "realtime_unavailable");
    }
  }

  /** Records a transport failure; it never changes the assessment state/budget. */
  async recordFallback({ actorId, sessionId, connectionId, reason }) {
    const context = await this.#activeContext({ actorId, sessionId });
    const connection = await this.#connectionFor({ actorId, context, connectionId });
    if (connection.state === "submitted") throw new VoicePolicyError("This voice response was already submitted.", "voice_response_already_submitted");
    const fallbackReason = assertFallbackReason(reason);
    await this.#repository.updateConnection(connectionId, { state: "fallback", fallbackReason, endedAt: this.#timestamp() });
    return this.#fallback(connectionId, fallbackReason);
  }

  /**
   * Records learner-selected exits separately from failures. Pause and
   * human-follow-up are accepted only after the F04 session already reflects
   * that truthful state; switch-to-text is valid while a question is active.
   */
  async recordIntentionalExit({ actorId, sessionId, connectionId, reason }) {
    const context = await this.#authorizedContext({ actorId, sessionId });
    const connection = await this.#connectionFor({ actorId, context, connectionId });
    const exitReason = assertIntentionalExitReason(reason);
    const requiredState = exitReason === "switch_to_text" ? "in_progress" : exitReason === "session_paused" ? "paused" : "human_follow_up";
    if (context.state !== requiredState) {
      throw new VoicePolicyError("The requested voice exit does not match the current check-in state.", "voice_exit_state_mismatch");
    }
    if (connection.state === "submitted") throw new VoicePolicyError("This voice response was already submitted.", "voice_response_already_submitted");
    await this.#repository.updateConnection(connectionId, { state: "intentional_exit", exitReason, endedAt: this.#timestamp() });
    return Object.freeze({ mode: exitReason === "switch_to_text" ? "text" : "stopped", connectionId, reason: exitReason, preserveProgress: true, message: EXIT_MESSAGES[exitReason] });
  }

  /**
   * One retry key and one server operation. The F04 access adapter performs a
   * single transaction covering raw transcript, canonical `voice` response,
   * audit data, next-question issuance/completion, and idempotency result.
   */
  async persistTranscript({ actorId, sessionId, connectionId, questionId, transcript, editedTranscript = null, idempotencyKey }) {
    const context = await this.#authorizedContext({ actorId, sessionId, questionId });
    const connection = await this.#connectionFor({ actorId, context, connectionId });
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      throw new VoicePolicyError("A response retry key is required.", "voice_idempotency_key_required");
    }
    const retry = connection.state === "submitted" && connection.submissionIdempotencyKey === idempotencyKey;
    if (connection.state !== "active" && !retry) {
      throw new VoicePolicyError("This voice connection is no longer active. Continue with text without losing progress.", "voice_connection_inactive");
    }
    if (!retry) {
      this.#assertActive(context);
      if (Date.parse(connection.expiresAt) <= this.#clock()) {
        throw new VoicePolicyError("This voice connection expired. Continue with text without losing progress.", "voice_credential_expired");
      }
    }
    const spokenText = assertTranscript(transcript);
    if (editedTranscript !== null && editedTranscript !== undefined && typeof editedTranscript !== "string") {
      throw new VoicePolicyError("The edited transcript must be text.", "edited_transcript_invalid");
    }
    const editedText = editedTranscript === null || editedTranscript === undefined ? null : assertTranscript(editedTranscript, "edited transcript");

    let saved;
    try {
      saved = await this.#sessionAccess.submitVoiceResponse({
        actorId, sessionId: context.sessionId, questionId, transcript: spokenText, editedTranscript: editedText, idempotencyKey,
      });
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_CONFLICT") {
        throw new VoicePolicyError("This response retry key was reused with different content.", "voice_idempotency_conflict");
      }
      if (error?.code === "CONFLICT") {
        throw new VoicePolicyError("This question already has a canonical response.", "voice_response_conflict");
      }
      throw error;
    }
    if (!saved.idempotent && !retry) {
      await this.#repository.updateConnection(connectionId, {
        state: "submitted", transcriptId: saved.transcript.id, responseId: saved.response.id,
        submissionIdempotencyKey: idempotencyKey, endedAt: this.#timestamp(),
      });
    }
    return Object.freeze({
      transcriptId: saved.transcript.id,
      responseId: saved.response.id,
      canonicalText: saved.response.canonical_text,
      session: saved.session,
      nextQuestion: saved.nextQuestion,
      idempotent: saved.idempotent === true || retry,
    });
  }

  async #authorizedContext({ actorId, sessionId, questionId }) {
    const context = await this.#sessionAccess.resolveVoiceSession({ actorId, sessionId, questionId });
    if (!context || context.sessionId !== sessionId || typeof context.submissionId !== "string") {
      throw new VoicePolicyError("You do not have access to this check-in.", "voice_session_forbidden");
    }
    if (context.voiceCheckInEnabled !== true) {
      throw new VoicePolicyError("Voice is not enabled for this assessment. Continue with the available text check-in.", "voice_not_enabled_by_policy");
    }
    if (context.startedAt !== null && (typeof context.startedAt !== "string" || Number.isNaN(Date.parse(context.startedAt)))) {
      throw new VoicePolicyError("This check-in is missing its trusted start time.", "voice_session_context_invalid");
    }
    return context;
  }

  async #activeContext(input) {
    const context = await this.#authorizedContext(input);
    this.#assertActive(context);
    return context;
  }

  #assertActive(context) {
    if (context.state !== "in_progress" || typeof context.startedAt !== "string") {
      throw new VoicePolicyError("Voice is available only while this check-in is in progress. You can use text when it resumes.", "voice_session_not_active");
    }
  }

  async #connectionFor({ actorId, context, connectionId }) {
    const connection = await this.#repository.getConnection(connectionId);
    if (!connection || connection.actorId !== actorId || connection.sessionId !== context.sessionId || connection.submissionId !== context.submissionId) {
      throw new VoicePolicyError("This voice connection is not available for this check-in.", "voice_connection_forbidden");
    }
    return connection;
  }

  #timestamp() { return new Date(this.#clock()).toISOString(); }
  #fallback(connectionId, reason) {
    return Object.freeze({ mode: "text", connectionId, reason, preserveProgress: true, message: FALLBACK_MESSAGES[reason] });
  }
}
