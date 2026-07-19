#!/bin/sh
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
for bucket in "$S3_BUCKET_QUARANTINE" "$S3_BUCKET_CLEAN" "$S3_BUCKET_DERIVED"; do mc mb --ignore-existing "local/$bucket" >/dev/null; mc anonymous set none "local/$bucket" >/dev/null; done
cat >/tmp/api-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:PutObject"],"Resource":["arn:aws:s3:::$S3_BUCKET_QUARANTINE/q/*"]}]}
EOF
cat >/tmp/worker-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::$S3_BUCKET_QUARANTINE/q/*"]},{"Effect":"Allow","Action":["s3:PutObject"],"Resource":["arn:aws:s3:::$S3_BUCKET_CLEAN/c/*","arn:aws:s3:::$S3_BUCKET_DERIVED/d/*"]}]}
EOF
mc admin policy create local evidence-loop-api /tmp/api-policy.json >/dev/null 2>&1 || true
mc admin policy create local evidence-loop-worker /tmp/worker-policy.json >/dev/null 2>&1 || true
mc admin user add local "$MINIO_API_ACCESS_KEY" "$MINIO_API_SECRET_KEY" >/dev/null 2>&1 || true
mc admin user add local "$MINIO_WORKER_ACCESS_KEY" "$MINIO_WORKER_SECRET_KEY" >/dev/null 2>&1 || true
mc admin policy attach local evidence-loop-api --user "$MINIO_API_ACCESS_KEY" >/dev/null
mc admin policy attach local evidence-loop-worker --user "$MINIO_WORKER_ACCESS_KEY" >/dev/null

echo "Created private zones and restricted API/worker MinIO identities."
