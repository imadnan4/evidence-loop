import { randomBytes, randomUUID } from "node:crypto";
import { ARTIFACT_POLICY, ArtifactPolicyError, validateArtifactMetadata, validateUploadBytes } from "./policy.js";
import { makePrivateStorageKey, sha256 } from "./storage.js";
import { assertCleanScan } from "./scanner.js";

/**
 * Artifact workflow application service. It deliberately has no model client,
 * executable-code path, public object URL, or cross-submission lookup.
 */
export class ArtifactService {
  #repository;
  #storage;
  #authorizer;
  #clock;
  #intents = new Map();

  constructor({ repository, storage, authorizer, clock = () => Date.now() }) {
    if (!repository || !storage || !authorizer) throw new Error("ArtifactService requires repository, private storage, and an authorizer.");
    this.#repository = repository;
    this.#storage = storage;
    this.#authorizer = authorizer;
    this.#clock = clock;
  }

  /**
   * Returns an opaque one-use upload capability for an application upload
   * endpoint. It is not a bucket URL and never grants artifact read access.
   */
  async createPrivateUploadIntent({ actorId, submissionId, fileName, contentType, byteSize }) {
    await this.#assertAuthorized(actorId, submissionId, "artifact:upload");
    const metadata = validateArtifactMetadata({ fileName, contentType, byteSize });
    const existing = await this.#repository.countForSubmission(submissionId);
    const pending = [...this.#intents.values()].filter((intent) => intent.submissionId === submissionId && !intent.used && intent.expiresAt > this.#clock()).length;
    if (existing + pending >= ARTIFACT_POLICY.maxArtifactsPerSubmission) {
      throw new ArtifactPolicyError("This submission has reached its artifact limit.", "artifact_limit_reached");
    }

    const token = randomBytes(32).toString("base64url");
    const intent = Object.freeze({
      token,
      actorId,
      submissionId,
      metadata,
      expiresAt: this.#clock() + ARTIFACT_POLICY.uploadIntentTtlMs,
      used: false,
    });
    this.#intents.set(token, intent);
    return Object.freeze({
      uploadToken: token,
      expiresAt: new Date(intent.expiresAt).toISOString(),
      acceptedContentType: metadata.contentType,
      maxBytes: metadata.byteSize,
      // The client sends the token to the application upload route. Storage
      // keys and read URLs remain server-only.
      uploadEndpoint: "/submissions/" + encodeURIComponent(submissionId) + "/artifacts/upload",
    });
  }

  async acceptPrivateUpload({ actorId, uploadToken, bytes }) {
    const intent = this.#intents.get(uploadToken);
    if (!intent || intent.used || intent.expiresAt <= this.#clock()) {
      throw new ArtifactPolicyError("This upload link has expired or was already used. Start a new upload.", "upload_intent_invalid");
    }
    if (intent.actorId !== actorId) throw new ArtifactPolicyError("This upload link belongs to a different account.", "upload_intent_forbidden");
    await this.#assertAuthorized(actorId, intent.submissionId, "artifact:upload");
    if (!Buffer.isBuffer(bytes) || bytes.length !== intent.metadata.byteSize) {
      throw new ArtifactPolicyError("The uploaded file size did not match the approved upload.", "upload_size_mismatch");
    }
    validateUploadBytes(bytes, intent.metadata.contentType);

    const artifactId = `artifact_${randomUUID()}`;
    const storageKey = makePrivateStorageKey(artifactId);
    const artifact = Object.freeze({
      id: artifactId,
      submissionId: intent.submissionId,
      fileName: intent.metadata.fileName,
      contentType: intent.metadata.contentType,
      extension: intent.metadata.extension,
      byteSize: bytes.length,
      checksum: sha256(bytes),
      storageKey,
      createdAt: new Date(this.#clock()).toISOString(),
    });

    // Write private bytes before publishing the immutable record. If writing
    // fails, no artifact metadata or partial citation can be observed.
    await this.#storage.putPrivate({ storageKey, bytes, contentType: artifact.contentType });
    try {
      await this.#repository.createArtifact(artifact);
      this.#intents.set(uploadToken, Object.freeze({ ...intent, used: true }));
      return Object.freeze({ artifactId, status: "awaiting_upload" });
    } catch (error) {
      await this.#storage.deletePrivate(storageKey);
      throw error;
    }
  }

  async getArtifactForSubmission({ actorId, submissionId, artifactId }) {
    await this.#assertAuthorized(actorId, submissionId, "artifact:read");
    const artifact = await this.#repository.getArtifact(artifactId);
    if (!artifact || artifact.submissionId !== submissionId) return null;
    // Storage keys are internal capabilities, not API response fields.
    const { storageKey: _storageKey, ...visibleArtifact } = artifact;
    return visibleArtifact;
  }

  async #assertAuthorized(actorId, submissionId, action) {
    const allowed = await this.#authorizer.authorize({ actorId, submissionId, action });
    if (allowed !== true) throw new ArtifactPolicyError("You do not have access to this submission artifact.", "artifact_access_forbidden");
  }
}

/** Runs after upload in a queue/worker process, never in the request handler. */
export class ArtifactNormalizationJob {
  #repository;
  #storage;
  #scanner;
  #parserSandbox;

  constructor({ repository, storage, scanner, parserSandbox }) {
    if (!repository || !storage || !scanner || !parserSandbox) throw new Error("Normalization requires repository, storage, scanner, and parser sandbox.");
    this.#repository = repository;
    this.#storage = storage;
    this.#scanner = scanner;
    this.#parserSandbox = parserSandbox;
  }

  async run({ artifactId }) {
    const artifact = await this.#repository.getArtifact(artifactId);
    if (!artifact) throw new ArtifactPolicyError("Artifact not found.", "artifact_not_found");
    if (artifact.status === "ready") return { artifactId, status: "ready", idempotent: true };
    if (artifact.status !== "awaiting_upload") return { artifactId, status: artifact.status, idempotent: true };

    await this.#repository.setRuntime(artifactId, { status: "scanning", errorCode: null });
    let bytes;
    try {
      bytes = await this.#storage.readPrivate(artifact.storageKey);
      if (sha256(bytes) !== artifact.checksum) throw new Error("Original checksum mismatch");
      const scan = await this.#scanner.scan({ artifactId, bytes: Buffer.from(bytes), contentType: artifact.contentType });
      if (!assertCleanScan(scan)) {
        if (scan.verdict === "infected") {
          await this.#storage.deletePrivate(artifact.storageKey);
          await this.#repository.setRuntime(artifactId, { status: "rejected", errorCode: "malware_detected", scan });
          return { artifactId, status: "rejected" };
        }
        await this.#repository.setRuntime(artifactId, { status: "blocked", errorCode: "scanner_failed", scan });
        return { artifactId, status: "blocked" };
      }
      await this.#repository.setRuntime(artifactId, { status: "normalizing", scan });
      const fragments = await this.#parserSandbox.normalize({ artifact, bytes: Buffer.from(bytes) });
      await this.#repository.insertFragments(artifactId, fragments);
      await this.#repository.setRuntime(artifactId, { status: "ready", errorCode: null });
      return { artifactId, status: "ready", fragmentCount: fragments.length };
    } catch (error) {
      await this.#repository.setRuntime(artifactId, {
        status: "failed",
        errorCode: error instanceof ArtifactPolicyError ? error.code : "normalization_failed",
      });
      return { artifactId, status: "failed" };
    }
  }
}
