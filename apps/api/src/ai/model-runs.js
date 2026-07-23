import { randomUUID } from "node:crypto";

function copy(value) {
  return structuredClone(value);
}

/**
 * Append-only run metadata. Raw artifacts, responses, prompts, and model
 * output are intentionally excluded; debugging storage requires a separate,
 * tightly restricted retention policy.
 */
export class InMemoryModelRunRepository {
  #runs = [];

  async append(run) {
    const entry = Object.freeze(copy(run));
    this.#runs.push(entry);
    return copy(entry);
  }

  async list() {
    return copy(this.#runs);
  }
}

export function createModelRun({
  id = `modelrun_${randomUUID()}`,
  operation,
  templateVersion,
  modelId,
  schemaVersion,
  inputObjectIds,
  outcome,
  failureMode = null,
  startedAt,
  completedAt,
}) {
  return Object.freeze({
    id,
    operation,
    templateVersion,
    modelId,
    schemaVersion,
    inputObjectIds: Object.freeze([...new Set(inputObjectIds)]),
    outcome,
    failureMode,
    startedAt,
    completedAt,
  });
}
