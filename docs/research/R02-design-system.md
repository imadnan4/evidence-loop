# R02 — Original Optics-inspired design system

- **Date:** 2026-07-18
- **Status:** Proposed
- **Owner:** Product-design research agent; approval owner: product + accessibility lead

## Recommendation
Create an original Evidence Loop system: calm neutral canvas, semantic surface/text/border/accent/success/caution/danger/focus tokens, 4px spacing rhythm, 4/8/16px elevation, responsive instructor shell, and focused learner check-in room. Ship owned `AppShell`, `Sidebar`, `TopBar`, `Surface`, `FormField`, `AsyncButton`, `Dialog`, `Drawer`, `Toast`, `StepProgress`, `EvidenceCard`, `ProvenanceTimeline`, `StatusBadge`, `DataTable`, `FileDropzone`, `TranscriptEditor`, `ConsentNotice`, and `InstructorDecisionPanel`.

Use Optics only as a reference for accessible component composition and interaction patterns. Do **not** copy its branding, names, logo, screenshots, illustrations, source, or distinctive page templates.

## Primary sources
- [Optics repository](https://github.com/AgusMayol/optics)
- [Optics MIT license](https://github.com/AgusMayol/optics/blob/main/LICENSE)
- [Optics accessibility guide](https://optics.agusmayol.com.ar/resources/accesibility)
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## Rejected/deferred
Copied Optics assets/source are rejected; copied source would require MIT notice and separate dependency/asset provenance review. A branded component gallery and learner-facing command palette are deferred; the palette is instructor-only.

## Security and cost impact
No vendor/runtime cost. Use semantic HTML, skip link, labelled errors, live status, focus trap/restore, visible focus, reduced motion, non-colour state labels, and 320px/reflow support. Never use urgency, animation, or color as learner-quality signals.

## Acceptance checks
1. Token contrast validation and reduced-motion test pass.
2. Keyboard-only learner/instructor critical flows pass, including overlay focus restoration.
3. Automated accessibility scan plus NVDA/Firefox and VoiceOver/Safari scripts identify no release blocker.
4. Asset/license scan shows no Optics-branded asset or copied source without review.

## Dependencies and unresolved owner decisions
Depends on R07 validation. Product owner must approve the three primary screen flows, component priority, supported browser/AT matrix, and whether dark theme is in first release.
