import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/http/app.ts";

const environment: any = {
  profile: "local",
  port: 3001,
  databaseUrl: new URL("postgresql://a:b@localhost/db"),
  objectStorage: {
    endpoint: new URL("http://localhost:9000"),
    region: "x",
    accessKeyId: "a",
    secretAccessKey: "b",
    buckets: { quarantine: "quarantine", clean: "clean", derived: "derived" },
  },
  oidc: {
    issuer: new URL("http://localhost:9100"),
    jwksUri: new URL("http://localhost:9100/jwks"),
    audience: "api",
    organizationClaim: "org",
  },
  allowedWebOrigins: [new URL("http://app.test")],
  deploymentId: "test",
  releaseVersion: "test",
  syntheticDataOnly: true,
};

test("health is public and product routes fail closed with security headers", async () => {
  const app = buildApp({
    environment,
    client: (async () => []) as any,
    verifyToken: async () => {
      throw new Error("should not verify");
    },
  });
  try {
    let response = await app.inject({ method: "GET", url: "/health/live", headers: { origin: "http://app.test" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], "http://app.test");
    assert.match(String(response.headers["content-security-policy"]), /default-src/);

    response = await app.inject({ method: "GET", url: "/v1/me" });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), { error: { code: "unauthorized", message: "Authentication required." } });

    response = await app.inject({ method: "GET", url: "/v1/me", headers: { origin: "http://evil.test" } });
    assert.equal(response.headers["access-control-allow-origin"], undefined);

    response = await app.inject({ method: "GET", url: "/v1/courses/not-a-uuid/access" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "validation");

    response = await app.inject({ method: "GET", url: "/not-a-route" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "not_found");
  } finally {
    await app.close();
  }
});

test("request logs whitelist fields and never include query or credential literals", async () => {
  const messages: string[] = [];
  const app = buildApp({
    environment,
    client: (async () => []) as any,
    verifyToken: async () => { throw new Error("should not verify"); },
    loggerStream: { write(message: string) { messages.push(message); return true; } } as any,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health/live?access_token=query-secret&email=learner@example.test",
      headers: { authorization: "Bearer header-secret" },
    });
    assert.equal(response.statusCode, 200);
    const output = messages.join("\n");
    assert.doesNotMatch(output, /query-secret|header-secret|learner@example\.test|access_token/);
    assert.match(output, /"method":"GET"/);
  } finally {
    await app.close();
  }
});

test("rate limits use a generic response and never echo bearer credentials", async () => {
  const app = buildApp({
    environment,
    client: (async () => []) as any,
    verifyToken: async () => {
      throw new Error("should not verify");
    },
    rateLimit: { max: 1, timeWindow: "1 minute" },
  });
  try {
    const first = await app.inject({ method: "GET", url: "/health/live", headers: { authorization: "Bearer sensitive-token" } });
    assert.equal(first.statusCode, 200);
    const limited = await app.inject({ method: "GET", url: "/health/live", headers: { authorization: "Bearer sensitive-token" } });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "rate_limited");
    assert.ok(limited.headers["retry-after"]);
    assert.doesNotMatch(limited.body, /sensitive-token/);
  } finally {
    await app.close();
  }
});
