import { randomUUID } from "node:crypto";
import type {
  CheckInSession,
  Question,
  Response,
  SourceRef,
} from "@evidence-loop/contracts/v1";
import {
  CheckInSessionSchema,
  QuestionSchema,
  ResponseSchema,
} from "@evidence-loop/contracts/v1";
import { IdempotencyConflictError, withTenantTransaction } from "@evidence-loop/db";
import type { Sql, TransactionSql, JSONValue } from "postgres";
import type {
  SessionContext,
  SessionEventAction,
  SessionRepository,
  SessionTimelineEvent,
  SubmittedVoiceResponse,
  VoiceResponseCommit,
  VoiceTranscript,
} from "./types.ts";

type SessionRow = {
  id: string;
  organization_id: string;
  learner_id: string;
  submission_id: string;
  assessment_version_id: string;
  policy_version_id: string;
  state: "ready" | "in_progress" | "paused" | "completed" | "human_follow_up";
  mode: "text" | "voice";
  question_budget: number;
  questions_asked: number;
  started_at: Date | null;
  paused_at: Date | null;
  completed_at: Date | null;
};

type ContextRow = {
  session_id: string;
  organization_id: string;
  submission_id: string;
  learner_id: string;
  policy_learner_facing_text: string;
  policy_ai_use: "allowed" | "allowed_with_disclosure" | "not_allowed";
  policy_privacy_summary: string;
  policy_completion_criteria: string;
  pause_and_resume: boolean;
  time_budget_minutes: number;
  voice_check_in_enabled: boolean;
  objectives: { id: string; label: string; assessableInCheckIn: boolean }[];
  objective_sources: { objectiveId: string; sourceRefs: SourceRef[] }[];
  policy_shown_at: Date | null;
  policy_acknowledged_at: Date | null;
};

type QuestionRow = {
  id: string;
  session_id: string;
  submission_id: string;
  objective_id: string;
  sequence: number;
  text: string;
  kind: "explain" | "apply" | "revise" | "compare";
  rationale: string;
  source_refs: SourceRef[];
  created_at: Date;
};

type ResponseRow = {
  id: string;
  question_id: string;
  session_id: string;
  submission_id: string;
  modality: "text" | "voice";
  canonical_text: string;
  edited_text: string | null;
  started_at: Date;
  submitted_at: Date;
};

type VoiceTranscriptRow = {
  id: string;
  response_id: string;
  session_id: string;
  submission_id: string;
  question_id: string;
  transcript: string;
  edited_transcript: string | null;
  canonical_text: string;
  created_at: Date;
  submitted_at: Date;
};

/**
 * Durable session repository. It implements the in-memory contract used by
 * `TextCheckInSessionService` but persists every entity to PostgreSQL inside
 * tenant-scoped transactions. Contract rows do not carry organization_id or the
 * learner_id, so those are resolved from the transaction-local GUCs
 * (current_organization_id / current_actor_id) that the durable service sets.
 * State transitions, policy acknowledgement, and immutable rows are written only
 * through the fixed SECURITY DEFINER functions declared in migration 0004, so the
 * non-owner API role cannot skip validation.
 */
export class DurableSessionRepository implements SessionRepository {
  private readonly _client: Sql<{}>;
  private tx: TransactionSql | null = null;

  constructor(client: Sql<{}>) {
    this._client = client;
  }

  /** Binds the repository to an open tenant transaction so every query runs on
   * the same connection and inherits the transaction-local GUCs (org/actor).
   * Without this, repository queries would escape to a separate pooled
   * connection and bypass the active transaction and row-level security. */
  bind(transaction: TransactionSql | null): void {
    this.tx = transaction;
  }

  /** The active tenant transaction when bound, otherwise the pool client. All
   * repository queries use this so they stay inside the caller's transaction. */
  private get client(): TransactionSql {
    const bound = this.tx;
    if (!bound) throw new Error("DurableSessionRepository used outside a tenant transaction.");
    return bound;
  }

  async saveSession(session: CheckInSession): Promise<void> {
    const parsed = CheckInSessionSchema.parse(session);
    // Update first (lifecycle transitions on an existing row); fall back to an
    // insert only when the row does not yet exist. This avoids an
    // INSERT...ON CONFLICT, which would re-evaluate the insert-time boundary
    // check (state must be 'ready') on the would-be-inserted transition row.
    const updated = await this.client`
      UPDATE check_in_sessions SET
        state = ${parsed.state},
        questions_asked = ${parsed.questions_asked},
        started_at = ${parsed.started_at},
        paused_at = ${parsed.paused_at},
        completed_at = ${parsed.completed_at},
        updated_at = now()
      WHERE id = ${parsed.id}`;
    if (Number(updated.count ?? 0) > 0) return;
    await this.client`
      INSERT INTO check_in_sessions (
        id, organization_id, submission_id, assessment_version_id, policy_version_id, learner_id,
        state, mode, question_budget, questions_asked, started_at, paused_at, completed_at
      )
      VALUES (
        ${parsed.id}, (SELECT current_organization_id()), ${parsed.submission_id}, ${parsed.assessment_version_id}, ${parsed.policy_version_id}, (SELECT current_actor_id()),
        ${parsed.state}, ${parsed.mode}, ${parsed.question_budget}, ${parsed.questions_asked}, ${parsed.started_at}, ${parsed.paused_at}, ${parsed.completed_at}
      )`;
  }

  async getSession(sessionId: string): Promise<CheckInSession | undefined> {
    const rows = await this.client<SessionRow[]>`
      SELECT id, organization_id, submission_id, assessment_version_id, policy_version_id, learner_id, state, mode, question_budget, questions_asked, started_at, paused_at, completed_at
      FROM check_in_sessions WHERE id = ${sessionId}`;
    const row = rows[0];
    if (!row) return undefined;
    return this.toSession(row);
  }

  async findSessionForSubmission(actorId: string, submissionId: string): Promise<CheckInSession | undefined> {
    const rows = await this.client<SessionRow[]>`
      SELECT id, organization_id, submission_id, assessment_version_id, policy_version_id, learner_id, state, mode, question_budget, questions_asked, started_at, paused_at, completed_at
      FROM check_in_sessions WHERE submission_id = ${submissionId} AND learner_id = ${actorId}
      ORDER BY created_at DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return undefined;
    return this.toSession(row);
  }

  async saveContext(sessionId: string, context: SessionContext): Promise<void> {
    // The session context is immutable except for the learner-visible policy
    // timestamps. Update only those columns when present (so the immutable
    // provenance columns are never rewritten), then create the row on first
    // write. This avoids an INSERT...ON CONFLICT that would re-touch immutable
    // jsonb columns on replay.
    const policyShown = context.policyShownAt ? new Date(context.policyShownAt) : null;
    const policyAck = context.policyAcknowledgedAt ? new Date(context.policyAcknowledgedAt) : null;
    if (policyShown || policyAck) {
      const sets: string[] = [];
      const values: Array<Date | string> = [];
      if (policyShown) { sets.push("policy_shown_at = $1"); values.push(policyShown); }
      if (policyAck) { sets.push(`policy_acknowledged_at = $${values.length + 1}`); values.push(policyAck); }
      const result = await this.client.unsafe(
        `UPDATE check_in_session_contexts SET ${sets.join(", ")} WHERE session_id = $${values.length + 1}`,
        [...values, sessionId],
      );
      if (Number(result.count ?? 0) > 0) return;
    }
    await this.client`
      INSERT INTO check_in_session_contexts (
        session_id, organization_id, submission_id, learner_id,
        policy_learner_facing_text, policy_ai_use, policy_privacy_summary, policy_completion_criteria,
        pause_and_resume, time_budget_minutes, voice_check_in_enabled,
        objectives, objective_sources, policy_shown_at, policy_acknowledged_at
      )
      VALUES (
        ${sessionId}, (SELECT current_organization_id()), ${context.submissionId}, ${context.learnerId},
        ${context.policy.learnerFacingText}, ${context.policy.aiUsePolicy}, ${context.policy.privacySummary}, ${context.policy.completionCriteria},
        ${context.pauseAndResume}, ${context.timeBudgetMinutes}, ${context.voiceCheckInEnabled},
        ${this.client.json(context.objectives as unknown as JSONValue)}, ${this.client.json(context.objectiveSources as unknown as JSONValue)},
        ${policyShown}, ${policyAck}
      )
      ON CONFLICT (session_id) DO NOTHING`;
  }

  async getContext(sessionId: string): Promise<SessionContext | undefined> {
    const rows = await this.client<ContextRow[]>`
      SELECT session_id, organization_id, submission_id, learner_id,
        policy_learner_facing_text, policy_ai_use, policy_privacy_summary, policy_completion_criteria,
        pause_and_resume, time_budget_minutes, voice_check_in_enabled,
        objectives, objective_sources, policy_shown_at, policy_acknowledged_at
      FROM check_in_session_contexts WHERE session_id = ${sessionId}`;
    const row = rows[0];
    if (!row) return undefined;
    return this.toContext(row);
  }

  async saveQuestion(question: Question): Promise<void> {
    const parsed = QuestionSchema.parse(question);
    await this.client`
      INSERT INTO check_in_questions (id, organization_id, session_id, submission_id, objective_id, sequence, text, kind, rationale, source_refs)
      VALUES (${parsed.id}, (SELECT current_organization_id()), ${parsed.session_id}, ${parsed.submission_id}, ${parsed.objective_id}, ${parsed.sequence}, ${parsed.text}, ${parsed.kind}, ${parsed.rationale}, ${this.client.json(parsed.source_refs as unknown as JSONValue)})
      ON CONFLICT (id) DO NOTHING`;
  }

  async listQuestions(sessionId: string): Promise<readonly Question[]> {
    const rows = await this.client<QuestionRow[]>`
      SELECT id, session_id, submission_id, objective_id, sequence, text, kind, rationale, source_refs, created_at
      FROM check_in_questions WHERE session_id = ${sessionId} ORDER BY sequence`;
    return rows.map((row) => this.toQuestion(row));
  }

  async getQuestion(questionId: string): Promise<Question | undefined> {
    const rows = await this.client<QuestionRow[]>`
      SELECT id, session_id, submission_id, objective_id, sequence, text, kind, rationale, source_refs, created_at
      FROM check_in_questions WHERE id = ${questionId}`;
    const row = rows[0];
    if (!row) return undefined;
    return this.toQuestion(row);
  }

  async saveResponse(response: Response): Promise<void> {
    const parsed = ResponseSchema.parse(response);
    await this.client`
      INSERT INTO check_in_responses (id, organization_id, question_id, session_id, submission_id, modality, canonical_text, edited_text, started_at, submitted_at)
      VALUES (${parsed.id}, (SELECT current_organization_id()), ${parsed.question_id}, ${parsed.session_id}, ${parsed.submission_id}, ${parsed.modality}, ${parsed.canonical_text}, ${parsed.edited_text}, ${new Date(parsed.started_at)}, ${new Date(parsed.submitted_at)})
      ON CONFLICT (id) DO NOTHING`;
  }

  async getResponseForQuestion(questionId: string): Promise<Response | undefined> {
    const rows = await this.client<ResponseRow[]>`
      SELECT id, question_id, session_id, submission_id, modality, canonical_text, edited_text, started_at, submitted_at
      FROM check_in_responses WHERE question_id = ${questionId}`;
    const row = rows[0];
    if (!row) return undefined;
    return this.toResponse(row);
  }

  async listResponses(sessionId: string): Promise<readonly Response[]> {
    const rows = await this.client<ResponseRow[]>`
      SELECT id, question_id, session_id, submission_id, modality, canonical_text, edited_text, started_at, submitted_at
      FROM check_in_responses WHERE session_id = ${sessionId} ORDER BY submitted_at`;
    return rows.map((row) => this.toResponse(row));
  }

  async commitVoiceResponse(commit: VoiceResponseCommit): Promise<SubmittedVoiceResponse> {
    const organizationId = await this.organizationIdForSubmission(commit.session.submission_id);
    await withTenantTransaction(this.client, { organizationId, actorId: commit.transcript.id, correlationId: commit.transcript.id }, async (tx) => {
      await tx`
        INSERT INTO check_in_responses (id, organization_id, question_id, session_id, submission_id, modality, canonical_text, edited_text, started_at, submitted_at)
        VALUES (${commit.response.id}, ${organizationId}, ${commit.response.question_id}, ${commit.response.session_id}, ${commit.response.submission_id}, ${commit.response.modality}, ${commit.response.canonical_text}, ${commit.response.edited_text}, ${new Date(commit.response.started_at)}, ${new Date(commit.response.submitted_at)})
        ON CONFLICT (id) DO NOTHING`;
      await tx`
        INSERT INTO check_in_voice_transcripts (id, organization_id, response_id, session_id, submission_id, question_id, transcript, edited_transcript, canonical_text, created_at, submitted_at)
        VALUES (${commit.transcript.id}, ${organizationId}, ${commit.transcript.responseId}, ${commit.transcript.sessionId}, ${commit.transcript.submissionId}, ${commit.transcript.questionId}, ${commit.transcript.transcript}, ${commit.transcript.editedTranscript}, ${commit.transcript.canonicalText}, ${new Date(commit.transcript.createdAt)}, ${new Date(commit.transcript.submittedAt)})
        ON CONFLICT (id) DO NOTHING`;
      await tx`UPDATE check_in_sessions SET state = ${commit.session.state}, questions_asked = ${commit.session.questions_asked}, started_at = ${commit.session.started_at ? new Date(commit.session.started_at) : null}, paused_at = ${commit.session.paused_at ? new Date(commit.session.paused_at) : null}, completed_at = ${commit.session.completed_at ? new Date(commit.session.completed_at) : null}, updated_at = now() WHERE id = ${commit.session.id} AND organization_id = ${organizationId}`;
      if (commit.nextQuestion) {
        await tx`
          INSERT INTO check_in_questions (id, organization_id, session_id, submission_id, objective_id, sequence, text, kind, rationale, source_refs)
          VALUES (${commit.nextQuestion.id}, ${organizationId}, ${commit.nextQuestion.session_id}, ${commit.nextQuestion.submission_id}, ${commit.nextQuestion.objective_id}, ${commit.nextQuestion.sequence}, ${commit.nextQuestion.text}, ${commit.nextQuestion.kind}, ${commit.nextQuestion.rationale}, ${tx.json(commit.nextQuestion.source_refs as unknown as JSONValue)})
          ON CONFLICT (id) DO NOTHING`;
      }
      for (const event of commit.events) {
        await tx`
          INSERT INTO check_in_session_events (organization_id, session_id, actor_id, action, prior_state, new_state, policy_version_id, correlation_id)
          VALUES (${organizationId}, ${event.sessionId}, ${event.actorId}, ${event.action}, ${event.priorState ?? null}, ${event.newState ?? null}, ${event.policyVersionId}, ${event.correlationId})`;
      }
      await tx`
        INSERT INTO check_in_idempotency (organization_id, scope, fingerprint, result)
        VALUES (${organizationId}, ${commit.idempotencyScope}, ${commit.idempotencyFingerprint}, ${tx.json(commit.result as unknown as JSONValue)})
        ON CONFLICT (organization_id, scope) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, result = EXCLUDED.result`;
    });
    return commit.result;
  }

  async getVoiceTranscriptForResponse(responseId: string): Promise<VoiceTranscript | undefined> {
    const rows = await this.client<VoiceTranscriptRow[]>`
      SELECT id, response_id, session_id, submission_id, question_id, transcript, edited_transcript, canonical_text, created_at, submitted_at
      FROM check_in_voice_transcripts WHERE response_id = ${responseId}`;
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      responseId: row.response_id,
      sessionId: row.session_id,
      submissionId: row.submission_id,
      questionId: row.question_id,
      modality: "voice",
      transcript: row.transcript,
      editedTranscript: row.edited_transcript,
      canonicalText: row.canonical_text,
      createdAt: row.created_at.toISOString(),
      submittedAt: row.submitted_at.toISOString(),
    };
  }

  async getVoiceResponseSourceRef(responseId: string): Promise<SourceRef | undefined> {
    const rows = await this.client<{ id: string; session_id: string; submission_id: string; question_id: string }[]>`
      SELECT r.id, r.session_id, r.submission_id, r.question_id
      FROM check_in_responses r
      JOIN check_in_voice_transcripts v ON v.response_id = r.id AND v.organization_id = r.organization_id
      WHERE r.id = ${responseId} AND r.modality = 'voice'`;
    const row = rows[0];
    if (!row) return undefined;
    return { source_type: "response", source_id: row.id, submission_id: row.submission_id, locator: `question:${row.question_id}` };
  }

  async saveEvent(event: SessionTimelineEvent): Promise<void> {
    await this.client`
      INSERT INTO check_in_session_events (organization_id, session_id, actor_id, action, prior_state, new_state, policy_version_id, correlation_id)
      VALUES ((SELECT current_organization_id()), ${event.sessionId}, ${event.actorId}, ${event.action}, ${event.priorState ?? null}, ${event.newState ?? null}, ${event.policyVersionId}, ${event.correlationId})`;
  }

  async listEvents(sessionId: string): Promise<readonly SessionTimelineEvent[]> {
    const rows = await this.client<{
      id: string;
      session_id: string;
      actor_id: string;
      action: SessionEventAction;
      prior_state: string | null;
      new_state: string | null;
      policy_version_id: string;
      correlation_id: string;
      occurred_at: Date;
    }[]>`
      SELECT id, session_id, actor_id, action, prior_state, new_state, policy_version_id, correlation_id, occurred_at
      FROM check_in_session_events WHERE session_id = ${sessionId} ORDER BY occurred_at`;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      actorId: row.actor_id,
      action: row.action,
      priorState: row.prior_state as SessionTimelineEvent["priorState"],
      newState: row.new_state as SessionTimelineEvent["newState"],
      policyVersionId: row.policy_version_id,
      correlationId: row.correlation_id,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }

  async getIdempotentResult<T>(scope: string, fingerprint: string): Promise<T | undefined> {
    const rows = await this.client<{ fingerprint: string; result: T }[]>`
      SELECT fingerprint, result FROM check_in_idempotency WHERE scope = ${scope}`;
    const row = rows[0];
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new IdempotencyConflictError();
    return row.result;
  }

  async saveIdempotentResult<T>(scope: string, fingerprint: string, result: T): Promise<void> {
    await this.client`
      INSERT INTO check_in_idempotency (organization_id, scope, fingerprint, result)
      VALUES ((SELECT current_organization_id()), ${scope}, ${fingerprint}, ${this.client.json(result as unknown as JSONValue)})
      ON CONFLICT (organization_id, scope) DO NOTHING`;
  }

  private toSession(row: SessionRow): CheckInSession {
    // The contract session omits tenant/learner columns; those are enforced by
    // RLS and the session context, not carried on the domain object.
    return CheckInSessionSchema.parse({
      id: row.id,
      submission_id: row.submission_id,
      assessment_version_id: row.assessment_version_id,
      policy_version_id: row.policy_version_id,
      state: row.state,
      mode: row.mode,
      question_budget: row.question_budget,
      questions_asked: row.questions_asked,
      started_at: row.started_at ? row.started_at.toISOString() : null,
      paused_at: row.paused_at ? row.paused_at.toISOString() : null,
      completed_at: row.completed_at ? row.completed_at.toISOString() : null,
    });
  }

  private toContext(row: ContextRow): SessionContext {
    return {
      submissionId: row.submission_id,
      learnerId: row.learner_id,
      policy: {
        learnerFacingText: row.policy_learner_facing_text,
        aiUsePolicy: row.policy_ai_use,
        privacySummary: row.policy_privacy_summary,
        completionCriteria: row.policy_completion_criteria,
      },
      pauseAndResume: row.pause_and_resume,
      timeBudgetMinutes: row.time_budget_minutes,
      voiceCheckInEnabled: row.voice_check_in_enabled,
      objectives: row.objectives.map((objective) => ({ id: objective.id, label: objective.label, assessableInCheckIn: objective.assessableInCheckIn })),
      objectiveSources: row.objective_sources.map((entry) => ({ objectiveId: entry.objectiveId, sourceRefs: entry.sourceRefs })),
      policyShownAt: row.policy_shown_at ? row.policy_shown_at.toISOString() : null,
      policyAcknowledgedAt: row.policy_acknowledged_at ? row.policy_acknowledged_at.toISOString() : null,
    };
  }

  private toQuestion(row: QuestionRow): Question {
    return QuestionSchema.parse({
      id: row.id,
      session_id: row.session_id,
      submission_id: row.submission_id,
      objective_id: row.objective_id,
      sequence: row.sequence,
      text: row.text,
      kind: row.kind,
      rationale: row.rationale,
      source_refs: row.source_refs,
      created_at: row.created_at.toISOString(),
    });
  }

  private toResponse(row: ResponseRow): Response {
    return ResponseSchema.parse({
      id: row.id,
      question_id: row.question_id,
      session_id: row.session_id,
      submission_id: row.submission_id,
      modality: row.modality,
      canonical_text: row.canonical_text,
      edited_text: row.edited_text,
      started_at: row.started_at.toISOString(),
      submitted_at: row.submitted_at.toISOString(),
    });
  }

  private async organizationIdForSubmission(submissionId: string): Promise<string> {
    const rows = await this.client<{ organization_id: string }[]>`
      SELECT organization_id FROM submissions WHERE id = ${submissionId}`;
    const row = rows[0];
    if (!row) throw new Error("submission not found for durable voice response commit");
    return row.organization_id;
  }
}
