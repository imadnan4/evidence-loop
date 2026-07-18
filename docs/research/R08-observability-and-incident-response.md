# R08 — Redacted telemetry and incident readiness

- **Date:** 2026-07-18
- **Status:** Proposed
- **Owner:** Reliability/security agent; approval owner: security + operations lead

## Recommendation
Emit structured, redacted events for request/job/audit correlation and upload state changes: received, validation rejection (reason code), scan requested/completed, promotion/quarantine, parser start/complete/timeout, authorized download, model run outcome, retention/deletion, and review action. Use UTC time, service/version, severity/outcome, opaque correlation/upload IDs, pseudonymous actor/tenant references, policy/scanner/parser/model versions, and reason codes.

Redact **before emission**. Never log artifact/extracted/transcript content, filenames/paths, bodies, raw exceptions, URLs/query strings, presigned URLs, cookies, authorization headers, session IDs, credentials, keys, or client secrets. Sanitize untrusted log fields to prevent log injection. Send logs through access-controlled encrypted transport to a separate collector with bounded retention.

## Primary sources
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OWASP ASVS security logging](https://asvs.dev/v5.0.0/V16-Security-Logging-and-Error-Handling/)
- [OpenTelemetry specification](https://opentelemetry.io/docs/specs/otel/)

## Rejected/deferred
Raw-content observability, browser telemetry with student content, unrestricted vendor support logs, and log-sink failure that opens the upload gate are rejected. Specific telemetry/error-tracking vendor and retention duration are deferred to R00/R04 procurement.

## Security and cost impact
Requires central collector access controls, retention/deletion configuration, alerting, redaction tests, and incident/restore drills; vendor cost is unselected. Logging remains best effort for diagnostics, but core security decisions must persist auditable transaction/outbox records without content.

## Acceptance checks
1. Redaction corpus proves secrets/content/headers/URLs/CRLF payloads do not appear in API, worker, or error logs.
2. Every security-relevant transition emits a schema-valid event with no raw content.
3. Unauthorized read/write to log plane fails; collector transport is encrypted and log tampering is alerted.
4. Alert, trace-to-audit, backup/restore, and incident escalation drills have dated evidence.

## Dependencies and unresolved owner decisions
Depends on R00/R04/R05. Operations/security must choose collector/vendor, retention, access roles, alert thresholds, on-call/incident owner, pseudonym rotation, and approved data classification.
