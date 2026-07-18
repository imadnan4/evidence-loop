import { check, foreignKey, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  createdAt,
}, (table) => [
  unique("organizations_slug_key").on(table.slug),
  check("organizations_slug_check", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
  check("organizations_display_name_check", sql`char_length(${table.displayName}) BETWEEN 1 AND 160`),
]);

export const internalUsers = pgTable("internal_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  subject: text("subject").notNull(),
  createdAt,
}, (table) => [
  unique("internal_users_organization_id_subject_key").on(table.organizationId, table.subject),
  unique("internal_users_id_organization_id_key").on(table.id, table.organizationId),
  check("internal_users_subject_check", sql`char_length(${table.subject}) BETWEEN 1 AND 255`),
]);

export const courses = pgTable("courses", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  code: text("code").notNull(),
  title: text("title").notNull(),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("courses_organization_id_code_key").on(table.organizationId, table.code),
  unique("courses_id_organization_id_key").on(table.id, table.organizationId),
  check("courses_code_check", sql`char_length(${table.code}) BETWEEN 1 AND 64`),
  check("courses_title_check", sql`char_length(${table.title}) BETWEEN 1 AND 255`),
]);

export const courseMemberships = pgTable("course_memberships", {
  courseId: uuid("course_id").notNull(),
  userId: uuid("user_id").notNull(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  role: text("role").notNull(),
  createdAt,
}, (table) => [
  primaryKey({ columns: [table.courseId, table.userId], name: "course_memberships_pkey" }),
  foreignKey({ columns: [table.courseId, table.organizationId], foreignColumns: [courses.id, courses.organizationId], name: "course_memberships_course_org_fkey" }),
  foreignKey({ columns: [table.userId, table.organizationId], foreignColumns: [internalUsers.id, internalUsers.organizationId], name: "course_memberships_user_org_fkey" }),
  check("course_memberships_role_check", sql`${table.role} IN ('instructor', 'teaching_assistant', 'learner', 'course_admin')`),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  actorId: uuid("actor_id"),
  correlationId: uuid("correlation_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt,
}, (table) => [
  foreignKey({ columns: [table.actorId, table.organizationId], foreignColumns: [internalUsers.id, internalUsers.organizationId], name: "audit_events_actor_id_organization_id_fkey" }),
  check("audit_events_action_check", sql`char_length(${table.action}) BETWEEN 1 AND 128`),
  check("audit_events_target_type_check", sql`char_length(${table.targetType}) BETWEEN 1 AND 128`),
  check("audit_events_metadata_object_check", sql`jsonb_typeof(${table.metadata}) = 'object'`),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  createdAt,
}, (table) => [
  unique("idempotency_keys_organization_id_operation_key_key").on(table.organizationId, table.operation, table.key),
  check("idempotency_keys_operation_check", sql`char_length(${table.operation}) BETWEEN 1 AND 128`),
  check("idempotency_keys_key_check", sql`char_length(${table.key}) BETWEEN 1 AND 255`),
  check("idempotency_keys_fingerprint_check", sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`),
]);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  topic: text("topic").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt,
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  check("outbox_events_aggregate_type_check", sql`char_length(${table.aggregateType}) BETWEEN 1 AND 128`),
  check("outbox_events_topic_check", sql`char_length(${table.topic}) BETWEEN 1 AND 128`),
  check("outbox_events_payload_object_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
]);
