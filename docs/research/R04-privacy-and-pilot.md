# R04 — Privacy and pilot operating guardrails

- **Date:** 2026-07-18
- **Status:** Conditional; **blocks any PII/education-record launch**
- **Owner:** Privacy research agent + institution counsel/procurement; approval owner: institution privacy officer

## Recommendation
This is **non-legal operational guidance, not legal advice or a compliance certification**. Keep staging synthetic/de-identified. Before any real learner data, obtain the institution's documented data map, applicable legal/FERPA analysis, approved disclosure/consent basis, executed vendor agreements/DPA, subprocessor and transfer review, retention/deletion/export schedule, and pilot incident/support plan.

Minimize collection; keep consent/policy version, timestamp, withdrawal, and actor audit evidence; do not condition ordinary educational access on optional research/analytics consent. Provide an alternative text/accommodation route and clear distinction among export, deactivation, and deletion.

## Primary sources
- [34 CFR Part 99](https://www.ecfr.gov/current/title-34/subtitle-A/part-99)
- [NIST Privacy Framework](https://www.nist.gov/document/nist-privacy-frameworkv10pdf)
- [Clerk DPA](https://clerk.com/legal/dpa)
- [OpenAI data controls](https://platform.openai.com/docs/guides/your-data)

## Rejected/deferred
Self-certifying FERPA/GDPR/DPA compliance, public-DPA-only approval, real student-data demos, and unbounded free-text/sensitive uploads are rejected. Research-study status, retention duration, data region, raw-audio policy, and institution data-processing terms are deferred to authorized owners.

## Security and cost impact
Maintain a per-vendor data inventory, purpose, data class, region, retention trigger, backup expiry, deletion evidence, support access, and subprocessors. Restricted support, quarterly access review, break-glass audit, and deletion/exit drills add operational work; their cost is not yet estimated.

## Acceptance checks
1. Counsel/procurement signoff and an executed applicable agreement exist before PII.
2. Pilot uses documented consent/policy versioning, authorized export, deletion evidence, and backup-expiry behavior.
3. Access-review, incident, vendor-offboarding, and deletion drills pass with recorded evidence.
4. No raw education records enter logs, support tickets, or unapproved providers.

## Dependencies and unresolved owner decisions
Blocks R00 production selection, R01 data flow, R03 provider procurement, and all PII release gates. Institution must decide jurisdiction, role/basis, data categories, retention, pilot purpose, DPA/subprocessors, required notices, and accountable incident/records owners.
