import { randomUUID } from "node:crypto";
import type { CheckInSession, Question } from "@evidence-loop/contracts/v1";
import {
  fingerprintRequest,
  IdempotencyConflictError,
  reserveIdempotencyKey,
  withTenantTransaction,
  writeWithAuditAndOutbox,
} from "@evidence-loop/db";
import type { Sql } from "postgres";
import type { Principal } from "../auth/principal.ts";
import { DurableSessionRepository } from "./durable-repository.ts";
import { DurableTrustedSessionResolver } from "./durable-resolver.ts";
import { SessionError, TextCheckInSessionService } from "./service.ts";
import type {
  ResolvedVoiceSession,
  SubmittedResponse,
  SubmittedVoiceResponse,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CheckInHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const notFound = () => new CheckInHttpError(404, "not_found");
const invalid = () => new CheckInHttpError(400, "validation");
const conflict = () => new CheckInHttpError(409, "invalid_state");

function requireUuid(value: string, label: string): string {
  if (!UUID.test(value)) throw invalid();
  return value;
}

function idempotencyKeyHeader(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{1,255}$/.test(value)) throw invalid();
  return value;
}

/**
 * Durable C02 check-in service. It wraps the validated in-memory
 * `TextCheckInSessionService` state machine with tenant-scoped transactions,
 * request-level idempotency, audit, and outbox. The finite state machine,
 * question provenance, and human-follow-up logic stay in the inner service;
 * this layer only provides durable persistence, authorization scope, and the
 * event envelope. The F07a voice bridge reuses the same repository so one
 * transaction owns the raw transcript, canonical response, and state changes.
 */
export class DurableCheckInService {
  private readonly client: Sql<{}>;
  private readonly service: TextCheckInSessionService;

  constructor(client: Sql<{}>) {
    this.client = client;
    this.service = new TextCheckInSessionService(
      new DurableSessionRepository(client),
      new DurableTrustedSessionResolver(client),
      { id: () => randomUUID(), now: () => new Date().toISOString() },
    );
  }

  private transaction<T>(principal: Principal, work: (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      correlationId: principal.correlationId,
    }, async (tx) => {
      this.service.bindRepository(tx);
      try {
        return await work(tx);
      } finally {
        this.service.unbindRepository();
      }
    });
  }

  private actor(principal: Principal) {
    return { userId: principal.userId };
  }

  async createSession(principal: Principal, submissionId: string, header: string | undefined): Promise<{ replayed: boolean; sessionId: string; session: CheckInSession }> {
    const submission = requireUuid(submissionId, "submissionId");
    const key = idempotencyKeyHeader(header);
    const operation = "check_in.create";
    return this.transaction(principal, async (tx) => {
      const reserved = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprintRequest({ submissionId }) });
      const session = await this.service.createSession(this.actor(principal), { submissionId: submission, idempotencyKey: key });
      if (reserved === "replayed") {
        return { replayed: true, sessionId: session.id, session };
      }
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        correlationId: principal.correlationId,
        audit: { action: "check_in.created", targetType: "check_in_session", targetId: session.id, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "check_in_session", aggregateId: session.id, topic: "check_in.created", payload: { submission_id: submission } },
        domainWrite: async () => undefined,
      });
      await tx`INSERT INTO idempotency_results (organization_id, operation, key, target_type, target_id) VALUES (${principal.organizationId}, ${operation}, ${key}, 'check_in_session', ${session.id})`;
      return { replayed: false, sessionId: session.id, session };
    });
  }

  async showPolicy(principal: Principal, sessionId: string, header: string | undefined): Promise<CheckInSession> {
    const id = requireUuid(sessionId, "sessionId");
    const key = idempotencyKeyHeader(header);
    const operation = "check_in.show_policy";
    return this.transaction(principal, async (tx) => {
      const reserved = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprintRequest({ sessionId }) });
      const briefing = await this.service.showPolicy(this.actor(principal), { sessionId: id, idempotencyKey: key });
      if (reserved === "replayed") return briefing.session;
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        correlationId: principal.correlationId,
        audit: { action: "check_in.policy_shown", targetType: "check_in_session", targetId: id, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "check_in_session", aggregateId: id, topic: "check_in.policy_shown", payload: { submission_id: briefing.session.submission_id } },
        domainWrite: async () => undefined,
      });
      return briefing.session;
    });
  }

  async acknowledgePolicy(principal: Principal, sessionId: string, policyVersionId: string, header: string | undefined): Promise<CheckInSession> {
    const id = requireUuid(sessionId, "sessionId");
    const versionId = requireUuid(policyVersionId, "policyVersionId");
    const key = idempotencyKeyHeader(header);
    const operation = "check_in.acknowledge_policy";
    return this.transaction(principal, async (tx) => {
      const reserved = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprintRequest({ sessionId, policyVersionId }) });
      const session = await this.service.acknowledgePolicy(this.actor(principal), { sessionId: id, policyVersionId: versionId, idempotencyKey: key });
      if (reserved === "replayed") return session;
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        correlationId: principal.correlationId,
        audit: { action: "check_in.policy_acknowledged", targetType: "check_in_session", targetId: id, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "check_in_session", aggregateId: id, topic: "check_in.policy_acknowledged", payload: { submission_id: session.submission_id } },
        domainWrite: async () => undefined,
      });
      return session;
    });
  }

  async start(principal: Principal, sessionId: string, policyVersionId: string, header: string | undefined): Promise<{ session: CheckInSession; question: Question }> {
    const id = requireUuid(sessionId, "sessionId");
    const versionId = requireUuid(policyVersionId, "policyVersionId");
    const key = idempotencyKeyHeader(header);
    const operation = "check_in.start";
    return this.transaction(principal, async (tx) => {
      const reserved = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprintRequest({ sessionId, policyVersionId, mode: "text" }) });
      const started = await this.service.start(this.actor(principal), { sessionId: id, policyVersionId: versionId, mode: "text", idempotencyKey: key });
      if (reserved === "replayed") return { session: started.session, question: started.question };
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        correlationId: principal.correlationId,
        audit: { action: "check_in.started", targetType: "check_in_session", targetId: id, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "check_in_session", aggregateId: id, topic: "check_in.started", payload: { submission_id: started.session.submission_id } },
        domainWrite: async () => undefined,
      });
      return { session: started.session, question: started.question };
    });
  }

  async pause(principal: Principal, sessionId: string, header: string | undefined): Promise<CheckInSession> {
    return this.mutate(principal, sessionId, "check_in.pause", "check_in.paused", header, async (actor, id, key) => this.service.pause(actor, { sessionId: id, idempotencyKey: key }));
  }

  async resume(principal: Principal, sessionId: string, header: string | undefined): Promise<CheckInSession> {
    return this.mutate(principal, sessionId, "check_in.resume", "check_in.resumed", header, async (actor, id, key) => this.service.resume(actor, { sessionId: id, idempotencyKey: key }));
  }

  async requestHumanFollowUp(principal: Principal, sessionId: string, header: string | undefined): Promise<CheckInSession> {
    return this.mutate(principal, sessionId, "check_in.request_follow_up", "check_in.human_follow_up_requested", header, async (actor, id, key) => this.service.requestHumanFollowUp(actor, { sessionId: id, idempotencyKey: key }));
  }

  private async mutate(
    principal: Principal,
    sessionId: string,
    operation: string,
    topic: string,
    header: string | undefined,
    work: (actor: { userId: string }, id: string, key: string) => Promise<CheckInSession>,
  ): Promise<CheckInSession> {
    const id = requireUuid(sessionId, "sessionId");
    const key = idempotencyKeyHeader(header);
    return this.transaction(principal, async (tx) => {
      const reserved = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprintRequest({ sessionId }) });
      const session = await work(this.actor(principal), id, key);
      if (reserved === "replayed") return session;
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        correlationId: principal.correlationId,
        audit: { action: operation, targetType: "check_in_session", targetId: id, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "check_in_session", aggregateId: id, topic, payload: { submission_id: session.submission_id } },
        domainWrite: async () => undefined,
      });
      return session;
    });
  }

  async submitTextResponse(
    principal: Principal,
    sessionId: string,
    questionId: string,
    canonicalText: string,
    editedText: string | null,
    header: string | undefined,
  ): Promise<SubmittedResponse> {
    const id = requireUuid(sessionId, "sessionId");
    const question = requireUuid(questionId, "questionId");
    const key = idempotencyKeyHeader(header);
    const operation = "check_in.submit_response";
    return this.transaction(principal, async (tx) => {
      const reserved = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprintRequest({ sessionId, questionId, canonicalText, editedText }) });
      const result = await this.service.submitTextResponse(this.actor(principal), { sessionId: id, questionId: question, canonicalText, editedText, idempotencyKey: key });
      if (reserved === "replayed") return result;
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        correlationId: principal.correlationId,
        audit: { action: "check_in.response_submitted", targetType: "check_in_session", targetId: id, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "check_in_session", aggregateId: id, topic: "check_in.response_submitted", payload: { submission_id: result.session.submission_id } },
        domainWrite: async () => undefined,
      });
      return result;
    });
  }

  async submitVoiceResponse(principal: Principal, input: {
    sessionId: string;
    questionId: string;
    transcript: string;
    editedTranscript: string | null;
    idempotencyKey: string;
  }): Promise<SubmittedVoiceResponse> {
    const sessionId = requireUuid(input.sessionId, "sessionId");
    const questionId = requireUuid(input.questionId, "questionId");
    if (!input.idempotencyKey || !/^[A-Za-z0-9._:-]{1,255}$/.test(input.idempotencyKey)) throw invalid();
    const operation = "check_in.submit_voice_response";
    return this.transaction(principal, async (tx) => {
      const reserved = await reserveIdempotencyKey(tx, {
        organizationId: principal.organizationId,
        operation,
        key: input.idempotencyKey,
        requestFingerprint: fingerprintRequest({ sessionId, questionId, transcript: input.transcript, editedTranscript: input.editedTranscript }),
      });
      const result = await this.service.submitVoiceResponse(this.actor(principal), {
        sessionId,
        questionId,
        transcript: input.transcript,
        editedTranscript: input.editedTranscript,
        idempotencyKey: input.idempotencyKey,
      });
      if (reserved === "replayed") return result;
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        correlationId: principal.correlationId,
        audit: { action: "check_in.voice_response_submitted", targetType: "check_in_session", targetId: sessionId, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "check_in_session", aggregateId: sessionId, topic: "check_in.voice_response_submitted", payload: { submission_id: result.session.submission_id } },
        domainWrite: async () => undefined,
      });
      return result;
    });
  }

  async getReceipt(principal: Principal, sessionId: string) {
    const id = requireUuid(sessionId, "sessionId");
    return this.transaction(principal, async () => await this.service.getReceipt(this.actor(principal), id));
  }

  async getTimeline(principal: Principal, sessionId: string) {
    const id = requireUuid(sessionId, "sessionId");
    return this.transaction(principal, async () => await this.service.getTimeline(this.actor(principal), id));
  }

  /** F07a bridge: trusted resolution of a voice session for credential minting. */
  async resolveVoiceSession(principal: Principal, sessionId: string, questionId?: string): Promise<ResolvedVoiceSession> {
    const id = requireUuid(sessionId, "sessionId");
    return this.transaction(principal, async () => await this.service.resolveVoiceSession(this.actor(principal), id, questionId));
  }

  /** Maps the inner service's domain error to an HTTP-safe error. */
  static httpError(error: unknown): CheckInHttpError | undefined {
    if (error instanceof SessionError) {
      switch (error.code) {
        case "NOT_FOUND": return notFound();
        case "FORBIDDEN": return new CheckInHttpError(403, "forbidden");
        case "INVALID_STATE": return conflict();
        case "IDEMPOTENCY_CONFLICT": return new CheckInHttpError(409, "idempotency_conflict");
        case "CONFLICT": return conflict();
        case "INVALID_REQUEST": return invalid();
        default: return notFound();
      }
    }
    if (error instanceof IdempotencyConflictError) return new CheckInHttpError(409, "idempotency_conflict");
    return undefined;
  }
}
