import type {
  CheckInSession,
  Question,
  Response,
  SourceRef,
} from "@evidence-loop/contracts/v1";
import { IdempotencyConflictError } from "@evidence-loop/db";
import type {
  SessionContext,
  SessionRepository,
  SessionTimelineEvent,
  SubmittedVoiceResponse,
  VoiceResponseCommit,
  VoiceTranscript,
} from "./types.ts";

/**
 * In-memory session repository. Used by unit tests for the finite state
 * machine. The durable deployment uses `DurableSessionRepository`.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, CheckInSession>();
  private readonly contexts = new Map<string, SessionContext>();
  private readonly questions = new Map<string, Question>();
  private readonly responses = new Map<string, Response>();
  private readonly events = new Map<string, SessionTimelineEvent[]>();
  private readonly transcripts = new Map<string, VoiceTranscript>();
  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();

  async saveSession(session: CheckInSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async getSession(sessionId: string): Promise<CheckInSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async findSessionForSubmission(actorId: string, submissionId: string): Promise<CheckInSession | undefined> {
    for (const session of this.sessions.values()) {
      if (session.submission_id === submissionId && (this.contexts.get(session.id)?.learnerId ?? session.learner_id) === actorId) {
        return structuredClone(session);
      }
    }
    return undefined;
  }

  async saveContext(sessionId: string, context: SessionContext): Promise<void> {
    this.contexts.set(sessionId, structuredClone(context));
  }

  async getContext(sessionId: string): Promise<SessionContext | undefined> {
    const context = this.contexts.get(sessionId);
    return context ? structuredClone(context) : undefined;
  }

  async saveQuestion(question: Question): Promise<void> {
    this.questions.set(question.id, structuredClone(question));
  }

  async listQuestions(sessionId: string): Promise<readonly Question[]> {
    return [...this.questions.values()]
      .filter((question) => question.session_id === sessionId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((question) => structuredClone(question));
  }

  async getQuestion(questionId: string): Promise<Question | undefined> {
    const question = this.questions.get(questionId);
    return question ? structuredClone(question) : undefined;
  }

  async saveResponse(response: Response): Promise<void> {
    this.responses.set(response.id, structuredClone(response));
  }

  async getResponseForQuestion(questionId: string): Promise<Response | undefined> {
    for (const response of this.responses.values()) {
      if (response.question_id === questionId) return structuredClone(response);
    }
    return undefined;
  }

  async listResponses(sessionId: string): Promise<readonly Response[]> {
    return [...this.responses.values()]
      .filter((response) => response.session_id === sessionId)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .map((response) => structuredClone(response));
  }

  async commitVoiceResponse(commit: VoiceResponseCommit): Promise<SubmittedVoiceResponse> {
    this.transcripts.set(commit.transcript.responseId, structuredClone(commit.transcript));
    await this.saveResponse(structuredClone(commit.response));
    await this.saveSession(structuredClone(commit.session));
    if (commit.nextQuestion) {
      await this.saveQuestion(structuredClone(commit.nextQuestion));
    }
    for (const event of commit.events) {
      const list = this.events.get(event.sessionId) ?? [];
      list.push(structuredClone(event));
      this.events.set(event.sessionId, list);
    }
    this.idempotency.set(`${commit.idempotencyScope}:${commit.idempotencyFingerprint}`, {
      fingerprint: commit.idempotencyFingerprint,
      result: commit.result,
    });
    return structuredClone(commit.result);
  }

  async getVoiceTranscriptForResponse(responseId: string): Promise<VoiceTranscript | undefined> {
    const transcript = this.transcripts.get(responseId);
    return transcript ? structuredClone(transcript) : undefined;
  }

  async getVoiceResponseSourceRef(responseId: string): Promise<SourceRef | undefined> {
    const transcript = this.transcripts.get(responseId);
    return transcript ? { source_type: "voice-transcript", source_id: transcript.id, submission_id: transcript.submissionId, locator: `voice-transcript:${transcript.responseId}` } : undefined;
  }

  async saveEvent(event: SessionTimelineEvent): Promise<void> {
    const list = this.events.get(event.sessionId) ?? [];
    list.push(structuredClone(event));
    this.events.set(event.sessionId, list);
  }

  async listEvents(sessionId: string): Promise<readonly SessionTimelineEvent[]> {
    return (this.events.get(sessionId) ?? []).map((event) => structuredClone(event));
  }

  async getIdempotentResult<T>(scope: string, fingerprint: string): Promise<T | undefined> {
    const entry = this.idempotency.get(scope);
    if (!entry) return undefined;
    if (entry.fingerprint !== fingerprint) throw new IdempotencyConflictError();
    return entry.result as T;
  }

  async saveIdempotentResult<T>(scope: string, _fingerprint: string, result: T): Promise<void> {
    this.idempotency.set(scope, { fingerprint: _fingerprint, result });
  }
}
