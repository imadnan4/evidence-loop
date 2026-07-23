import { AiConfigurationError, AiModelError } from "./errors.js";

const OUTPUT_SCHEMAS = Object.freeze({
  objective_proposal: objectSchema({
    objectives: arraySchema(objectSchema({
      label: stringSchema(),
      description: stringSchema(),
      evidence_criteria: arraySchema(stringSchema()),
    })),
  }),
  artifact_map: objectSchema({
    mappings: arraySchema(objectSchema({
      objective_id: stringSchema(),
      artifact_fragment_ids: arraySchema(stringSchema()),
    })),
  }),
  question_proposal: objectSchema({
    objective_id: stringSchema(),
    question_text: stringSchema(),
    question_kind: stringSchema(),
    why_this_question: stringSchema(),
    source_fragment_ids: arraySchema(stringSchema()),
    expected_evidence: stringSchema(),
    follow_up_condition: stringSchema(),
  }),
  evidence_card_draft: objectSchema({
    claims: arraySchema(objectSchema({
      objective_id: stringSchema(),
      status: stringSchema(),
      claim: stringSchema(),
      source_refs: arraySchema(objectSchema({
        source_type: stringSchema(),
        source_id: stringSchema(),
      })),
      uncertainty: nullableStringSchema(),
      formative_next_step: stringSchema(),
      learner_strengths: arraySchema(stringSchema()),
    })),
  }),
});

/**
 * Server-only adapter for the OpenAI Responses API. It exposes no tool or web
 * options and requires the caller to pass a pinned model identifier. API keys
 * stay in server configuration; do not instantiate this class in the browser.
 */
export class OpenAiResponsesClient {
  #apiKey;
  #fetch;
  #endpoint;

  constructor({ apiKey, fetchImplementation = globalThis.fetch, endpoint = "https://api.openai.com/v1/responses" }) {
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new AiConfigurationError("OpenAiResponsesClient requires a server-side API key.");
    }
    if (typeof fetchImplementation !== "function") {
      throw new AiConfigurationError("OpenAiResponsesClient requires fetch.");
    }
    this.#apiKey = apiKey;
    this.#fetch = fetchImplementation;
    this.#endpoint = endpoint;
  }

  async generateStructured({ operation, modelId, templateVersion, schemaVersion, prompt }) {
    const schema = OUTPUT_SCHEMAS[operation];
    if (!schema) throw new AiConfigurationError(`Unknown structured AI operation: ${operation}`);
    if (typeof modelId !== "string" || modelId.trim() === "" || typeof prompt !== "string" || prompt.trim() === "") {
      throw new AiConfigurationError("Structured model requests require modelId and prompt.");
    }

    const timeoutMs = 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          "x-client-template-version": templateVersion,
          "x-client-schema-version": schemaVersion,
        },
        body: JSON.stringify({
          model: modelId,
          input: prompt,
          // Keep server-side application state authoritative and request no
          // provider-side response storage for this student-content operation.
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: `evidence_loop_${operation}`,
              strict: true,
              schema,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AiModelError) throw error;
      throw new AiModelError("The structured model request did not complete.", "model_request_failed");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Do not include provider response text: it can echo sensitive inputs.
      throw new AiModelError("The structured model request did not complete.", "model_request_failed");
    }
    const payload = await response.json();
    if (typeof payload?.output_text !== "string") {
      throw new AiModelError("The structured model response has no output text.", "model_response_invalid");
    }
    try {
      return JSON.parse(payload.output_text);
    } catch {
      throw new AiModelError("The structured model response is not valid JSON.", "model_response_invalid");
    }
  }
}

export function outputSchemaFor(operation) {
  const schema = OUTPUT_SCHEMAS[operation];
  if (!schema) throw new AiConfigurationError(`Unknown structured AI operation: ${operation}`);
  return structuredClone(schema);
}

function stringSchema() {
  return { type: "string" };
}

function nullableStringSchema() {
  return { type: ["string", "null"] };
}

function arraySchema(items) {
  return { type: "array", items };
}

function objectSchema(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
