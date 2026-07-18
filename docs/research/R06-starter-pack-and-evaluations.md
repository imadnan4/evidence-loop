# R06 — Data Analysis Starter evaluation pack

- **Date:** 2026-07-18
- **Status:** Proposed; pack must be instructor-reviewed before use
- **Owner:** Pedagogy/evaluation agent; approval owner: instructor adviser + product/safety leads

## Recommendation
Create a versioned, **synthetic 30–50 case** Data Analysis Starter corpus for Evidence Loop—not a generic freeform data-analysis app. Each case contains a learner artifact (notebook/Python/PDF/text/CSV sample), published objectives/policy, a finite 3–5-question text check-in transcript or expected question path, source-fragment IDs, expected evidence-card claims/uncertainty, human-review expectation, accessibility variant, and injection payload where applicable.

Starter objectives: data preparation; leakage/validation; choice justification; interpretation; revision. Oracles must assert source scope, finite budget, no grades/misconduct/personality/voice inference, and human-only final review.

## Primary sources
- [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)
- [OWASP LLM Top 10](https://genai.owasp.org/llm-top-10/)
- [OWASP prompt-injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)

## Rejected/deferred
The prior generic “data import → analyst result/chart/export” framing is rejected: it does not test Evidence Loop's artifact → check-in → provenance → instructor-review contract. Real learner records, automated scoring, unrestricted tool tests, and model selection by intuition are deferred/rejected.

## Security and cost impact
All fixtures remain synthetic and pinned by fixture/prompt/model/schema/parser versions. Run deterministic validators before semantic adjudication. Cost comes from controlled model-evaluation runs; set a run budget and record it without raw content.

## Acceptance checks
1. Corpus includes clear/partial/misconception/mismatch, edited transcript, pause/resume, accommodation, and indirect-injection cases.
2. Every expected displayed claim has current-submission source IDs; forbidden output and cross-submission tests fail closed.
3. Two human reviewers label claims/question suitability and version oracle changes with rationale.
4. Zero P0 safety/provenance/keyboard failures; baseline results are retained by version.

## Dependencies and unresolved owner decisions
Depends on R01/R02/R05/R07. Instructor adviser must approve starter rubric, evaluation labels, exact question/time budget, participant-safe artifact examples, release thresholds, and evaluation spend cap.
