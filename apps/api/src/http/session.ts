import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Sql } from "postgres";
import type { Principal } from "../auth/principal.ts";
import { DurableCheckInService, CheckInHttpError } from "../session/durable-service.ts";
import { SessionError } from "../session/service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PrincipalResolver = (request: FastifyRequest) => Promise<Principal>;
type Deps = Readonly<{ client: Sql<{}>; principal: PrincipalResolver }>;

/**
 * C02 authenticated check-in routes. Every route requires a resolved learner
 * principal in the current tenant; cross-tenant and non-owner access fail
 * closed via the session RLS policy. No grade, misconduct, personality, or
 * voice-derived scoring is ever produced.
 */
export function registerSessionRoutes(app: FastifyInstance, deps: Deps): void {
  const checkIns = new DurableCheckInService(deps.client);
  const resolve = deps.principal;

  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/check-ins", async (request, reply) => {
    if (!UUID.test(request.params.submissionId)) return reply.code(400).send(validationError("Invalid submission id."));
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const result = await checkIns.createSession(current, request.params.submissionId, header);
      return reply.code(result.replayed ? 200 : 201).send({ check_in_id: result.sessionId, replayed: result.replayed, session: result.session });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/policy", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const session = await checkIns.showPolicy(current, request.params.sessionId, header);
      return reply.code(200).send({ session });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/policy/acknowledge", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    const body = request.body as { policy_version_id?: string } | null;
    const policyVersionId = body?.policy_version_id;
    if (typeof policyVersionId !== "string" || !UUID.test(policyVersionId)) {
      return reply.code(400).send(validationError("Invalid policy version id."));
    }
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const session = await checkIns.acknowledgePolicy(current, request.params.sessionId, policyVersionId, header);
      return reply.code(200).send({ session });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/start", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    const body = request.body as { policy_version_id?: string; mode?: string } | null;
    const policyVersionId = body?.policy_version_id;
    if (typeof policyVersionId !== "string" || !UUID.test(policyVersionId)) {
      return reply.code(400).send(validationError("Invalid policy version id."));
    }
    if (body?.mode && body.mode !== "text") {
      return reply.code(400).send(validationError("Only the typed check-in route is supported."));
    }
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const started = await checkIns.start(current, request.params.sessionId, policyVersionId, header);
      return reply.code(200).send({ session: started.session, question: started.question });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/pause", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const session = await checkIns.pause(current, request.params.sessionId, header);
      return reply.code(200).send({ session });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/resume", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const session = await checkIns.resume(current, request.params.sessionId, header);
      return reply.code(200).send({ session });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { sessionId: string; questionId: string } }>("/v1/check-ins/:sessionId/questions/:questionId/responses", async (request, reply) => {
    if (!UUID.test(request.params.sessionId) || !UUID.test(request.params.questionId)) {
      return reply.code(400).send(validationError("Invalid check-in or question id."));
    }
    const body = request.body as { canonical_text?: unknown; edited_text?: unknown } | null;
    const canonicalText = typeof body?.canonical_text === "string" ? body.canonical_text.trim() : "";
    const editedText = body?.edited_text === null ? null : typeof body?.edited_text === "string" ? body.edited_text : undefined;
    if (canonicalText.length === 0 || editedText === undefined) {
      return reply.code(400).send(validationError("A non-empty canonical text is required."));
    }
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const result = await checkIns.submitTextResponse(current, request.params.sessionId, request.params.questionId, canonicalText, editedText, header);
      return reply.code(200).send({ session: result.session, response: result.response, next_question: result.nextQuestion });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/human-follow-up", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    const header = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    try {
      const current = await resolve(request);
      const session = await checkIns.requestHumanFollowUp(current, request.params.sessionId, header);
      return reply.code(200).send({ session });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.get<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/receipt", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    try {
      const current = await resolve(request);
      const receipt = await checkIns.getReceipt(current, request.params.sessionId);
      return reply.code(200).send({
        session: receipt.session,
        policy_version_id: receipt.policyVersionId,
        questions: receipt.questions,
        responses: receipt.responses,
        completed_at: receipt.completedAt,
      });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });

  app.get<{ Params: { sessionId: string } }>("/v1/check-ins/:sessionId/timeline", async (request, reply) => {
    if (!UUID.test(request.params.sessionId)) return reply.code(400).send(validationError("Invalid check-in id."));
    try {
      const current = await resolve(request);
      const events = await checkIns.getTimeline(current, request.params.sessionId);
      return reply.code(200).send({ events });
    } catch (error) {
      return reply.code(statusFor(error)).send(errorBody(error));
    }
  });
}

function statusFor(error: unknown): number {
  if (error instanceof CheckInHttpError) return error.statusCode;
  if (error instanceof SessionError) return sessionErrorStatus(error.code);
  return 500;
}

function sessionErrorStatus(code: SessionError["code"]): number {
  switch (code) {
    case "NOT_FOUND": return 404;
    case "FORBIDDEN": return 403;
    case "INVALID_STATE": return 409;
    case "IDEMPOTENCY_CONFLICT": return 409;
    case "CONFLICT": return 409;
    case "INVALID_REQUEST": return 400;
    default: return 404;
  }
}

function errorBody(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof CheckInHttpError) return { error: { code: error.code, message: httpMessage(error.code) } };
  if (error instanceof SessionError) {
    const code = sessionErrorCode(error.code);
    return { error: { code, message: httpMessage(code) } };
  }
  return { error: { code: "internal", message: "Request failed." } };
}

function sessionErrorCode(code: SessionError["code"]): string {
  switch (code) {
    case "NOT_FOUND": return "not_found";
    case "FORBIDDEN": return "forbidden";
    case "INVALID_STATE": return "invalid_state";
    case "IDEMPOTENCY_CONFLICT": return "idempotency_conflict";
    case "CONFLICT": return "invalid_state";
    case "INVALID_REQUEST": return "validation";
    default: return "not_found";
  }
}

function validationError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "validation", message } };
}

function httpMessage(code: string): string {
  switch (code) {
    case "not_found": return "Resource not found.";
    case "forbidden": return "You are not authorized to access this check-in.";
    case "invalid_state": return "This check-in is not in a valid state for that action.";
    case "idempotency_conflict": return "Idempotency key conflicts with a different request.";
    case "validation": return "Invalid request.";
    default: return "Request failed.";
  }
}
