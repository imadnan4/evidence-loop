// Future HTTP handlers import durable persistence primitives from this server-only seam.
// Existing prototype services intentionally remain in-memory until their owning gates migrate them.
export { createDatabase, withTenantTransaction, reserveIdempotencyKey, writeWithAuditAndOutbox } from "@evidence-loop/db";
