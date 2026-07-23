# Evidence Loop

> **Let learners use AI; make understanding visible.**

Evidence Loop is an assessment-support prototype for AI-enabled coursework. It helps instructors review source-linked evidence of what a learner can explain about their submitted work, while preserving learner choice and instructor judgment.

It is **not** an AI detector, proctoring product, or automated grader. It does not issue final grades, pass/fail outcomes, misconduct findings, or behavioral, personality, emotion, accent, tone, or voice-confidence inferences.

## What is implemented

The repository currently contains the following foundations through the reviewed F07b voice-UI gate:

- **Assessment authoring** — course-scoped authoring, instructor-approved objectives, versioned policy, and immutable published assessment versions.
- **Artifact provenance** — private, one-use upload capabilities; supported PDF, text, Python, notebook, and CSV normalization; immutable cited fragments; and a scan/parser boundary that never executes learner work.
- **Typed learner check-in** — a policy briefing and acknowledgement, finite question and time budgets, pause/resume, human-follow-up, receipts, idempotent responses, and an always-available text route.
- **Bounded AI orchestration** — structured proposals for objectives, artifact maps, questions, and evidence-card drafts, constrained to current-submission sources with validation for grounding, scope, prompt injection, and prohibited outputs. It has no tool, web, code-execution, or workflow-transition surface.
- **Instructor evidence review** — a keyboard-oriented, synthetic review interface with provenance inspection, editable feedback, and human review actions. The current interface is a local demo: its actions are not sent or saved.
- **Safe voice check-in** — short-lived browser credentials, authorized session linkage, opt-in capture, editable live transcript, pause/replay, idempotent atomic voice submission, intentional-exit states, and a text fallback. Transcript text—not audio or acoustic features—is the canonical record.

A typical evidence loop is:

```text
Instructor-approved objectives → submitted artifact → finite text/voice check-in
→ source-linked evidence draft → instructor review and decision
```

## Repository layout

```text
apps/
  api/          Assessment, artifact, session, AI, and voice services
  web/          Static learner and instructor web shell
packages/
  config/       Runnable server-only environment validation
  contracts/    Versioned v1 domain and API contracts
  ui/           Reusable design tokens, CSS primitives, and components
```

`packages/config` is a private workspace package used by server processes to validate environment configuration; it is not browser code or a published package.

## Local setup

**Requirements:** Node.js 24 or later, pnpm 11 or later, and Docker Compose for the synthetic local dependency stack. The workspace pins `pnpm@11.12.0`.

```bash
pnpm install --frozen-lockfile
node scripts/create-local-env.mjs
docker compose --env-file infra/env/.env.local up --wait
```

This starts only loopback-bound PostgreSQL and private MinIO zones (`quarantine`, `clean`, and `derived`) for **synthetic data**. It does not create a database schema, deploy an API, or authorize real learner records. See [`infra/OPERATIONS.md`](infra/OPERATIONS.md) before resetting volumes or rotating local credentials.

Run the static web shell:

```bash
pnpm --filter @evidence-loop/web-shell start
```

It listens on `http://localhost:3000` by default. The web shell uses synthetic data; it is not a production deployment or a connected student-record system.

## Checks

```bash
# Canonical workspace checks: format, config typecheck/tests, contracts, API
# (including the session state machine), web, UI, smoke, env template, Compose config.
pnpm check

# Starts an isolated throwaway Compose stack, checks bucket privacy, then removes volumes.
pnpm run compose:smoke
```

The release smoke check still starts the static shell on an ephemeral local port and verifies only its synthetic routes and basic HTTP boundaries.

## Synthetic demo walkthrough

All visible people, artifacts, notebook excerpts, responses, and timestamps in the demo are synthetic. The instructor-facing screen labels them as such.

1. Start the shell and open `http://localhost:3000/instructor/`.
2. In **Review queue**, open **Sample learner A**. Inspect the three evidence-card sections: **Demonstrated**, **Needs human review**, and **Next learning step**.
3. Open each provenance control to inspect its current-submission notebook cell or response excerpt. Close the drawer with **Escape** and observe focus returning to its trigger.
4. Edit the feedback note, choose a human review action, and select **Record human review**. The demo confirms that the action is local only; it does not send or save a grade or decision.
5. Open `http://localhost:3000/learner/` to inspect the plain-language briefing, typed route, privacy explanation, and optional voice controls. The live learner loop requires a course-provided check-in session from the F04a/F07a API boundary; this repository does not package an HTTP BFF or real student-record runtime. Its keyboard, text, voice-fallback, receipt, and retry paths are exercised by the browser-flow check above.

## Boundaries by design

| Area | Current boundary |
| --- | --- |
| Accessibility | Typed response is required as an equivalent route. Learners receive a policy briefing and can pause, resume, request human follow-up, and review/edit transcript text where voice is available. |
| Privacy | The implementation minimizes browser credentials, keeps storage capabilities server-side, and retains transcript text rather than raw audio in the voice path. Production retention, provider controls, and legal review remain future work. |
| Safety | Learner artifacts are untrusted data. The AI boundary rejects unsafe or ungrounded output and has no web, arbitrary-tool, or code-execution capability. |
| Provenance | Questions and evidence claims are scoped to the current submission and carry artifact or response references. |
| Human authority | AI output is decision support only. An instructor reviews evidence and makes every consequential decision; final grading remains outside Evidence Loop. |

## Project status

The scoped F00–F08 project is complete: its implementation and release-hardening gates are reviewed, and the repository includes the synthetic-demo documentation and release smoke check. Package checks cover the API, contracts, UI system, and browser flows; the release smoke check covers static demo availability and basic HTTP boundaries.

This completed scope is a test-backed prototype and synthetic demo, not a production service. A deployed instructor → learner → instructor runtime—with an HTTP BFF, authenticated course/session setup, durable storage, and deployment configuration—is intentionally outside scope. Production concerns such as identity integration, retention controls, provider data controls, operational storage, and legal/institutional review are not implemented or claimed here.

## Development workflow

Keep changes small and within one ownership area. Run the matching package check, preserve the evidence/safety boundaries above, and request independent review before integration. Do not add automated grades, misconduct or cheating labels, surveillance, voice-derived scoring, or cross-learner retrieval. Project-manager integration, commits, and releases occur only after review.
