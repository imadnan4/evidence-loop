function copy(value) {
  return structuredClone(value);
}

/**
 * Persistence boundary for F03. Production adapters should make artifacts and
 * fragments append-only and enforce submission/course authorization in the
 * database query itself. This adapter models that behavior for local checks.
 */
export class InMemoryArtifactRepository {
  #artifacts = new Map();
  #runtime = new Map();
  #fragments = new Map();

  async countForSubmission(submissionId) {
    let count = 0;
    for (const artifact of this.#artifacts.values()) if (artifact.submissionId === submissionId) count += 1;
    return count;
  }

  async createArtifact(artifact) {
    if (this.#artifacts.has(artifact.id)) throw new Error("Artifact already exists.");
    this.#artifacts.set(artifact.id, Object.freeze(copy(artifact)));
    this.#runtime.set(artifact.id, { status: "awaiting_upload", errorCode: null, scan: null });
    return this.getArtifact(artifact.id);
  }

  async getArtifact(id) {
    const artifact = this.#artifacts.get(id);
    const runtime = this.#runtime.get(id);
    if (!artifact || !runtime) return null;
    return copy({ ...artifact, ...runtime });
  }

  async setRuntime(id, patch) {
    const existing = this.#runtime.get(id);
    if (!existing) throw new Error("Artifact not found.");
    this.#runtime.set(id, Object.freeze({ ...existing, ...copy(patch) }));
    return this.getArtifact(id);
  }

  async insertFragments(artifactId, fragments) {
    if (this.#fragments.has(artifactId)) throw new Error("Artifact fragments are immutable and already exist.");
    this.#fragments.set(artifactId, Object.freeze(fragments.map((fragment) => Object.freeze(copy(fragment)))));
  }

  async listFragments(artifactId) {
    return copy(this.#fragments.get(artifactId) ?? []);
  }
}
