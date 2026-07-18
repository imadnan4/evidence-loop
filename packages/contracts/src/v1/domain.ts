import {
  array,
  boolean,
  defineSchema,
  enumValue,
  integer,
  invalidValue,
  isoTimestamp,
  nonEmptyString,
  nullable,
  opaqueId,
  optional,
  plainMetadata,
  required,
  strictObject,
  type Schema,
  string
} from "../schema.ts";

export type AiUsePolicy = "allowed" | "allowed_with_disclosure" | "not_allowed";
export type AssessmentVersionState = "draft" | "published";
export type SessionState = "ready" | "in_progress" | "paused" | "completed" | "human_follow_up";
export type ResponseModality = "text" | "voice";
export type EvidenceStatus = "demonstrated" | "partial" | "not_yet_evidenced";

export interface Objective {
  id: string;
  assessment_version_id: string;
  label: string;
  description: string;
  evidence_criteria: string[];
  assessable_in_check_in: boolean;
}

export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  objective_ids: string[];
}

export interface AssessmentPolicy {
  policy_text: string;
  ai_use_policy: AiUsePolicy;
  accommodations: ("text" | "extended_time" | "human_follow_up")[];
  retention_summary: string;
}

export interface AssessmentVersion {
  id: string;
  assessment_id: string;
  version: number;
  state: AssessmentVersionState;
  policy: AssessmentPolicy;
  objectives: Objective[];
  rubric: RubricCriterion[];
  question_budget: number;
  time_budget_minutes: number;
  created_at: string;
  published_at: string | null;
}

export interface Assessment {
  id: string;
  course_id: string;
  title: string;
  status: "draft" | "published" | "archived";
  current_version_id: string | null;
  created_at: string;
}

export type ArtifactLocator =
  | { kind: "line_range"; start_line: number; end_line: number }
  | { kind: "notebook_cell"; cell_id: string }
  | { kind: "pdf_page"; page: number }
  | { kind: "csv_sample"; row_start: number; row_end: number };

export interface ArtifactFragment {
  id: string;
  artifact_id: string;
  submission_id: string;
  content_type: "code" | "markdown" | "text" | "pdf_text" | "csv_sample" | "output";
  locator: ArtifactLocator;
  content: string;
  content_hash: string;
  created_at: string;
}

export interface CheckInSession {
  id: string;
  submission_id: string;
  assessment_version_id: string;
  policy_version_id: string;
  state: SessionState;
  mode: ResponseModality;
  question_budget: number;
  questions_asked: number;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
}

export interface SourceRef {
  source_type: "artifact_fragment" | "response";
  source_id: string;
  submission_id: string;
  locator: string;
}

export interface Question {
  id: string;
  session_id: string;
  submission_id: string;
  objective_id: string;
  sequence: number;
  text: string;
  kind: "explain" | "apply" | "revise" | "compare";
  rationale: string;
  source_refs: SourceRef[];
  created_at: string;
}

export interface Response {
  id: string;
  question_id: string;
  session_id: string;
  submission_id: string;
  modality: ResponseModality;
  canonical_text: string;
  edited_text: string | null;
  started_at: string;
  submitted_at: string;
}

export interface EvidenceClaim {
  id: string;
  objective_id: string;
  status: EvidenceStatus;
  claim: string;
  source_refs: SourceRef[];
  uncertainty: string | null;
  formative_next_step: string;
  learner_strengths: string[];
}

export interface EvidenceCard {
  id: string;
  submission_id: string;
  assessment_version_id: string;
  status: "draft" | "review_pending" | "reviewed";
  claims: EvidenceClaim[];
  learner_reflection: string | null;
  generated_at: string;
  learner_visible_at: string | null;
}

export interface ClaimOverride {
  claim_id: string;
  action: "keep" | "revise" | "remove";
  replacement_claim: string | null;
  reason: string;
}

export interface InstructorReview {
  id: string;
  evidence_card_id: string;
  reviewer_id: string;
  action: "reviewed" | "request_follow_up" | "return_for_revision";
  feedback_note: string;
  claim_overrides: ClaimOverride[];
  reviewed_at: string;
}

export interface AuditEvent {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  policy_version_id: string | null;
  correlation_id: string;
  metadata_redacted: Record<string, string | number | boolean | null>;
  occurred_at: string;
}

function parseObjective(input: unknown, path: string): Objective {
  const object = strictObject(input, path, [
    "id", "assessment_version_id", "label", "description", "evidence_criteria", "assessable_in_check_in"
  ]);
  return {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    assessment_version_id: opaqueId(required(object, "assessment_version_id", path), `${path}.assessment_version_id`),
    label: nonEmptyString(required(object, "label", path), `${path}.label`),
    description: nonEmptyString(required(object, "description", path), `${path}.description`),
    evidence_criteria: array(required(object, "evidence_criteria", path), `${path}.evidence_criteria`, nonEmptyString),
    assessable_in_check_in: boolean(required(object, "assessable_in_check_in", path), `${path}.assessable_in_check_in`)
  };
}

function parseRubricCriterion(input: unknown, path: string): RubricCriterion {
  const object = strictObject(input, path, ["id", "label", "description", "objective_ids"]);
  return {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    label: nonEmptyString(required(object, "label", path), `${path}.label`),
    description: nonEmptyString(required(object, "description", path), `${path}.description`),
    objective_ids: array(required(object, "objective_ids", path), `${path}.objective_ids`, opaqueId)
  };
}

function parseAssessmentPolicy(input: unknown, path: string): AssessmentPolicy {
  const object = strictObject(input, path, ["policy_text", "ai_use_policy", "accommodations", "retention_summary"]);
  const accommodations: AssessmentPolicy["accommodations"] = array(required(object, "accommodations", path), `${path}.accommodations`, (value, itemPath) =>
    enumValue(value, itemPath, ["text", "extended_time", "human_follow_up"] as const)
  );
  if (!accommodations.includes("text")) {
    invalidValue(`${path}.accommodations`, "Assessment policy must provide the equivalent typed-response route.");
  }
  return {
    policy_text: nonEmptyString(required(object, "policy_text", path), `${path}.policy_text`),
    ai_use_policy: enumValue(required(object, "ai_use_policy", path), `${path}.ai_use_policy`, [
      "allowed", "allowed_with_disclosure", "not_allowed"
    ]),
    accommodations,
    retention_summary: nonEmptyString(required(object, "retention_summary", path), `${path}.retention_summary`)
  };
}

function parseAssessmentVersion(input: unknown, path: string): AssessmentVersion {
  const object = strictObject(input, path, [
    "id", "assessment_id", "version", "state", "policy", "objectives", "rubric", "question_budget",
    "time_budget_minutes", "created_at", "published_at"
  ]);
  const state = enumValue(required(object, "state", path), `${path}.state`, ["draft", "published"]);
  const version: AssessmentVersion = {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    assessment_id: opaqueId(required(object, "assessment_id", path), `${path}.assessment_id`),
    version: integer(required(object, "version", path), `${path}.version`, 1),
    state,
    policy: parseAssessmentPolicy(required(object, "policy", path), `${path}.policy`),
    objectives: array(required(object, "objectives", path), `${path}.objectives`, parseObjective),
    rubric: array(required(object, "rubric", path), `${path}.rubric`, parseRubricCriterion),
    question_budget: integer(required(object, "question_budget", path), `${path}.question_budget`, 3, 5),
    time_budget_minutes: integer(required(object, "time_budget_minutes", path), `${path}.time_budget_minutes`, 3, 8),
    created_at: isoTimestamp(required(object, "created_at", path), `${path}.created_at`),
    published_at: nullable(required(object, "published_at", path), `${path}.published_at`, isoTimestamp)
  };
  if (version.objectives.length === 0) invalidValue(`${path}.objectives`, "Assessment versions require at least one objective.");
  if (state === "published" && version.published_at === null) invalidValue(`${path}.published_at`, "Published assessment versions require published_at.");
  if (state === "draft" && version.published_at !== null) invalidValue(`${path}.published_at`, "Draft assessment versions cannot have published_at.");
  const objectiveIds = new Set(version.objectives.map((objective) => objective.id));
  if (version.objectives.some((objective) => objective.assessment_version_id !== version.id)) {
    invalidValue(`${path}.objectives`, "Every objective must belong to its assessment version.");
  }
  if (version.rubric.some((criterion) => criterion.objective_ids.some((id) => !objectiveIds.has(id)))) {
    invalidValue(`${path}.rubric`, "Rubric criteria may only reference objectives in the same assessment version.");
  }
  return version;
}

function parseAssessment(input: unknown, path: string): Assessment {
  const object = strictObject(input, path, ["id", "course_id", "title", "status", "current_version_id", "created_at"]);
  return {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    course_id: opaqueId(required(object, "course_id", path), `${path}.course_id`),
    title: nonEmptyString(required(object, "title", path), `${path}.title`),
    status: enumValue(required(object, "status", path), `${path}.status`, ["draft", "published", "archived"]),
    current_version_id: nullable(required(object, "current_version_id", path), `${path}.current_version_id`, opaqueId),
    created_at: isoTimestamp(required(object, "created_at", path), `${path}.created_at`)
  };
}

function parseArtifactLocator(input: unknown, path: string): ArtifactLocator {
  const base = strictObject(input, path, ["kind", "start_line", "end_line", "cell_id", "page", "row_start", "row_end"]);
  const kind = enumValue(required(base, "kind", path), `${path}.kind`, ["line_range", "notebook_cell", "pdf_page", "csv_sample"]);
  if (kind === "line_range") {
    const start_line = integer(required(base, "start_line", path), `${path}.start_line`, 1);
    const end_line = integer(required(base, "end_line", path), `${path}.end_line`, start_line);
    if (optional(base, "cell_id") !== undefined || optional(base, "page") !== undefined || optional(base, "row_start") !== undefined || optional(base, "row_end") !== undefined) {
      invalidValue(path, "A line-range locator may not contain another locator type's fields.");
    }
    return { kind, start_line, end_line };
  }
  if (kind === "notebook_cell") {
    if (optional(base, "start_line") !== undefined || optional(base, "end_line") !== undefined || optional(base, "page") !== undefined || optional(base, "row_start") !== undefined || optional(base, "row_end") !== undefined) {
      invalidValue(path, "A notebook-cell locator may not contain another locator type's fields.");
    }
    return { kind, cell_id: opaqueId(required(base, "cell_id", path), `${path}.cell_id`) };
  }
  if (kind === "pdf_page") {
    if (optional(base, "start_line") !== undefined || optional(base, "end_line") !== undefined || optional(base, "cell_id") !== undefined || optional(base, "row_start") !== undefined || optional(base, "row_end") !== undefined) {
      invalidValue(path, "A PDF-page locator may not contain another locator type's fields.");
    }
    return { kind, page: integer(required(base, "page", path), `${path}.page`, 1) };
  }
  if (optional(base, "start_line") !== undefined || optional(base, "end_line") !== undefined || optional(base, "cell_id") !== undefined || optional(base, "page") !== undefined) {
    invalidValue(path, "A CSV-sample locator may not contain another locator type's fields.");
  }
  const row_start = integer(required(base, "row_start", path), `${path}.row_start`, 1);
  return { kind, row_start, row_end: integer(required(base, "row_end", path), `${path}.row_end`, row_start) };
}

function parseArtifactFragment(input: unknown, path: string): ArtifactFragment {
  const object = strictObject(input, path, [
    "id", "artifact_id", "submission_id", "content_type", "locator", "content", "content_hash", "created_at"
  ]);
  return {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    artifact_id: opaqueId(required(object, "artifact_id", path), `${path}.artifact_id`),
    submission_id: opaqueId(required(object, "submission_id", path), `${path}.submission_id`),
    content_type: enumValue(required(object, "content_type", path), `${path}.content_type`, ["code", "markdown", "text", "pdf_text", "csv_sample", "output"]),
    locator: parseArtifactLocator(required(object, "locator", path), `${path}.locator`),
    content: string(required(object, "content", path), `${path}.content`),
    content_hash: nonEmptyString(required(object, "content_hash", path), `${path}.content_hash`),
    created_at: isoTimestamp(required(object, "created_at", path), `${path}.created_at`)
  };
}

function parseCheckInSession(input: unknown, path: string): CheckInSession {
  const object = strictObject(input, path, [
    "id", "submission_id", "assessment_version_id", "policy_version_id", "state", "mode", "question_budget",
    "questions_asked", "started_at", "paused_at", "completed_at"
  ]);
  const state = enumValue(required(object, "state", path), `${path}.state`, ["ready", "in_progress", "paused", "completed", "human_follow_up"]);
  const session: CheckInSession = {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    submission_id: opaqueId(required(object, "submission_id", path), `${path}.submission_id`),
    assessment_version_id: opaqueId(required(object, "assessment_version_id", path), `${path}.assessment_version_id`),
    policy_version_id: opaqueId(required(object, "policy_version_id", path), `${path}.policy_version_id`),
    state,
    mode: enumValue(required(object, "mode", path), `${path}.mode`, ["text", "voice"]),
    question_budget: integer(required(object, "question_budget", path), `${path}.question_budget`, 3, 5),
    questions_asked: integer(required(object, "questions_asked", path), `${path}.questions_asked`, 0, 5),
    started_at: nullable(required(object, "started_at", path), `${path}.started_at`, isoTimestamp),
    paused_at: nullable(required(object, "paused_at", path), `${path}.paused_at`, isoTimestamp),
    completed_at: nullable(required(object, "completed_at", path), `${path}.completed_at`, isoTimestamp)
  };
  if (session.questions_asked > session.question_budget) invalidValue(`${path}.questions_asked`, "questions_asked cannot exceed question_budget.");
  if ((state === "ready") !== (session.started_at === null)) invalidValue(`${path}.started_at`, "Only a ready session may omit started_at.");
  if (state === "paused" && session.paused_at === null) invalidValue(`${path}.paused_at`, "Paused sessions require paused_at.");
  if (state === "completed" && session.completed_at === null) invalidValue(`${path}.completed_at`, "Completed sessions require completed_at.");
  return session;
}

function parseSourceRef(input: unknown, path: string): SourceRef {
  const object = strictObject(input, path, ["source_type", "source_id", "submission_id", "locator"]);
  return {
    source_type: enumValue(required(object, "source_type", path), `${path}.source_type`, ["artifact_fragment", "response"]),
    source_id: opaqueId(required(object, "source_id", path), `${path}.source_id`),
    submission_id: opaqueId(required(object, "submission_id", path), `${path}.submission_id`),
    locator: nonEmptyString(required(object, "locator", path), `${path}.locator`)
  };
}

function parseQuestion(input: unknown, path: string): Question {
  const object = strictObject(input, path, ["id", "session_id", "submission_id", "objective_id", "sequence", "text", "kind", "rationale", "source_refs", "created_at"]);
  const question: Question = {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    session_id: opaqueId(required(object, "session_id", path), `${path}.session_id`),
    submission_id: opaqueId(required(object, "submission_id", path), `${path}.submission_id`),
    objective_id: opaqueId(required(object, "objective_id", path), `${path}.objective_id`),
    sequence: integer(required(object, "sequence", path), `${path}.sequence`, 1, 5),
    text: nonEmptyString(required(object, "text", path), `${path}.text`),
    kind: enumValue(required(object, "kind", path), `${path}.kind`, ["explain", "apply", "revise", "compare"]),
    rationale: nonEmptyString(required(object, "rationale", path), `${path}.rationale`),
    source_refs: array(required(object, "source_refs", path), `${path}.source_refs`, parseSourceRef),
    created_at: isoTimestamp(required(object, "created_at", path), `${path}.created_at`)
  };
  if (question.source_refs.length === 0) invalidValue(`${path}.source_refs`, "Questions require current-submission source references.");
  if (question.source_refs.some((source) => source.submission_id !== question.submission_id)) {
    invalidValue(`${path}.source_refs`, "Question sources must belong to the current submission.");
  }
  return question;
}

function parseResponse(input: unknown, path: string): Response {
  const object = strictObject(input, path, ["id", "question_id", "session_id", "submission_id", "modality", "canonical_text", "edited_text", "started_at", "submitted_at"]);
  return {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    question_id: opaqueId(required(object, "question_id", path), `${path}.question_id`),
    session_id: opaqueId(required(object, "session_id", path), `${path}.session_id`),
    submission_id: opaqueId(required(object, "submission_id", path), `${path}.submission_id`),
    modality: enumValue(required(object, "modality", path), `${path}.modality`, ["text", "voice"]),
    canonical_text: nonEmptyString(required(object, "canonical_text", path), `${path}.canonical_text`),
    edited_text: nullable(required(object, "edited_text", path), `${path}.edited_text`, string),
    started_at: isoTimestamp(required(object, "started_at", path), `${path}.started_at`),
    submitted_at: isoTimestamp(required(object, "submitted_at", path), `${path}.submitted_at`)
  };
}

function parseEvidenceClaim(input: unknown, path: string): EvidenceClaim {
  const object = strictObject(input, path, ["id", "objective_id", "status", "claim", "source_refs", "uncertainty", "formative_next_step", "learner_strengths"]);
  const claim: EvidenceClaim = {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    objective_id: opaqueId(required(object, "objective_id", path), `${path}.objective_id`),
    status: enumValue(required(object, "status", path), `${path}.status`, ["demonstrated", "partial", "not_yet_evidenced"]),
    claim: nonEmptyString(required(object, "claim", path), `${path}.claim`),
    source_refs: array(required(object, "source_refs", path), `${path}.source_refs`, parseSourceRef),
    uncertainty: nullable(required(object, "uncertainty", path), `${path}.uncertainty`, nonEmptyString),
    formative_next_step: nonEmptyString(required(object, "formative_next_step", path), `${path}.formative_next_step`),
    learner_strengths: array(required(object, "learner_strengths", path), `${path}.learner_strengths`, nonEmptyString)
  };
  if (claim.source_refs.length === 0) invalidValue(`${path}.source_refs`, "Evidence claims require source references.");
  if (claim.status !== "demonstrated" && claim.uncertainty === null) {
    invalidValue(`${path}.uncertainty`, "Partial or not-yet-evidenced claims require uncertainty.");
  }
  return claim;
}

function parseEvidenceCard(input: unknown, path: string): EvidenceCard {
  const object = strictObject(input, path, [
    "id", "submission_id", "assessment_version_id", "status", "claims", "learner_reflection", "generated_at", "learner_visible_at"
  ]);
  const card: EvidenceCard = {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    submission_id: opaqueId(required(object, "submission_id", path), `${path}.submission_id`),
    assessment_version_id: opaqueId(required(object, "assessment_version_id", path), `${path}.assessment_version_id`),
    status: enumValue(required(object, "status", path), `${path}.status`, ["draft", "review_pending", "reviewed"]),
    claims: array(required(object, "claims", path), `${path}.claims`, parseEvidenceClaim),
    learner_reflection: nullable(required(object, "learner_reflection", path), `${path}.learner_reflection`, string),
    generated_at: isoTimestamp(required(object, "generated_at", path), `${path}.generated_at`),
    learner_visible_at: nullable(required(object, "learner_visible_at", path), `${path}.learner_visible_at`, isoTimestamp)
  };
  if (card.claims.some((claim) => claim.source_refs.some((source) => source.submission_id !== card.submission_id))) {
    invalidValue(`${path}.claims`, "Evidence card claims may only cite the current submission.");
  }
  return card;
}

function parseClaimOverride(input: unknown, path: string): ClaimOverride {
  const object = strictObject(input, path, ["claim_id", "action", "replacement_claim", "reason"]);
  const action = enumValue(required(object, "action", path), `${path}.action`, ["keep", "revise", "remove"]);
  const override: ClaimOverride = {
    claim_id: opaqueId(required(object, "claim_id", path), `${path}.claim_id`),
    action,
    replacement_claim: nullable(required(object, "replacement_claim", path), `${path}.replacement_claim`, nonEmptyString),
    reason: nonEmptyString(required(object, "reason", path), `${path}.reason`)
  };
  if ((action === "revise") !== (override.replacement_claim !== null)) {
    invalidValue(`${path}.replacement_claim`, "Only revised claims may include replacement_claim.");
  }
  return override;
}

function parseInstructorReview(input: unknown, path: string): InstructorReview {
  const object = strictObject(input, path, ["id", "evidence_card_id", "reviewer_id", "action", "feedback_note", "claim_overrides", "reviewed_at"]);
  return {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    evidence_card_id: opaqueId(required(object, "evidence_card_id", path), `${path}.evidence_card_id`),
    reviewer_id: opaqueId(required(object, "reviewer_id", path), `${path}.reviewer_id`),
    action: enumValue(required(object, "action", path), `${path}.action`, ["reviewed", "request_follow_up", "return_for_revision"]),
    feedback_note: string(required(object, "feedback_note", path), `${path}.feedback_note`),
    claim_overrides: array(required(object, "claim_overrides", path), `${path}.claim_overrides`, parseClaimOverride),
    reviewed_at: isoTimestamp(required(object, "reviewed_at", path), `${path}.reviewed_at`)
  };
}

function parseAuditEvent(input: unknown, path: string): AuditEvent {
  const object = strictObject(input, path, [
    "id", "actor_id", "action", "target_type", "target_id", "policy_version_id", "correlation_id", "metadata_redacted", "occurred_at"
  ]);
  return {
    id: opaqueId(required(object, "id", path), `${path}.id`),
    actor_id: opaqueId(required(object, "actor_id", path), `${path}.actor_id`),
    action: nonEmptyString(required(object, "action", path), `${path}.action`),
    target_type: nonEmptyString(required(object, "target_type", path), `${path}.target_type`),
    target_id: opaqueId(required(object, "target_id", path), `${path}.target_id`),
    policy_version_id: nullable(required(object, "policy_version_id", path), `${path}.policy_version_id`, opaqueId),
    correlation_id: opaqueId(required(object, "correlation_id", path), `${path}.correlation_id`),
    metadata_redacted: plainMetadata(required(object, "metadata_redacted", path), `${path}.metadata_redacted`),
    occurred_at: isoTimestamp(required(object, "occurred_at", path), `${path}.occurred_at`)
  };
}

export const AssessmentSchema: Schema<Assessment> = defineSchema(parseAssessment);
export const AssessmentVersionSchema: Schema<AssessmentVersion> = defineSchema(parseAssessmentVersion);
export const ObjectiveSchema: Schema<Objective> = defineSchema(parseObjective);
export const ArtifactFragmentSchema: Schema<ArtifactFragment> = defineSchema(parseArtifactFragment);
export const CheckInSessionSchema: Schema<CheckInSession> = defineSchema(parseCheckInSession);
export const QuestionSchema: Schema<Question> = defineSchema(parseQuestion);
export const ResponseSchema: Schema<Response> = defineSchema(parseResponse);
export const EvidenceClaimSchema: Schema<EvidenceClaim> = defineSchema(parseEvidenceClaim);
export const EvidenceCardSchema: Schema<EvidenceCard> = defineSchema(parseEvidenceCard);
export const InstructorReviewSchema: Schema<InstructorReview> = defineSchema(parseInstructorReview);
export const AuditEventSchema: Schema<AuditEvent> = defineSchema(parseAuditEvent);
