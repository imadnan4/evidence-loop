#!/bin/sh
set -eu

case "${1:-}" in
  postgres)
    exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
    ;;
  minio)
    exec curl -fsS http://127.0.0.1:9000/minio/health/ready
    ;;
  *)
    echo "usage: healthcheck.sh postgres|minio" >&2
    exit 64
    ;;
esac
