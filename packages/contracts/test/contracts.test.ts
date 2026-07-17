import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoProhibitedFields,
  AssessmentVersionSchema,
  CreateSubmissionRequestSchema,
  EvidenceCardSchema,
  QuestionSchema
} from "../src/index.ts";

const now = "2026-07-18T12:00:00.000Z";

function source(submission_id = "submission-current") {
  return {
    source_type: "artifact_fragment",
    source_id: "fragment-01",
    submission_id,
    locator: "cell:train-test-split"
  };
}

function publishedAssessmentVersion(accommodations = ["text", "extended_time", "human_follow_up"]) {
  return {
    id: "version-01",
    assessment_id: "assessment-01",
    version: 1,
    state: "published",
    policy: {
      policy_text: "AI may be used for debugging when disclosed.",
      ai_use_policy: "allowed_with_disclosure",
      accommodations,
      retention_summary: "The transcript is retained for the course schedule."
    },
    objectives: [{
      id: "objective-validation",
      assessment_version_id: "version-01",
      label: "Explain validation",
      description: "Explain why the split occurs before scaling.",
      evidence_criteria: ["Names leakage risk"],
      assessable_in_check_in: true
    }],
    rubric: [{
      id: "criterion-validation",
      label: "Validation reasoning",
      description: "Connect the workflow to leakage prevention.",
      objective_ids: ["objective-validation"]
    }],
    question_budget: 3,
    time_budget_minutes: 5,
    created_at: now,
    published_at: now
  };
}

test("published assessment versions bind approved objectives and rubric references", () => {
  const result = AssessmentVersionSchema.safeParse(publishedAssessmentVersion());

  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.objectives[0]?.label, "Explain validation");
  assert.equal(AssessmentVersionSchema.safeParse(publishedAssessmentVersion(["extended_time"])).success, false);
});

test("evidence claims must cite sources from the current submission and state uncertainty", () => {
  const validCard = {
    id: "card-01",
    submission_id: "submission-current",
    assessment_version_id: "version-01",
    status: "review_pending",
    claims: [{
      id: "claim-01",
      objective_id: "objective-validation",
      status: "partial",
      claim: "The learner explains that scaling before a split can leak information.",
      source_refs: [source()],
      uncertainty: "The explanation does not address cross-validation.",
      formative_next_step: "Revise the split and scaling sequence in one cell.",
      learner_strengths: ["Identifies the leakage concern."]
    }],
    learner_reflection: null,
    generated_at: now,
    learner_visible_at: null
  };

  assert.equal(EvidenceCardSchema.safeParse(validCard).success, true);
  assert.equal(EvidenceCardSchema.safeParse({
    ...validCard,
    claims: [{ ...validCard.claims[0], uncertainty: null }]
  }).success, false);
  assert.equal(EvidenceCardSchema.safeParse({
    ...validCard,
    claims: [{ ...validCard.claims[0], source_refs: [source("submission-other")] }]
  }).success, false);
});

test("questions are grounded in the current submission", () => {
  const question = {
    id: "question-01",
    session_id: "session-01",
    submission_id: "submission-current",
    objective_id: "objective-validation",
    sequence: 1,
    text: "Why should scaling happen after the train/test split?",
    kind: "explain",
    rationale: "Checks the approved validation objective.",
    source_refs: [source()],
    created_at: now
  };
  assert.equal(QuestionSchema.safeParse(question).success, true);
  assert.equal(QuestionSchema.safeParse({ ...question, source_refs: [source("submission-other")] }).success, false);
});

test("prohibited automated-decision fields and unknown fields are rejected", () => {
  const request = {
    assessment_id: "assessment-01",
    artifact_ids: ["artifact-01"],
    ai_use_reflection: null,
    idempotency_key: "request-01"
  };
  assert.equal(CreateSubmissionRequestSchema.safeParse(request).success, true);

  const prohibited = CreateSubmissionRequestSchema.safeParse({ ...request, final_grade: "A" });
  assert.equal(prohibited.success, false);
  if (!prohibited.success) assert.equal(prohibited.issues[0]?.code, "forbidden_field");

  const unknown = CreateSubmissionRequestSchema.safeParse({ ...request, unexpected: true });
  assert.equal(unknown.success, false);
  if (!unknown.success) assert.equal(unknown.issues[0]?.code, "unknown_field");
});

test("forbidden-field guard rejects automated-judgment aliases in direct and schema use", () => {
  const request = {
    assessment_id: "assessment-01",
    artifact_ids: ["artifact-01"],
    ai_use_reflection: null,
    idempotency_key: "request-01"
  };
  const aliases = [
    "automatedGrade",
    "gradeRecommendation",
    "passFail",
    "passFailResult",
    "passStatus",
    "failStatus",
    "riskScore",
    "cheatingRisk",
    "misconductFlag",
    "emotionScore",
    "personalityScore",
    "voiceDerivedScore",
    "speechConfidenceScore",
    "accentScore",
    "toneScore"
  ];

  for (const field of aliases) {
    assert.throws(() => assertNoProhibitedFields({ [field]: true }));
    const result = CreateSubmissionRequestSchema.safeParse({ ...request, [field]: true });
    assert.equal(result.success, false, field);
    if (!result.success) assert.equal(result.issues[0]?.code, "forbidden_field", field);
  }

  assert.doesNotThrow(() => assertNoProhibitedFields({ failure_mode: "timeout" }));
});
