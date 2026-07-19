-- B04 forward-only durable artifact pipeline. Never edit 0001/0002.
ALTER TABLE idempotency_results DROP CONSTRAINT idempotency_results_target_type_check;
ALTER TABLE idempotency_results ADD CONSTRAINT idempotency_results_target_type_check CHECK (target_type IN ('assessment','assessment_version','submission','artifact','artifact_upload_intent'));

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  course_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  assessment_version_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','processing','ready','needs_human_follow_up','rejected','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (course_id, organization_id) REFERENCES courses(id, organization_id),
  FOREIGN KEY (assessment_id, organization_id, course_id) REFERENCES assessments(id, organization_id, course_id),
  FOREIGN KEY (assessment_version_id, organization_id, assessment_id) REFERENCES assessment_versions(id, organization_id, assessment_id),
  FOREIGN KEY (learner_id, organization_id) REFERENCES internal_users(id, organization_id)
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), submission_id uuid NOT NULL,
  quarantine_key text NOT NULL CHECK (char_length(quarantine_key) BETWEEN 1 AND 512), clean_key text, derived_key text,
  declared_extension text NOT NULL CHECK (declared_extension IN ('.pdf','.txt','.py','.ipynb','.csv')),
  declared_content_type text NOT NULL CHECK (char_length(declared_content_type) BETWEEN 1 AND 128),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880), sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'intent_issued' CHECK (status IN ('intent_issued','uploaded','scanning','parsing','ready','rejected','blocked','failed','deleted')),
  failure_code text, scanner_version text, parser_version text, scan_completed_at timestamptz, parsed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id), UNIQUE (quarantine_key),
  FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id),
  CHECK ((status <> 'ready') OR (clean_key IS NOT NULL AND derived_key IS NOT NULL AND scan_completed_at IS NOT NULL AND parsed_at IS NOT NULL))
);
CREATE TABLE artifact_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), submission_id uuid NOT NULL, artifact_id uuid NOT NULL,
  actor_id uuid NOT NULL, token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expected_byte_size integer NOT NULL CHECK (expected_byte_size BETWEEN 1 AND 5242880), expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, consumed_at timestamptz, expired_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id), UNIQUE (token_digest), UNIQUE (artifact_id),
  FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id),
  FOREIGN KEY (artifact_id, organization_id) REFERENCES artifacts(id, organization_id),
  FOREIGN KEY (actor_id, organization_id) REFERENCES internal_users(id, organization_id)
);
CREATE TABLE artifact_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), artifact_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('uploaded','scan_started','scan_clean','scan_rejected','scan_blocked','parse_blocked','parse_failed','promoted','deleted')),
  reason_code text, attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 20), scanner_version text, parser_version text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (artifact_id, organization_id) REFERENCES artifacts(id, organization_id)
);
CREATE TABLE artifact_fragments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), submission_id uuid NOT NULL, artifact_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0), locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object'), content_type text NOT NULL CHECK (content_type IN ('code','markdown','text','pdf_text','csv_sample')),
  content text NOT NULL CHECK (char_length(content) <= 50000), content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'), parser_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, ordinal), FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id),
  FOREIGN KEY (artifact_id, organization_id) REFERENCES artifacts(id, organization_id)
);
ALTER TABLE outbox_events ADD COLUMN dedupe_key text;
ALTER TABLE outbox_events ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10);
ALTER TABLE outbox_events ADD COLUMN locked_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN locked_by text;
ALTER TABLE outbox_events ADD COLUMN last_error_code text;
ALTER TABLE outbox_events ADD COLUMN dead_lettered_at timestamptz;
CREATE UNIQUE INDEX outbox_artifact_dedupe ON outbox_events (organization_id, topic, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX artifact_submission_scope_idx ON artifacts (organization_id, submission_id, status);
CREATE INDEX submission_learner_scope_idx ON submissions (organization_id, learner_id, course_id);
CREATE INDEX artifact_intent_expiry_idx ON artifact_upload_intents (organization_id, expires_at) WHERE consumed_at IS NULL;
CREATE INDEX outbox_lease_idx ON outbox_events (available_at) WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- Bind every child to the same organization, submission, assessment and course.
ALTER TABLE assessment_versions ADD CONSTRAINT assessment_versions_id_org_assessment_course_key UNIQUE (id, organization_id, assessment_id, course_id);
ALTER TABLE submissions ADD CONSTRAINT submissions_version_course_scope_fkey FOREIGN KEY (assessment_version_id, organization_id, assessment_id, course_id) REFERENCES assessment_versions(id, organization_id, assessment_id, course_id);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_id_org_submission_key UNIQUE (id, organization_id, submission_id);
ALTER TABLE artifact_upload_intents ADD CONSTRAINT artifact_intents_artifact_submission_scope_fkey FOREIGN KEY (artifact_id, organization_id, submission_id) REFERENCES artifacts(id, organization_id, submission_id);
ALTER TABLE artifact_fragments ADD CONSTRAINT artifact_fragments_artifact_submission_scope_fkey FOREIGN KEY (artifact_id, organization_id, submission_id) REFERENCES artifacts(id, organization_id, submission_id);

CREATE OR REPLACE FUNCTION deny_artifact_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.submission_id IS DISTINCT FROM NEW.submission_id OR OLD.quarantine_key IS DISTINCT FROM NEW.quarantine_key OR OLD.declared_extension IS DISTINCT FROM NEW.declared_extension OR OLD.declared_content_type IS DISTINCT FROM NEW.declared_content_type OR OLD.byte_size IS DISTINCT FROM NEW.byte_size OR OLD.sha256 IS DISTINCT FROM NEW.sha256 THEN
   RAISE EXCEPTION 'artifact identity is immutable' USING ERRCODE='55000';
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER artifacts_identity_immutable BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION deny_artifact_identity_mutation();
CREATE OR REPLACE FUNCTION deny_artifact_fragment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'artifact fragments are immutable' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER artifact_fragments_immutable BEFORE UPDATE OR DELETE ON artifact_fragments FOR EACH ROW EXECUTE FUNCTION deny_artifact_fragment_mutation();
-- Fragments are derived evidence, never a pre-clean work product.  A privileged
-- parser completion transaction must transition the artifact to ready before it
-- can insert its immutable fragments.
CREATE OR REPLACE FUNCTION require_ready_artifact_for_fragment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM artifacts a
    WHERE a.id = NEW.artifact_id
      AND a.organization_id = NEW.organization_id
      AND a.submission_id = NEW.submission_id
      AND a.status = 'ready'
  ) THEN
    RAISE EXCEPTION 'artifact fragments require a ready artifact' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER artifact_fragments_require_ready BEFORE INSERT ON artifact_fragments
  FOR EACH ROW EXECUTE FUNCTION require_ready_artifact_for_fragment();
CREATE OR REPLACE FUNCTION deny_artifact_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'artifact events are append-only' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER artifact_events_immutable BEFORE UPDATE OR DELETE ON artifact_events FOR EACH ROW EXECUTE FUNCTION deny_artifact_event_mutation();

-- Lifecycle columns and derived evidence are not writable by ordinary tenant-scoped
-- API transactions.  The only permitted writers are the fixed SECURITY DEFINER
-- functions owned by the migration/table owner.  Do not replace this with a
-- caller-set GUC: application roles can set custom GUCs themselves.
CREATE OR REPLACE FUNCTION artifact_lifecycle_definer() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.artifacts'::regclass)
$$;
CREATE OR REPLACE FUNCTION enforce_submission_lifecycle_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT artifact_lifecycle_definer() THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'submission lifecycle is managed by fixed functions' USING ERRCODE='55000';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.state <> 'uploading' THEN
      RAISE EXCEPTION 'submission lifecycle is managed by fixed functions' USING ERRCODE='55000';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.course_id IS DISTINCT FROM NEW.course_id
      OR OLD.assessment_id IS DISTINCT FROM NEW.assessment_id OR OLD.assessment_version_id IS DISTINCT FROM NEW.assessment_version_id
      OR OLD.learner_id IS DISTINCT FROM NEW.learner_id OR OLD.state IS DISTINCT FROM NEW.state
    ) THEN
      RAISE EXCEPTION 'submission lifecycle is managed by fixed functions' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER submissions_lifecycle_boundary BEFORE INSERT OR UPDATE OR DELETE ON submissions FOR EACH ROW EXECUTE FUNCTION enforce_submission_lifecycle_boundary();
CREATE OR REPLACE FUNCTION enforce_artifact_lifecycle_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT artifact_lifecycle_definer() THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'artifact lifecycle is managed by fixed functions' USING ERRCODE='55000';
    END IF;
    IF TG_OP = 'INSERT' AND (NEW.status <> 'intent_issued' OR NEW.failure_code IS NOT NULL OR NEW.clean_key IS NOT NULL OR NEW.derived_key IS NOT NULL OR NEW.scanner_version IS NOT NULL OR NEW.parser_version IS NOT NULL OR NEW.scan_completed_at IS NOT NULL OR NEW.parsed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'artifact lifecycle is managed by fixed functions' USING ERRCODE='55000';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      OLD.status IS DISTINCT FROM NEW.status OR OLD.failure_code IS DISTINCT FROM NEW.failure_code
      OR OLD.clean_key IS DISTINCT FROM NEW.clean_key OR OLD.derived_key IS DISTINCT FROM NEW.derived_key
      OR OLD.scanner_version IS DISTINCT FROM NEW.scanner_version OR OLD.parser_version IS DISTINCT FROM NEW.parser_version
      OR OLD.scan_completed_at IS DISTINCT FROM NEW.scan_completed_at OR OLD.parsed_at IS DISTINCT FROM NEW.parsed_at
    ) THEN
      RAISE EXCEPTION 'artifact lifecycle is managed by fixed functions' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER artifacts_lifecycle_boundary BEFORE INSERT OR UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION enforce_artifact_lifecycle_boundary();
CREATE OR REPLACE FUNCTION enforce_artifact_intent_lifecycle_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT artifact_lifecycle_definer() THEN
    IF TG_OP = 'INSERT' AND (NEW.consumed_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.reconcile_locked_at IS NOT NULL OR NEW.reconcile_locked_by IS NOT NULL) THEN
      RAISE EXCEPTION 'artifact upload intents are lifecycle-managed' USING ERRCODE='55000';
    END IF;
    IF TG_OP IN ('UPDATE','DELETE') THEN
      RAISE EXCEPTION 'artifact upload intents are lifecycle-managed' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER artifact_intents_lifecycle_boundary BEFORE INSERT OR UPDATE OR DELETE ON artifact_upload_intents FOR EACH ROW EXECUTE FUNCTION enforce_artifact_intent_lifecycle_boundary();
CREATE OR REPLACE FUNCTION enforce_artifact_event_lifecycle_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT artifact_lifecycle_definer() THEN
    RAISE EXCEPTION 'artifact events are lifecycle-managed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER artifact_events_lifecycle_boundary BEFORE INSERT ON artifact_events FOR EACH ROW EXECUTE FUNCTION enforce_artifact_event_lifecycle_boundary();
CREATE OR REPLACE FUNCTION enforce_artifact_fragment_lifecycle_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT artifact_lifecycle_definer() THEN
    RAISE EXCEPTION 'artifact fragments are lifecycle-managed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER artifact_fragments_lifecycle_boundary BEFORE INSERT ON artifact_fragments FOR EACH ROW EXECUTE FUNCTION enforce_artifact_fragment_lifecycle_boundary();

-- The worker cannot enumerate tenant rows. This fixed, topic-restricted function is its only cross-tenant claim path.
CREATE OR REPLACE FUNCTION claim_artifact_outbox(worker_name text, lease_seconds integer DEFAULT 60)
RETURNS TABLE(id uuid, organization_id uuid, aggregate_id uuid, attempt_count integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF worker_name !~ '^[A-Za-z0-9_-]{1,96}$' OR lease_seconds NOT BETWEEN 5 AND 300 THEN RAISE EXCEPTION 'invalid lease input' USING ERRCODE='22023'; END IF;
 RETURN QUERY WITH candidate AS (
   SELECT e.id FROM public.outbox_events e WHERE e.topic='artifact.normalize' AND e.processed_at IS NULL AND e.dead_lettered_at IS NULL AND e.available_at<=now() AND (e.locked_at IS NULL OR e.locked_at < now() - make_interval(secs => lease_seconds)) ORDER BY e.available_at FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE public.outbox_events e SET locked_at=now(), locked_by=worker_name, attempt_count=e.attempt_count+1 FROM candidate c WHERE e.id=c.id RETURNING e.id,e.organization_id,e.aggregate_id,e.attempt_count;
END; $$;
CREATE OR REPLACE FUNCTION finish_artifact_outbox(event_id uuid, worker_name text, success boolean, safe_error_code text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF worker_name !~ '^[A-Za-z0-9_-]{1,96}$' OR (safe_error_code IS NOT NULL AND safe_error_code !~ '^[a-z0-9_]{1,64}$') THEN RAISE EXCEPTION 'invalid finish input' USING ERRCODE='22023'; END IF;
 UPDATE public.outbox_events SET processed_at=CASE WHEN success THEN now() ELSE processed_at END, locked_at=NULL, locked_by=NULL, last_error_code=safe_error_code, dead_lettered_at=CASE WHEN NOT success AND attempt_count>=5 THEN now() ELSE dead_lettered_at END, available_at=CASE WHEN NOT success AND attempt_count<5 THEN now()+make_interval(secs => least(3600, 30 * (2 ^ attempt_count)::int)) ELSE available_at END WHERE id=event_id AND topic='artifact.normalize' AND locked_by=worker_name;
END; $$;

-- Worker reads and changes an artifact only through claim-bound fixed SQL. It has no table grants.
CREATE OR REPLACE FUNCTION load_claimed_artifact(event_id uuid, worker_name text)
RETURNS TABLE(artifact_id uuid, quarantine_key text, declared_extension text, declared_content_type text, byte_size integer, digest text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF worker_name !~ '^[A-Za-z0-9_-]{1,96}$' THEN RAISE EXCEPTION 'invalid worker input' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH claimed AS (SELECT aggregate_id FROM public.outbox_events WHERE id=event_id AND topic='artifact.normalize' AND locked_by=worker_name AND processed_at IS NULL)
 SELECT a.id,a.quarantine_key,a.declared_extension,a.declared_content_type,a.byte_size,a.sha256,a.status FROM public.artifacts a JOIN claimed c ON c.aggregate_id=a.id;
 UPDATE public.artifacts a SET status='scanning',updated_at=now() FROM public.outbox_events e WHERE e.id=event_id AND e.aggregate_id=a.id AND e.locked_by=worker_name AND a.status='uploaded';
END; $$;
CREATE OR REPLACE FUNCTION terminal_claimed_artifact(event_id uuid, worker_name text, terminal_status text, safe_reason text, artifact_event text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id uuid; artifact uuid; submission uuid;
BEGIN
 IF worker_name !~ '^[A-Za-z0-9_-]{1,96}$' OR terminal_status NOT IN ('rejected','blocked','failed') OR safe_reason !~ '^[a-z0-9_]{1,64}$' OR artifact_event NOT IN ('scan_rejected','scan_blocked','parse_blocked','parse_failed') THEN RAISE EXCEPTION 'invalid worker input' USING ERRCODE='22023'; END IF;
 SELECT organization_id,aggregate_id INTO org_id,artifact FROM public.outbox_events WHERE id=event_id AND topic='artifact.normalize' AND locked_by=worker_name AND processed_at IS NULL;
 IF artifact IS NULL THEN RAISE EXCEPTION 'claim not held' USING ERRCODE='55000'; END IF;
 UPDATE public.artifacts SET status=terminal_status,failure_code=safe_reason,updated_at=now(),scan_completed_at=CASE WHEN artifact_event IN ('scan_rejected','scan_blocked') THEN now() ELSE scan_completed_at END WHERE id=artifact AND organization_id=org_id AND status IN ('uploaded','scanning','parsing') RETURNING submission_id INTO submission;
 IF submission IS NULL THEN RAISE EXCEPTION 'artifact is not terminal-mutable' USING ERRCODE='55000'; END IF;
 UPDATE public.submissions SET state=CASE WHEN terminal_status='rejected' THEN 'rejected' ELSE 'needs_human_follow_up' END,updated_at=now() WHERE id=submission AND organization_id=org_id;
 INSERT INTO public.artifact_events (organization_id,artifact_id,event_type,reason_code) VALUES (org_id,artifact,artifact_event,safe_reason);
 INSERT INTO public.audit_events (organization_id,actor_id,correlation_id,action,target_type,target_id,metadata) VALUES (org_id,NULL,gen_random_uuid(),'artifact.worker_terminal','artifact',artifact,jsonb_build_object('source','worker','outcome','failed'));
END; $$;

-- B04 resource rows require both the tenant and a trusted transaction-local actor.
-- Worker access remains exclusively inside the fixed SECURITY DEFINER functions above.
CREATE OR REPLACE FUNCTION current_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
$$;

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY; ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY submissions_scope ON submissions
  USING (
    organization_id=current_organization_id()
    AND (learner_id=current_actor_id() OR EXISTS (
      SELECT 1 FROM course_memberships m
      WHERE m.organization_id=submissions.organization_id AND m.course_id=submissions.course_id
        AND m.user_id=current_actor_id() AND m.role IN ('instructor','teaching_assistant','course_admin')
    ))
  )
  WITH CHECK (
    organization_id=current_organization_id() AND learner_id=current_actor_id()
    AND EXISTS (
      SELECT 1 FROM course_memberships m
      WHERE m.organization_id=submissions.organization_id AND m.course_id=submissions.course_id
        AND m.user_id=current_actor_id() AND m.role='learner'
    )
  );
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY; ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY artifacts_scope ON artifacts
  USING (organization_id=current_organization_id() AND EXISTS (
    SELECT 1 FROM submissions s WHERE s.id=artifacts.submission_id AND s.organization_id=artifacts.organization_id
  ))
  WITH CHECK (organization_id=current_organization_id() AND EXISTS (
    SELECT 1 FROM submissions s WHERE s.id=artifacts.submission_id AND s.organization_id=artifacts.organization_id
  ));
ALTER TABLE artifact_upload_intents ENABLE ROW LEVEL SECURITY; ALTER TABLE artifact_upload_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_intents_scope ON artifact_upload_intents
  USING (organization_id=current_organization_id() AND actor_id=current_actor_id() AND EXISTS (
    SELECT 1 FROM artifacts a WHERE a.id=artifact_upload_intents.artifact_id AND a.organization_id=artifact_upload_intents.organization_id
  ))
  WITH CHECK (organization_id=current_organization_id() AND actor_id=current_actor_id() AND EXISTS (
    SELECT 1 FROM artifacts a WHERE a.id=artifact_upload_intents.artifact_id AND a.organization_id=artifact_upload_intents.organization_id
  ));
ALTER TABLE artifact_events ENABLE ROW LEVEL SECURITY; ALTER TABLE artifact_events FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_events_scope ON artifact_events
  USING (organization_id=current_organization_id() AND EXISTS (
    SELECT 1 FROM artifacts a WHERE a.id=artifact_events.artifact_id AND a.organization_id=artifact_events.organization_id
  ))
  WITH CHECK (organization_id=current_organization_id() AND EXISTS (
    SELECT 1 FROM artifacts a WHERE a.id=artifact_events.artifact_id AND a.organization_id=artifact_events.organization_id
  ));
ALTER TABLE artifact_fragments ENABLE ROW LEVEL SECURITY; ALTER TABLE artifact_fragments FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_fragments_scope ON artifact_fragments
  USING (organization_id=current_organization_id() AND EXISTS (
    SELECT 1 FROM artifacts a WHERE a.id=artifact_fragments.artifact_id AND a.organization_id=artifact_fragments.organization_id
  ))
  WITH CHECK (organization_id=current_organization_id() AND EXISTS (
    SELECT 1 FROM artifacts a WHERE a.id=artifact_fragments.artifact_id AND a.organization_id=artifact_fragments.organization_id
  ));
-- API upload finalization is also fixed SQL. The API role may create an intent
-- row, but it cannot consume the one-use intent, transition lifecycle state, or
-- emit derived events except through this function after the object is already
-- durably written to quarantine.
CREATE OR REPLACE FUNCTION complete_artifact_upload(
  held_organization_id uuid, held_actor_id uuid, held_correlation_id uuid,
  held_intent_id uuid, provided_token_digest text, idem_operation text, idem_key text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target_artifact uuid; target_submission uuid; target_course uuid;
BEGIN
  IF provided_token_digest !~ '^[a-f0-9]{64}$' OR idem_operation <> ('artifact.upload:' || held_intent_id::text) OR idem_key !~ '^[A-Za-z0-9_-]{16,255}$' THEN
    RAISE EXCEPTION 'invalid upload completion input' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.organization_id=held_organization_id AND k.operation=idem_operation AND k.key=idem_key
  ) THEN
    RAISE EXCEPTION 'upload completion requires a reserved idempotency key' USING ERRCODE='55000';
  END IF;
  SELECT i.artifact_id, i.submission_id, s.course_id INTO target_artifact, target_submission, target_course
  FROM public.artifact_upload_intents i
  JOIN public.submissions s ON s.id=i.submission_id AND s.organization_id=i.organization_id
  WHERE i.organization_id=held_organization_id AND i.id=held_intent_id AND i.actor_id=held_actor_id
    AND i.token_digest=provided_token_digest AND i.consumed_at IS NULL AND i.expires_at>now()
    AND s.learner_id=held_actor_id
  FOR UPDATE OF i, s;
  IF target_artifact IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.course_memberships m
    WHERE m.organization_id=held_organization_id AND m.course_id=target_course AND m.user_id=held_actor_id AND m.role='learner'
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE public.artifact_upload_intents SET consumed_at=now() WHERE id=held_intent_id AND organization_id=held_organization_id;
  UPDATE public.artifacts SET status='uploaded',updated_at=now()
    WHERE id=target_artifact AND organization_id=held_organization_id AND submission_id=target_submission AND status='intent_issued'
    RETURNING id INTO target_artifact;
  IF target_artifact IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.artifact_events (organization_id,artifact_id,event_type) VALUES (held_organization_id,target_artifact,'uploaded');
  INSERT INTO public.audit_events (organization_id,actor_id,correlation_id,action,target_type,target_id,metadata)
    VALUES (held_organization_id,held_actor_id,held_correlation_id,'artifact.uploaded','artifact',target_artifact,jsonb_build_object('source','learner','outcome','queued'));
  INSERT INTO public.outbox_events (organization_id,aggregate_type,aggregate_id,topic,payload,dedupe_key)
    VALUES (held_organization_id,'artifact',target_artifact,'artifact.normalize',jsonb_build_object('artifact_id',target_artifact),'artifact.normalize:' || target_artifact::text)
    ON CONFLICT (organization_id,topic,dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  INSERT INTO public.idempotency_results (organization_id,operation,key,target_type,target_id) VALUES (held_organization_id,idem_operation,idem_key,'artifact',target_artifact);
  RETURN target_artifact;
END; $$;

REVOKE ALL ON FUNCTION claim_artifact_outbox(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_artifact_outbox(uuid, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION load_claimed_artifact(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_claimed_artifact(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_artifact_upload(uuid, uuid, uuid, uuid, text, text, text) FROM PUBLIC;

-- Expired one-use intents are reconciled only by the restricted worker.  The
-- lease makes a lost browser completion recoverable without allowing a worker
-- to enumerate artifacts or attach arbitrary object keys.
ALTER TABLE artifact_upload_intents
  ADD COLUMN reconcile_locked_at timestamptz,
  ADD COLUMN reconcile_locked_by text;
CREATE INDEX artifact_intent_reconcile_idx ON artifact_upload_intents (expires_at)
  WHERE consumed_at IS NULL AND expired_at IS NULL;

CREATE OR REPLACE FUNCTION claim_stale_artifact_upload_intents(worker_name text, lease_seconds integer DEFAULT 60)
RETURNS TABLE(intent_id uuid, artifact_id uuid, quarantine_key text, expected_byte_size integer, expected_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF worker_name !~ '^[A-Za-z0-9_-]{1,96}$' OR lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid reconcile lease input' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT i.id
    FROM public.artifact_upload_intents i
    WHERE i.consumed_at IS NULL AND i.expired_at IS NULL AND i.expires_at <= now()
      AND (i.reconcile_locked_at IS NULL OR i.reconcile_locked_at < now() - make_interval(secs => lease_seconds))
    ORDER BY i.expires_at
    FOR UPDATE SKIP LOCKED
    LIMIT 5
  )
  UPDATE public.artifact_upload_intents i
    SET reconcile_locked_at=now(), reconcile_locked_by=worker_name
    FROM candidate c
    WHERE i.id=c.id
  RETURNING i.id, i.artifact_id,
    (SELECT a.quarantine_key FROM public.artifacts a WHERE a.id=i.artifact_id AND a.organization_id=i.organization_id),
    i.expected_byte_size, i.expected_sha256;
END; $$;

CREATE OR REPLACE FUNCTION finish_stale_artifact_upload_intent(
  held_intent_id uuid, worker_name text, object_present boolean, observed_byte_size integer DEFAULT NULL, observed_sha256 text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE intent public.artifact_upload_intents%ROWTYPE; object_matches boolean; event_id uuid;
BEGIN
  IF worker_name !~ '^[A-Za-z0-9_-]{1,96}$'
    OR (observed_byte_size IS NOT NULL AND observed_byte_size NOT BETWEEN 0 AND 5242880)
    OR (observed_sha256 IS NOT NULL AND observed_sha256 !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'invalid reconcile completion input' USING ERRCODE='22023';
  END IF;
  SELECT * INTO intent FROM public.artifact_upload_intents
    WHERE id=held_intent_id AND consumed_at IS NULL AND expired_at IS NULL AND reconcile_locked_by=worker_name
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconcile lease not held' USING ERRCODE='55000'; END IF;
  object_matches := object_present AND observed_byte_size=intent.expected_byte_size AND observed_sha256=intent.expected_sha256;
  IF object_matches THEN
    UPDATE public.artifact_upload_intents SET consumed_at=now(), reconcile_locked_at=NULL, reconcile_locked_by=NULL WHERE id=intent.id;
    UPDATE public.artifacts SET status='uploaded',updated_at=now() WHERE id=intent.artifact_id AND organization_id=intent.organization_id AND status='intent_issued';
    INSERT INTO public.artifact_events (organization_id,artifact_id,event_type) VALUES (intent.organization_id,intent.artifact_id,'uploaded');
    INSERT INTO public.outbox_events (organization_id,aggregate_type,aggregate_id,topic,payload,dedupe_key)
      VALUES (intent.organization_id,'artifact',intent.artifact_id,'artifact.normalize',jsonb_build_object('artifact_id',intent.artifact_id),'artifact.normalize:' || intent.artifact_id::text)
      ON CONFLICT (organization_id,topic,dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    INSERT INTO public.audit_events (organization_id,actor_id,correlation_id,action,target_type,target_id,metadata)
      VALUES (intent.organization_id,NULL,gen_random_uuid(),'artifact.upload_reconciled','artifact',intent.artifact_id,jsonb_build_object('source','worker','outcome','queued'));
  ELSE
    UPDATE public.artifact_upload_intents SET expired_at=now(),reconcile_locked_at=NULL,reconcile_locked_by=NULL WHERE id=intent.id;
    UPDATE public.artifacts SET status='rejected',failure_code='upload_mismatch',updated_at=now() WHERE id=intent.artifact_id AND organization_id=intent.organization_id AND status='intent_issued';
    INSERT INTO public.artifact_events (organization_id,artifact_id,event_type,reason_code) VALUES (intent.organization_id,intent.artifact_id,'scan_rejected','upload_mismatch');
    INSERT INTO public.audit_events (organization_id,actor_id,correlation_id,action,target_type,target_id,metadata)
      VALUES (intent.organization_id,NULL,gen_random_uuid(),'artifact.upload_expired','artifact',intent.artifact_id,jsonb_build_object('source','worker','outcome','rejected'));
  END IF;
END; $$;

REVOKE ALL ON FUNCTION claim_stale_artifact_upload_intents(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_stale_artifact_upload_intent(uuid, text, boolean, integer, text) FROM PUBLIC;
