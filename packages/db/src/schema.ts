import { boolean, check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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

export const assessments = pgTable("assessments", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id), courseId: uuid("course_id").notNull(), title: text("title").notNull(), state: text("state").notNull().default("draft"), currentPublishedVersionId: uuid("current_published_version_id"), createdAt, updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("assessments_id_organization_id_course_id_key").on(t.id,t.organizationId,t.courseId), foreignKey({columns:[t.courseId,t.organizationId],foreignColumns:[courses.id,courses.organizationId],name:"assessments_course_organization_fkey"})]);
export const assessmentVersions = pgTable("assessment_versions", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull(), courseId: uuid("course_id").notNull(), assessmentId: uuid("assessment_id").notNull(), versionNumber: integer("version_number").notNull(), state:text("state").notNull(), title:text("title").notNull(), assignmentInstructions:text("assignment_instructions").notNull(), learnerFacingText:text("learner_facing_text").notNull(), aiUsePolicy:text("ai_use_policy").notNull(), privacySummary:text("privacy_summary").notNull(), completionCriteria:text("completion_criteria").notNull(), textCheckIn:boolean("text_check_in").notNull(), voiceCheckIn:boolean("voice_check_in").notNull(), extraTime:boolean("extra_time").notNull(), pauseAndResume:boolean("pause_and_resume").notNull(), alternativeAssessmentRequest:boolean("alternative_assessment_request").notNull(), questionBudget:integer("question_budget").notNull(), timeBudgetMinutes:integer("time_budget_minutes").notNull(), createdBy:uuid("created_by").notNull(), createdAt, publishedBy:uuid("published_by"), publishedAt:timestamp("published_at",{withTimezone:true}),
},(t)=>[unique("assessment_versions_assessment_id_version_number_key").on(t.assessmentId,t.versionNumber),unique("assessment_versions_id_organization_id_assessment_id_key").on(t.id,t.organizationId,t.assessmentId),foreignKey({columns:[t.assessmentId,t.organizationId,t.courseId],foreignColumns:[assessments.id,assessments.organizationId,assessments.courseId],name:"assessment_versions_assessment_tenant_fkey"})]);
export const assessmentObjectives = pgTable("assessment_objectives", { id:uuid("id").defaultRandom().primaryKey(),organizationId:uuid("organization_id").notNull(),assessmentId:uuid("assessment_id").notNull(),assessmentVersionId:uuid("assessment_version_id").notNull(),position:integer("position").notNull(),label:text("label").notNull(),description:text("description").notNull(),evidenceCriteria:text("evidence_criteria").notNull(),assessableInCheckIn:boolean("assessable_in_check_in").notNull(),approvedBy:uuid("approved_by").notNull(),approvedAt:timestamp("approved_at",{withTimezone:true}).notNull().defaultNow() });
export const rubricCriteria = pgTable("rubric_criteria", { id:uuid("id").defaultRandom().primaryKey(),organizationId:uuid("organization_id").notNull(),assessmentId:uuid("assessment_id").notNull(),assessmentVersionId:uuid("assessment_version_id").notNull(),position:integer("position").notNull(),label:text("label").notNull(),description:text("description").notNull(),evidenceCriteria:text("evidence_criteria").notNull() });
export const rubricCriterionObjectives = pgTable("rubric_criterion_objectives", { organizationId:uuid("organization_id").notNull(),assessmentVersionId:uuid("assessment_version_id").notNull(),criterionId:uuid("criterion_id").notNull(),objectiveId:uuid("objective_id").notNull() },t=>[primaryKey({columns:[t.criterionId,t.objectiveId],name:"rubric_criterion_objectives_pkey"})]);
export const idempotencyResults = pgTable("idempotency_results", { organizationId:uuid("organization_id").notNull(),operation:text("operation").notNull(),key:text("key").notNull(),targetType:text("target_type").notNull(),targetId:uuid("target_id").notNull(),createdAt },t=>[primaryKey({columns:[t.organizationId,t.operation,t.key],name:"idempotency_results_pkey"})]);

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
