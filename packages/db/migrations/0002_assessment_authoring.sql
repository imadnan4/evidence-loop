-- Durable B02 assessment authoring. Forward-only; never edit 0001.
CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  course_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','archived')),
  current_published_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id, course_id),
  FOREIGN KEY (course_id, organization_id) REFERENCES courses(id, organization_id)
);

CREATE TABLE assessment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  course_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number >= 1),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  assignment_instructions text NOT NULL CHECK (char_length(assignment_instructions) BETWEEN 1 AND 50000),
  learner_facing_text text NOT NULL CHECK (char_length(learner_facing_text) BETWEEN 1 AND 20000),
  ai_use_policy text NOT NULL CHECK (ai_use_policy IN ('allowed','allowed_with_disclosure','not_allowed')),
  privacy_summary text NOT NULL CHECK (char_length(privacy_summary) BETWEEN 1 AND 10000),
  completion_criteria text NOT NULL CHECK (char_length(completion_criteria) BETWEEN 1 AND 10000),
  text_check_in boolean NOT NULL CHECK (text_check_in),
  voice_check_in boolean NOT NULL,
  extra_time boolean NOT NULL,
  pause_and_resume boolean NOT NULL,
  alternative_assessment_request boolean NOT NULL,
  question_budget integer NOT NULL CHECK (question_budget BETWEEN 3 AND 5),
  time_budget_minutes integer NOT NULL CHECK (time_budget_minutes BETWEEN 3 AND 8),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  published_at timestamptz,
  UNIQUE (assessment_id, version_number),
  UNIQUE (id, organization_id, assessment_id),
  FOREIGN KEY (assessment_id, organization_id, course_id) REFERENCES assessments(id, organization_id, course_id),
  FOREIGN KEY (created_by, organization_id) REFERENCES internal_users(id, organization_id),
  FOREIGN KEY (published_by, organization_id) REFERENCES internal_users(id, organization_id),
  CHECK ((state = 'draft' AND published_by IS NULL AND published_at IS NULL) OR (state = 'published' AND published_by IS NOT NULL AND published_at IS NOT NULL))
);
ALTER TABLE assessments ADD CONSTRAINT assessments_current_published_version_fkey
  FOREIGN KEY (current_published_version_id, organization_id, id) REFERENCES assessment_versions(id, organization_id, assessment_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE assessment_objectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  assessment_id uuid NOT NULL,
  assessment_version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 10),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 255),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 10000),
  evidence_criteria text NOT NULL CHECK (char_length(evidence_criteria) BETWEEN 1 AND 10000),
  assessable_in_check_in boolean NOT NULL,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_version_id, position),
  UNIQUE (id, organization_id, assessment_version_id),
  FOREIGN KEY (assessment_version_id, organization_id, assessment_id) REFERENCES assessment_versions(id, organization_id, assessment_id),
  FOREIGN KEY (approved_by, organization_id) REFERENCES internal_users(id, organization_id)
);
CREATE TABLE rubric_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  assessment_id uuid NOT NULL,
  assessment_version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 12),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 255),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 10000),
  evidence_criteria text NOT NULL CHECK (char_length(evidence_criteria) BETWEEN 1 AND 10000),
  UNIQUE (assessment_version_id, position),
  UNIQUE (id, organization_id, assessment_version_id),
  FOREIGN KEY (assessment_version_id, organization_id, assessment_id) REFERENCES assessment_versions(id, organization_id, assessment_id)
);
CREATE TABLE rubric_criterion_objectives (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  assessment_version_id uuid NOT NULL,
  criterion_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  PRIMARY KEY (criterion_id, objective_id),
  FOREIGN KEY (criterion_id, organization_id, assessment_version_id) REFERENCES rubric_criteria(id, organization_id, assessment_version_id),
  FOREIGN KEY (objective_id, organization_id, assessment_version_id) REFERENCES assessment_objectives(id, organization_id, assessment_version_id)
);
CREATE TABLE idempotency_results (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  operation text NOT NULL,
  key text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('assessment','assessment_version')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, operation, key),
  FOREIGN KEY (organization_id, operation, key) REFERENCES idempotency_keys(organization_id, operation, key)
);

CREATE OR REPLACE FUNCTION assessment_version_is_mutable(version_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT state = 'draft' FROM assessment_versions WHERE id = version_id), false)
$$;
CREATE OR REPLACE FUNCTION deny_published_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_version_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'assessment_versions' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.state = 'published' THEN
      RAISE EXCEPTION 'published assessment versions are immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- A child may never be reparented between versions. Checking only NEW would
  -- let a published snapshot be moved into a mutable version before edits.
  IF TG_OP = 'UPDATE' AND OLD.assessment_version_id IS DISTINCT FROM NEW.assessment_version_id THEN
    RAISE EXCEPTION 'assessment version parent is immutable' USING ERRCODE = '55000';
  END IF;

  -- OLD is unassigned on INSERT and NEW is unassigned on DELETE, so select the
  -- existing parent by operation. This blocks edits/deletes of published
  -- snapshots while still allowing inserts into a draft version.
  IF TG_OP = 'INSERT' THEN
    checked_version_id := NEW.assessment_version_id;
  ELSE
    checked_version_id := OLD.assessment_version_id;
  END IF;
  IF NOT assessment_version_is_mutable(checked_version_id) THEN
    RAISE EXCEPTION 'published assessment version children are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER assessment_versions_immutable BEFORE UPDATE OR DELETE ON assessment_versions FOR EACH ROW EXECUTE FUNCTION deny_published_version_mutation();
CREATE TRIGGER assessment_objectives_immutable BEFORE INSERT OR UPDATE OR DELETE ON assessment_objectives FOR EACH ROW EXECUTE FUNCTION deny_published_version_mutation();
CREATE TRIGGER rubric_criteria_immutable BEFORE INSERT OR UPDATE OR DELETE ON rubric_criteria FOR EACH ROW EXECUTE FUNCTION deny_published_version_mutation();
CREATE TRIGGER rubric_criterion_objectives_immutable BEFORE INSERT OR UPDATE OR DELETE ON rubric_criterion_objectives FOR EACH ROW EXECUTE FUNCTION deny_published_version_mutation();

ALTER TABLE assessments ENABLE ROW LEVEL SECURITY; ALTER TABLE assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_scope ON assessments USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id());
ALTER TABLE assessment_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE assessment_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_version_scope ON assessment_versions USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id());
ALTER TABLE assessment_objectives ENABLE ROW LEVEL SECURITY; ALTER TABLE assessment_objectives FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_objective_scope ON assessment_objectives USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id());
ALTER TABLE rubric_criteria ENABLE ROW LEVEL SECURITY; ALTER TABLE rubric_criteria FORCE ROW LEVEL SECURITY;
CREATE POLICY rubric_criterion_scope ON rubric_criteria USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id());
ALTER TABLE rubric_criterion_objectives ENABLE ROW LEVEL SECURITY; ALTER TABLE rubric_criterion_objectives FORCE ROW LEVEL SECURITY;
CREATE POLICY rubric_mapping_scope ON rubric_criterion_objectives USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id());
ALTER TABLE idempotency_results ENABLE ROW LEVEL SECURITY; ALTER TABLE idempotency_results FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_result_scope ON idempotency_results USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id());
