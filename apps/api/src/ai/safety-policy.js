import { AiValidationError } from "./errors.js";

/**
 * Deterministic policy enforcement for model-authored text. This is separate
 * from the shared-contract field-name boundary: free-form model text needs its
 * own conservative safety policy before it can reach an evidence card or a
 * learner question. It intentionally rejects a category rather than trying to
 * decide whether an inference in that category is accurate.
 */
export const QUESTION_RATIONALE = "This question targets an uncovered instructor-approved objective using cited current-submission context.";
export const EXPECTED_EVIDENCE = "A response that explains, applies, compares, or revises the cited work in relation to the objective.";
export const FOLLOW_UP_CONDITION = "If the response does not address the objective, request human follow-up or a formative revision.";
export const PARTIAL_UNCERTAINTY = "The available current-submission sources do not yet verify all parts of this objective.";
export const FORMATIVE_NEXT_STEP = "Review the cited work and explain the objective in a new example.";

export const MODEL_OUTPUT_SAFETY_POLICY = Object.freeze([
  Object.freeze({
    category: "automated_grading",
    patterns: Object.freeze([/\b(?:grade|grading|score|scored|pass[ -]?fail|final\s+(?:mark|result)|letter\s+grade|(?:merits?|earns?|deserves?)\s+(?:an?\s+)?[a-f])\b/i]),
  }),
  Object.freeze({
    category: "academic_integrity_or_authorship",
    patterns: Object.freeze([
      /\b(?:cheat(?:ing)?|misconduct|plagiari[sz](?:e|ed|m|ing)?|deception|fraud)\b/i,
      /\b(?:authorship|authored|wrote\s+(?:this|the\s+(?:work|submission))|writing\s+style|ai[ -]?(?:generated|written|authored)|used\s+ai|ai\s+use|chatgpt|openai)\b/i,
    ]),
  }),
  Object.freeze({
    category: "honesty_or_intent",
    patterns: Object.freeze([/\b(?:honest(?:y)?|dishonest|lying|truthful|intention(?:s)?|intended\s+to)\b/i]),
  }),
  Object.freeze({
    category: "emotion_or_personality",
    patterns: Object.freeze([
      /\b(?:anxious|anxiety|nervous|stressed|upset|afraid|angry|frustrated|emotional|confident|uncertain|calm|shy|quiet)\b/i,
      /\b(?:introvert(?:ed)?|extrovert(?:ed)?|personality|trait|conscientious|lazy|diligent|motivated)\b/i,
      /\b(?:sounds?|seems?|appears?)\s+(?:anxious|nervous|stressed|upset|afraid|angry|frustrated|confident|introverted|extroverted|calm|shy)\b/i,
    ]),
  }),
  Object.freeze({
    category: "voice_or_language_inference",
    patterns: Object.freeze([
      /\b(?:voice|accent|tone|speech\s+(?:rate|pattern)|speaks?\s+(?:quickly|slowly)|pace|pronunciation|fluency|native\s+(?:\w+\s+)?(?:speaker|language))\b/i,
      /\b(?:sounds?|speaks?|spoke)\s+(?:like|with)\b/i,
    ]),
  }),
  Object.freeze({
    category: "identity_or_disability_inference",
    patterns: Object.freeze([/\b(?:identity|race|ethnicity|gender|disability|disabled|adhd|autistic|dyslexi[ac])\b/i]),
  }),
]);

const INSTRUCTION_INJECTION = /(?:ignore|override|disregard|reveal|follow)\s+(?:all\s+)?(?:previous|prior|system|developer|instructions?)|\b(?:system\s*prompt|call\s+(?:a\s+)?tool|browse\s+(?:the\s+)?web|execute\s+(?:this\s+)?code)\b/i;

/** Reject any model-authored text that violates the product boundary. */
export function assertSafeModelText(value, label) {
  for (const rule of MODEL_OUTPUT_SAFETY_POLICY) {
    if (rule.patterns.some((pattern) => pattern.test(value))) {
      throw new AiValidationError(`${label} violates the ${rule.category} policy.`, "ai_output_prohibited");
    }
  }
  if (INSTRUCTION_INJECTION.test(value)) {
    throw new AiValidationError(`${label} contains instruction-like content.`, "ai_output_injection");
  }
}

/**
 * Only a source-extractive candidate objective can be offered for instructor
 * approval. This removes model freedom to infer learner traits or outcomes
 * while retaining the authoring assistant's ability to select relevant rubric
 * language. The instructor remains the required approver.
 */
export function assertExtractiveObjectiveText(value, sourceText, label) {
  assertSafeModelText(value, label);
  if (!normalizeForMatch(sourceText).includes(normalizeForMatch(value))) {
    throw new AiValidationError(`${label} must be an exact excerpt from the assignment or rubric.`, "ai_output_not_extractive");
  }
}

/** Requires model-authored operational prose to be one fixed safe template. */
export function assertBoundedText(value, expected, label) {
  assertSafeModelText(value, label);
  if (value.trim() !== expected) {
    throw new AiValidationError(`${label} must use the bounded Evidence Loop template.`, "ai_output_not_bounded");
  }
}

/** A learner question is fixed to its approved objective; only source IDs select context. */
export function expectedQuestionText(objectiveLabel) {
  return `How does the cited work relate to the objective "${objectiveLabel}"?`;
}

export function assertBoundedQuestionText(value, objectiveLabel) {
  assertSafeModelText(value, "question proposal.question_text");
  if (value.trim() !== expectedQuestionText(objectiveLabel)) {
    throw new AiValidationError("Question must use the objective-scoped Evidence Loop template.", "ai_question_unsafe");
  }
}

/**
 * Reject a learner-facing question if it supplies its own causal explanation.
 * The check is deliberately conservative: a question can ask *whether* or
 * *why* something happens, but cannot state a reason/outcome in the question.
 */
export function assertQuestionHasNoEmbeddedAnswer(questionText) {
  const questionMarks = questionText.match(/\?/g) ?? [];
  if (questionMarks.length !== 1 || !questionText.trim().endsWith("?")) {
    throw new AiValidationError("Question must contain exactly one interrogative sentence.", "ai_question_leading");
  }
  const normalized = questionText.toLowerCase();
  const directAnswer = /\b(?:the\s+(?:correct|right)\s+answer\s+is|answer\s*[:=]|you\s+should\s+answer|say\s+that)\b/i;
  const causalAssertion = /\b(?:because|since|thereby|so\s+that|in\s+order\s+to|by\s+(?:preventing|keeping|avoiding|ensuring|reducing))\b/i;
  const whyWithOutcome = /^\s*why\b[^?]*(?:\bwhen\s+it\s+|\b(?:prevents?|avoids?|keeps?|ensures?|protects?|stops?|reduces?|causes?|means|allows?|leads\s+to)\b)[^?]*\?\s*$/i;
  const assertionPhrase = /\b(?:keeps?\s+(?:the\s+)?(?:test|held[ -]?out)\s+(?:data|information)\s+(?:from|out\s+of)|prevents?\s+(?:data\s+)?leakage|avoids?\s+(?:data\s+)?leakage|ensures?\s+(?:that\s+)?(?:test|held[ -]?out)\s+(?:data|information)|reduces?\s+(?:the\s+)?(?:error|bias)|causes?\s+(?:the\s+)?(?:result|model))\b/i;
  if (directAnswer.test(questionText) || causalAssertion.test(questionText) || whyWithOutcome.test(questionText) || assertionPhrase.test(questionText)) {
    throw new AiValidationError("Question contains an explanatory answer.", "ai_question_leading");
  }
}

function normalizeForMatch(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

