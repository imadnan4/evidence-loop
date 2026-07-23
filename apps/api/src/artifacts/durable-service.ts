import { createHmac, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { withTenantTransaction, fingerprintRequest, IdempotencyConflictError, reserveIdempotencyKey, writeWithAuditAndOutbox } from "@evidence-loop/db";
import { capabilityDigest, opaqueQuarantineKey, sha256, validateBytes, validateUploadMetadata, type ArtifactStorage } from "@evidence-loop/artifact-pipeline";
import type { Principal, CourseRole } from "../auth/principal.ts";

const STAFF = new Set<CourseRole>(["instructor", "teaching_assistant", "course_admin"]);
const CAPABILITY_VERSION = "v1";

export class ArtifactHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string) { super(code); this.statusCode = statusCode; this.code = code; }
}
const notFound = () => new ArtifactHttpError(404, "not_found");
const invalid = () => new ArtifactHttpError(400, "validation");
const conflict = () => new ArtifactHttpError(409, "invalid_state");
function idempotencyKey(value: string | undefined) { if (!value || !/^[A-Za-z0-9_-]{16,255}$/.test(value)) throw invalid(); return value; }
function capability(secret: string, intentId: string) { return `${CAPABILITY_VERSION}_${createHmac("sha256", secret).update(`${CAPABILITY_VERSION}:${intentId}`).digest("base64url")}`; }

type SubmissionRow = { id: string; course_id: string; learner_id: string; state: string };
type IntentRow = { artifact_id: string; submission_id: string; expected_byte_size: number; expected_sha256: string; expires_at: Date; consumed_at: Date | null; quarantine_key: string; declared_extension: string; declared_content_type: string };

/** Durable ingress only. It never returns object keys, bucket names, object bytes, or read capabilities. */
export class DurableArtifactService {
  private readonly client: Sql<{}>;
  private readonly storage: ArtifactStorage;
  private readonly capabilitySecret: string;
  constructor(client: Sql<{}>, storage: ArtifactStorage, capabilitySecret: string) {
    // The parsed server environment requires this non-browser storage secret. It is used only as an HMAC key; the raw capability is never persisted.
    this.client = client; this.storage = storage; this.capabilitySecret = capabilitySecret;
  }
  private transaction<T>(principal: Principal, work: (tx: TransactionSql) => Promise<T>) {
    return withTenantTransaction(this.client, { organizationId: principal.organizationId, actorId: principal.userId, correlationId: principal.correlationId }, work);
  }
  private async submission(tx: TransactionSql, principal: Principal, submissionId: string, ownerWrite: boolean): Promise<SubmissionRow> {
    const rows = await tx<SubmissionRow[]>`
      SELECT s.id, s.course_id, s.learner_id, s.state
      FROM submissions s JOIN course_memberships m
        ON m.organization_id=s.organization_id AND m.course_id=s.course_id AND m.user_id=${principal.userId}
      WHERE s.organization_id=${principal.organizationId} AND s.id=${submissionId}`;
    const row = rows[0];
    if (!row) throw notFound();
    const roleRows = await tx<{ role: CourseRole }[]>`SELECT role FROM course_memberships WHERE organization_id=${principal.organizationId} AND course_id=${row.course_id} AND user_id=${principal.userId}`;
    const role = roleRows[0]?.role;
    if (!role || (ownerWrite && (role !== "learner" || row.learner_id !== principal.userId)) || (!ownerWrite && row.learner_id !== principal.userId && !STAFF.has(role))) throw notFound();
    return row;
  }
  private responseCapability(intentId: string) { return capability(this.capabilitySecret, intentId); }

  async createSubmission(principal: Principal, assessmentVersionId: string, header: string | undefined) {
    const key = idempotencyKey(header);
    return this.transaction(principal, async (tx) => {
      const reservation = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation: "submission.create", key, requestFingerprint: fingerprintRequest({ assessmentVersionId }) });
      if (reservation === "replayed") {
        const prior = await tx<{ target_id: string }[]>`SELECT target_id FROM idempotency_results WHERE organization_id=${principal.organizationId} AND operation='submission.create' AND key=${key}`;
        if (!prior[0]) throw conflict();
        return { submission_id: prior[0].target_id, replayed: true };
      }
      const versions = await tx<{ assessment_id: string; course_id: string }[]>`
        SELECT v.assessment_id, v.course_id FROM assessment_versions v JOIN assessments a
          ON a.id=v.assessment_id AND a.organization_id=v.organization_id
        WHERE v.organization_id=${principal.organizationId} AND v.id=${assessmentVersionId}
          AND v.state='published' AND a.state='published' AND a.current_published_version_id=v.id`;
      const version = versions[0];
      if (!version) throw notFound();
      const member = await tx<{ role: CourseRole }[]>`SELECT role FROM course_memberships WHERE organization_id=${principal.organizationId} AND course_id=${version.course_id} AND user_id=${principal.userId}`;
      if (member[0]?.role !== "learner") throw notFound();
      const submissionId = randomUUID();
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId, actorId: principal.userId, correlationId: principal.correlationId,
        audit: { action: "submission.created", targetType: "submission", targetId: submissionId, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "submission", aggregateId: submissionId, topic: "artifact.submission_created", payload: {} },
        domainWrite: async (inner) => {
          await inner`INSERT INTO submissions (id,organization_id,course_id,assessment_id,assessment_version_id,learner_id) VALUES (${submissionId},${principal.organizationId},${version.course_id},${version.assessment_id},${assessmentVersionId},${principal.userId})`;
          await inner`INSERT INTO idempotency_results (organization_id,operation,key,target_type,target_id) VALUES (${principal.organizationId},'submission.create',${key},'submission',${submissionId})`;
        },
      });
      return { submission_id: submissionId, replayed: false };
    });
  }

  async issueIntent(principal: Principal, submissionId: string, body: unknown, header: string | undefined) {
    const key = idempotencyKey(header);
    let metadata: ReturnType<typeof validateUploadMetadata>;
    try { const value = body as Record<string, unknown>; metadata = validateUploadMetadata(value.file_name, value.content_type, value.byte_size, value.sha256); } catch { throw invalid(); }
    return this.transaction(principal, async (tx) => {
      const submission = await this.submission(tx, principal, submissionId, true);
      if (submission.state !== "uploading") throw conflict();
      const operation = `artifact.intent:${submissionId}`;
      const reservation = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprintRequest(metadata) });
      if (reservation === "replayed") {
        const prior = await tx<{ target_id: string }[]>`SELECT target_id FROM idempotency_results WHERE organization_id=${principal.organizationId} AND operation=${operation} AND key=${key}`;
        const intents = prior[0] ? await tx<{ id: string; artifact_id: string; expires_at: Date; consumed_at: Date | null }[]>`SELECT id,artifact_id,expires_at,consumed_at FROM artifact_upload_intents WHERE organization_id=${principal.organizationId} AND id=${prior[0].target_id}` : [];
        const intent = intents[0];
        if (!intent || intent.expires_at <= new Date() || intent.consumed_at) throw conflict();
        return { artifact_id: intent.artifact_id, intent_id: intent.id, expires_at: intent.expires_at.toISOString(), capability: this.responseCapability(intent.id), replayed: true };
      }
      await tx`SELECT s.id FROM submissions s WHERE s.organization_id=${principal.organizationId} AND s.id=${submissionId} FOR UPDATE`;
      const count = await tx<{ count: string }[]>`SELECT count(*) FROM artifacts WHERE organization_id=${principal.organizationId} AND submission_id=${submissionId} AND status NOT IN ('rejected','deleted')`;
      if (Number(count[0]?.count ?? 0) >= 5) throw conflict();
      const artifactId = randomUUID(); const intentId = randomUUID(); const expiresAt = new Date(Date.now() + 10 * 60_000);
      const uploadCapability = this.responseCapability(intentId);
      await writeWithAuditAndOutbox(tx, {
        organizationId: principal.organizationId, actorId: principal.userId, correlationId: principal.correlationId,
        audit: { action: "artifact.intent_issued", targetType: "artifact", targetId: artifactId, metadata: { source: "learner", outcome: "accepted" } },
        outbox: { aggregateType: "artifact", aggregateId: artifactId, topic: "artifact.intent_issued", payload: { artifact_id: artifactId } },
        domainWrite: async (inner) => {
          await inner`INSERT INTO artifacts (id,organization_id,submission_id,quarantine_key,declared_extension,declared_content_type,byte_size,sha256) VALUES (${artifactId},${principal.organizationId},${submissionId},${opaqueQuarantineKey(principal.organizationId, artifactId)},${metadata.extension},${metadata.contentType},${metadata.byteSize},${metadata.digest})`;
          await inner`INSERT INTO artifact_upload_intents (id,organization_id,submission_id,artifact_id,actor_id,token_digest,expected_byte_size,expected_sha256,expires_at) VALUES (${intentId},${principal.organizationId},${submissionId},${artifactId},${principal.userId},${capabilityDigest(uploadCapability)},${metadata.byteSize},${metadata.digest},${expiresAt})`;
          await inner`INSERT INTO idempotency_results (organization_id,operation,key,target_type,target_id) VALUES (${principal.organizationId},${operation},${key},'artifact_upload_intent',${intentId})`;
        },
      });
      return { artifact_id: artifactId, intent_id: intentId, expires_at: expiresAt.toISOString(), capability: uploadCapability, replayed: false };
    });
  }

  async upload(principal: Principal, intentId: string, rawCapability: string | undefined, bytes: Buffer, header: string | undefined) {
    const key = idempotencyKey(header);
    if (!rawCapability || !/^v1_[A-Za-z0-9_-]{43}$/.test(rawCapability)) throw notFound();
    const digest = capabilityDigest(rawCapability); const operation = `artifact.upload:${intentId}`; const fingerprint = fingerprintRequest({ intentId, sha256: sha256(bytes) });
    const claimed = await this.transaction(principal, async (tx) => {
      const rows = await tx<IntentRow[]>`
        SELECT i.artifact_id,i.submission_id,i.expected_byte_size,i.expected_sha256,i.expires_at,i.consumed_at,a.quarantine_key,a.declared_extension,a.declared_content_type
        FROM artifact_upload_intents i JOIN artifacts a ON a.id=i.artifact_id AND a.organization_id=i.organization_id AND a.submission_id=i.submission_id
        WHERE i.organization_id=${principal.organizationId} AND i.id=${intentId} AND i.actor_id=${principal.userId} AND i.token_digest=${digest}`;
      const row = rows[0]; if (!row) throw notFound();
      const existing = await tx<{ request_fingerprint: string }[]>`SELECT request_fingerprint FROM idempotency_keys WHERE organization_id=${principal.organizationId} AND operation=${operation} AND key=${key}`;
      if (existing[0] && existing[0].request_fingerprint !== fingerprint) throw new IdempotencyConflictError();
      if (existing[0]) {
        const prior = await tx<{ target_id: string }[]>`SELECT target_id FROM idempotency_results WHERE organization_id=${principal.organizationId} AND operation=${operation} AND key=${key}`;
        if (prior[0]) return { row, replayedArtifactId: prior[0].target_id };
      }
      await this.submission(tx, principal, row.submission_id, true);
      if (row.consumed_at || row.expires_at <= new Date()) throw conflict();
      if (bytes.length !== row.expected_byte_size || sha256(bytes) !== row.expected_sha256) throw invalid();
      try { validateBytes(row.declared_extension, bytes); } catch { throw invalid(); }
      return { row, replayedArtifactId: null };
    });
    if (claimed.replayedArtifactId) return { artifact_id: claimed.replayedArtifactId, replayed: true };
    try { await this.storage.putQuarantine(claimed.row.quarantine_key, bytes, claimed.row.declared_content_type); }
    catch (error) { if (!(error instanceof Error) || error.message !== "storage_exists") throw error; }
    return this.transaction(principal, async (tx) => {
      const reservation = await reserveIdempotencyKey(tx, { organizationId: principal.organizationId, operation, key, requestFingerprint: fingerprint });
      if (reservation === "replayed") {
        const prior = await tx<{ target_id: string }[]>`SELECT target_id FROM idempotency_results WHERE organization_id=${principal.organizationId} AND operation=${operation} AND key=${key}`;
        if (!prior[0]) throw conflict();
        return { artifact_id: prior[0].target_id, replayed: true };
      }
      const completed = await tx<{ artifact_id: string | null }[]>`SELECT complete_artifact_upload(${principal.organizationId},${principal.userId},${principal.correlationId},${intentId},${digest},${operation},${key}) AS artifact_id`;
      const artifactId = completed[0]?.artifact_id;
      if (!artifactId) throw conflict();
      return { artifact_id: artifactId, replayed: false };
    });
  }

  async status(principal: Principal, submissionId: string, artifactId: string) {
    return this.transaction(principal, async (tx) => {
      await this.submission(tx, principal, submissionId, false);
      const rows = await tx<{ id: string; status: string; failure_code: string | null; created_at: Date; updated_at: Date }[]>`SELECT id,status,failure_code,created_at,updated_at FROM artifacts WHERE organization_id=${principal.organizationId} AND submission_id=${submissionId} AND id=${artifactId}`;
      const artifact = rows[0]; if (!artifact) throw notFound();
      // Until an artifact is ready, its lifecycle is the only observable state.
      // This prevents upload timing, byte-size, fragment, and parser-work signals
      // from becoming a pre-clean metadata oracle.
      if (artifact.status !== "ready") {
        return { artifact_id: artifact.id, status: artifact.status, reason_code: artifact.failure_code };
      }
      const fragments = await tx<{ count: string }[]>`SELECT count(*) FROM artifact_fragments WHERE organization_id=${principal.organizationId} AND artifact_id=${artifactId}`;
      return { artifact_id: artifact.id, status: artifact.status, reason_code: artifact.failure_code, fragment_count: Number(fragments[0]?.count ?? 0), created_at: artifact.created_at.toISOString(), updated_at: artifact.updated_at.toISOString() };
    });
  }
}
