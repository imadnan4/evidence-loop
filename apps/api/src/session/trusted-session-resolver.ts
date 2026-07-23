import type { ResolvedTextCheckInContext, TrustedSessionResolver } from "./types.ts";

const immutable = <T>(value: T): T => {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    }
  };
  freeze(copy);
  return copy;
};

/**
 * Local/test resolver. Production must implement the same lookup against
 * authorized enrollment, published-version, submission, and fragment stores.
 */
export class InMemoryTrustedSessionResolver implements TrustedSessionResolver {
  #contexts = new Map<string, ResolvedTextCheckInContext>();

  constructor(contexts: readonly ResolvedTextCheckInContext[] = []) {
    for (const context of contexts) this.add(context);
  }

  add(context: ResolvedTextCheckInContext): void {
    this.#contexts.set(context.submissionId, immutable(context));
  }

  resolveForLearner(actorId: string, submissionId: string): ResolvedTextCheckInContext | undefined {
    const context = this.#contexts.get(submissionId);
    // Do not disclose whether another learner's submission exists.
    if (!context || context.learnerId !== actorId) return undefined;
    return immutable(context);
  }
}
