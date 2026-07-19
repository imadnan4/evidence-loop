import { createHash } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";

export type TenantTransactionContext = Readonly<{
  organizationId: string;
  actorId: string | null;
  correlationId: string;
}>;

export type AuditMetadata = Readonly<Record<string, string | number | boolean>>;

type AuditEnumKey = "reason" | "source" | "outcome";

const AUDIT_ENUMS: Readonly<Record<AuditEnumKey, ReadonlySet<string>>> = {
  reason: new Set(["policy_acknowledged", "human_follow_up", "idempotency_replay", "validation_failed", "system_failure"]),
  source: new Set(["api", "worker", "system", "instructor", "learner"]),
  outcome: new Set(["accepted", "rejected", "queued", "completed", "failed", "replayed"]),
};
const AUDIT_OPAQUE_ID_KEYS = new Set(["requestId", "jobId", "modelRunId"]);
const AUDIT_NUMBER_KEYS = new Set(["count", "attempt"]);
const AUDIT_BOOLEAN_KEYS = new Set(["retryable"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AUDIT_NUMBER = 1_000_000;

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different request.");
    this.name = "IdempotencyConflictError";
  }
}

export class AuditMetadataError extends Error {
  readonly key: string;
  readonly code: string;

  constructor(key: string, code: string) {
    super(`Audit metadata ${key}: ${code}`);
    this.name = "AuditMetadataError";
    this.key = key;
    this.code = code;
  }
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Request fingerprint requires finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Request fingerprint does not accept cyclic values.");
    ancestors.add(value);
    const result = `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Request fingerprint requires plain JSON objects.");
    if (ancestors.has(value)) throw new TypeError("Request fingerprint does not accept cyclic values.");
    ancestors.add(value);
    const object = value as Record<string, unknown>;
    const result = `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`).join(",")}}`;
    ancestors.delete(value);
    return result;
  }
  throw new TypeError("Request fingerprint requires JSON-compatible input.");
}

/** Hashes validated request data with stable object-key ordering for idempotency. */
export function fingerprintRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Audit metadata is operational context only, never student content or credentials.
 * Strings are restricted to a finite operational vocabulary or UUID-shaped opaque IDs;
 * arbitrary free text is rejected rather than redacted.
 */
export function validateAuditMetadata(value: unknown): AuditMetadata {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AuditMetadataError("metadata", "must-be-a-flat-object");
  }
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key in AUDIT_ENUMS) {
      if (typeof entry !== "string" || !AUDIT_ENUMS[key as AuditEnumKey].has(entry)) {
        throw new AuditMetadataError(key, "enum-value-not-allowed");
      }
      safe[key] = entry;
    } else if (AUDIT_OPAQUE_ID_KEYS.has(key)) {
      if (typeof entry !== "string" || !UUID.test(entry)) throw new AuditMetadataError(key, "invalid-opaque-id");
      safe[key] = entry;
    } else if (AUDIT_NUMBER_KEYS.has(key)) {
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 || entry > MAX_AUDIT_NUMBER) {
        throw new AuditMetadataError(key, "invalid-operational-number");
      }
      safe[key] = entry;
    } else if (AUDIT_BOOLEAN_KEYS.has(key)) {
      if (typeof entry !== "boolean") throw new AuditMetadataError(key, "must-be-boolean");
      safe[key] = entry;
    } else {
      throw new AuditMetadataError(key, "key-not-allowed");
    }
  }
  return Object.freeze(safe);
}

/**
 * Runs a transaction with tenant/actor/correlation context confined to that transaction.
 * Callers must derive these IDs from authenticated server state, never browser input.
 */
export async function withTenantTransaction<T>(client: Sql<{}>, context: TenantTransactionContext, operation: (transaction: TransactionSql) => Promise<T>): Promise<T> {
  return (await client.begin(async (transaction) => {
    await transaction`SELECT set_config('app.organization_id', ${context.organizationId}, true)`;
    await transaction`SELECT set_config('app.actor_id', ${context.actorId ?? ""}, true)`;
    await transaction`SELECT set_config('app.correlation_id', ${context.correlationId}, true)`;
    return operation(transaction);
  })) as T;
}

export async function reserveIdempotencyKey(
  transaction: TransactionSql,
  input: Readonly<{ organizationId: string; operation: string; key: string; requestFingerprint: string }>,
): Promise<"created" | "replayed"> {
  const inserted = await transaction<{ request_fingerprint: string }[]>`
    INSERT INTO idempotency_keys (organization_id, operation, key, request_fingerprint)
    VALUES (${input.organizationId}, ${input.operation}, ${input.key}, ${input.requestFingerprint})
    ON CONFLICT (organization_id, operation, key) DO NOTHING
    RETURNING request_fingerprint`;
  if (inserted.length > 0) return "created";
  const existing = await transaction<{ request_fingerprint: string }[]>`
    SELECT request_fingerprint FROM idempotency_keys
    WHERE organization_id = ${input.organizationId} AND operation = ${input.operation} AND key = ${input.key}`;
  if (existing[0]?.request_fingerprint !== input.requestFingerprint) throw new IdempotencyConflictError();
  return "replayed";
}

export async function writeWithAuditAndOutbox<T>(
  transaction: TransactionSql,
  input: Readonly<{
    organizationId: string;
    actorId: string | null;
    correlationId: string;
    audit: Readonly<{ action: string; targetType: string; targetId: string; metadata?: unknown }>;
    outbox: Readonly<{ aggregateType: string; aggregateId: string; topic: string; payload: Record<string, postgres.JSONValue>; dedupeKey?: string }>;
    domainWrite: (transaction: TransactionSql) => Promise<T>;
  }>,
): Promise<T> {
  const metadata = validateAuditMetadata(input.audit.metadata);
  const result = await input.domainWrite(transaction);
  await transaction`
    INSERT INTO audit_events (organization_id, actor_id, correlation_id, action, target_type, target_id, metadata)
    VALUES (${input.organizationId}, ${input.actorId}, ${input.correlationId}, ${input.audit.action}, ${input.audit.targetType}, ${input.audit.targetId}, ${transaction.json(metadata)})`;
  await transaction`
    INSERT INTO outbox_events (organization_id, aggregate_type, aggregate_id, topic, payload, dedupe_key)
    VALUES (${input.organizationId}, ${input.outbox.aggregateType}, ${input.outbox.aggregateId}, ${input.outbox.topic}, ${transaction.json(input.outbox.payload)}, ${input.outbox.dedupeKey ?? null})`;
  return result;
}
