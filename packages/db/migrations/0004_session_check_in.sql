-- C02 forward-only durable session / check-in state machine.
-- Never edit 0001/0002/0003.
ALTER TABLE idempotency_results DROP CONSTRAINT idempotency_results_target_type_check;
ALTER TABLE idempotency_results ADD CONSTRAINT idempotency_results_target_type_check CHECK (target_type IN ('assessment','assessment_version','submission','artifact','artifact_upload_intent','check_in_session'));

-- The check_in_sessions foreign key references (id, organization_id) on the
-- published version; ensure that prefix is unique so the reference is valid.
ALTER TABLE assessment_versions ADD CONSTRAINT assessment_versions_id_org_key UNIQUE (id, organization_id);

CREATE TABLE check_in_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  submission_id uuid NOT NULL,
  assessment_version_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','in_progress','paused','completed','human_follow_up')),
  mode text NOT NULL DEFAULT 'text' CHECK (mode IN ('text','voice')),
  question_budget integer NOT NULL CHECK (question_budget BETWEEN 3 AND 5),
  questions_asked integer NOT NULL DEFAULT 0 CHECK (questions_asked BETWEEN 0 AND 5),
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id),
  FOREIGN KEY (assessment_version_id, organization_id) REFERENCES assessment_versions(id, organization_id),
  FOREIGN KEY (learner_id, organization_id) REFERENCES internal_users(id, organization_id),
  CHECK ((state = 'ready') = (started_at IS NULL)),
  CHECK (state <> 'paused' OR paused_at IS NOT NULL),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  CHECK (questions_asked <= question_budget)
);

-- Immutable, server-resolved snapshot of policy/objectives/provenance. It is
-- written once at session creation and never mutated. A learner-facing policy is
-- acknowledged against this frozen copy, not any later version.
CREATE TABLE check_in_session_contexts (
  session_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  submission_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  policy_learner_facing_text text NOT NULL CHECK (char_length(policy_learner_facing_text) BETWEEN 1 AND 20000),
  policy_ai_use text NOT NULL CHECK (policy_ai_use IN ('allowed','allowed_with_disclosure','not_allowed')),
  policy_privacy_summary text NOT NULL CHECK (char_length(policy_privacy_summary) BETWEEN 1 AND 10000),
  policy_completion_criteria text NOT NULL CHECK (char_length(policy_completion_criteria) BETWEEN 1 AND 10000),
  pause_and_resume boolean NOT NULL,
  time_budget_minutes integer NOT NULL CHECK (time_budget_minutes BETWEEN 3 AND 8),
  voice_check_in_enabled boolean NOT NULL,
  objectives jsonb NOT NULL CHECK (jsonb_typeof(objectives) = 'array' AND jsonb_array_length(objectives) BETWEEN 3 AND 5),
  objective_sources jsonb NOT NULL CHECK (jsonb_typeof(objective_sources) = 'array'),
  policy_shown_at timestamptz,
  policy_acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, organization_id),
  FOREIGN KEY (session_id, organization_id) REFERENCES check_in_sessions(id, organization_id),
  FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id),
  FOREIGN KEY (learner_id, organization_id) REFERENCES internal_users(id, organization_id),
  CHECK (policy_acknowledged_at IS NULL OR policy_shown_at IS NOT NULL),
  CHECK (policy_acknowledged_at IS NULL OR policy_acknowledged_at >= policy_shown_at)
);

CREATE TABLE check_in_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 5),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 10000),
  kind text NOT NULL CHECK (kind IN ('explain','apply','revise','compare')),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 10000),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array' AND jsonb_array_length(source_refs) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (session_id, sequence),
  FOREIGN KEY (session_id, organization_id) REFERENCES check_in_sessions(id, organization_id),
  FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id)
);

CREATE TABLE check_in_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  question_id uuid NOT NULL,
  session_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  modality text NOT NULL CHECK (modality IN ('text','voice')),
  canonical_text text NOT NULL CHECK (char_length(canonical_text) BETWEEN 1 AND 20000),
  edited_text text,
  started_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (question_id),
  FOREIGN KEY (question_id, organization_id) REFERENCES check_in_questions(id, organization_id),
  FOREIGN KEY (session_id, organization_id) REFERENCES check_in_sessions(id, organization_id),
  FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id)
);

CREATE TABLE check_in_voice_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  response_id uuid NOT NULL,
  session_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  question_id uuid NOT NULL,
  modality text NOT NULL DEFAULT 'voice' CHECK (modality = 'voice'),
  transcript text NOT NULL CHECK (char_length(transcript) BETWEEN 1 AND 20000),
  edited_transcript text,
  canonical_text text NOT NULL CHECK (char_length(canonical_text) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NOT NULL,
  UNIQUE (id, organization_id),
  UNIQUE (response_id),
  FOREIGN KEY (response_id, organization_id) REFERENCES check_in_responses(id, organization_id),
  FOREIGN KEY (session_id, organization_id) REFERENCES check_in_sessions(id, organization_id),
  FOREIGN KEY (submission_id, organization_id) REFERENCES submissions(id, organization_id),
  FOREIGN KEY (question_id, organization_id) REFERENCES check_in_questions(id, organization_id)
);

CREATE TABLE check_in_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('policy_shown','policy_acknowledged','session_started','question_issued','session_paused','session_resumed','response_submitted','session_completed','human_follow_up_requested')),
  prior_state text,
  new_state text,
  policy_version_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, organization_id) REFERENCES check_in_sessions(id, organization_id),
  FOREIGN KEY (actor_id, organization_id) REFERENCES internal_users(id, organization_id)
);

-- The request-level Idempotency-Key header covers create/show/ack/start/pause/
-- resume/submit/follow-up. This separate table covers the in-transaction
-- idempotency used by the finite state machine for replay safety on concurrent
-- retries of the same logical operation within one scope (actor + operation +
-- key). It is ledger-only: once written, the result is immutable and a changed
-- fingerprint rejects the retry instead of re-executing.
CREATE TABLE check_in_idempotency (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 512),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, scope),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX check_in_question_session_idx ON check_in_questions (organization_id, session_id, sequence);
CREATE INDEX check_in_response_session_idx ON check_in_responses (organization_id, session_id, submitted_at);
CREATE INDEX check_in_event_session_idx ON check_in_session_events (organization_id, session_id, occurred_at);

-- Sessions and their children are owned by the learner who created them.
-- Staff (instructor/TA/course_admin) may read a learner's session for review
-- but may never mutate it. The fixed SECURITY DEFINER functions below are the
-- only writers of lifecycle state; the non-owner API role cannot set state
-- transitions or force completion.
CREATE OR REPLACE FUNCTION check_in_session_owner(held_organization_id uuid, held_session_id uuid, held_actor_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM check_in_sessions s
    WHERE s.id = held_session_id AND s.organization_id = held_organization_id AND s.learner_id = held_actor_id
  )
$$;

CREATE OR REPLACE FUNCTION check_in_is_staff(held_organization_id uuid, held_course_id uuid, held_actor_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_memberships m
    WHERE m.organization_id = held_organization_id AND m.course_id = held_course_id
      AND m.user_id = held_actor_id AND m.role IN ('instructor','teaching_assistant','course_admin')
  )
$$;

-- State transitions are confined to fixed writers. A caller may insert a
-- ready session row, but the API role may not jump a session to in_progress,
-- completed, paused, human_follow_up, or alter started/paused/completed
-- timestamps except through the SECURITY DEFINER functions below.
CREATE OR REPLACE FUNCTION check_in_lifecycle_definer() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.check_in_sessions'::regclass)
$$;

CREATE OR REPLACE FUNCTION enforce_check_in_session_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT check_in_lifecycle_definer() THEN
    IF TG_OP = 'INSERT' AND (NEW.state <> 'ready' OR NEW.started_at IS NOT NULL OR NEW.paused_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.questions_asked <> 0) THEN
      RAISE EXCEPTION 'check-in sessions start in ready state through fixed functions' USING ERRCODE='55000';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.submission_id IS DISTINCT FROM NEW.submission_id
      OR OLD.assessment_version_id IS DISTINCT FROM NEW.assessment_version_id OR OLD.policy_version_id IS DISTINCT FROM NEW.policy_version_id
      OR OLD.learner_id IS DISTINCT FROM NEW.learner_id OR OLD.mode IS DISTINCT FROM NEW.mode OR OLD.question_budget IS DISTINCT FROM NEW.question_budget
    ) THEN
      RAISE EXCEPTION 'check-in session provenance is immutable' USING ERRCODE='55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'check-in sessions are retained, not deleted' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER check_in_sessions_boundary BEFORE INSERT OR UPDATE OR DELETE ON check_in_sessions FOR EACH ROW EXECUTE FUNCTION enforce_check_in_session_boundary();

CREATE OR REPLACE FUNCTION deny_check_in_context_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The session context (policy text, objectives, provenance) is immutable once
  -- written. Only the learner-visible policy timestamps may be set, and only
  -- from NULL to a value; everything else is frozen.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'check-in session context is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.submission_id IS DISTINCT FROM NEW.submission_id
    OR OLD.learner_id IS DISTINCT FROM NEW.learner_id
    OR OLD.policy_learner_facing_text IS DISTINCT FROM NEW.policy_learner_facing_text
    OR OLD.policy_ai_use IS DISTINCT FROM NEW.policy_ai_use
    OR OLD.policy_privacy_summary IS DISTINCT FROM NEW.policy_privacy_summary
    OR OLD.policy_completion_criteria IS DISTINCT FROM NEW.policy_completion_criteria
    OR OLD.pause_and_resume IS DISTINCT FROM NEW.pause_and_resume
    OR OLD.time_budget_minutes IS DISTINCT FROM NEW.time_budget_minutes
    OR OLD.voice_check_in_enabled IS DISTINCT FROM NEW.voice_check_in_enabled
    OR OLD.objectives IS DISTINCT FROM NEW.objectives
    OR OLD.objective_sources IS DISTINCT FROM NEW.objective_sources THEN
    RAISE EXCEPTION 'check-in session context is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER check_in_contexts_immutable BEFORE INSERT OR UPDATE OR DELETE ON check_in_session_contexts FOR EACH ROW EXECUTE FUNCTION deny_check_in_context_mutation();

CREATE OR REPLACE FUNCTION enforce_check_in_question_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'check-in questions are immutable once issued' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER check_in_questions_immutable BEFORE INSERT OR UPDATE OR DELETE ON check_in_questions FOR EACH ROW EXECUTE FUNCTION enforce_check_in_question_boundary();

CREATE OR REPLACE FUNCTION enforce_check_in_response_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'check-in responses are immutable once stored' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER check_in_responses_immutable BEFORE INSERT OR UPDATE OR DELETE ON check_in_responses FOR EACH ROW EXECUTE FUNCTION enforce_check_in_response_boundary();

CREATE OR REPLACE FUNCTION deny_check_in_voice_transcript_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'check-in voice transcripts are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER check_in_voice_transcripts_immutable BEFORE INSERT OR UPDATE OR DELETE ON check_in_voice_transcripts FOR EACH ROW EXECUTE FUNCTION deny_check_in_voice_transcript_mutation();

CREATE OR REPLACE FUNCTION deny_check_in_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'check-in session events are append-only' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER check_in_events_append_only BEFORE INSERT OR UPDATE OR DELETE ON check_in_session_events FOR EACH ROW EXECUTE FUNCTION deny_check_in_event_mutation();

CREATE OR REPLACE FUNCTION deny_check_in_idempotency_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (OLD.fingerprint IS DISTINCT FROM NEW.fingerprint OR OLD.result IS DISTINCT FROM NEW.result)) THEN
    RAISE EXCEPTION 'check-in idempotency results are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER check_in_idempotency_immutable BEFORE INSERT OR UPDATE OR DELETE ON check_in_idempotency FOR EACH ROW EXECUTE FUNCTION deny_check_in_idempotency_mutation();

-- Fixed, single-responsibility writers. Each performs its validated transition
-- inside the tenant-scoped transaction and is the only path the API role has to
-- advance session state. The actor is the transaction-local current_actor_id().
CREATE OR REPLACE FUNCTION check_in_create_session(
  held_organization_id uuid, held_actor_id uuid, held_correlation_id uuid,
  held_submission_id uuid, held_assessment_version_id uuid, held_policy_version_id uuid,
  held_question_budget integer, held_idempotency_scope text, held_idempotency_fingerprint text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target_session uuid;
BEGIN
  IF held_idempotency_scope !~ '^[A-Za-z0-9:_]{1,512}$' OR held_idempotency_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid session create input' USING ERRCODE='22023';
  END IF;
  INSERT INTO check_in_idempotency (organization_id, scope, fingerprint, result)
    VALUES (held_organization_id, held_idempotency_scope, held_idempotency_fingerprint, '{"created":true}'::jsonb)
    ON CONFLICT (organization_id, scope) DO NOTHING;
  SELECT result->>'session_id' INTO target_session
    FROM check_in_idempotency WHERE organization_id = held_organization_id AND scope = held_idempotency_scope;
  IF target_session IS NOT NULL THEN RETURN target_session; END IF;
  INSERT INTO check_in_sessions (organization_id, submission_id, assessment_version_id, policy_version_id, learner_id, state, mode, question_budget, questions_asked)
    VALUES (held_organization_id, held_submission_id, held_assessment_version_id, held_policy_version_id, held_actor_id, 'ready', 'text', held_question_budget, 0)
    RETURNING id INTO target_session;
  INSERT INTO check_in_idempotency (organization_id, scope, fingerprint, result)
    VALUES (held_organization_id, held_idempotency_scope, held_idempotency_fingerprint, jsonb_build_object('session_id', target_session))
    ON CONFLICT (organization_id, scope) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, result = EXCLUDED.result;
  RETURN target_session;
END; $$;

CREATE OR REPLACE FUNCTION check_in_transition(
  held_organization_id uuid, held_session_id uuid, held_actor_id uuid, held_correlation_id uuid,
  held_new_state text, held_set_started boolean, held_set_paused boolean, held_set_completed boolean,
  held_idempotency_scope text, held_idempotency_fingerprint text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prior_state text; rows_updated integer;
BEGIN
  IF held_idempotency_scope !~ '^[A-Za-z0-9:_]{1,512}$' OR held_idempotency_fingerprint !~ '^[a-f0-9]{64}$'
    OR held_new_state NOT IN ('in_progress','paused','completed','human_follow_up') THEN
    RAISE EXCEPTION 'invalid session transition input' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM check_in_idempotency WHERE organization_id = held_organization_id AND scope = held_idempotency_scope AND fingerprint <> held_idempotency_fingerprint) THEN
    RAISE EXCEPTION 'idempotency key used for a different request' USING ERRCODE='55000';
  END IF;
  SELECT state INTO prior_state FROM check_in_sessions WHERE id = held_session_id AND organization_id = held_organization_id AND learner_id = held_actor_id FOR UPDATE;
  IF prior_state IS NULL THEN RETURN false; END IF;
  IF prior_state = held_new_state THEN RETURN true; END IF;
  UPDATE check_in_sessions
    SET state = held_new_state,
        started_at = CASE WHEN held_set_started THEN now() ELSE started_at END,
        paused_at = CASE WHEN held_set_paused THEN now() WHEN held_new_state = 'in_progress' THEN NULL ELSE paused_at END,
        completed_at = CASE WHEN held_set_completed THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = held_session_id AND organization_id = held_organization_id AND learner_id = held_actor_id AND state = prior_state;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  IF rows_updated = 0 THEN RETURN false; END IF;
  INSERT INTO check_in_idempotency (organization_id, scope, fingerprint, result)
    VALUES (held_organization_id, held_idempotency_scope, held_idempotency_fingerprint, jsonb_build_object('replayed', true))
    ON CONFLICT (organization_id, scope) DO UPDATE SET fingerprint = EXCLUDED.fingerprint;
  INSERT INTO check_in_session_events (organization_id, session_id, actor_id, action, prior_state, new_state, policy_version_id, correlation_id)
    VALUES (held_organization_id, held_session_id, held_actor_id,
      CASE held_new_state WHEN 'in_progress' THEN 'session_started' WHEN 'paused' THEN 'session_paused'
        WHEN 'completed' THEN 'session_completed' WHEN 'human_follow_up' THEN 'human_follow_up_requested' END,
      prior_state, held_new_state, (SELECT policy_version_id FROM check_in_sessions WHERE id = held_session_id), held_correlation_id);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION check_in_acknowledge_policy(
  held_organization_id uuid, held_session_id uuid, held_actor_id uuid,
  held_phase text, held_idempotency_scope text, held_idempotency_fingerprint text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rows_updated integer;
BEGIN
  IF held_idempotency_scope !~ '^[A-Za-z0-9:_]{1,512}$' OR held_idempotency_fingerprint !~ '^[a-f0-9]{64}$' OR held_phase NOT IN ('shown','acknowledged') THEN
    RAISE EXCEPTION 'invalid policy acknowledgement input' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM check_in_idempotency WHERE organization_id = held_organization_id AND scope = held_idempotency_scope AND fingerprint <> held_idempotency_fingerprint) THEN
    RAISE EXCEPTION 'idempotency key used for a different request' USING ERRCODE='55000';
  END IF;
  IF held_phase = 'shown' THEN
    UPDATE check_in_session_contexts SET policy_shown_at = now()
      WHERE session_id = held_session_id AND organization_id = held_organization_id AND learner_id = held_actor_id AND policy_shown_at IS NULL;
  ELSE
    UPDATE check_in_session_contexts SET policy_acknowledged_at = now()
      WHERE session_id = held_session_id AND organization_id = held_organization_id AND learner_id = held_actor_id
        AND policy_shown_at IS NOT NULL AND policy_acknowledged_at IS NULL;
  END IF;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  INSERT INTO check_in_idempotency (organization_id, scope, fingerprint, result)
    VALUES (held_organization_id, held_idempotency_scope, held_idempotency_fingerprint, jsonb_build_object('replayed', true))
    ON CONFLICT (organization_id, scope) DO UPDATE SET fingerprint = EXCLUDED.fingerprint;
  INSERT INTO check_in_session_events (organization_id, session_id, actor_id, action, prior_state, new_state, policy_version_id, correlation_id)
    VALUES (held_organization_id, held_session_id, held_actor_id,
      CASE held_phase WHEN 'shown' THEN 'policy_shown' ELSE 'policy_acknowledged' END,
      (SELECT state FROM check_in_sessions WHERE id = held_session_id),
      (SELECT state FROM check_in_sessions WHERE id = held_session_id),
      (SELECT policy_version_id FROM check_in_sessions WHERE id = held_session_id),
      gen_random_uuid());
  RETURN rows_updated > 0;
END; $$;

REVOKE ALL ON FUNCTION check_in_create_session(uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_in_transition(uuid, uuid, uuid, uuid, text, boolean, boolean, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_in_acknowledge_policy(uuid, uuid, uuid, text, text, text) FROM PUBLIC;

ALTER TABLE check_in_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE check_in_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_sessions_scope ON check_in_sessions
  USING (
    organization_id = current_organization_id()
    AND (learner_id = current_actor_id() OR check_in_is_staff(organization_id, (SELECT s2.course_id FROM submissions s2 WHERE s2.id = check_in_sessions.submission_id AND s2.organization_id = check_in_sessions.organization_id), current_actor_id()))
  )
  WITH CHECK (
    organization_id = current_organization_id() AND learner_id = current_actor_id()
  );
ALTER TABLE check_in_session_contexts ENABLE ROW LEVEL SECURITY; ALTER TABLE check_in_session_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_contexts_scope ON check_in_session_contexts
  USING (
    organization_id = current_organization_id()
    AND (learner_id = current_actor_id() OR check_in_is_staff(organization_id, (SELECT s2.course_id FROM submissions s2 WHERE s2.id = check_in_session_contexts.submission_id AND s2.organization_id = check_in_session_contexts.organization_id), current_actor_id()))
  )
  WITH CHECK (organization_id = current_organization_id() AND learner_id = current_actor_id());
ALTER TABLE check_in_questions ENABLE ROW LEVEL SECURITY; ALTER TABLE check_in_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_questions_scope ON check_in_questions
  USING (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_questions.session_id AND s.organization_id = check_in_questions.organization_id))
  WITH CHECK (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_questions.session_id AND s.organization_id = check_in_questions.organization_id));
ALTER TABLE check_in_responses ENABLE ROW LEVEL SECURITY; ALTER TABLE check_in_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_responses_scope ON check_in_responses
  USING (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_responses.session_id AND s.organization_id = check_in_responses.organization_id))
  WITH CHECK (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_responses.session_id AND s.organization_id = check_in_responses.organization_id));
ALTER TABLE check_in_voice_transcripts ENABLE ROW LEVEL SECURITY; ALTER TABLE check_in_voice_transcripts FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_voice_transcripts_scope ON check_in_voice_transcripts
  USING (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_voice_transcripts.session_id AND s.organization_id = check_in_voice_transcripts.organization_id))
  WITH CHECK (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_voice_transcripts.session_id AND s.organization_id = check_in_voice_transcripts.organization_id));
ALTER TABLE check_in_session_events ENABLE ROW LEVEL SECURITY; ALTER TABLE check_in_session_events FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_events_scope ON check_in_session_events
  USING (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_session_events.session_id AND s.organization_id = check_in_session_events.organization_id))
  WITH CHECK (organization_id = current_organization_id() AND EXISTS (SELECT 1 FROM check_in_sessions s WHERE s.id = check_in_session_events.session_id AND s.organization_id = check_in_session_events.organization_id));
ALTER TABLE check_in_idempotency ENABLE ROW LEVEL SECURITY; ALTER TABLE check_in_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_idempotency_scope ON check_in_idempotency
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());
