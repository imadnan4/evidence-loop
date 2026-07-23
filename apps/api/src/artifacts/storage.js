import { createHash, randomUUID } from "node:crypto";

/**
 * Private object-storage boundary. Implementations deliberately do not expose
 * a public read URL. A web route may accept the opaque upload token, but only
 * workers with this interface may read original bytes.
 */
export class PrivateObjectStorage {
  async putPrivate(_input) { throw new Error("Not implemented"); }
  async readPrivate(_storageKey) { throw new Error("Not implemented"); }
  async deletePrivate(_storageKey) { throw new Error("Not implemented"); }
}

/** In-memory adapter used by tests and local development only. */
export class InMemoryPrivateObjectStorage extends PrivateObjectStorage {
  #objects = new Map();

  async putPrivate({ storageKey, bytes, contentType }) {
    if (this.#objects.has(storageKey)) throw new Error("Storage keys are write-once.");
    this.#objects.set(storageKey, Object.freeze({ bytes: Buffer.from(bytes), contentType }));
  }

  async readPrivate(storageKey) {
    const object = this.#objects.get(storageKey);
    if (!object) throw new Error("Private object was not found.");
    return Buffer.from(object.bytes);
  }

  async deletePrivate(storageKey) {
    this.#objects.delete(storageKey);
  }

  has(storageKey) { return this.#objects.has(storageKey); }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Opaque, non-user-controlled key. Never return this to browser callers. */
export function makePrivateStorageKey(artifactId) {
  return `artifacts/${artifactId}/${randomUUID()}`;
}
