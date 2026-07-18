export type RuntimeProfile = "local" | "ci" | "staging";

export type ServerEnvironment = Readonly<{
  profile: RuntimeProfile;
  port: number;
  databaseUrl: URL;
  objectStorage: Readonly<{
    endpoint: URL;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    buckets: Readonly<{
      quarantine: string;
      clean: string;
      derived: string;
    }>;
  }>;
  allowedWebOrigins: readonly URL[];
  deploymentId: string;
  releaseVersion: string;
  syntheticDataOnly: true;
}>;

type Environment = Record<string, string | undefined>;

type OptionalIntegration = Readonly<{
  name: string;
  variables: readonly string[];
}>;

const OPTIONAL_INTEGRATIONS: readonly OptionalIntegration[] = [
  { name: "OpenAI", variables: ["OPENAI_API_KEY", "OPENAI_MODEL"] },
  { name: "OIDC", variables: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] },
  { name: "telemetry", variables: ["TELEMETRY_COLLECTOR_URL", "TELEMETRY_AUTH_TOKEN"] },
  { name: "scanner", variables: ["MALWARE_SCANNER_URL", "MALWARE_SCANNER_TOKEN"] },
  { name: "parser", variables: ["PARSER_SERVICE_URL", "PARSER_SERVICE_TOKEN"] },
];

const REQUIRED = [
  "EVIDENCE_LOOP_ENV",
  "PORT",
  "SYNTHETIC_DATA_ONLY",
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET_QUARANTINE",
  "S3_BUCKET_CLEAN",
  "S3_BUCKET_DERIVED",
  "ALLOWED_WEB_ORIGINS",
  "DEPLOYMENT_ID",
  "RELEASE_VERSION",
] as const;

const DEFAULT_LIKE = /^(?:changeme|change-me|example|placeholder|replace-me|password|secret|admin|test|local)$/i;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export class EnvironmentError extends Error {
  readonly code: string;
  readonly variable: string;

  constructor(variable: string, code: string) {
    super(`${variable}: ${code}`);
    this.name = "EnvironmentError";
    this.variable = variable;
    this.code = code;
  }
}

function valueOf(source: Environment, variable: string): string {
  const value = source[variable]?.trim();
  if (!value) throw new EnvironmentError(variable, "required");
  return value;
}

function parseUrl(variable: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new EnvironmentError(variable, "invalid-url");
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function assertNoBrowserNamespace(source: Environment): void {
  for (const variable of Object.keys(source)) {
    if (variable.startsWith("NEXT_PUBLIC_") || variable.startsWith("VITE_") || variable.startsWith("PUBLIC_")) {
      throw new EnvironmentError(variable, "browser-namespace-not-allowed");
    }
  }
}

function assertOptionalIntegrations(source: Environment): void {
  for (const integration of OPTIONAL_INTEGRATIONS) {
    const configured = integration.variables.filter((variable) => Boolean(source[variable]?.trim()));
    if (configured.length > 0 && configured.length !== integration.variables.length) {
      throw new EnvironmentError(integration.variables.find((variable) => !source[variable]?.trim()) ?? integration.name, "partial-integration-config");
    }
  }
}

function parseProfile(source: Environment): RuntimeProfile {
  const profile = valueOf(source, "EVIDENCE_LOOP_ENV");
  if (profile === "local" || profile === "ci" || profile === "staging") return profile;
  throw new EnvironmentError("EVIDENCE_LOOP_ENV", "unsupported-profile");
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new EnvironmentError("PORT", "invalid-port");
  return port;
}

function parseOrigins(value: string, profile: RuntimeProfile): readonly URL[] {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => parseUrl("ALLOWED_WEB_ORIGINS", origin));
  if (!origins.length) throw new EnvironmentError("ALLOWED_WEB_ORIGINS", "required");
  for (const origin of origins) {
    if (!/^https?:$/.test(origin.protocol)) throw new EnvironmentError("ALLOWED_WEB_ORIGINS", "invalid-protocol");
    if (profile === "staging" && (origin.protocol !== "https:" || isLoopback(origin))) {
      throw new EnvironmentError("ALLOWED_WEB_ORIGINS", "staging-requires-public-https-origin");
    }
  }
  return origins;
}

function parseBuckets(source: Environment): ServerEnvironment["objectStorage"]["buckets"] {
  const buckets = {
    quarantine: valueOf(source, "S3_BUCKET_QUARANTINE"),
    clean: valueOf(source, "S3_BUCKET_CLEAN"),
    derived: valueOf(source, "S3_BUCKET_DERIVED"),
  };
  for (const [name, bucket] of Object.entries(buckets)) {
    if (!BUCKET.test(bucket) || bucket.includes("..")) throw new EnvironmentError(`S3_BUCKET_${name.toUpperCase()}`, "invalid-bucket-name");
  }
  if (new Set(Object.values(buckets)).size !== 3) throw new EnvironmentError("S3_BUCKET_QUARANTINE", "bucket-names-must-be-distinct");
  return buckets;
}

export function parseServerEnvironment(source: Environment = process.env): ServerEnvironment {
  assertNoBrowserNamespace(source);
  for (const variable of REQUIRED) valueOf(source, variable);
  assertOptionalIntegrations(source);

  const profile = parseProfile(source);
  const synthetic = valueOf(source, "SYNTHETIC_DATA_ONLY");
  if (synthetic !== "true") throw new EnvironmentError("SYNTHETIC_DATA_ONLY", "must-be-true-for-a01");

  const databaseUrl = parseUrl("DATABASE_URL", valueOf(source, "DATABASE_URL"));
  if (!/^postgres(?:ql)?:$/.test(databaseUrl.protocol)) throw new EnvironmentError("DATABASE_URL", "invalid-protocol");
  const endpoint = parseUrl("S3_ENDPOINT", valueOf(source, "S3_ENDPOINT"));
  if (!/^https?:$/.test(endpoint.protocol)) throw new EnvironmentError("S3_ENDPOINT", "invalid-protocol");

  const accessKeyId = valueOf(source, "S3_ACCESS_KEY_ID");
  const secretAccessKey = valueOf(source, "S3_SECRET_ACCESS_KEY");
  if (profile === "staging") {
    if (isLoopback(databaseUrl)) throw new EnvironmentError("DATABASE_URL", "staging-loopback-not-allowed");
    if (isLoopback(endpoint) || endpoint.protocol !== "https:") throw new EnvironmentError("S3_ENDPOINT", "staging-requires-public-https-endpoint");
    for (const [variable, value] of [["S3_ACCESS_KEY_ID", accessKeyId], ["S3_SECRET_ACCESS_KEY", secretAccessKey]] as const) {
      if (value.length < 16 || DEFAULT_LIKE.test(value)) throw new EnvironmentError(variable, "staging-placeholder-credential");
    }
  }

  return Object.freeze({
    profile,
    port: parsePort(valueOf(source, "PORT")),
    databaseUrl,
    objectStorage: Object.freeze({
      endpoint,
      region: valueOf(source, "S3_REGION"),
      accessKeyId,
      secretAccessKey,
      buckets: Object.freeze(parseBuckets(source)),
    }),
    allowedWebOrigins: Object.freeze(parseOrigins(valueOf(source, "ALLOWED_WEB_ORIGINS"), profile)),
    deploymentId: valueOf(source, "DEPLOYMENT_ID"),
    releaseVersion: valueOf(source, "RELEASE_VERSION"),
    syntheticDataOnly: true,
  });
}

export function redactEnvironmentError(error: unknown): string {
  if (error instanceof EnvironmentError) return `${error.variable}: ${error.code}`;
  return "environment: invalid";
}
