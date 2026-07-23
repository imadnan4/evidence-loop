import { AiValidationError } from "./errors.js";
import {
  assertBoundedQuestionText,
  assertBoundedText,
  assertExtractiveObjectiveText,
  assertQuestionHasNoEmbeddedAnswer,
  assertSafeModelText,
  EXPECTED_EVIDENCE,
  FOLLOW_UP_CONDITION,
  FORMATIVE_NEXT_STEP,
  PARTIAL_UNCERTAINTY,
  QUESTION_RATIONALE,
} from "./safety-policy.js";

const ADVERSARIAL_QUESTION = /\b(?:prove\s+(?:that\s+)?you\s+(?:did|wrote|authored)|are\s+you\s+(?:lying|honest)|did\s+you\s+cheat)\b/i;

function fail(message, code = "ai_output_invalid") {
  throw new AiValidationError(message, code);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, label, keys) {
  const candidate = object(value, label);
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an unexpected output shape.`, "ai_output_schema_invalid");
  }
  return candidate;
}

function text(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be non-empty text.`);
  assertSafeModelText(value, label);
  return value.trim();
}

function id(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(`${label} must be an opaque ID.`);
  return value;
}

function bounded(value, expected, label) {
  const normalized = text(value, label);
  assertBoundedText(normalized, expected, label);
  return normalized;
}

function sourceContent(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be non-empty source text.`, "ai_context_invalid");
  return value;
}

function textArray(value, label, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) fail(`${label} must contain ${min ? `at least ${min}` : "only"} text item${min === 1 ? "" : "s"}.`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function requireCurrentSubmission(value, submissionId, label) {
  if (value.submissionId !== submissionId) fail(`${label} does not belong to the current submission.`, "ai_scope_violation");
}

function sourceIndex({ submissionId, artifactFragments = [], responses = [] }) {
  const sources = new Map();
  for (const fragment of artifactFragments) {
    object(fragment, "artifact fragment");
    requireCurrentSubmission(fragment, submissionId, `Artifact fragment ${fragment.id ?? ""}`);
    const sourceId = id(fragment.id, "artifact fragment.id");
    if (sources.has(sourceId)) fail(`Duplicate current-submission source ID ${sourceId}.`, "ai_scope_violation");
    sources.set(sourceId, {
      sourceType: "artifact_fragment",
      locator: text(fragment.locator, `artifact fragment ${sourceId}.locator`),
      content: sourceContent(fragment.content, `artifact fragment ${sourceId}.content`),
    });
  }
  for (const response of responses) {
    object(response, "response");
    requireCurrentSubmission(response, submissionId, `Response ${response.id ?? ""}`);
    const sourceId = id(response.id, "response.id");
    if (sources.has(sourceId)) fail(`Duplicate current-submission source ID ${sourceId}.`, "ai_scope_violation");
    sources.set(sourceId, {
      sourceType: "response",
      locator: `answer:${id(response.questionId, `response ${sourceId}.questionId`)}`,
      content: sourceContent(response.canonicalText, `response ${sourceId}.canonicalText`),
    });
  }
  return sources;
}

function approvedObjectiveIds(objectives) {
  if (!Array.isArray(objectives) || objectives.length === 0) fail("At least one instructor-approved objective is required.", "ai_context_invalid");
  const ids = new Set();
  for (const objective of objectives) {
    object(objective, "objective");
    if (objective.assessableInCheckIn !== true) continue;
    ids.add(id(objective.id, "objective.id"));
  }
  if (ids.size === 0) fail("At least one assessable instructor-approved objective is required.", "ai_context_invalid");
  return ids;
}

function normalizedTerms(value) {
  return new Set(value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

function isSemanticDuplicate(question, priorQuestions) {
  const terms = normalizedTerms(question);
  if (terms.size === 0) return false;
  return priorQuestions.some((prior) => {
    const priorTerms = normalizedTerms(prior);
    const shared = [...terms].filter((term) => priorTerms.has(term)).length;
    return shared / Math.max(terms.size, priorTerms.size, 1) >= 0.8;
  });
}

export function validateObjectiveProposal(output, { sourceText }) {
  const root = exactKeys(output, "objective proposal", ["objectives"]);
  if (typeof sourceText !== "string" || sourceText.trim() === "") fail("Objective proposal requires assignment and rubric source text.", "ai_context_invalid");
  if (!Array.isArray(root.objectives) || root.objectives.length === 0 || root.objectives.length > 10) {
    fail("Objective proposal must contain 1 to 10 candidates.");
  }
  return Object.freeze({
    objectives: Object.freeze(root.objectives.map((candidate, index) => {
      const item = exactKeys(candidate, `objectives[${index}]`, ["label", "description", "evidence_criteria"]);
      const label = text(item.label, `objectives[${index}].label`);
      const description = text(item.description, `objectives[${index}].description`);
      const evidenceCriteria = textArray(item.evidence_criteria, `objectives[${index}].evidence_criteria`, { min: 1 });
      assertExtractiveObjectiveText(label, sourceText, `objectives[${index}].label`);
      assertExtractiveObjectiveText(description, sourceText, `objectives[${index}].description`);
      evidenceCriteria.forEach((criterion, criterionIndex) =>
        assertExtractiveObjectiveText(criterion, sourceText, `objectives[${index}].evidence_criteria[${criterionIndex}]`),
      );
      return Object.freeze({ label, description, evidenceCriteria });
    })),
  });
}

export function validateArtifactMap(output, { submissionId, objectives, artifactFragments }) {
  const root = exactKeys(output, "artifact map", ["mappings"]);
  const objectiveIds = approvedObjectiveIds(objectives);
  const sources = sourceIndex({ submissionId, artifactFragments });
  if (!Array.isArray(root.mappings) || root.mappings.length === 0) fail("Artifact map must include mappings.");
  const mapped = new Set();
  return Object.freeze({
    mappings: Object.freeze(root.mappings.map((mapping, index) => {
      const item = exactKeys(mapping, `mappings[${index}]`, ["objective_id", "artifact_fragment_ids"]);
      const objectiveId = id(item.objective_id, `mappings[${index}].objective_id`);
      if (!objectiveIds.has(objectiveId) || mapped.has(objectiveId)) fail("Artifact map may only map each approved objective once.", "ai_scope_violation");
      mapped.add(objectiveId);
      const fragmentIds = textArray(item.artifact_fragment_ids, `mappings[${index}].artifact_fragment_ids`, { min: 1 }).map((value, itemIndex) => {
        const fragmentId = id(value, `mappings[${index}].artifact_fragment_ids[${itemIndex}]`);
        if (sources.get(fragmentId)?.sourceType !== "artifact_fragment") fail("Artifact maps may cite only current-submission artifact fragments.", "ai_scope_violation");
        return fragmentId;
      });
      return Object.freeze({ objectiveId, artifactFragmentIds: Object.freeze([...new Set(fragmentIds)]) });
    })),
  });
}

export function validateQuestionProposal(output, { submissionId, objectives, artifactFragments, priorQuestions = [], remainingBudget }) {
  if (!Number.isInteger(remainingBudget) || remainingBudget < 1) fail("No question budget remains.", "ai_budget_exhausted");
  const root = exactKeys(output, "question proposal", ["objective_id", "question_text", "question_kind", "why_this_question", "source_fragment_ids", "expected_evidence", "follow_up_condition"]);
  const objectiveIds = approvedObjectiveIds(objectives);
  const sources = sourceIndex({ submissionId, artifactFragments });
  const objectiveId = id(root.objective_id, "question proposal.objective_id");
  if (!objectiveIds.has(objectiveId)) fail("Question must map to an approved assessable objective.", "ai_scope_violation");
  const objective = objectives.find((item) => item.id === objectiveId);
  const questionText = text(root.question_text, "question proposal.question_text");
  if (questionText.length > 600 || !/[?]$/.test(questionText)) fail("Question must be one concise question ending in a question mark.");
  const expectedEvidence = text(root.expected_evidence, "question proposal.expected_evidence");
  assertQuestionHasNoEmbeddedAnswer(questionText);
  assertBoundedQuestionText(questionText, objective.label);
  assertBoundedText(expectedEvidence, EXPECTED_EVIDENCE, "question proposal.expected_evidence");
  if (ADVERSARIAL_QUESTION.test(questionText)) fail("Question is adversarial.", "ai_question_adversarial");
  if (isSemanticDuplicate(questionText, priorQuestions.map((prior) => typeof prior === "string" ? prior : prior?.text).filter(Boolean))) {
    fail("Question duplicates a prior question.", "ai_question_duplicate");
  }
  const sourceFragmentIds = textArray(root.source_fragment_ids, "question proposal.source_fragment_ids", { min: 1 }).map((value, index) => {
    const fragmentId = id(value, `question proposal.source_fragment_ids[${index}]`);
    if (sources.get(fragmentId)?.sourceType !== "artifact_fragment") fail("Questions may cite only current-submission artifact fragments.", "ai_scope_violation");
    return fragmentId;
  });
  const kind = text(root.question_kind, "question proposal.question_kind");
  if (!new Set(["explain", "apply", "revise", "compare"]).has(kind)) fail("Question kind is invalid.");
  return Object.freeze({
    objectiveId,
    questionText,
    questionKind: kind,
    whyThisQuestion: bounded(root.why_this_question, QUESTION_RATIONALE, "question proposal.why_this_question"),
    sourceFragmentIds: Object.freeze([...new Set(sourceFragmentIds)]),
    expectedEvidence,
    followUpCondition: bounded(root.follow_up_condition, FOLLOW_UP_CONDITION, "question proposal.follow_up_condition"),
  });
}

function groundedClaim(value, objective, sourceRefs, label) {
  const claim = text(value, label);
  const prefix = `For objective "${objective.label}", the cited submission evidence is: "`;
  const suffix = '".';
  if (!claim.startsWith(prefix) || !claim.endsWith(suffix)) {
    fail(`${label} must use the source-grounded objective template.`, "ai_claim_not_grounded");
  }
  const excerpt = claim.slice(prefix.length, -suffix.length);
  if (excerpt.trim().length === 0 || excerpt.length > 320 || /[\r\n"]/.test(excerpt)) {
    fail(`${label} must contain one concise quoted source excerpt.`, "ai_claim_not_grounded");
  }
  if (!sourceRefs.some((source) => source.content.includes(excerpt))) {
    fail(`${label} excerpt must appear in a cited current-submission source.`, "ai_claim_not_grounded");
  }
  return claim;
}

export function validateEvidenceCardDraft(output, { submissionId, objectives, artifactFragments, responses }) {
  const root = exactKeys(output, "evidence card draft", ["claims"]);
  const objectiveIds = approvedObjectiveIds(objectives);
  const sources = sourceIndex({ submissionId, artifactFragments, responses });
  if (!Array.isArray(root.claims) || root.claims.length === 0) fail("Evidence card draft requires claims.");
  const claimedObjectives = new Set();
  return Object.freeze({
    claims: Object.freeze(root.claims.map((claim, index) => {
      const item = exactKeys(claim, `claims[${index}]`, ["objective_id", "status", "claim", "source_refs", "uncertainty", "formative_next_step", "learner_strengths"]);
      const objectiveId = id(item.objective_id, `claims[${index}].objective_id`);
      if (!objectiveIds.has(objectiveId) || claimedObjectives.has(objectiveId)) fail("Claims must each cover one approved objective once.", "ai_scope_violation");
      claimedObjectives.add(objectiveId);
      const status = text(item.status, `claims[${index}].status`);
      if (!new Set(["demonstrated", "partial", "not_yet_evidenced"]).has(status)) fail("Evidence status is invalid.");
      if (!Array.isArray(item.source_refs) || item.source_refs.length === 0) fail("Every evidence claim needs a current-submission source.", "ai_provenance_missing");
      const sourceRefs = item.source_refs.map((source, sourceIndexValue) => {
        const sourceItem = exactKeys(source, `claims[${index}].source_refs[${sourceIndexValue}]`, ["source_type", "source_id"]);
        const sourceId = id(sourceItem.source_id, `claims[${index}].source_refs[${sourceIndexValue}].source_id`);
        const expected = sources.get(sourceId);
        if (!expected || sourceItem.source_type !== expected.sourceType) fail("Evidence claim source is not in the current submission.", "ai_scope_violation");
        return Object.freeze({ sourceType: expected.sourceType, sourceId, submissionId, locator: expected.locator, content: expected.content });
      });
      const uncertainty = text(item.uncertainty, `claims[${index}].uncertainty`, { nullable: true });
      if (status === "demonstrated" && uncertainty !== null) fail("Demonstrated claims must not include model-authored uncertainty.", "ai_output_not_bounded");
      if (status !== "demonstrated") {
        if (uncertainty === null) fail("Partial or not-yet-evidenced claims require uncertainty.", "ai_provenance_missing");
        assertBoundedText(uncertainty, PARTIAL_UNCERTAINTY, `claims[${index}].uncertainty`);
      }
      if (!Array.isArray(item.learner_strengths) || item.learner_strengths.length !== 0) {
        fail("Evidence drafts may not contain model-authored learner strengths.", "ai_output_not_bounded");
      }
      return Object.freeze({
        objectiveId,
        status,
        claim: groundedClaim(item.claim, objectives.find((objective) => objective.id === objectiveId), sourceRefs, `claims[${index}].claim`),
        sourceRefs: Object.freeze(sourceRefs.map(({ content: _content, ...sourceRef }) => Object.freeze(sourceRef))),
        uncertainty,
        formativeNextStep: bounded(item.formative_next_step, FORMATIVE_NEXT_STEP, `claims[${index}].formative_next_step`),
        learnerStrengths: Object.freeze([]),
      });
    })),
  });
}
