import type {
  CheckInSession,
  Question,
  Response,
  SourceRef,
} from "@evidence-loop/contracts/v1";
import type { TransactionSql } from "postgres";

export type Actor = Readonly<{ userId: string }>;

export type CheckInObjective = Readonly<{
  id: string;
  label: string;
  assessableInCheckIn: boolean;
}>;

export type ApprovedCheckInObjective = CheckInObjective & Readonly<{
  approvedBy: string;
  approvedAt: string;
}>;

export type ObjectiveSources = Readonly<{
  objectiveId: string;
  sourceRefs: readonly SourceRef[];
}>;

/** The sole learner-controlled creation input. All assessment/provenance data is resolved server-side. */
export type CreateTextSessionRequest = Readonly<{
  submissionId: string;
  idempotencyKey: string;
}>;

export type LearnerFacingPolicy = Readonly<{
  learnerFacingText: string;
  aiUsePolicy: "allowed" | "allowed_with_disclosure" | "not_allowed";
  privacySummary: string;
  completionCriteria: string;
}>;

/**
 * Server-resolved, published context. An implementation must resolve this from
 * submission, assessment-version, enrollment, and immutable-fragment stores;
 * it is never accepted from a learner request.
 */
export type ResolvedTextCheckInContext = Readonly<{
  submissionId: string;
  learnerId: string;
  submissionCourseId: string;
  assessmentCourseId: string;
  submissionState: "ready";
  assessmentVersionId: string;
  assessmentVersionState: "published";
  policyVersionId: string;
  policy: LearnerFacingPolicy;
  questionBudget: number;
  timeBudgetMinutes: number;
  pauseAndResume: boolean;
  /** Immutable published accommodation; text remains available regardless. */
  voiceCheckInEnabled: boolean;
  objectives: readonly ApprovedCheckInObjective[];
  objectiveFragmentIds: readonly Readonly<{ objectiveId: string; fragmentIds: readonly string[] }> [];
  fragments: readonly Readonly<{ id: string; submissionId: string; locator: string }> [];
}>;

/** Authorization and provenance boundary injected by the application layer. */
export interface TrustedSessionResolver {
  resolveForLearner(actorId: string, submissionId: string): Promise<ResolvedTextCheckInContext | undefined>;
  /** Binds the resolver to the caller's open tenant transaction (null releases it). */
  bind(transaction: TransactionSql | null): void;
}

export type SessionContext = Readonly<{
  submissionId: string;
  learnerId: string;
  policy: LearnerFacingPolicy;
  pauseAndResume: boolean;
  timeBudgetMinutes: number;
  voiceCheckInEnabled: boolean;
  objectives: readonly CheckInObjective[];
  objectiveSources: readonly ObjectiveSources[];
  policyShownAt: string | null;
  policyAcknowledgedAt: string | null;
}>;

export type PolicyBriefing = Readonly<{
  session: CheckInSession;
  policy: LearnerFacingPolicy;
  textCheckInAvailable: true;
  pauseAndResumeAvailable: boolean;
}>;

export type SessionEventAction =
  | "policy_shown"
  | "policy_acknowledged"
  | "session_started"
  | "question_issued"
  | "session_paused"
  | "session_resumed"
  | "response_submitted"
  | "session_completed"
  | "human_follow_up_requested";

export type SessionTimelineEvent = Readonly<{
  id: string;
  sessionId: string;
  actorId: string;
  action: SessionEventAction;
  priorState: CheckInSession["state"] | null;
  newState: CheckInSession["state"] | null;
  policyVersionId: string;
  correlationId: string;
  occurredAt: string;
}>;

export type StartTextSessionInput = Readonly<{
  sessionId: string;
  policyVersionId: string;
  mode: "text";
  idempotencyKey: string;
}>;

export type SessionMutationInput = Readonly<{
  sessionId: string;
  idempotencyKey: string;
}>;

export type SubmitTextResponseInput = Readonly<{
  sessionId: string;
  questionId: string;
  canonicalText: string;
  editedText: string | null;
  idempotencyKey: string;
}>;

/** Server-only voice transport input. Raw transcript is retained for learner correction/audit; edited text is canonical. */
export type SubmitVoiceResponseInput = Readonly<{
  sessionId: string;
  questionId: string;
  transcript: string;
  editedTranscript: string | null;
  idempotencyKey: string;
}>;

export type VoiceTranscript = Readonly<{
  id: string;
  responseId: string;
  sessionId: string;
  submissionId: string;
  questionId: string;
  modality: "voice";
  transcript: string;
  editedTranscript: string | null;
  canonicalText: string;
  createdAt: string;
  submittedAt: string;
}>;

export type ResolvedVoiceSession = Readonly<{
  sessionId: string;
  submissionId: string;
  state: CheckInSession["state"];
  voiceCheckInEnabled: boolean;
  startedAt: string | null;
}>;

export type StartedSession = Readonly<{
  session: CheckInSession;
  question: Question;
}>;

export type SubmittedResponse = Readonly<{
  session: CheckInSession;
  response: Response;
  nextQuestion: Question | null;
}>;

export type SubmittedVoiceResponse = SubmittedResponse & Readonly<{
  transcript: VoiceTranscript;
}>;

export type VoiceResponseCommit = Readonly<{
  transcript: VoiceTranscript;
  response: Response;
  session: CheckInSession;
  nextQuestion: Question | null;
  events: readonly SessionTimelineEvent[];
  idempotencyScope: string;
  idempotencyFingerprint: string;
  result: SubmittedVoiceResponse;
}>;

export type CheckInReceipt = Readonly<{
  session: CheckInSession;
  policyVersionId: string;
  questions: readonly Question[];
  responses: readonly Response[];
  completedAt: string | null;
}>;

export interface SessionRepository {
  /** Binds the repository to the caller's open tenant transaction (null releases it). */
  bind(transaction: TransactionSql | null): void;
  saveSession(session: CheckInSession): Promise<void>;
  getSession(sessionId: string): Promise<CheckInSession | undefined>;
  /** Returns an existing check-in session owned by the actor for the submission, if any. */
  findSessionForSubmission(actorId: string, submissionId: string): Promise<CheckInSession | undefined>;
  saveContext(sessionId: string, context: SessionContext): Promise<void>;
  getContext(sessionId: string): Promise<SessionContext | undefined>;
  saveQuestion(question: Question): Promise<void>;
  listQuestions(sessionId: string): Promise<readonly Question[]>;
  getQuestion(questionId: string): Promise<Question | undefined>;
  saveResponse(response: Response): Promise<void>;
  getResponseForQuestion(questionId: string): Promise<Response | undefined>;
  listResponses(sessionId: string): Promise<readonly Response[]>;
  /** One transaction: raw transcript, canonical voice response, state/audit changes, and retry result. */
  commitVoiceResponse(commit: VoiceResponseCommit): Promise<SubmittedVoiceResponse>;
  getVoiceTranscriptForResponse(responseId: string): Promise<VoiceTranscript | undefined>;
  getVoiceResponseSourceRef(responseId: string): Promise<SourceRef | undefined>;
  saveEvent(event: SessionTimelineEvent): Promise<void>;
  listEvents(sessionId: string): Promise<readonly SessionTimelineEvent[]>;
  getIdempotentResult<T>(scope: string, fingerprint: string): Promise<T | undefined>;
  saveIdempotentResult<T>(scope: string, fingerprint: string, result: T): Promise<void>;
}
