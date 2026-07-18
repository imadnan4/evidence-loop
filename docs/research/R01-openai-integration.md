# R01 — OpenAI bounded integration

- **Date:** 2026-07-18
- **Status:** Proposed; account controls and model benchmark still required
- **Owner:** AI platform research agent; approval owner: security/privacy + project owner

## Recommendation
Use server-side Responses API calls only for bounded, schema-validated proposals. Set `text.format` to strict JSON Schema and handle refusal/incomplete results before business validation. Set **`store: false` by default**; this does not eliminate documented abuse-monitoring retention. Browser voice, if later approved, receives only an authenticated server-minted Realtime client secret that expires at the provider-returned `expires_at`; the standard OpenAI API key never enters browser code.

The API may receive only the current submission's allowlisted fragments, approved objectives, and canonical text transcript. It has no tools, browser, code execution, cross-course retrieval, or workflow-transition authority.

## Primary sources
- [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [Realtime WebRTC](https://platform.openai.com/docs/guides/realtime-webrtc)
- [Realtime client secrets](https://platform.openai.com/docs/api-reference/realtime-beta-sessions)
- [OpenAI data controls](https://platform.openai.com/docs/guides/your-data)
- [Business/API data use](https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/)

## Rejected/deferred
- Browser-held standard API keys, JSON-mode-only parsing, model-directed state changes, remote MCP/tools, and unbenchmarked model selection are rejected.
- ZDR/MAM claims, raw-audio retention, and a production model pin are deferred pending account approval, benchmark, and privacy review.

## Security and cost impact
Record template/model/schema versions, input object IDs, outcome, latency, and spend caps without raw content. Strict transport schema is not semantic safety: validate source IDs, submission scope, banned concepts, duplicates, and output length locally. Rate-limit calls and token minting; do not log client secrets, audio, or prompts.

## Acceptance checks
1. Automated tests cover strict-schema normal/refusal/incomplete paths and local grounding rejection.
2. Request defaults assert `store: false`; no browser bundle contains provider keys.
3. Realtime mint route authenticates session, uses a server-side safety identifier, returns only scoped secret metadata, and respects expiry.
4. Golden and injection corpus select a model only after documented quality/latency/cost results.

## Dependencies and unresolved owner decisions
Depends on R04 privacy approval and R06 evaluation corpus. Owners must select benchmarked model/version, per-course budget, permitted data classes, OpenAI account retention configuration, and whether optional voice ships after text-first release.
