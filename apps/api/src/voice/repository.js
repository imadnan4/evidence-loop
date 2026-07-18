function clone(value) { return structuredClone(value); }

export class VoiceRepositoryConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VoiceRepositoryConflictError";
    this.code = code;
  }
}

/**
 * Atomic voice persistence boundary. A committed transcript and its F00-shaped
 * canonical response are written together. No audio, voice features, or
 * provider credentials are accepted or stored.
 */
export class InMemoryVoiceRepository {
  #connections = new Map(); #transcripts = new Map(); #responses = new Map();
  #responseByQuestion = new Map(); #idempotency = new Map();

  async createConnection(connection) {
    if (this.#connections.has(connection.id)) throw new Error("Voice connection already exists.");
    this.#connections.set(connection.id, Object.freeze(clone(connection)));
    return this.getConnection(connection.id);
  }
  async getConnection(id) { const value = this.#connections.get(id); return value ? clone(value) : null; }
  async updateConnection(id, patch) {
    const current = this.#connections.get(id);
    if (!current) throw new Error("Voice connection not found.");
    const next = Object.freeze({ ...current, ...clone(patch) });
    this.#connections.set(id, next);
    return clone(next);
  }

  /**
   * No await occurs between uniqueness checks and writes. Database adapters
   * must implement the same operation as one transaction with unique indexes
   * on `(connection_id, question_id)` and canonical `question_id` response.
   */
  async saveTranscript({ connectionId, idempotencyKey, transcript, response }) {
    const key = `${connectionId}:${idempotencyKey}`;
    const priorId = this.#idempotency.get(key);
    if (priorId) {
      const prior = this.#transcripts.get(priorId);
      if (prior.questionId !== transcript.questionId || prior.transcript !== transcript.transcript || prior.editedTranscript !== transcript.editedTranscript || prior.canonicalText !== transcript.canonicalText) {
        throw new VoiceRepositoryConflictError("idempotency_conflict", "Idempotency key conflict.");
      }
      return { transcript: clone(prior), response: clone(this.#responses.get(prior.responseId)), idempotent: true };
    }
    if (this.#responseByQuestion.has(`${connectionId}:${transcript.questionId}`) || this.#responseByQuestion.has(transcript.questionId)) {
      throw new VoiceRepositoryConflictError("response_already_exists", "A canonical response already exists for this question.");
    }
    if (this.#transcripts.has(transcript.id) || this.#responses.has(response.id)) throw new Error("Transcript or response already exists.");
    if (response.question_id !== transcript.questionId || response.session_id !== transcript.sessionId || response.submission_id !== transcript.submissionId) {
      throw new Error("Transcript and canonical response must have identical provenance.");
    }
    const storedTranscript = Object.freeze(clone(transcript));
    const storedResponse = Object.freeze(clone(response));
    this.#transcripts.set(storedTranscript.id, storedTranscript);
    this.#responses.set(storedResponse.id, storedResponse);
    this.#responseByQuestion.set(`${connectionId}:${storedTranscript.questionId}`, storedResponse.id);
    this.#responseByQuestion.set(storedTranscript.questionId, storedResponse.id);
    this.#idempotency.set(key, storedTranscript.id);
    return { transcript: clone(storedTranscript), response: clone(storedResponse), idempotent: false };
  }

  async getCanonicalResponseForQuestion(questionId) {
    const responseId = this.#responseByQuestion.get(questionId);
    const response = responseId && this.#responses.get(responseId);
    return response ? clone(response) : null;
  }
  async getResponseSourceRef(responseId) {
    const response = this.#responses.get(responseId);
    return response ? Object.freeze({ source_type: "response", source_id: response.id, submission_id: response.submission_id, locator: `question:${response.question_id}` }) : null;
  }
  async listTranscriptsForSession(sessionId) {
    return [...this.#transcripts.values()].filter((item) => item.sessionId === sessionId).map(clone);
  }
}
