# Synthetic local platform operations

This Compose stack is for **synthetic data only**. It is not staging or production, has no authentication or schema migration runtime, and must never receive learner records, education records, production API keys, or other PII.

## Bootstrap and health

```bash
pnpm install --frozen-lockfile
node scripts/create-local-env.mjs
docker compose --env-file infra/env/.env.local up --wait
docker compose --env-file infra/env/.env.local ps
```

PostgreSQL and MinIO bind to loopback only. `minio-init` must complete successfully; it creates the private `quarantine`, `clean`, and `derived` buckets. Use `pnpm run compose:smoke` for an isolated privacy and cleanup check.

## Stop, reset, and rotate

Stop the local services without deleting state:

```bash
docker compose --env-file infra/env/.env.local down
```

Delete all local synthetic database and object-store data:

```bash
docker compose --env-file infra/env/.env.local down --volumes --remove-orphans
```

To rotate local credentials, stop and remove volumes, delete the ignored `infra/env/.env.local`, then run `node scripts/create-local-env.mjs` again. Do not copy that file to another environment or commit it.

## Backup and rollback limits

This local stack has no backup, point-in-time recovery, migration rollback, or deployment rollback guarantee. A volume reset is destructive. A real staging/production rollout remains blocked on the approved provider, region, retention, backup/restore drill, migration plan, secrets manager, monitoring, and institutional/privacy approvals documented in R00, R04, and R08.
