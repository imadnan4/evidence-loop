function clone(value) { return structuredClone(value); }

/**
 * Voice transport lifecycle only. Canonical transcripts/responses belong to the
 * F04 session repository, whose `commitVoiceResponse` operation is the sole
 * transaction for assessment evidence and state advancement.
 */
export class InMemoryVoiceRepository {
  #connections = new Map();

  async createConnection(connection) {
    if (this.#connections.has(connection.id)) throw new Error("Voice connection already exists.");
    this.#connections.set(connection.id, Object.freeze(clone(connection)));
    return this.getConnection(connection.id);
  }

  async getConnection(id) {
    const value = this.#connections.get(id);
    return value ? clone(value) : null;
  }

  async updateConnection(id, patch) {
    const current = this.#connections.get(id);
    if (!current) throw new Error("Voice connection not found.");
    const next = Object.freeze({ ...current, ...clone(patch) });
    this.#connections.set(id, next);
    return clone(next);
  }
}
