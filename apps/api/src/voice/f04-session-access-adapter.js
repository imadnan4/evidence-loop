/**
 * Narrow application adapter between the F07 transport and frozen F04 session
 * service. It deliberately accepts only authenticated actor/session/question
 * values and delegates the sole canonical response write to F04.
 */
export class F04VoiceSessionAccessAdapter {
  #sessionService;

  constructor({ sessionService }) {
    if (!sessionService || typeof sessionService.resolveVoiceSession !== "function" || typeof sessionService.submitVoiceResponse !== "function") {
      throw new Error("F04 voice session access requires the trusted session service.");
    }
    this.#sessionService = sessionService;
  }

  resolveVoiceSession({ actorId, sessionId, questionId }) {
    // Do not expose whether an inaccessible session or question exists.
    try {
      return this.#sessionService.resolveVoiceSession({ userId: actorId }, sessionId, questionId);
    } catch {
      return null;
    }
  }

  submitVoiceResponse({ actorId, sessionId, questionId, transcript, editedTranscript, idempotencyKey }) {
    return this.#sessionService.submitVoiceResponse({ userId: actorId }, {
      sessionId, questionId, transcript, editedTranscript, idempotencyKey,
    });
  }
}
