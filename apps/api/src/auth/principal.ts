import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { withTenantTransaction } from "@evidence-loop/db";
import type { VerifiedIdentity } from "./oidc-jwt.ts";

const COURSE_ROLES = new Set(["instructor", "teaching_assistant", "learner", "course_admin"]);

export type Principal = Readonly<{
  organizationId: string;
  userId: string;
  subject: string;
  correlationId: string;
}>;
export type CourseRole = "instructor" | "teaching_assistant" | "learner" | "course_admin";

export class UnknownPrincipalError extends Error {
  constructor() {
    super("Authenticated identity is not provisioned.");
    this.name = "UnknownPrincipalError";
  }
}

export async function resolvePrincipal(client: Sql<{}>, identity: VerifiedIdentity): Promise<Principal> {
  const correlationId = randomUUID();
  return withTenantTransaction(client, { organizationId: identity.organizationId, actorId: null, correlationId }, async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      SELECT id FROM internal_users
      WHERE organization_id = ${identity.organizationId} AND subject = ${identity.subject}`;
    if (rows.length !== 1) throw new UnknownPrincipalError();
    return Object.freeze({
      organizationId: identity.organizationId,
      userId: rows[0]!.id,
      subject: identity.subject,
      correlationId,
    });
  });
}

export async function courseRole(client: Sql<{}>, principal: Principal, courseId: string): Promise<CourseRole | null> {
  return withTenantTransaction(client, {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    correlationId: principal.correlationId,
  }, async (transaction) => {
    const rows = await transaction<{ role: string }[]>`
      SELECT role FROM course_memberships
      WHERE organization_id = ${principal.organizationId}
        AND course_id = ${courseId}
        AND user_id = ${principal.userId}`;
    const role = rows[0]?.role;
    return role && COURSE_ROLES.has(role) ? role as CourseRole : null;
  });
}
