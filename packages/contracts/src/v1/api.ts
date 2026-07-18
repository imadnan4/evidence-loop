import {
  array,
  boolean,
  integer,
  defineSchema,
  enumValue,
  invalidValue,
  nonEmptyString,
  nullable,
  opaqueId,
  required,
  strictObject,
  type Schema,
  string
} from "../schema.ts";
import type { InstructorReview, ResponseModality, AiUsePolicy } from "./domain.ts";

export interface ApiSuccess<T> {
  contract_version: "v1";
  request_id: string;
  data: T;
}

export type ApiErrorCode =
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "idempotency_conflict"
  | "rate_limited"
  | "internal";

export interface ApiErrorEnvelope {
  contract_version: "v1";
  request_id: string;
  error: {
    code: ApiErrorCode;
    message: string;
    field_issues: { path: string; message: string }[] | null;
  };
}

export interface CreateAssessmentRequest {
  course_id: string;
  title: string;
  idempotency_key: string;
}

export interface PublishAssessmentVersionRequest {
  assessment_id: string;
  assessment_version_id: string;
  idempotency_key: string;
}

export interface CreateSubmissionRequest {
  assessment_id: string;
  artifact_ids: string[];
  ai_use_reflection: string | null;
  idempotency_key: string;
}

export interface StartCheckInRequest {
  submission_id: string;
  policy_version_id: string;
  mode: ResponseModality;
  idempotency_key: string;
}

export interface SubmitResponseRequest {
  session_id: string;
  question_id: string;
  canonical_text: string;
  edited_text: string | null;
  idempotency_key: string;
}

export interface ReviewEvidenceCardRequest {
  evidence_card_id: string;
  action: InstructorReview["action"];
  feedback_note: string;
  claim_overrides: InstructorReview["claim_overrides"];
  idempotency_key: string;
}

function parseCreateAssessmentRequest(input: unknown, path: string): CreateAssessmentRequest {
  const object = strictObject(input, path, ["course_id", "title", "idempotency_key"]);
  return {
    course_id: opaqueId(required(object, "course_id", path), `${path}.course_id`),
    title: nonEmptyString(required(object, "title", path), `${path}.title`),
    idempotency_key: opaqueId(required(object, "idempotency_key", path), `${path}.idempotency_key`)
  };
}

function parsePublishAssessmentVersionRequest(input: unknown, path: string): PublishAssessmentVersionRequest {
  const object = strictObject(input, path, ["assessment_id", "assessment_version_id", "idempotency_key"]);
  return {
    assessment_id: opaqueId(required(object, "assessment_id", path), `${path}.assessment_id`),
    assessment_version_id: opaqueId(required(object, "assessment_version_id", path), `${path}.assessment_version_id`),
    idempotency_key: opaqueId(required(object, "idempotency_key", path), `${path}.idempotency_key`)
  };
}

function parseCreateSubmissionRequest(input: unknown, path: string): CreateSubmissionRequest {
  const object = strictObject(input, path, ["assessment_id", "artifact_ids", "ai_use_reflection", "idempotency_key"]);
  const artifact_ids = array(required(object, "artifact_ids", path), `${path}.artifact_ids`, opaqueId);
  if (artifact_ids.length === 0) invalidValue(`${path}.artifact_ids`, "A submission requires at least one artifact.");
  return {
    assessment_id: opaqueId(required(object, "assessment_id", path), `${path}.assessment_id`),
    artifact_ids,
    ai_use_reflection: nullable(required(object, "ai_use_reflection", path), `${path}.ai_use_reflection`, string),
    idempotency_key: opaqueId(required(object, "idempotency_key", path), `${path}.idempotency_key`)
  };
}

function parseStartCheckInRequest(input: unknown, path: string): StartCheckInRequest {
  const object = strictObject(input, path, ["submission_id", "policy_version_id", "mode", "idempotency_key"]);
  return {
    submission_id: opaqueId(required(object, "submission_id", path), `${path}.submission_id`),
    policy_version_id: opaqueId(required(object, "policy_version_id", path), `${path}.policy_version_id`),
    mode: enumValue(required(object, "mode", path), `${path}.mode`, ["text", "voice"]),
    idempotency_key: opaqueId(required(object, "idempotency_key", path), `${path}.idempotency_key`)
  };
}

function parseSubmitResponseRequest(input: unknown, path: string): SubmitResponseRequest {
  const object = strictObject(input, path, ["session_id", "question_id", "canonical_text", "edited_text", "idempotency_key"]);
  return {
    session_id: opaqueId(required(object, "session_id", path), `${path}.session_id`),
    question_id: opaqueId(required(object, "question_id", path), `${path}.question_id`),
    canonical_text: nonEmptyString(required(object, "canonical_text", path), `${path}.canonical_text`),
    edited_text: nullable(required(object, "edited_text", path), `${path}.edited_text`, string),
    idempotency_key: opaqueId(required(object, "idempotency_key", path), `${path}.idempotency_key`)
  };
}

function parseClaimOverride(input: unknown, path: string): InstructorReview["claim_overrides"][number] {
  const object = strictObject(input, path, ["claim_id", "action", "replacement_claim", "reason"]);
  const action = enumValue(required(object, "action", path), `${path}.action`, ["keep", "revise", "remove"]);
  const replacement_claim = nullable(required(object, "replacement_claim", path), `${path}.replacement_claim`, nonEmptyString);
  if ((action === "revise") !== (replacement_claim !== null)) {
    invalidValue(`${path}.replacement_claim`, "Only revised claims may include replacement_claim.");
  }
  return {
    claim_id: opaqueId(required(object, "claim_id", path), `${path}.claim_id`),
    action,
    replacement_claim,
    reason: nonEmptyString(required(object, "reason", path), `${path}.reason`)
  };
}

function parseReviewEvidenceCardRequest(input: unknown, path: string): ReviewEvidenceCardRequest {
  const object = strictObject(input, path, ["evidence_card_id", "action", "feedback_note", "claim_overrides", "idempotency_key"]);
  return {
    evidence_card_id: opaqueId(required(object, "evidence_card_id", path), `${path}.evidence_card_id`),
    action: enumValue(required(object, "action", path), `${path}.action`, ["reviewed", "request_follow_up", "return_for_revision"]),
    feedback_note: string(required(object, "feedback_note", path), `${path}.feedback_note`),
    claim_overrides: array(required(object, "claim_overrides", path), `${path}.claim_overrides`, parseClaimOverride),
    idempotency_key: opaqueId(required(object, "idempotency_key", path), `${path}.idempotency_key`)
  };
}

function parseApiErrorEnvelope(input: unknown, path: string): ApiErrorEnvelope {
  const object = strictObject(input, path, ["contract_version", "request_id", "error"]);
  const error = strictObject(required(object, "error", path), `${path}.error`, ["code", "message", "field_issues"]);
  return {
    contract_version: enumValue(required(object, "contract_version", path), `${path}.contract_version`, ["v1"]),
    request_id: opaqueId(required(object, "request_id", path), `${path}.request_id`),
    error: {
      code: enumValue(required(error, "code", `${path}.error`), `${path}.error.code`, [
        "validation_failed", "unauthorized", "forbidden", "not_found", "conflict", "invalid_state", "idempotency_conflict", "rate_limited", "internal"
      ]),
      message: nonEmptyString(required(error, "message", `${path}.error`), `${path}.error.message`),
      field_issues: nullable(required(error, "field_issues", `${path}.error`), `${path}.error.field_issues`, (value, issuePath) =>
        array(value, issuePath, (item, itemPath) => {
          const fieldIssue = strictObject(item, itemPath, ["path", "message"]);
          return {
            path: nonEmptyString(required(fieldIssue, "path", itemPath), `${itemPath}.path`),
            message: nonEmptyString(required(fieldIssue, "message", itemPath), `${itemPath}.message`)
          };
        })
      )
    }
  };
}

export const CreateAssessmentRequestSchema: Schema<CreateAssessmentRequest> = defineSchema(parseCreateAssessmentRequest);
export const PublishAssessmentVersionRequestSchema: Schema<PublishAssessmentVersionRequest> = defineSchema(parsePublishAssessmentVersionRequest);
export const CreateSubmissionRequestSchema: Schema<CreateSubmissionRequest> = defineSchema(parseCreateSubmissionRequest);
export const StartCheckInRequestSchema: Schema<StartCheckInRequest> = defineSchema(parseStartCheckInRequest);
export const SubmitResponseRequestSchema: Schema<SubmitResponseRequest> = defineSchema(parseSubmitResponseRequest);
export const ReviewEvidenceCardRequestSchema: Schema<ReviewEvidenceCardRequest> = defineSchema(parseReviewEvidenceCardRequest);
export const ApiErrorEnvelopeSchema: Schema<ApiErrorEnvelope> = defineSchema(parseApiErrorEnvelope);

export function success<T>(request_id: string, data: T): ApiSuccess<T> {
  return { contract_version: "v1", request_id: opaqueId(request_id, "$.request_id"), data };
}

export interface DurableObjectiveInput { id: string; label: string; description: string; evidence_criteria: string; assessable_in_check_in: boolean; }
export interface DurableRubricInput { label: string; description: string; evidence_criteria: string; objective_ids: string[]; }
export interface CreateAssessmentDraftRequest {
  title: string; assignment_instructions: string; objectives: DurableObjectiveInput[]; rubric: DurableRubricInput[];
  policy: { learner_facing_text: string; ai_use_policy: AiUsePolicy; privacy_summary: string; completion_criteria: string };
  accommodations: { text_check_in: boolean; voice_check_in: boolean; extra_time: boolean; pause_and_resume: boolean; alternative_assessment_request: boolean };
  question_budget: number; time_budget_minutes: number;
}
function parseDurableObjective(input: unknown, path: string): DurableObjectiveInput {
  const o = strictObject(input, path, ["id", "label", "description", "evidence_criteria", "assessable_in_check_in"]);
  return { id: opaqueId(required(o,"id",path),`${path}.id`), label: nonEmptyString(required(o,"label",path),`${path}.label`), description: nonEmptyString(required(o,"description",path),`${path}.description`), evidence_criteria: nonEmptyString(required(o,"evidence_criteria",path),`${path}.evidence_criteria`), assessable_in_check_in: boolean(required(o,"assessable_in_check_in",path),`${path}.assessable_in_check_in`) };
}
function parseDurableRubric(input: unknown, path: string): DurableRubricInput {
  const o = strictObject(input, path, ["label", "description", "evidence_criteria", "objective_ids"]);
  const objective_ids = array(required(o,"objective_ids",path),`${path}.objective_ids`,opaqueId);
  if (!objective_ids.length) invalidValue(`${path}.objective_ids`, "Each rubric criterion needs an explicit objective mapping.");
  return { label: nonEmptyString(required(o,"label",path),`${path}.label`), description: nonEmptyString(required(o,"description",path),`${path}.description`), evidence_criteria: nonEmptyString(required(o,"evidence_criteria",path),`${path}.evidence_criteria`), objective_ids };
}
function parseCreateAssessmentDraft(input: unknown, path: string): CreateAssessmentDraftRequest {
  const o = strictObject(input,path,["title","assignment_instructions","objectives","rubric","policy","accommodations","question_budget","time_budget_minutes"]);
  const objectives = array(required(o,"objectives",path),`${path}.objectives`,parseDurableObjective);
  const rubric = array(required(o,"rubric",path),`${path}.rubric`,parseDurableRubric);
  if (objectives.length < 1 || objectives.length > 10) invalidValue(`${path}.objectives`, "Expected 1 to 10 objectives.");
  if (rubric.length < 1 || rubric.length > 12) invalidValue(`${path}.rubric`, "Expected 1 to 12 rubric criteria.");
  if (new Set(objectives.map(x=>x.id)).size !== objectives.length) invalidValue(`${path}.objectives`, "Objective ids must be unique.");
  const ids = new Set(objectives.map(x=>x.id));
  if (rubric.some(x => x.objective_ids.some(id => !ids.has(id)))) invalidValue(`${path}.rubric`, "Rubric mappings must reference supplied objectives.");
  const policy = strictObject(required(o,"policy",path),`${path}.policy`,["learner_facing_text","ai_use_policy","privacy_summary","completion_criteria"]);
  const accommodations = strictObject(required(o,"accommodations",path),`${path}.accommodations`,["text_check_in","voice_check_in","extra_time","pause_and_resume","alternative_assessment_request"]);
  const text_check_in = boolean(required(accommodations,"text_check_in",`${path}.accommodations`),`${path}.accommodations.text_check_in`);
  if (!text_check_in) invalidValue(`${path}.accommodations.text_check_in`, "Typed check-in is required.");
  return { title: nonEmptyString(required(o,"title",path),`${path}.title`), assignment_instructions: nonEmptyString(required(o,"assignment_instructions",path),`${path}.assignment_instructions`), objectives, rubric,
    policy: { learner_facing_text: nonEmptyString(required(policy,"learner_facing_text",`${path}.policy`),`${path}.policy.learner_facing_text`), ai_use_policy: enumValue(required(policy,"ai_use_policy",`${path}.policy`),`${path}.policy.ai_use_policy`,["allowed","allowed_with_disclosure","not_allowed"]), privacy_summary: nonEmptyString(required(policy,"privacy_summary",`${path}.policy`),`${path}.policy.privacy_summary`), completion_criteria: nonEmptyString(required(policy,"completion_criteria",`${path}.policy`),`${path}.policy.completion_criteria`) },
    accommodations: { text_check_in, voice_check_in: boolean(required(accommodations,"voice_check_in",`${path}.accommodations`),`${path}.accommodations.voice_check_in`), extra_time: boolean(required(accommodations,"extra_time",`${path}.accommodations`),`${path}.accommodations.extra_time`), pause_and_resume: boolean(required(accommodations,"pause_and_resume",`${path}.accommodations`),`${path}.accommodations.pause_and_resume`), alternative_assessment_request: boolean(required(accommodations,"alternative_assessment_request",`${path}.accommodations`),`${path}.accommodations.alternative_assessment_request`) },
    question_budget: integer(required(o,"question_budget",path),`${path}.question_budget`,3,5), time_budget_minutes: integer(required(o,"time_budget_minutes",path),`${path}.time_budget_minutes`,3,8) };
}
export const CreateAssessmentDraftRequestSchema: Schema<CreateAssessmentDraftRequest> = defineSchema(parseCreateAssessmentDraft);
