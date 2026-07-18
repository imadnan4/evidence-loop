# A01 runtime probes

These images are **not** the Evidence Loop API, worker, or deployed BFF. They are deliberately small, non-root runtime contracts while A02/B01/B04/D03 are incomplete.

- `web` runs the existing synthetic static shell and is the only Compose service with a host port.
- `api` exposes only `GET /health/live` and `GET /health/ready` on the internal Compose network. Any product path returns `404`.
- `worker` checks dependency reachability and never polls, consumes, parses, or promotes work.

The eventual Fastify bootstrap must retain the two API health paths without exposing product data before authorization. The future worker must consume only the A02 durable outbox/job adapter. These images deliberately include no provider credentials, application routes, migrations, scanner, parser, or model integration.
