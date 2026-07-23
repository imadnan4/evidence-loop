# Provisional staging boundary

A01 provides synthetic-only local dependencies and CI health proof. It does **not** provision DigitalOcean, a staging URL, paid services, or a PII environment.

Until R00, R03, R04, R05, and R08 receive their required approvals, local Compose and any future staging verification are limited to synthetic data. The intended topology is a public web/BFF boundary with API, worker, PostgreSQL, and object storage private; this repository does not yet implement that BFF.

Still unresolved: provider region and budget, recovery targets, identity provider, scanner/parser sandbox, telemetry vendor, retention, DPA, and incident owners. A code rollback never restores database or object data; restore requires an approved database/object recovery procedure.
