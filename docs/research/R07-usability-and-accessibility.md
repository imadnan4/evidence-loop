# R07 — Formative usability and accessibility validation

- **Date:** 2026-07-18
- **Status:** Proposed; not a conformance certification
- **Owner:** UX research agent; approval owner: product + accessibility lead

## Recommendation
Run a formative 3–5 adult-participant study on synthetic staging: include a keyboard-only user, a regular screen-reader user, a low-vision zoom/high-contrast user, and a novice in the subject context without requiring medical disclosure. Test the actual Evidence Loop loop: learner reads policy, uploads a synthetic artifact, completes text-first finite check-in/pause-resume/receipt, and instructor inspects provenance then records an editable human action. Voice is optional and must never block text completion.

Measure completion, time, assistance, observed barrier, environment/AT, post-task ease, and satisfaction. Combine this with expert/manual and automated WCAG 2.2 AA-oriented testing; participant sessions alone do not prove accessibility or legal conformance.

## Primary sources
- [W3C involving users](https://www.w3.org/WAI/test-evaluate/involving-users/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C accessibility evaluation report template](https://www.w3.org/WAI/test-evaluate/report-template/)
- [ISO 9241-11](https://www.iso.org/standard/63500.html)

## Rejected/deferred
A generic analyst-dashboard study, unconsented recordings, claims of statistical significance from 3–5 sessions, and treating automated scans as complete accessibility validation are rejected. Large pilot and production UX claims are deferred.

## Security and cost impact
Use de-identified notes, consented/limited recordings, synthetic accounts/artifacts, and restricted research access. Budget participant compensation and accessibility specialist time; no amount is approved.

## Acceptance checks
1. Keyboard-only and screen-reader participants can complete applicable critical paths without a blocker.
2. Test issues are severity-ranked; any critical issue or recurring/core-task high issue is fixed and retested.
3. Separate report records keyboard, focus, names/roles/status, errors, contrast, reflow, motion, and voice-to-text equivalence.
4. Readout explicitly states what was and was not tested.

## Dependencies and unresolved owner decisions
Depends on R02 and runnable text-first stack. Product owner must approve recruitment/consent, support matrix, compensation, study recording policy, target metrics, and whether voice is in scope for first-release validation.
