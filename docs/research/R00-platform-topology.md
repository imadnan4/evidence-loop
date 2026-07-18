# R00 — Provisional synthetic-only staging topology

- **Date:** 2026-07-18
- **Status:** Proposed; not approved for PII or production
- **Owner:** Platform research agent; approval owner: project owner + institution/procurement

## Recommendation
Use a **synthetic-only** staging environment in one yet-to-be-approved region: Next.js web, internal Fastify API, and non-public worker; managed PostgreSQL; private S3-compatible object storage with separate quarantine/clean/derived prefixes; and a Postgres outbox. The preferred researched candidate is DigitalOcean App Platform plus Managed PostgreSQL and Spaces. This is a topology proposal, not a provisioned account, cost commitment, or data-residency decision.

**Assumptions:** no real learner records, secrets supplied only at deployment, an institution-approved region is selected before provisioning, and the job queue can use the planned Postgres outbox. Indicative research cost is about US$35/month without Redis, or US$45/month if a separate fixed Redis queue is necessary; verify current pricing before purchase.

## Primary sources
- [DigitalOcean App Platform availability](https://docs.digitalocean.com/products/app-platform/details/availability/)
- [App Platform pricing](https://docs.digitalocean.com/products/app-platform/details/pricing/)
- [Managed PostgreSQL features/PITR](https://docs.digitalocean.com/products/databases/postgresql/details/features/)
- [Spaces permissions](https://docs.digitalocean.com/products/spaces/how-to/set-file-permissions/)
- [Spaces backup limitation](https://docs.digitalocean.com/support/how-do-i-back-up-spaces-buckets/)
- [App deployment rollback](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/)

## Rejected/deferred
- **Railway object storage:** deferred because documented buckets lack versioning, lifecycle configuration, and native backups.
- **Render plus external object store:** deferred because it adds a provider boundary before a pilot need exists.
- **Production/PII topology:** blocked pending region, DPA, retention, recovery, and institution decisions.

## Security and cost impact
Private objects only; scoped server-issued upload/download access; queue payloads contain opaque IDs only. App rollback does **not** roll back database data: use backward-compatible migrations, tagged releases, PITR, versioned objects, external object-copy/restore evidence, and a queue replay runbook. Single-node pilot database is not HA.

## Acceptance checks
1. Synthetic staging deploy exposes only the web service publicly.
2. API/worker have no public listener; database/object permissions are least privilege.
3. Restore drill proves database and object recovery; rollback runbook distinguishes code from data recovery.
4. Billing alert, secret scan, and synthetic-data banner pass.

## Dependencies and unresolved owner decisions
Depends on R03/R04/R05/R08. Project owner and institution must choose region, monthly budget, pilot country/institution, RTO/RPO, whether a separate queue is required, and whether email-only demo login is acceptable. No PII launch until R04 conditions are approved.
