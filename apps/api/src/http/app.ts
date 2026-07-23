import { createHash } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import pino, { type DestinationStream } from "pino";
import type { Sql } from "postgres";
import { bearerToken, AuthenticationError, createTokenVerifier } from "../auth/oidc-jwt.ts";
import { courseRole, resolvePrincipal, UnknownPrincipalError, type Principal } from "../auth/principal.ts";
import type { ServerEnvironment } from "@evidence-loop/config";
import { ContractValidationError, CreateAssessmentDraftRequestSchema } from "@evidence-loop/contracts/v1";
import { DurableAssessmentService } from "../assessment/durable-service.ts";
import { AssessmentHttpError } from "../assessment/durable-errors.ts";
import { IdempotencyConflictError } from "@evidence-loop/db";
import type { ArtifactStorage } from "@evidence-loop/artifact-pipeline";
import { DurableArtifactService, ArtifactHttpError } from "../artifacts/durable-service.ts";
import { registerSessionRoutes } from "./session.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_RATE_LIMIT = Object.freeze({ max: 100, timeWindow: "1 minute" });

type TokenVerifier = ReturnType<typeof createTokenVerifier>;
type RateLimitSettings = Readonly<{ max: number; timeWindow: string | number }>;
type Dependencies = Readonly<{
  environment: ServerEnvironment;
  client: Sql<{}>;
  verifyToken?: TokenVerifier;
  rateLimit?: RateLimitSettings;
  loggerStream?: DestinationStream;
  artifactStorage?: ArtifactStorage;
}>;
type CourseParams = Readonly<{ courseId: string }>;

function stableRateLimitKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.length > 0) {
    // The store receives a one-way bounded key, never a bearer token.
    return `token:${createHash("sha256").update(authorization).digest("base64url")}`;
  }
  // trustProxy is false, so this is the direct socket address, not an X-Forwarded-For value.
  return `ip:${request.ip}`;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function buildApp({
  environment,
  client,
  verifyToken = createTokenVerifier(environment.oidc),
  rateLimit: rateLimitSettings = DEFAULT_RATE_LIMIT,
  loggerStream,
  artifactStorage,
}: Dependencies) {
  const runtimeStorage: ArtifactStorage = artifactStorage ?? { putQuarantine: async () => { throw new Error("storage unavailable"); }, readQuarantine: async () => { throw new Error("storage unavailable"); }, deleteQuarantine: async () => { throw new Error("storage unavailable"); }, putClean: async () => { throw new Error("storage unavailable"); }, putDerived: async () => { throw new Error("storage unavailable"); } };
  const allowedOrigins = new Set(environment.allowedWebOrigins.map((origin) => origin.origin));
  // Request logs intentionally whitelist fields. In particular, paths, query strings,
  // headers, request bodies, and provider errors are not telemetry until D03's redaction work.
  const logger = pino({
    level: "info",
    serializers: {
      req(request) {
        return { method: request.method, remoteAddress: request.socket.remoteAddress };
      },
      res(response) {
        return { statusCode: response.statusCode };
      },
    },
  }, loggerStream);
  const app = Fastify({ loggerInstance: logger, trustProxy: false, bodyLimit: 5 * 1024 * 1024 });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.register(cors, {
    origin: (origin, callback) => callback(null, Boolean(origin && allowedOrigins.has(origin))),
    credentials: false,
  });
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: environment.profile === "staging",
  });
  app.register(rateLimit, {
    global: true,
    max: rateLimitSettings.max,
    timeWindow: rateLimitSettings.timeWindow,
    keyGenerator: stableRateLimitKey,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    if (reply.getHeader("content-type")?.toString().includes("application/json")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AuthenticationError || error instanceof UnknownPrincipalError) {
      return reply.code(401).send(errorBody("unauthorized", "Authentication required."));
    }
    if (error instanceof ContractValidationError) {
      return reply.code(400).send(errorBody("validation", "Invalid request."));
    }
    if (error instanceof IdempotencyConflictError) {
      return reply.code(409).send(errorBody("idempotency_conflict", "Idempotency key conflicts with a different request."));
    }
    if (error instanceof ArtifactHttpError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.code === "not_found" ? "Resource not found." : "Request cannot be completed."));
    }
    if (error instanceof AssessmentHttpError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message));
    }
    const err = error as FastifyError;
    if (err.statusCode === 429 || err.code === "FST_ERR_RATE_LIMIT") {
      return reply.code(429).send(errorBody("rate_limited", "Too many requests. Try again later."));
    }
    if (err.validation) {
      return reply.code(400).send(errorBody("validation", "Invalid request."));
    }
    const databaseError = err as FastifyError & { constraint?: unknown; constraint_name?: unknown };
    app.log.error({ error_name: err.name, error_code: err.code ?? "unknown", error_constraint: databaseError.constraint_name ?? databaseError.constraint ?? undefined }, "request failed");
    return reply.code(500).send(errorBody("internal", "Request failed."));
  });

  async function principal(request: FastifyRequest): Promise<Principal> {
    const identity = await verifyToken(bearerToken(request.headers.authorization));
    return resolvePrincipal(client, identity);
  }

  // Fastify plugins are encapsulated. Register routes only after rate-limit is loaded
  // in this scope so the global limiter applies to every API and health endpoint.
  app.after(() => {
    const assessments = new DurableAssessmentService(client);
    const artifacts = new DurableArtifactService(client, runtimeStorage, environment.objectStorage.secretAccessKey);
    registerSessionRoutes(app as unknown as FastifyInstance, { client, principal });
    app.setNotFoundHandler(async (_request, reply) => reply.code(404).send(errorBody("not_found", "Resource not found.")));
    app.get("/health/live", async () => ({ status: "live" }));
    app.get("/health/ready", async (_request, reply) => {
      try {
        await client`SELECT 1`;
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    });
    app.get("/v1/me", async (request) => {
      const current = await principal(request);
      return { userId: current.userId, organizationId: current.organizationId };
    });
    app.post<{ Params: CourseParams }>("/v1/courses/:courseId/assessments", async (request, reply) => {
      if (!UUID.test(request.params.courseId)) return reply.code(400).send(errorBody("validation", "Invalid course id."));
      const body = CreateAssessmentDraftRequestSchema.parse(request.body);
      const result = await assessments.createInitialDraft(await principal(request), request.params.courseId, body, typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined);
      return reply.code(result.status).send({ assessment_id: result.assessment_id, draft: result.draft, replayed: result.replayed });
    });
    app.post<{ Params: { versionId: string } }>("/v1/assessment-versions/:versionId/publish", async (request, reply) => {
      if (!UUID.test(request.params.versionId)) return reply.code(400).send(errorBody("validation", "Invalid version id."));
      const result = await assessments.publish(await principal(request), request.params.versionId, typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined);
      return reply.code(result.status).send({ published: result.published, replayed: result.replayed });
    });
    app.post<{ Params: { versionId: string } }>("/v1/assessment-versions/:versionId/submissions", async (request, reply) => {
      if (!UUID.test(request.params.versionId)) return reply.code(400).send(errorBody("validation", "Invalid assessment version id."));
      const result = await artifacts.createSubmission(await principal(request), request.params.versionId, typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined);
      return reply.code(result.replayed ? 200 : 201).send(result);
    });
    app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/artifacts/upload-intents", async (request, reply) => {
      if (!UUID.test(request.params.submissionId)) return reply.code(400).send(errorBody("validation", "Invalid submission id."));
      const result = await artifacts.issueIntent(await principal(request), request.params.submissionId, request.body, typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined);
      // The upload capability is application-only and short-lived; no storage capability is exposed.
      return reply.code(result.replayed ? 200 : 201).send({ artifact_id: result.artifact_id, upload_intent_id: result.intent_id, expires_at: result.expires_at, upload_capability: result.capability, upload_path: `/v1/artifact-upload-intents/${result.intent_id}/content`, replayed: result.replayed });
    });
    app.put<{ Params: { intentId: string }; Body: Buffer }>("/v1/artifact-upload-intents/:intentId/content", async (request, reply) => {
      if (!UUID.test(request.params.intentId) || !Buffer.isBuffer(request.body)) return reply.code(400).send(errorBody("validation", "Invalid upload."));
      const result = await artifacts.upload(await principal(request), request.params.intentId, typeof request.headers["upload-capability"] === "string" ? request.headers["upload-capability"] : undefined, request.body, typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined);
      return reply.code(result.replayed ? 200 : 201).send({ artifact_id: result.artifact_id, status: "uploaded", replayed: result.replayed });
    });
    app.get<{ Params: { submissionId: string; artifactId: string } }>("/v1/submissions/:submissionId/artifacts/:artifactId", async (request, reply) => {
      if (!UUID.test(request.params.submissionId) || !UUID.test(request.params.artifactId)) return reply.code(400).send(errorBody("validation", "Invalid artifact id."));
      return reply.send(await artifacts.status(await principal(request), request.params.submissionId, request.params.artifactId));
    });
    app.get<{ Params: { assessmentId: string } }>("/v1/assessments/:assessmentId/published", async (request, reply) => {
      if (!UUID.test(request.params.assessmentId)) return reply.code(400).send(errorBody("validation", "Invalid assessment id."));
      return reply.send({ published: await assessments.published(await principal(request), request.params.assessmentId) });
    });
    app.get<{ Params: CourseParams }>("/v1/courses/:courseId/access", async (request, reply) => {
      if (!UUID.test(request.params.courseId)) {
        return reply.code(400).send(errorBody("validation", "Invalid course id."));
      }
      const current = await principal(request);
      const role = await courseRole(client, current, request.params.courseId);
      if (!role) return reply.code(404).send(errorBody("not_found", "Course not found."));
      return { courseId: request.params.courseId, role };
    });
    app.get<{ Params: CourseParams }>("/v1/courses/:courseId/instructor-access", async (request, reply) => {
      if (!UUID.test(request.params.courseId)) {
        return reply.code(400).send(errorBody("validation", "Invalid course id."));
      }
      const current = await principal(request);
      const role = await courseRole(client, current, request.params.courseId);
      if (role !== "instructor" && role !== "course_admin") {
        return reply.code(404).send(errorBody("not_found", "Course not found."));
      }
      return { courseId: request.params.courseId, role };
    });
  });

  return app;
}
