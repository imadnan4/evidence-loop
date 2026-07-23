import { randomUUID } from "node:crypto";

import { AiConfigurationError, AiModelError, AiValidationError } from "./errors.js";
import { createModelRun } from "./model-runs.js";
import {
  artifactMapPrompt,
  evidenceCardPrompt,
  objectiveProposalPrompt,
  questionProposalPrompt,
  TEMPLATE_VERSION,
} from "./templates.js";
import {
  validateArtifactMap,
  validateEvidenceCardDraft,
  validateObjectiveProposal,
  validateQuestionProposal,
} from "./validators.js";

export const AI_OUTPUT_SCHEMA_VERSION = "f05.1";

/**
 * Bounded AI application service. Its only dependency is a structured model
 * adapter with generateStructured({ operation, modelId, templateVersion,
 * schemaVersion, prompt }). There is deliberately no tool, web, retrieval,
 * code-execution, or action callback surface.
 */
export class AiOrchestrator {
  #modelClient;
  #modelRunRepository;
  #modelId;
  #clock;
  #id;

  constructor({ modelClient, modelRunRepository, modelId, clock = () => new Date().toISOString(), id = () => `modelrun_${randomUUID()}` }) {
    if (!modelClient || typeof modelClient.generateStructured !== "function") {
      throw new AiConfigurationError("AiOrchestrator requires a structured model client.");
    }
    if (!modelRunRepository || typeof modelRunRepository.append !== "function") {
      throw new AiConfigurationError("AiOrchestrator requires a model-run repository.");
    }
    if (typeof modelId !== "string" || modelId.trim() === "") {
      throw new AiConfigurationError("AiOrchestrator requires a pinned model ID.");
    }
    this.#modelClient = modelClient;
    this.#modelRunRepository = modelRunRepository;
    this.#modelId = modelId;
    this.#clock = clock;
    this.#id = id;
  }

  async proposeObjectives({ assignmentInstructions, rubric, assessmentId }) {
    requireText(assignmentInstructions, "assignmentInstructions");
    requireText(rubric, "rubric");
    const output = await this.#run({
      operation: "objective_proposal",
      inputObjectIds: [requireId(assessmentId, "assessmentId")],
      prompt: objectiveProposalPrompt({ assignmentInstructions, rubric }),
      validate: (value) => validateObjectiveProposal(value, { sourceText: `${assignmentInstructions}\n${rubric}` }),
    });
    // This output intentionally has no approval or publish side effect.
    return output;
  }

  async mapArtifacts({ submissionId, objectives, artifactFragments }) {
    const currentSubmissionId = requireId(submissionId, "submissionId");
    const fragments = currentArtifacts(currentSubmissionId, artifactFragments);
    const output = await this.#run({
      operation: "artifact_map",
      inputObjectIds: [currentSubmissionId, ...fragments.map((fragment) => fragment.id), ...objectiveIds(objectives)],
      prompt: artifactMapPrompt({ objectives: modelObjectives(objectives), fragments: modelFragments(fragments) }),
      validate: (value) => validateArtifactMap(value, { submissionId: currentSubmissionId, objectives, artifactFragments: fragments }),
    });
    return output;
  }

  async proposeQuestion({ submissionId, objectives, artifactFragments, priorAnswers = [], priorQuestions = [], remainingBudget }) {
    if (!Number.isInteger(remainingBudget) || remainingBudget < 1) {
      throw new AiValidationError("No question budget remains.", "ai_budget_exhausted");
    }
    const currentSubmissionId = requireId(submissionId, "submissionId");
    const fragments = currentArtifacts(currentSubmissionId, artifactFragments);
    const answers = currentResponses(currentSubmissionId, priorAnswers);
    const output = await this.#run({
      operation: "question_proposal",
      inputObjectIds: [
        currentSubmissionId,
        ...objectiveIds(objectives),
        ...fragments.map((fragment) => fragment.id),
        ...answers.map((answer) => answer.id),
      ],
      prompt: questionProposalPrompt({
        objectives: modelObjectives(objectives),
        fragments: modelFragments(fragments),
        priorAnswers: modelResponses(answers),
        priorQuestions: priorQuestions.map((question) => ({ text: typeof question === "string" ? question : question.text })),
        remainingBudget,
      }),
      validate: (value) => validateQuestionProposal(value, {
        submissionId: currentSubmissionId,
        objectives,
        artifactFragments: fragments,
        priorQuestions,
        remainingBudget,
      }),
    });
    return output;
  }

  async draftEvidenceCard({ submissionId, objectives, artifactFragments, responses, questions = [] }) {
    const currentSubmissionId = requireId(submissionId, "submissionId");
    const fragments = currentArtifacts(currentSubmissionId, artifactFragments);
    const currentResponsesForSubmission = currentResponses(currentSubmissionId, responses);
    const output = await this.#run({
      operation: "evidence_card_draft",
      inputObjectIds: [
        currentSubmissionId,
        ...objectiveIds(objectives),
        ...fragments.map((fragment) => fragment.id),
        ...currentResponsesForSubmission.map((response) => response.id),
        ...questions.map((question) => requireId(question.id, "question.id")),
      ],
      prompt: evidenceCardPrompt({
        objectives: modelObjectives(objectives),
        fragments: modelFragments(fragments),
        responses: modelResponses(currentResponsesForSubmission),
        questions: questions.map((question) => ({ id: question.id, text: question.text, objectiveId: question.objectiveId })),
      }),
      validate: (value) => validateEvidenceCardDraft(value, {
        submissionId: currentSubmissionId,
        objectives,
        artifactFragments: fragments,
        responses: currentResponsesForSubmission,
      }),
    });
    return output;
  }

  async #run({ operation, inputObjectIds, prompt, validate }) {
    const startedAt = this.#clock();
    try {
      const rawOutput = await this.#modelClient.generateStructured(Object.freeze({
        operation,
        modelId: this.#modelId,
        templateVersion: TEMPLATE_VERSION,
        schemaVersion: AI_OUTPUT_SCHEMA_VERSION,
        prompt,
        // A fixed operation intentionally has no `tools`, `webSearch`, or
        // executable context fields. Provider adapters must honor this shape.
      }));
      const output = validate(rawOutput);
      await this.#record({ operation, inputObjectIds, outcome: "accepted", startedAt });
      return output;
    } catch (error) {
      const validationError = error instanceof AiValidationError;
      await this.#record({
        operation,
        inputObjectIds,
        outcome: validationError ? "rejected" : "failed",
        failureMode: validationError || error instanceof AiModelError ? error.code : "model_call_failed",
        startedAt,
      });
      throw error;
    }
  }

  async #record({ operation, inputObjectIds, outcome, failureMode = null, startedAt }) {
    await this.#modelRunRepository.append(createModelRun({
      id: this.#id(),
      operation,
      templateVersion: TEMPLATE_VERSION,
      modelId: this.#modelId,
      schemaVersion: AI_OUTPUT_SCHEMA_VERSION,
      inputObjectIds,
      outcome,
      failureMode,
      startedAt,
      completedAt: this.#clock(),
    }));
  }
}

function requireId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new AiValidationError(`${label} must be an opaque ID.`, "ai_context_invalid");
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AiValidationError(`${label} must be non-empty text.`, "ai_context_invalid");
  }
  return value;
}

function objectiveIds(objectives) {
  if (!Array.isArray(objectives)) throw new AiValidationError("objectives must be an array.", "ai_context_invalid");
  return objectives.map((objective) => requireId(objective?.id, "objective.id"));
}

function currentArtifacts(submissionId, fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    throw new AiValidationError("At least one current-submission artifact fragment is required.", "ai_context_invalid");
  }
  return fragments.map((fragment) => {
    if (fragment?.submissionId !== submissionId) {
      throw new AiValidationError("Artifact retrieval must be limited to the current submission.", "ai_scope_violation");
    }
    requireId(fragment.id, "artifact fragment.id");
    requireText(fragment.locator, "artifact fragment.locator");
    requireText(fragment.content, "artifact fragment.content");
    return fragment;
  });
}

function currentResponses(submissionId, responses) {
  if (!Array.isArray(responses)) throw new AiValidationError("responses must be an array.", "ai_context_invalid");
  return responses.map((response) => {
    if (response?.submissionId !== submissionId) {
      throw new AiValidationError("Response retrieval must be limited to the current submission.", "ai_scope_violation");
    }
    requireId(response.id, "response.id");
    requireId(response.questionId, "response.questionId");
    requireText(response.canonicalText, "response.canonicalText");
    return response;
  });
}

function modelObjectives(objectives) {
  return objectives.map((objective) => ({
    id: objective.id,
    label: objective.label,
    description: objective.description,
    evidenceCriteria: objective.evidenceCriteria,
    assessableInCheckIn: objective.assessableInCheckIn,
  }));
}

function modelFragments(fragments) {
  return fragments.map((fragment) => ({ id: fragment.id, locator: fragment.locator, content: fragment.content }));
}

function modelResponses(responses) {
  return responses.map((response) => ({ id: response.id, questionId: response.questionId, canonicalText: response.canonicalText }));
}
