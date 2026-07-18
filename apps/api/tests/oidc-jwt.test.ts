import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair, generateSecret, SignJWT } from "jose";
import { AuthenticationError, bearerToken, createTokenVerifier } from "../src/auth/oidc-jwt.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";

type KeyMaterial = Readonly<{ kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey }>;

async function createKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { kid, privateKey, publicJwk };
}

async function startJwks(keys: readonly KeyMaterial[]) {
  let active = keys.map((key) => key.publicJwk);
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ keys: active }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    replaceKeys(next: readonly KeyMaterial[]) {
      active = next.map((key) => key.publicJwk);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function sign(
  key: KeyMaterial,
  issuer: string,
  options: Readonly<{ audience?: string; subject?: string; organization?: string; notBefore?: number; expiration?: number }> = {},
) {
  const claims: Record<string, string> = {};
  if (options.organization !== undefined) claims.org = options.organization;
  const token = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(options.audience ?? "evidence-loop-api")
    .setIssuedAt();
  if (options.subject !== undefined) token.setSubject(options.subject);
  if (options.notBefore !== undefined) token.setNotBefore(options.notBefore);
  token.setExpirationTime(options.expiration ?? Math.floor(Date.now() / 1000) + 300);
  return token.sign(key.privateKey);
}

test("OIDC verifier cryptographically validates issuer, audience, lifetime, claims, and algorithms", async () => {
  const primary = await createKey("primary");
  const jwks = await startJwks([primary]);
  try {
    const verifier = createTokenVerifier({
      issuer: new URL(jwks.base),
      jwksUri: new URL(`${jwks.base}/jwks`),
      audience: "evidence-loop-api",
      organizationClaim: "org",
    });
    const valid = await sign(primary, jwks.base, { subject: "subject-1", organization: organizationId });
    assert.deepEqual(await verifier(valid), { subject: "subject-1", organizationId });

    await assert.rejects(
      async () => verifier(await sign(primary, `${jwks.base}/wrong`, { subject: "subject-1", organization: organizationId })),
      AuthenticationError,
    );
    await assert.rejects(
      async () => verifier(await sign(primary, jwks.base, { audience: "other-api", subject: "subject-1", organization: organizationId })),
      AuthenticationError,
    );
    await assert.rejects(
      async () => verifier(await sign(primary, jwks.base, { subject: "subject-1", organization: organizationId, expiration: Math.floor(Date.now() / 1000) - 60 })),
      AuthenticationError,
    );
    await assert.rejects(
      async () => verifier(await sign(primary, jwks.base, { subject: "subject-1", organization: organizationId, notBefore: Math.floor(Date.now() / 1000) + 120 })),
      AuthenticationError,
    );
    await assert.rejects(
      async () => verifier(await sign(primary, jwks.base, { subject: "", organization: organizationId })),
      AuthenticationError,
    );
    await assert.rejects(
      async () => verifier(await sign(primary, jwks.base, { subject: "subject-1" })),
      AuthenticationError,
    );
    await assert.rejects(
      async () => verifier(await sign(primary, jwks.base, { subject: "subject-1", organization: "not-a-uuid" })),
      AuthenticationError,
    );

    const hmac = await generateSecret("HS256");
    const disallowedAlgorithm = await new SignJWT({ org: organizationId })
      .setProtectedHeader({ alg: "HS256", kid: "primary", typ: "JWT" })
      .setIssuer(jwks.base)
      .setAudience("evidence-loop-api")
      .setSubject("subject-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(hmac);
    await assert.rejects(() => verifier(disallowedAlgorithm), AuthenticationError);
  } finally {
    await jwks.close();
  }
});

test("OIDC verifier rejects unknown keys and accepts a rotated signing key after JWKS refresh", async () => {
  const primary = await createKey("primary");
  const rotated = await createKey("rotated");
  const unknown = await createKey("unknown");
  const jwks = await startJwks([primary]);
  try {
    const verifier = createTokenVerifier({
      issuer: new URL(jwks.base),
      jwksUri: new URL(`${jwks.base}/jwks`),
      audience: "evidence-loop-api",
      organizationClaim: "org",
      jwksCooldownMs: 25,
    });
    await verifier(await sign(primary, jwks.base, { subject: "subject-1", organization: organizationId }));
    await assert.rejects(async () => verifier(await sign(unknown, jwks.base, { subject: "subject-1", organization: organizationId })), AuthenticationError);

    jwks.replaceKeys([primary, rotated]);
    // The remote set intentionally has a bounded refresh cooldown. Wait beyond it to prove
    // a process does not need restart to accept a provider key rotation.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      await verifier(await sign(rotated, jwks.base, { subject: "subject-2", organization: organizationId })),
      { subject: "subject-2", organizationId },
    );
  } finally {
    await jwks.close();
  }
});

test("bearer parsing rejects missing, malformed, and non-bearer credentials", () => {
  assert.equal(bearerToken("Bearer abc.def-ghi_jkl"), "abc.def-ghi_jkl");
  for (const value of [undefined, "", "Basic abc", "Bearer space token", "Bearer "]) {
    assert.throws(() => bearerToken(value), AuthenticationError);
  }
});
