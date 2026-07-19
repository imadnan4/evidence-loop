#!/bin/sh
set -eu

# Runtime roles are non-owner and cannot bypass tenant RLS. Worker discovery is
# limited to two fixed SECURITY DEFINER lease functions granted below.
psql -X -v ON_ERROR_STOP=1 \
  --set=app_user="$POSTGRES_APP_USER" --set=app_password="$POSTGRES_APP_PASSWORD" \
  --set=worker_user="$POSTGRES_WORKER_USER" --set=worker_password="$POSTGRES_WORKER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_user', :'app_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'worker_user', :'worker_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_user') \gexec
SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_user', :'app_password') \gexec
SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'worker_user', :'worker_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), :'app_user', :'worker_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I, %I', :'app_user', :'worker_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION complete_artifact_upload(uuid, uuid, uuid, uuid, text, text, text) TO %I', :'app_user') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION claim_artifact_outbox(text, integer), finish_artifact_outbox(uuid, text, boolean, text), load_claimed_artifact(uuid, text), terminal_claimed_artifact(uuid, text, text, text, text), claim_stale_artifact_upload_intents(text, integer), finish_stale_artifact_upload_intent(uuid, text, boolean, integer, text) TO %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', current_user, :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', current_user, :'app_user') \gexec
SQL

echo "Provisioned isolated non-owner NOBYPASSRLS API and worker roles."
