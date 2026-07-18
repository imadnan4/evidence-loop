# R05 — Fail-closed artifact pipeline

- **Date:** 2026-07-18
- **Status:** Proposed
- **Owner:** Security/platform research agent; approval owner: security lead

## Recommendation
Accept only PDF, TXT, `.py`, `.ipynb`, and constrained CSV through a server-authorized one-use upload intent. Store opaque server-generated keys in private quarantine. Validate extension, detected type/magic bytes, size/quota/checksum, and format limits; scan asynchronously; parse only after an explicit clean verdict in an isolated no-egress, non-root, resource-bounded worker. Every `failed`, `unsupported`, timeout, duplicate/unknown event, infected, or malformed result is **fail-closed**: no download, preview, parse, model input, or promotion.

Treat Python/notebooks as data; never import, execute, trust, or render untrusted output as active HTML. Preserve stable page/line/cell fragments and immutable audit state. CSV parsing never evaluates formulas; spreadsheet export requires field-level formula neutralization.

## Primary sources
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [OWASP ASVS file handling](https://asvs.dev/v5.0.0/V5-File-Handling/)
- [AWS GuardDuty S3 malware workflow](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html)
- [Jupyter notebook security](https://jupyter-notebook.readthedocs.io/en/master/security.html)
- [OWASP CSV injection](https://owasp.org/www-community/attacks/CSV_Injection)

## Rejected/deferred
Public buckets/URLs, client MIME trust, API-process parsing, best-effort scanning, archives, code execution, automatic notebook trust, and an unreviewed parser/scanner provider are rejected/deferred.

## Security and cost impact
Requires private object zones, scanner and sandbox runtime, durable idempotent jobs, resource quotas, and scanner/parser operational costs. AV alone is not proof of safety; keep isolation and limits after clean results.

## Acceptance checks
1. EICAR, forged MIME, double extension, malformed/oversized/bomb payload, timeout, and scanner failure remain inaccessible.
2. Duplicate completion does not duplicate promotion/audit; only clean objects gain constrained access.
3. Isolation test proves no egress/metadata/production credentials, non-root, read-only root, and CPU/RSS/wall/output limits.
4. Python/notebook sentinel and untrusted HTML tests prove no execution; CSV export injection cases pass.

## Dependencies and unresolved owner decisions
Depends on R00 storage/runtime and R08 telemetry. Security/platform must choose scanner, sandbox technology, exact type limits, retention lifecycle, preview policy, and signed-URL lifetime.
