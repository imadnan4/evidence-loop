import { assertNoProhibitedFields, ContractValidationError } from "@evidence-loop/contracts/v1";

import { badRequest } from "./errors.ts";

export const clone = <T>(value: T): T => structuredClone(value);

export function immutable<T>(value: T): Readonly<T> {
  return deepFreeze(clone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${name} is required.`);
  }
  return value.trim();
}

export function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, name);
}

export function wholeNumberInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw badRequest(`${name} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

export function exactBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw badRequest(`${name} must be true or false.`);
  return value;
}

/**
 * Applies the frozen F00 decision-support field boundary before F02's
 * operation-specific strict shape checks.
 */
export function allowedKeys(
  value: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  try {
    assertNoProhibitedFields(value, name);
  } catch (error) {
    if (error instanceof ContractValidationError) throw badRequest(error.message);
    throw error;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw badRequest(`${name}.${key} is not allowed.`);
  }
  return value as Record<string, unknown>;
}
