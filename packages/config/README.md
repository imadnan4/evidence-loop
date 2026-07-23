# Shared server configuration

`@evidence-loop/config` parses the server-only environment contract used by the future API and worker. It is deliberately not a browser package: variables in `NEXT_PUBLIC_`, `VITE_`, or `PUBLIC_` namespaces fail validation.

## A01 contract

Copy `infra/env/.env.example` to the ignored `infra/env/.env.local`, then generate unique local values with:

```bash
node scripts/create-local-env.mjs
```

The parser requires `EVIDENCE_LOOP_ENV` (`local`, `ci`, or `staging`) and `SYNTHETIC_DATA_ONLY=true`. Staging rejects loopback endpoints, HTTP object storage, and placeholder object credentials. It validates all base database/object-storage/origin metadata before a future server starts, and reports only variable names plus reason codes.

The following integrations are intentionally not configured by A01. Their variables must either all be absent or all be present; owning gates will validate their provider-specific settings:

- OpenAI: `OPENAI_API_KEY`, `OPENAI_MODEL`
- OIDC: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`
- telemetry: `TELEMETRY_COLLECTOR_URL`, `TELEMETRY_AUTH_TOKEN`
- scanner: `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_TOKEN`
- parser: `PARSER_SERVICE_URL`, `PARSER_SERVICE_TOKEN`

This package does not authorize requests, create storage credentials, or make provider calls.
