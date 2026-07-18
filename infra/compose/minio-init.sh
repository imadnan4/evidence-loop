#!/bin/sh
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
for bucket in "$S3_BUCKET_QUARANTINE" "$S3_BUCKET_CLEAN" "$S3_BUCKET_DERIVED"; do
  mc mb --ignore-existing "local/$bucket" >/dev/null
  mc anonymous set none "local/$bucket" >/dev/null
done

echo "Created private synthetic-only object zones."
