import type { CheckInSession, Question, Response } from "@evidence-loop/contracts/v1";

import type { SessionContext, SessionEventAction, SessionRepository, SessionTimelineEvent } from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);

const immutable = <T>(value: T): Readonly<T> => {
  const copy = clone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const nested of Object.values(item as Record<string, unknown>)) freeze(nested);
    }
  };
  freeze(copy);
  return copy;
};

type StoredIdempotentResult = Readonly<{ fingerprint: string; result: unknown }>;

/** In-memory adapter used by the F04a state-machine tests and local demo only. */
export class InMemorySessionRepository implements SessionRepository {
  #sessions = new Map<string, CheckInSession>();
  #contexts = new Map<string, SessionContext>();
  #questions = new Map<string, Question>();
  #responsesByQuestion = new Map<string, Response>();
  #events = new Map<string, SessionTimelineEvent[]>();
  #idempotency = new Map<string, StoredIdempotentResult>();

  saveSession(session: CheckInSession): void {
    this.#sessions.set(session.id, immutable(session));
  }

  getSession(sessionId: string): CheckInSession | undefined {
    const session = this.#sessions.get(sessionId);
    return session && immutable(session);
  }

  saveContext(sessionId: string, context: SessionContext): void {
    // Policy/objective/provenance snapshots are supplied only at creation;
    // the service may subsequently record policy visibility acknowledgements.
    this.#contexts.set(sessionId, immutable(context));
  }

  getContext(sessionId: string): SessionContext | undefined {
    const context = this.#contexts.get(sessionId);
    return context && immutable(context);
  }

  saveQuestion(question: Question): void {
    if (this.#questions.has(question.id)) throw new Error("Questions are immutable once issued.");
    this.#questions.set(question.id, immutable(question));
  }

  listQuestions(sessionId: string): readonly Question[] {
    return [...this.#questions.values()]
      .filter((question) => question.session_id === sessionId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((question) => immutable(question));
  }

  getQuestion(questionId: string): Question | undefined {
    const question = this.#questions.get(questionId);
    return question && immutable(question);
  }

  saveResponse(response: Response): void {
    if (this.#responsesByQuestion.has(response.question_id)) {
      throw new Error("A question already has its canonical response.");
    }
    this.#responsesByQuestion.set(response.question_id, immutable(response));
  }

  getResponseForQuestion(questionId: string): Response | undefined {
    const response = this.#responsesByQuestion.get(questionId);
    return response && immutable(response);
  }

  listResponses(sessionId: string): readonly Response[] {
    return [...this.#responsesByQuestion.values()]
      .filter((response) => response.session_id === sessionId)
      .sort((left, right) => left.submitted_at.localeCompare(right.submitted_at))
      .map((response) => immutable(response));
  }

  saveEvent(event: SessionTimelineEvent): void {
    const current = this.#events.get(event.sessionId) ?? [];
    this.#events.set(event.sessionId, [...current, immutable(event)]);
  }

  listEvents(sessionId: string): readonly SessionTimelineEvent[] {
    return (this.#events.get(sessionId) ?? []).map((event) => immutable(event));
  }

  getIdempotentResult<T>(scope: string, fingerprint: string): T | undefined {
    const stored = this.#idempotency.get(scope);
    if (!stored) return undefined;
    if (stored.fingerprint !== fingerprint) {
      throw new IdempotencyConflictError();
    }
    return immutable(stored.result) as T;
  }

  saveIdempotentResult<T>(scope: string, fingerprint: string, result: T): void {
    if (this.#idempotency.has(scope)) throw new Error("Idempotency result is immutable.");
    this.#idempotency.set(scope, immutable({ fingerprint, result }));
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor() {
    super("This idempotency key was already used with a different request.");
    this.name = "IdempotencyConflictError";
  }
}

export const isSessionEventAction = (value: string): value is SessionEventAction => value.length > 0;
