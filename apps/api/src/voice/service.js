import { randomUUID } from "node:crypto";
import { ResponseSchema } from "@evidence-loop/contracts/v1";
import { assertFallbackReason, assertTranscript, VoicePolicyError } from "./policy.js";
import { VoiceRepositoryConflictError } from "./repository.js";

const FALLBACK_MESSAGES = Object.freeze({
  realtime_unavailable: "Voice is unavailable right now. You can continue with text without losing progress.",
  connection_failed: "The voice connection ended. You can continue with text without losing progress.",
  microphone_unavailable: "Microphone access is unavailable. You can continue with text without losing progress.",
  credential_expired: "The voice connection expired. You can continue with text without losing progress.",
});

/**
 * Voice is deliberately a bounded transport adapter, not an assessment engine.
 * `sessionAccess.resolveVoiceSession({ actorId, sessionId, questionId? })` is
 * the trusted F04 session/authorization seam. It must return the current
 * `{ sessionId, submissionId, state, voiceCheckInEnabled, startedAt }` only
 * for the owning learner. `voiceCheckInEnabled` must be resolved from the
 * immutable published assessment policy, and a supplied question must belong
 * to that same current session.
 */
export class VoiceService {
  #repository; #sessionAccess; #credentialAdapter; #clock;

  constructor({ repository, sessionAccess, credentialAdapter, clock = () => Date.now() }) {
    if (!repository || !credentialAdapter || typeof sessionAccess?.resolveVoiceSession !== "function") {
      throw new Error("VoiceService requires repository, credential adapter, and authorized session access.");
    }
    this.#repository = repository;
    this.#sessionAccess = sessionAccess;
    this.#credentialAdapter = credentialAdapter;
    this.#clock = clock;
  }

  async requestRealtimeCredential({ actorId, sessionId }) {
    const context = await this.#activeContext({ actorId, sessionId });
    const connectionId = `voice_${randomUUID()}`;
    const createdAt = this.#timestamp();
    try {
      const credential = await this.#credentialAdapter.mintForBrowser();
      // This local binding scopes the browser token to one authorized learner
      // and active check-in; no provider credential is stored here.
      await this.#repository.createConnection({
        id: connectionId, actorId, sessionId: context.sessionId, submissionId: context.submissionId,
        state: "active", createdAt, expiresAt: credential.expiresAt, fallbackReason: null, transcriptId: null,
      });
      return Object.freeze({ mode: "voice", connectionId, credential, textFallbackAvailable: true });
    } catch (error) {
      if (!(error instanceof VoicePolicyError) || error.code !== "realtime_credential_unavailable") throw error;
      await this.#repository.createConnection({
        id: connectionId, actorId, sessionId: context.sessionId, submissionId: context.submissionId,
        state: "fallback", createdAt, expiresAt: createdAt, fallbackReason: "realtime_unavailable", transcriptId: null,
      });
      return this.#fallback(connectionId, "realtime_unavailable");
    }
  }

  /** Records a user-visible failure route without pausing/completing the session or consuming its budget. */
  async recordFallback({ actorId, sessionId, connectionId, reason }) {
    const context = await this.#activeContext({ actorId, sessionId });
    const connection = await this.#connectionFor({ actorId, context, connectionId });
    if (connection.state === "submitted") throw new VoicePolicyError("This voice response was already submitted.", "voice_response_already_submitted");
    const fallbackReason = assertFallbackReason(reason);
    await this.#repository.updateConnection(connectionId, { state: "fallback", fallbackReason, endedAt: this.#timestamp() });
    return this.#fallback(connectionId, fallbackReason);
  }

  /**
   * Persists the canonical text response linked to the current session/question.
   * The only accepted voice content is transcript text; it is not interpreted,
   * sent to a model, or augmented with acoustic/provider-confidence metadata.
   */
  async persistTranscript({ actorId, sessionId, connectionId, questionId, transcript, editedTranscript = null, idempotencyKey }) {
    const context = await this.#activeContext({ actorId, sessionId, questionId });
    const connection = await this.#connectionFor({ actorId, context, connectionId });
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      throw new VoicePolicyError("A response retry key is required.", "voice_idempotency_key_required");
    }
    const retry = connection.state === "submitted" && connection.submissionIdempotencyKey === idempotencyKey;
    if (connection.state !== "active" && !retry) {
      throw new VoicePolicyError("This voice connection is no longer active. Continue with text without losing progress.", "voice_connection_inactive");
    }
    if (!retry && Date.parse(connection.expiresAt) <= this.#clock()) {
      throw new VoicePolicyError("This voice connection expired. Continue with text without losing progress.", "voice_credential_expired");
    }
    const spokenText = assertTranscript(transcript);
    if (editedTranscript !== null && editedTranscript !== undefined && typeof editedTranscript !== "string") {
      throw new VoicePolicyError("The edited transcript must be text.", "edited_transcript_invalid");
    }
    const canonicalText = editedTranscript === null || editedTranscript === undefined
      ? spokenText : assertTranscript(editedTranscript, "edited transcript");
    const now = this.#timestamp();
    const responseId = `response_${randomUUID()}`;
    const candidate = Object.freeze({
      id: `transcript_${randomUUID()}`, responseId, connectionId, sessionId: context.sessionId, submissionId: context.submissionId, questionId,
      modality: "voice", transcript: spokenText, editedTranscript: editedTranscript ?? null, canonicalText, createdAt: now, submittedAt: now,
    });
    // This is the same contract shape consumed by receipts and evidence source
    // validation; the repository commits it with the transcript as one unit.
    const response = ResponseSchema.parse({
      id: responseId, question_id: questionId, session_id: context.sessionId, submission_id: context.submissionId,
      modality: "voice", canonical_text: canonicalText, edited_text: editedTranscript ?? null,
      started_at: context.startedAt, submitted_at: now,
    });
    let saved;
    try { saved = await this.#repository.saveTranscript({ connectionId, idempotencyKey, transcript: candidate, response }); }
    catch (error) {
      if (error instanceof VoiceRepositoryConflictError && error.code === "response_already_exists") {
        throw new VoicePolicyError("This question already has a canonical response.", "voice_response_conflict");
      }
      throw new VoicePolicyError("This response retry key was reused with different content.", "voice_idempotency_conflict");
    }
    if (!saved.idempotent) {
      await this.#repository.updateConnection(connectionId, {
        state: "submitted", transcriptId: saved.transcript.id, responseId: saved.response.id,
        submissionIdempotencyKey: idempotencyKey, endedAt: now,
      });
    }
    return Object.freeze({
      transcriptId: saved.transcript.id, responseId: saved.response.id, canonicalText: saved.response.canonical_text, idempotent: saved.idempotent,
    });
  }

  async #activeContext({ actorId, sessionId, questionId }) {
    const context = await this.#sessionAccess.resolveVoiceSession({ actorId, sessionId, questionId });
    if (!context || context.sessionId !== sessionId || typeof context.submissionId !== "string") {
      throw new VoicePolicyError("You do not have access to this check-in.", "voice_session_forbidden");
    }
    if (context.state !== "in_progress") {
      throw new VoicePolicyError("Voice is available only while this check-in is in progress. You can use text when it resumes.", "voice_session_not_active");
    }
    if (context.voiceCheckInEnabled !== true) {
      throw new VoicePolicyError("Voice is not enabled for this assessment. Continue with the available text check-in.", "voice_not_enabled_by_policy");
    }
    if (typeof context.startedAt !== "string" || Number.isNaN(Date.parse(context.startedAt))) {
      throw new VoicePolicyError("This check-in is missing its trusted start time.", "voice_session_context_invalid");
    }
    return context;
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
