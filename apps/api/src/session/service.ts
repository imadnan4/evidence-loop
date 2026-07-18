import { randomUUID } from "node:crypto";

import {
  CheckInSessionSchema,
  ContractValidationError,
  QuestionSchema,
  ResponseSchema,
  assertNoProhibitedFields,
  opaqueId,
  type CheckInSession,
  type Question,
  type Response,
  type SourceRef,
} from "@evidence-loop/contracts/v1";

import { IdempotencyConflictError } from "./in-memory-repository.ts";
import type {
  Actor,
  CheckInReceipt,
  CreateTextSessionRequest,
  PolicyBriefing,
  ResolvedTextCheckInContext,
  SessionContext,
  SessionMutationInput,
  SessionRepository,
  SessionTimelineEvent,
  StartTextSessionInput,
  StartedSession,
  SubmittedResponse,
  SubmitTextResponseInput,
  TrustedSessionResolver,
} from "./types.ts";

export class SessionError extends Error {
  readonly code: "INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "IDEMPOTENCY_CONFLICT";

  constructor(
    code: "INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "IDEMPOTENCY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

type Dependencies = Readonly<{ id?: () => string; now?: () => string }>;

/**
 * Deterministic, text-only F04a workflow control. It owns state transitions;
 * question text is a fixed placeholder planner and no model can change state.
 */
export class TextCheckInSessionService {
  private readonly repository: SessionRepository;
  private readonly resolver: TrustedSessionResolver;
  private readonly id: () => string;
  private readonly now: () => string;

  constructor(repository: SessionRepository, resolver: TrustedSessionResolver, dependencies: Dependencies = {}) {
    this.repository = repository;
    this.resolver = resolver;
    this.id = dependencies.id ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  createSession(actor: Actor, input: CreateTextSessionRequest): CheckInSession {
    const actorId = this.actorId(actor);
    this.assertAllowedKeys(input, "createSession", ["submissionId", "idempotencyKey"]);
    const submissionId = this.requireOpaque(input.submissionId, "submissionId");
    const idempotencyKey = this.requireOpaque(input.idempotencyKey, "idempotencyKey");
    const resolved = this.resolver.resolveForLearner(actorId, submissionId);
    if (!resolved) throw this.notFound();
    const normalized = this.normalizeResolvedContext(resolved, actorId, submissionId);

    return this.idempotent(actorId, "create", idempotencyKey, { submissionId, idempotencyKey }, () => {
      const session: CheckInSession = CheckInSessionSchema.parse({
        id: this.id(),
        submission_id: normalized.submissionId,
        assessment_version_id: normalized.assessmentVersionId,
        policy_version_id: normalized.policyVersionId,
        state: "ready",
        mode: "text",
        question_budget: normalized.questionBudget,
        questions_asked: 0,
        started_at: null,
        paused_at: null,
        completed_at: null,
      });
      const context: SessionContext = Object.freeze({
        learnerId: normalized.learnerId,
        policy: Object.freeze(normalized.policy),
        pauseAndResume: normalized.pauseAndResume,
        timeBudgetMinutes: normalized.timeBudgetMinutes,
        objectives: Object.freeze(normalized.objectives.map((objective) => Object.freeze({ ...objective }))),
        objectiveSources: Object.freeze(
          normalized.objectiveSources.map((entry) =>
            Object.freeze({ objectiveId: entry.objectiveId, sourceRefs: Object.freeze(entry.sourceRefs.map((source) => Object.freeze({ ...source }))) }),
          ),
        ),
        policyShownAt: null,
        policyAcknowledgedAt: null,
      });
      this.repository.saveSession(session);
      this.repository.saveContext(session.id, context);
      return session;
    });
  }

  /** Records a learner-visible policy display before assessment can start. */
  showPolicy(actor: Actor, input: SessionMutationInput): PolicyBriefing {
    this.assertAllowedKeys(input, "showPolicy", ["sessionId", "idempotencyKey"]);
    const session = this.requireOwnedSession(actor, input.sessionId);
    const context = this.requireContext(session.id);
    return this.idempotent(actor.userId, "show-policy", input.idempotencyKey, input, () => {
      if (!context.policyShownAt) {
        const occurredAt = this.now();
        this.repository.saveContext(session.id, { ...context, policyShownAt: occurredAt });
        this.recordEvent(session, actor.userId, "policy_shown", null, null, occurredAt);
      }
      return Object.freeze({
        session: this.requireSession(session.id),
        policy: context.policy,
        textCheckInAvailable: true as const,
        pauseAndResumeAvailable: context.pauseAndResume,
      });
    });
  }

  acknowledgePolicy(actor: Actor, input: SessionMutationInput & Readonly<{ policyVersionId: string }>): CheckInSession {
    this.assertAllowedKeys(input, "acknowledgePolicy", ["sessionId", "policyVersionId", "idempotencyKey"]);
    const session = this.requireOwnedSession(actor, input.sessionId);
    const context = this.requireContext(session.id);
    this.requireOpaque(input.policyVersionId, "policyVersionId");
    return this.idempotent(actor.userId, "acknowledge-policy", input.idempotencyKey, input, () => {
      if (input.policyVersionId !== session.policy_version_id) {
        throw new SessionError("INVALID_REQUEST", "The displayed policy version does not match this check-in.");
      }
      if (!context.policyShownAt) {
        throw new SessionError("INVALID_STATE", "Show the learner-facing policy before acknowledging it.");
      }
      if (!context.policyAcknowledgedAt) {
        const occurredAt = this.now();
        this.repository.saveContext(session.id, { ...context, policyAcknowledgedAt: occurredAt });
        this.recordEvent(session, actor.userId, "policy_acknowledged", null, null, occurredAt);
      }
      return this.requireSession(session.id);
    });
  }

  start(actor: Actor, input: StartTextSessionInput): StartedSession {
    this.assertAllowedKeys(input, "start", ["sessionId", "policyVersionId", "mode", "idempotencyKey"]);
    const session = this.requireOwnedSession(actor, input.sessionId);
    const context = this.requireContext(session.id);
    return this.idempotent(actor.userId, "start", input.idempotencyKey, input, () => {
      if (input.mode !== "text") throw new SessionError("INVALID_REQUEST", "F04a supports the equivalent typed-response route only.");
      if (input.policyVersionId !== session.policy_version_id) {
        throw new SessionError("INVALID_REQUEST", "The selected policy version does not match this check-in.");
      }
      if (!context.policyAcknowledgedAt) {
        throw new SessionError("INVALID_STATE", "Acknowledge the learner-facing policy before starting.");
      }
      if (session.state !== "ready") throw new SessionError("INVALID_STATE", "Only a ready check-in can be started.");

      const startedAt = this.now();
      const started = this.saveSession({ ...session, state: "in_progress", started_at: startedAt });
      this.recordEvent(started, actor.userId, "session_started", "ready", "in_progress", startedAt);
      const question = this.issueQuestion(started, context, actor.userId);
      return Object.freeze({ session: this.requireSession(started.id), question });
    });
  }

  pause(actor: Actor, input: SessionMutationInput): CheckInSession {
    this.assertAllowedKeys(input, "pause", ["sessionId", "idempotencyKey"]);
    const session = this.requireOwnedSession(actor, input.sessionId);
    const context = this.requireContext(session.id);
    return this.idempotent(actor.userId, "pause", input.idempotencyKey, input, () => {
      if (!context.pauseAndResume) throw new SessionError("INVALID_STATE", "Pause and resume are not enabled for this check-in.");
      if (session.state !== "in_progress") throw new SessionError("INVALID_STATE", "Only an in-progress check-in can be paused.");
      const occurredAt = this.now();
      this.completeIfTimeBudgetReached(session, context, actor.userId, occurredAt);
      const paused = this.saveSession({ ...session, state: "paused", paused_at: occurredAt });
      this.recordEvent(paused, actor.userId, "session_paused", "in_progress", "paused", occurredAt);
      return paused;
    });
  }

  resume(actor: Actor, input: SessionMutationInput): CheckInSession {
    this.assertAllowedKeys(input, "resume", ["sessionId", "idempotencyKey"]);
    const session = this.requireOwnedSession(actor, input.sessionId);
    const context = this.requireContext(session.id);
    return this.idempotent(actor.userId, "resume", input.idempotencyKey, input, () => {
      if (!context.pauseAndResume) throw new SessionError("INVALID_STATE", "Pause and resume are not enabled for this check-in.");
      if (session.state !== "paused") throw new SessionError("INVALID_STATE", "Only a paused check-in can be resumed.");
      const occurredAt = this.now();
      const resumed = this.saveSession({ ...session, state: "in_progress", paused_at: null });
      this.recordEvent(resumed, actor.userId, "session_resumed", "paused", "in_progress", occurredAt);
      return resumed;
    });
  }

  submitTextResponse(actor: Actor, input: SubmitTextResponseInput): SubmittedResponse {
    this.assertAllowedKeys(input, "submitTextResponse", ["sessionId", "questionId", "canonicalText", "editedText", "idempotencyKey"]);
    const session = this.requireOwnedSession(actor, input.sessionId);
    const canonicalText = this.requireText(input.canonicalText, "canonicalText");
    const editedText = input.editedText === null ? null : this.requireText(input.editedText, "editedText");
    return this.idempotent(actor.userId, "submit-response", input.idempotencyKey, { ...input, canonicalText, editedText }, () => {
      if (session.state !== "in_progress") throw new SessionError("INVALID_STATE", "Responses can only be submitted while the check-in is in progress.");
      const submittedAt = this.now();
      this.completeIfTimeBudgetReached(session, this.requireContext(session.id), actor.userId, submittedAt);
      const question = this.requireQuestion(input.questionId);
      if (question.session_id !== session.id || question.submission_id !== session.submission_id) throw this.notFound();
      if (this.repository.getResponseForQuestion(question.id)) {
        throw new SessionError("CONFLICT", "This question already has a canonical response.");
      }
      const response: Response = ResponseSchema.parse({
        id: this.id(),
        question_id: question.id,
        session_id: session.id,
        submission_id: session.submission_id,
        modality: "text",
        canonical_text: canonicalText,
        edited_text: editedText,
        started_at: session.started_at,
        submitted_at: submittedAt,
      });
      this.repository.saveResponse(response);
      this.recordEvent(session, actor.userId, "response_submitted", "in_progress", "in_progress", submittedAt);

      if (session.questions_asked === session.question_budget) {
        const completed = this.saveSession({ ...session, state: "completed", completed_at: submittedAt });
        this.recordEvent(completed, actor.userId, "session_completed", "in_progress", "completed", submittedAt);
        return Object.freeze({ session: completed, response, nextQuestion: null });
      }
      const questionAfterResponse = this.issueQuestion(session, this.requireContext(session.id), actor.userId);
      return Object.freeze({ session: this.requireSession(session.id), response, nextQuestion: questionAfterResponse });
    });
  }

  requestHumanFollowUp(actor: Actor, input: SessionMutationInput): CheckInSession {
    this.assertAllowedKeys(input, "requestHumanFollowUp", ["sessionId", "idempotencyKey"]);
    const session = this.requireOwnedSession(actor, input.sessionId);
    return this.idempotent(actor.userId, "request-human-follow-up", input.idempotencyKey, input, () => {
      if (session.state !== "in_progress" && session.state !== "paused") {
        throw new SessionError("INVALID_STATE", "A human follow-up can only be requested during a check-in.");
      }
      const occurredAt = this.now();
      const requested = this.saveSession({ ...session, state: "human_follow_up", paused_at: null });
      this.recordEvent(requested, actor.userId, "human_follow_up_requested", session.state, "human_follow_up", occurredAt);
      return requested;
    });
  }

  getReceipt(actor: Actor, sessionId: string): CheckInReceipt {
    const session = this.requireOwnedSession(actor, sessionId);
    if (session.state !== "completed" && session.state !== "human_follow_up") {
      throw new SessionError("INVALID_STATE", "A receipt is available after completion or a human follow-up request.");
    }
    return Object.freeze({
      session,
      policyVersionId: session.policy_version_id,
      questions: this.repository.listQuestions(session.id),
      responses: this.repository.listResponses(session.id),
      completedAt: session.completed_at,
    });
  }

  getTimeline(actor: Actor, sessionId: string): readonly SessionTimelineEvent[] {
    const session = this.requireOwnedSession(actor, sessionId);
    return this.repository.listEvents(session.id);
  }

  /** Completes only when the configured time limit has elapsed; pauses do not consume the learner's budget. */
  private completeIfTimeBudgetReached(
    session: CheckInSession,
    context: SessionContext,
    actorId: string,
    occurredAt: string,
  ): void {
    const startedAt = Date.parse(session.started_at!);
    const now = Date.parse(occurredAt);
    let pausedAt: number | null = null;
    let pausedMilliseconds = 0;
    for (const event of this.repository.listEvents(session.id)) {
      if (event.action === "session_paused") pausedAt = Date.parse(event.occurredAt);
      if (event.action === "session_resumed" && pausedAt !== null) {
        pausedMilliseconds += Date.parse(event.occurredAt) - pausedAt;
        pausedAt = null;
      }
    }
    if (pausedAt !== null) pausedMilliseconds += now - pausedAt;
    const activeMilliseconds = now - startedAt - pausedMilliseconds;
    if (activeMilliseconds < context.timeBudgetMinutes * 60_000) return;

    const completed = this.saveSession({ ...session, state: "completed", paused_at: null, completed_at: occurredAt });
    this.recordEvent(completed, actorId, "session_completed", session.state, "completed", occurredAt);
    throw new SessionError("INVALID_STATE", "The finite check-in time budget has been reached.");
  }

  private issueQuestion(session: CheckInSession, context: SessionContext, actorId: string): Question {
    const sequence = session.questions_asked + 1;
    if (sequence > session.question_budget) throw new SessionError("INVALID_STATE", "The finite question budget has been reached.");
    const objective = context.objectives[(sequence - 1) % context.objectives.length]!;
    const sources = context.objectiveSources.find((entry) => entry.objectiveId === objective.id)!.sourceRefs;
    const kind = (["explain", "apply", "revise", "compare"] as const)[(sequence - 1) % 4]!;
    const question: Question = QuestionSchema.parse({
      id: this.id(),
      session_id: session.id,
      submission_id: session.submission_id,
      objective_id: objective.id,
      sequence,
      text: `Describe your reasoning about ${objective.label} using the relevant part of your submitted work.`,
      kind,
      rationale: `This deterministic question invites you to show your thinking about the approved objective: ${objective.label}.`,
      source_refs: sources,
      created_at: this.now(),
    });
    this.repository.saveQuestion(question);
    const withQuestion = this.saveSession({ ...session, questions_asked: sequence });
    this.recordEvent(withQuestion, actorId, "question_issued", withQuestion.state, withQuestion.state, question.created_at);
    return question;
  }

  private saveSession(candidate: CheckInSession): CheckInSession {
    const session = CheckInSessionSchema.parse(candidate);
    this.repository.saveSession(session);
    return session;
  }

  private recordEvent(
    session: CheckInSession,
    actorId: string,
    action: SessionTimelineEvent["action"],
    priorState: CheckInSession["state"] | null,
    newState: CheckInSession["state"] | null,
    occurredAt: string,
  ): void {
    this.repository.saveEvent(Object.freeze({
      id: this.id(), sessionId: session.id, actorId, action, priorState, newState,
      policyVersionId: session.policy_version_id, correlationId: this.id(), occurredAt,
    }));
  }

  private normalizeResolvedContext(input: ResolvedTextCheckInContext, actorId: string, submissionId: string) {
    this.assertAllowedKeys(input, "resolvedContext", [
      "submissionId", "learnerId", "submissionCourseId", "assessmentCourseId", "submissionState", "assessmentVersionId", "assessmentVersionState",
      "policyVersionId", "policy", "questionBudget", "timeBudgetMinutes", "pauseAndResume", "objectives",
      "objectiveFragmentIds", "fragments",
    ]);
    if (input.submissionId !== submissionId || input.learnerId !== actorId) throw this.notFound();
    if (input.submissionState !== "ready") throw new SessionError("INVALID_STATE", "The submission is not ready for a check-in.");
    if (input.assessmentVersionState !== "published") throw new SessionError("INVALID_STATE", "Check-ins require a published assessment version.");
    const assessmentVersionId = this.requireOpaque(input.assessmentVersionId, "resolvedContext.assessmentVersionId");
    const policyVersionId = this.requireOpaque(input.policyVersionId, "resolvedContext.policyVersionId");
    if (policyVersionId !== assessmentVersionId) throw this.invalid("The resolved policy version must match the published assessment version.");
    const submissionCourseId = this.requireOpaque(input.submissionCourseId, "resolvedContext.submissionCourseId");
    const assessmentCourseId = this.requireOpaque(input.assessmentCourseId, "resolvedContext.assessmentCourseId");
    if (submissionCourseId !== assessmentCourseId) throw this.invalid("The submission and published assessment version must belong to the same course.");

    const objectives = Array.isArray(input.objectives) ? input.objectives : this.invalid("Resolved objectives must be an array.");
    const assessable = objectives.filter((objective) => objective?.assessableInCheckIn === true);
    if (assessable.length < 3 || assessable.length > 5) {
      throw this.invalid("A text check-in requires 3 to 5 instructor-approved assessable objectives.");
    }
    const objectiveIds = new Set<string>();
    const normalizedObjectives = assessable.map((objective, index) => {
      this.assertAllowedKeys(objective, `resolvedContext.objectives[${index}]`, ["id", "label", "assessableInCheckIn", "approvedBy", "approvedAt"]);
      const id = this.requireOpaque(objective.id, `resolvedContext.objectives[${index}].id`);
      if (objectiveIds.has(id)) throw this.invalid("Assessable objectives must be unique.");
      this.requireOpaque(objective.approvedBy, `resolvedContext.objectives[${index}].approvedBy`);
      this.requireText(objective.approvedAt, `resolvedContext.objectives[${index}].approvedAt`);
      objectiveIds.add(id);
      return { id, label: this.requireText(objective.label, `resolvedContext.objectives[${index}].label`), assessableInCheckIn: true } as const;
    });

    const fragments = Array.isArray(input.fragments) ? input.fragments : this.invalid("Resolved fragments must be an array.");
    const fragmentById = new Map<string, { id: string; submissionId: string; locator: string }>();
    for (const [index, fragment] of fragments.entries()) {
      this.assertAllowedKeys(fragment, `resolvedContext.fragments[${index}]`, ["id", "submissionId", "locator"]);
      const id = this.requireOpaque(fragment.id, `resolvedContext.fragments[${index}].id`);
      const fragmentSubmissionId = this.requireOpaque(fragment.submissionId, `resolvedContext.fragments[${index}].submissionId`);
      if (fragmentSubmissionId !== submissionId) throw this.invalid("Resolved fragments must belong to the current submission.");
      if (fragmentById.has(id)) throw this.invalid("Resolved fragment IDs must be unique.");
      fragmentById.set(id, { id, submissionId: fragmentSubmissionId, locator: this.requireText(fragment.locator, `resolvedContext.fragments[${index}].locator`) });
    }

    const mappings = Array.isArray(input.objectiveFragmentIds) ? input.objectiveFragmentIds : this.invalid("Resolved objective fragments must be an array.");
    const normalizedSources = mappings.map((mapping, index) => {
      this.assertAllowedKeys(mapping, `resolvedContext.objectiveFragmentIds[${index}]`, ["objectiveId", "fragmentIds"]);
      const objectiveId = this.requireOpaque(mapping.objectiveId, `resolvedContext.objectiveFragmentIds[${index}].objectiveId`);
      if (!objectiveIds.has(objectiveId)) throw this.invalid("Question provenance may only map approved objectives.");
      if (!Array.isArray(mapping.fragmentIds) || mapping.fragmentIds.length === 0) throw this.invalid("Every objective needs a current-submission artifact fragment.");
      const sourceRefs: SourceRef[] = mapping.fragmentIds.map((fragmentId, fragmentIndex) => {
        const fragment = fragmentById.get(this.requireOpaque(fragmentId, `resolvedContext.objectiveFragmentIds[${index}].fragmentIds[${fragmentIndex}]`));
        if (!fragment) throw this.invalid("Question provenance must reference an existing current-submission fragment.");
        return { source_type: "artifact_fragment", source_id: fragment.id, submission_id: fragment.submissionId, locator: fragment.locator };
      });
      return { objectiveId, sourceRefs };
    });
    if (normalizedSources.length !== normalizedObjectives.length || new Set(normalizedSources.map((entry) => entry.objectiveId)).size !== normalizedObjectives.length) {
      throw this.invalid("Every assessable objective needs exactly one provenance mapping.");
    }

    const policy = input.policy;
    this.assertAllowedKeys(policy, "resolvedContext.policy", ["learnerFacingText", "aiUsePolicy", "privacySummary", "completionCriteria"]);
    if (policy.aiUsePolicy !== "allowed" && policy.aiUsePolicy !== "allowed_with_disclosure" && policy.aiUsePolicy !== "not_allowed") {
      throw this.invalid("resolvedContext.policy.aiUsePolicy is invalid.");
    }
    if (typeof input.pauseAndResume !== "boolean") throw this.invalid("pauseAndResume must be true or false.");
    return {
      submissionId,
      assessmentVersionId,
      policyVersionId,
      learnerId: actorId,
      questionBudget: this.whole(input.questionBudget, "resolvedContext.questionBudget", 3, 5),
      timeBudgetMinutes: this.whole(input.timeBudgetMinutes, "resolvedContext.timeBudgetMinutes", 3, 8),
      policy: {
        learnerFacingText: this.requireText(policy.learnerFacingText, "resolvedContext.policy.learnerFacingText"),
        aiUsePolicy: policy.aiUsePolicy,
        privacySummary: this.requireText(policy.privacySummary, "resolvedContext.policy.privacySummary"),
        completionCriteria: this.requireText(policy.completionCriteria, "resolvedContext.policy.completionCriteria"),
      },
      pauseAndResume: input.pauseAndResume,
      objectives: normalizedObjectives,
      objectiveSources: normalizedSources,
    };
  }

  private idempotent<T>(actorId: string, operation: string, key: string, request: unknown, execute: () => T): T {
    const idempotencyKey = this.requireOpaque(key, "idempotencyKey");
    const scope = `${actorId}:${operation}:${idempotencyKey}`;
    const fingerprint = stableJson(request);
    try {
      const replay = this.repository.getIdempotentResult<T>(scope, fingerprint);
      if (replay !== undefined) return replay;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) throw new SessionError(error.code, error.message);
      throw error;
    }
    const result = execute();
    this.repository.saveIdempotentResult(scope, fingerprint, result);
    return result;
  }

  private requireOwnedSession(actor: Actor, sessionId: string): CheckInSession {
    const session = this.requireSession(sessionId);
    if (this.requireContext(session.id).learnerId !== this.actorId(actor)) throw this.forbidden();
    return session;
  }

  private requireSession(sessionId: string): CheckInSession {
    const session = this.repository.getSession(this.requireOpaque(sessionId, "sessionId"));
    if (!session) throw this.notFound();
    return session;
  }

  private requireContext(sessionId: string): SessionContext {
    const context = this.repository.getContext(sessionId);
    if (!context) throw this.notFound();
    return context;
  }

  private requireQuestion(questionId: string): Question {
    const question = this.repository.getQuestion(this.requireOpaque(questionId, "questionId"));
    if (!question) throw this.notFound();
    return question;
  }

  private assertAllowedKeys(value: unknown, name: string, keys: readonly string[]): asserts value is Record<string, unknown> {
    try {
      assertNoProhibitedFields(value, name);
    } catch (error) {
      if (error instanceof ContractValidationError) throw this.invalid(error.message);
      throw error;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw this.invalid(`${name} must be an object.`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw this.invalid(`${name}.${key} is not allowed.`);
  }

  private actorId(actor: Actor): string {
    return this.requireOpaque(actor?.userId, "authenticated actor.userId");
  }

  private requireOpaque(value: unknown, name: string): string {
    try {
      return opaqueId(value, name);
    } catch (error) {
      if (error instanceof ContractValidationError) throw this.invalid(error.message);
      throw error;
    }
  }

  private requireText(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) throw this.invalid(`${name} is required.`);
    return value.trim();
  }

  private whole(value: unknown, name: string, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw this.invalid(`${name} must be a whole number from ${min} to ${max}.`);
    }
    return value as number;
  }

  private invalid(message: string): SessionError { return new SessionError("INVALID_REQUEST", message); }
  private forbidden(): SessionError { return new SessionError("FORBIDDEN", "You are not authorized to access this check-in."); }
  private notFound(): SessionError { return new SessionError("NOT_FOUND", "The requested check-in resource was not found."); }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")} ]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
