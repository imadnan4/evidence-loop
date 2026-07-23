# Evidence Loop contracts

Versioned, framework-neutral runtime schemas for cross-app data and API boundaries. `v1` is intentionally strict: unknown fields are rejected, inbound writes include idempotency keys, and decision-support boundaries reject fields for automated grading, misconduct inference, personality/emotion inference, and voice-derived scoring.

## Use

```ts
import { EvidenceCardSchema } from "@evidence-loop/contracts/v1";

const result = EvidenceCardSchema.safeParse(untrustedInput);
if (!result.success) {
  // Return the v1 error envelope without logging raw learner content.
}
```

Schemas validate shape and local invariants. Services must still enforce authorization, immutable versioning, state transitions, and object-level source ownership against their system of record.
