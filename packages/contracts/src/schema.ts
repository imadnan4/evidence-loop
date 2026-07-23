export const CONTRACT_VERSION = "v1" as const;

export type ContractVersion = typeof CONTRACT_VERSION;

export type ValidationIssueCode =
  | "invalid_type"
  | "invalid_value"
  | "missing_field"
  | "unknown_field"
  | "forbidden_field";

export interface ValidationIssue {
  path: string;
  code: ValidationIssueCode;
  message: string;
}

export class ContractValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: readonly ValidationIssue[] };

export interface Schema<T> {
  readonly version: ContractVersion;
  parse(input: unknown): T;
  safeParse(input: unknown): ParseResult<T>;
}

type Parser<T> = (input: unknown, path: string) => T;

// These patterns apply only to object keys, never free-form learner or instructor text.
// Field names are normalized before matching so snake_case, kebab-case, and camelCase
// aliases cannot reintroduce automated judgment data in a later contract version.
const prohibitedFieldPatterns: readonly RegExp[] = [
  /grade/,
  /score/,
  /^(?:pass|fail)(?:fail)?(?:result|status|recommendation|decision)?$/,
  /cheat/,
  /misconduct/,
  /plagiar/,
  /deception/,
  /fraud/,
  /personality/,
  /emotion/,
  /sentiment/,
  /automateddecision/,
  /(?:voice|speech|accent|tone).*(?:confidence|risk|assessment)/,
  /(?:confidence|risk|assessment).*(?:voice|speech|accent|tone)/
];

function issue(path: string, code: ValidationIssueCode, message: string): never {
  throw new ContractValidationError([{ path, code, message }]);
}

export function invalidValue(path: string, message: string): never {
  issue(path, "invalid_value", message);
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function normalizedFieldName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/**
 * Rejects data-model fields that would turn this product into an automated
 * grading, misconduct, personality/emotion, or voice-scoring system.
 * Free-form learner and instructor text is intentionally not inspected.
 */
export function assertNoProhibitedFields(input: unknown, path = "$"): void {
  if (Array.isArray(input)) {
    input.forEach((value, index) => assertNoProhibitedFields(value, `${path}[${index}]`));
    return;
  }

  if (!isRecord(input)) return;

  for (const [key, value] of Object.entries(input)) {
    const keyPath = `${path}.${key}`;
    if (prohibitedFieldPatterns.some((pattern) => pattern.test(normalizedFieldName(key)))) {
      issue(
        keyPath,
        "forbidden_field",
        "This field is prohibited by the Evidence Loop decision-support boundary."
      );
    }
    assertNoProhibitedFields(value, keyPath);
  }
}

export function defineSchema<T>(parser: Parser<T>): Schema<T> {
  return {
    version: CONTRACT_VERSION,
    parse(input: unknown): T {
      assertNoProhibitedFields(input);
      return parser(input, "$");
    },
    safeParse(input: unknown): ParseResult<T> {
      try {
        return { success: true, data: this.parse(input) };
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return { success: false, issues: error.issues };
        }
        throw error;
      }
    }
  };
}

export function strictObject(
  input: unknown,
  path: string,
  fields: readonly string[]
): Record<string, unknown> {
  if (!isRecord(input)) issue(path, "invalid_type", "Expected an object.");

  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) {
      issue(`${path}.${key}`, "unknown_field", "Unknown field.");
    }
  }
  return input;
}

export function required(
  object: Record<string, unknown>,
  field: string,
  path: string
): unknown {
  if (!Object.hasOwn(object, field) || object[field] === undefined) {
    issue(`${path}.${field}`, "missing_field", "Required field is missing.");
  }
  return object[field];
}

export function optional(object: Record<string, unknown>, field: string): unknown {
  return object[field];
}

export function string(input: unknown, path: string, label = "string"): string {
  if (typeof input !== "string") issue(path, "invalid_type", `Expected ${label}.`);
  return input;
}

export function nonEmptyString(input: unknown, path: string, label = "a non-empty string"): string {
  const value = string(input, path, label);
  if (value.trim().length === 0) issue(path, "invalid_value", `Expected ${label}.`);
  return value;
}

export function boolean(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") issue(path, "invalid_type", "Expected a boolean.");
  return input;
}

export function integer(input: unknown, path: string, minimum?: number, maximum?: number): number {
  if (typeof input !== "number" || !Number.isInteger(input)) {
    issue(path, "invalid_type", "Expected an integer.");
  }
  if (minimum !== undefined && input < minimum) issue(path, "invalid_value", `Must be at least ${minimum}.`);
  if (maximum !== undefined && input > maximum) issue(path, "invalid_value", `Must be at most ${maximum}.`);
  return input;
}

export function array<T>(input: unknown, path: string, parser: Parser<T>): T[] {
  if (!Array.isArray(input)) issue(path, "invalid_type", "Expected an array.");
  return input.map((value, index) => parser(value, `${path}[${index}]`));
}

export function enumValue<T extends string>(
  input: unknown,
  path: string,
  values: readonly T[]
): T {
  if (typeof input !== "string" || !values.includes(input as T)) {
    issue(path, "invalid_value", `Expected one of: ${values.join(", ")}.`);
  }
  return input as T;
}

export function nullable<T>(input: unknown, path: string, parser: Parser<T>): T | null {
  return input === null ? null : parser(input, path);
}

export function opaqueId(input: unknown, path: string): string {
  const value = nonEmptyString(input, path, "an opaque identifier");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    issue(path, "invalid_value", "Expected an opaque identifier.");
  }
  return value;
}

export function isoTimestamp(input: unknown, path: string): string {
  const value = nonEmptyString(input, path, "an ISO-8601 timestamp");
  if (Number.isNaN(Date.parse(value))) issue(path, "invalid_value", "Expected an ISO-8601 timestamp.");
  return value;
}

export function plainMetadata(input: unknown, path: string): Record<string, string | number | boolean | null> {
  const object = strictObject(input, path, Object.keys((input ?? {}) as Record<string, unknown>));
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      metadata[key] = value;
    } else {
      issue(`${path}.${key}`, "invalid_type", "Metadata values must be primitive and redacted.");
    }
  }
  return metadata;
}
