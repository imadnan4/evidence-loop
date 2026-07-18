import { createRemoteJWKSet, jwtVerify } from "jose";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_JWKS_COOLDOWN_MS = 30_000;

export type OidcSettings = Readonly<{
  issuer: URL;
  jwksUri: URL;
  audience: string;
  organizationClaim: string;
  // Test-only override; runtime configuration always uses the conservative default.
  jwksCooldownMs?: number;
}>;
export type VerifiedIdentity = Readonly<{ subject: string; organizationId: string }>;

export class AuthenticationError extends Error {
  constructor() {
    super("Authentication failed.");
    this.name = "AuthenticationError";
  }
}

export function createTokenVerifier(settings: OidcSettings) {
  const jwks = createRemoteJWKSet(settings.jwksUri, {
    timeoutDuration: 3_000,
    cooldownDuration: settings.jwksCooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS,
  });
  return async (token: string): Promise<VerifiedIdentity> => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: settings.issuer.href.replace(/\/$/, ""),
        audience: settings.audience,
        algorithms: ["RS256", "ES256"],
        clockTolerance: 30,
        typ: "JWT",
      });
      const organization = payload[settings.organizationClaim];
      if (typeof payload.sub !== "string" || payload.sub.length === 0 || typeof organization !== "string" || !UUID.test(organization)) {
        throw new Error("required OIDC claims missing or invalid");
      }
      return Object.freeze({ subject: payload.sub, organizationId: organization });
    } catch {
      // Do not distinguish malformed, expired, signature, issuer, or claim failures.
      throw new AuthenticationError();
    }
  };
}

export function bearerToken(value: unknown): string {
  if (typeof value !== "string" || !/^Bearer [A-Za-z0-9._~-]+$/i.test(value)) {
    throw new AuthenticationError();
  }
  return value.slice(7);
}
