-- Initial integrated schema. Do not regenerate after this migration is applied.

-- Module proposal: auth/migrations/001_auth.sql
-- M01 migration proposal. The coordinator owns execution/versioning and backups.
-- IDs are shared opaque text IDs; other modules reference auth_users(id) by agreement.
CREATE TABLE auth_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deletion_pending', 'deleted')),
  platform_roles text[] NOT NULL DEFAULT ARRAY['user']::text[]
    CHECK (cardinality(platform_roles) > 0 AND platform_roles <@ ARRAY['user', 'reviewer', 'admin']::text[]),
  email_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE auth_login_challenges (
  id text PRIMARY KEY,
  email text NOT NULL,
  email_rate_key text NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  delivery text NOT NULL CHECK (delivery IN ('pending', 'ready', 'failed')),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX auth_login_challenges_email ON auth_login_challenges (email)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX auth_login_challenges_expiry ON auth_login_challenges (expires_at);

CREATE TABLE auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expiry ON auth_sessions (expires_at);

-- HMAC-derived mailbox/client identifiers, with prefix for persistent verify-mailbox budgets.
CREATE TABLE auth_rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  last_attempt_at timestamptz
);

-- No email address, code, token/hash, headers, raw IP, or provider exception payload.
CREATE TABLE auth_audit_events (
  id text PRIMARY KEY,
  actor_id text,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  result text NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX auth_audit_events_actor ON auth_audit_events (actor_id, occurred_at DESC);

-- Rollback requires a backup and coordinated module reference check first.
-- In reverse creation order: auth_audit_events, auth_rate_limits,
-- auth_sessions, auth_login_challenges, auth_users. Never auto-drop shared identities.
-- Schedule expiry cleanup in coordinator scripts only after retention policy is agreed;
-- keep rate rows at least a whole rate window/cooldown past their last attempt.

-- Module proposal: projects/sql/001-projects.sql
-- M02 migration proposal only. The coordinator executes it with the actual migrations.
-- User/Event/Resource foreign keys are intentionally omitted until their owners' tables are agreed.
-- All IDs are opaque text. created_by records history and never grants authorization.

CREATE TABLE projects_team (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'dissolved')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE projects_team_membership (
  membership_id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES projects_team(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('captain', 'member')),
  status text NOT NULL CHECK (status IN ('active', 'left', 'removed')),
  revision integer NOT NULL CHECK (revision > 0),
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  CONSTRAINT projects_team_user_unique UNIQUE (team_id, user_id),
  CHECK ((status = 'active' AND left_at IS NULL) OR (status <> 'active' AND left_at IS NOT NULL))
);
CREATE INDEX projects_team_member_user_active_idx ON projects_team_membership (user_id, team_id) WHERE status = 'active';

CREATE TABLE projects_project (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  team_id text REFERENCES projects_team(id) ON DELETE RESTRICT,
  event_id text,
  created_by text NOT NULL,
  goal text NOT NULL,
  minimum_deliverable text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('draft','preparing','active','finalizing','submitted','retrospective','archived')),
  timezone text NOT NULL CHECK (length(timezone) > 0),
  deadline timestamptz,
  deadline_source text NOT NULL CHECK (deadline_source IN ('member_entered','unknown')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((deadline IS NULL AND deadline_source = 'unknown') OR (deadline IS NOT NULL AND deadline_source = 'member_entered'))
);

CREATE TABLE projects_project_membership (
  membership_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('manager','member')),
  status text NOT NULL CHECK (status IN ('active','left','removed')),
  revision integer NOT NULL CHECK (revision > 0),
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  CONSTRAINT projects_project_user_unique UNIQUE (project_id, user_id),
  CHECK ((status = 'active' AND left_at IS NULL) OR (status <> 'active' AND left_at IS NOT NULL))
);
CREATE INDEX projects_project_member_user_active_idx ON projects_project_membership (user_id, project_id) WHERE status = 'active';

CREATE TABLE projects_invitation (
  id text PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('project','team')),
  scope_id text NOT NULL,
  project_id text REFERENCES projects_project(id) ON DELETE RESTRICT,
  team_id text REFERENCES projects_team(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) > 0),
  role text NOT NULL,
  invited_email text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','accepted','revoked')),
  accepted_by text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revision integer NOT NULL CHECK (revision > 0),
  CHECK (expires_at > created_at),
  CHECK ((scope_type = 'project' AND project_id = scope_id AND project_id IS NOT NULL AND team_id IS NULL AND role IN ('manager','member'))
      OR (scope_type = 'team' AND team_id = scope_id AND team_id IS NOT NULL AND project_id IS NULL AND role IN ('captain','member'))),
  CHECK ((status = 'pending' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
      OR (status = 'accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX projects_invitation_scope_idx ON projects_invitation (scope_type, scope_id, id);

CREATE TABLE projects_member_availability (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  timezone text NOT NULL CHECK (length(timezone) > 0),
  effective_minutes double precision NOT NULL CHECK (effective_minutes >= 0 AND effective_minutes < 'Infinity'::double precision),
  confirmed_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  membership_revision integer NOT NULL CHECK (membership_revision > 0),
  CONSTRAINT projects_availability_member_unique UNIQUE (project_id, user_id),
  FOREIGN KEY (project_id, user_id) REFERENCES projects_project_membership(project_id, user_id) ON DELETE RESTRICT
);

-- Current collection snapshot only. A replaced/removed window does not alter existing outbox facts.
-- M05 owns validation and window semantics; M02 owns persistence and collection revision.
CREATE TABLE projects_availability_window (
  availability_id text NOT NULL REFERENCES projects_member_availability(id) ON DELETE RESTRICT,
  id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  effective_minutes double precision NOT NULL CHECK (effective_minutes >= 0 AND effective_minutes < 'Infinity'::double precision),
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (availability_id, id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE projects_resource_bookmark (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  resource_id text,
  url text,
  title text NOT NULL,
  purpose_note text NOT NULL,
  saved_by text NOT NULL,
  saved_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active','removed')),
  source_status text NOT NULL CHECK (source_status IN ('reviewed_resource','member_reference_unverified')),
  revision integer NOT NULL CHECK (revision > 0),
  CHECK ((resource_id IS NOT NULL AND url IS NULL AND source_status = 'reviewed_resource')
      OR (resource_id IS NULL AND url IS NOT NULL AND source_status = 'member_reference_unverified'))
);
-- Include removed references so re-adding updates the historical row instead of duplicating it.
CREATE UNIQUE INDEX projects_bookmark_resource_unique ON projects_resource_bookmark (project_id, resource_id) WHERE resource_id IS NOT NULL;
CREATE UNIQUE INDEX projects_bookmark_url_unique ON projects_resource_bookmark (project_id, url) WHERE url IS NOT NULL;
CREATE INDEX projects_bookmark_project_idx ON projects_resource_bookmark (project_id, id);

CREATE TABLE projects_activity (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  type text NOT NULL,
  object_id text NOT NULL,
  before_summary jsonb NOT NULL CHECK (jsonb_typeof(before_summary) = 'object'),
  after_summary jsonb NOT NULL CHECK (jsonb_typeof(after_summary) = 'object'),
  occurred_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE INDEX projects_activity_recent_idx ON projects_activity (project_id, occurred_at DESC, id DESC);

CREATE TABLE projects_change_fact (
  event_id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('ProjectCreated','ProjectScopeChanged','ProjectMemberJoined','ProjectMemberLeft','ProjectMemberRoleChanged','MemberAvailabilityChanged','ProjectStageChanged','ProjectResourceBookmarked')),
  aggregate_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  acknowledged_at timestamptz
);
CREATE INDEX projects_fact_pending_idx ON projects_change_fact (occurred_at, event_id) WHERE acknowledged_at IS NULL;

-- Deferred constraints permit create+initial manager and manager handoff in the same transaction.
-- Scope row locks make the manager/captain count safe against concurrent direct membership writes.
CREATE FUNCTION projects_require_active_manager() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scope_id text;
  scope_stage text;
BEGIN
  IF TG_TABLE_NAME = 'projects_project' THEN
    IF TG_OP = 'DELETE' THEN scope_id := OLD.id; ELSE scope_id := NEW.id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN scope_id := OLD.project_id; ELSE scope_id := NEW.project_id; END IF;
  END IF;
  SELECT stage INTO scope_stage FROM projects_project WHERE id = scope_id FOR UPDATE;
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM projects_project_membership WHERE project_id = scope_id AND status = 'active' AND role = 'manager'
  ) THEN
    RAISE EXCEPTION 'Project requires an active manager' USING ERRCODE = '23514', CONSTRAINT = 'projects_active_manager_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER projects_project_manager_check AFTER INSERT OR UPDATE ON projects_project
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_manager();
CREATE CONSTRAINT TRIGGER projects_membership_manager_check AFTER INSERT OR UPDATE OR DELETE ON projects_project_membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_manager();

CREATE FUNCTION projects_require_active_captain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scope_id text;
  scope_status text;
BEGIN
  IF TG_TABLE_NAME = 'projects_team' THEN
    IF TG_OP = 'DELETE' THEN scope_id := OLD.id; ELSE scope_id := NEW.id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN scope_id := OLD.team_id; ELSE scope_id := NEW.team_id; END IF;
  END IF;
  SELECT status INTO scope_status FROM projects_team WHERE id = scope_id FOR UPDATE;
  IF FOUND AND scope_status = 'active' AND NOT EXISTS (
    SELECT 1 FROM projects_team_membership WHERE team_id = scope_id AND status = 'active' AND role = 'captain'
  ) THEN
    RAISE EXCEPTION 'Active team requires a captain' USING ERRCODE = '23514', CONSTRAINT = 'projects_active_captain_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER projects_team_captain_check AFTER INSERT OR UPDATE ON projects_team
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_captain();
CREATE CONSTRAINT TRIGGER projects_membership_captain_check AFTER INSERT OR UPDATE OR DELETE ON projects_team_membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_captain();

-- Relation identity cannot move between scopes. This also protects the old scope's manager/captain
-- count when a writer bypasses the adapter; status and role updates remain the permitted workflow.
CREATE FUNCTION projects_preserve_membership_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'projects_project_membership' THEN
    IF ROW(NEW.membership_id, NEW.project_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.membership_id, OLD.project_id, OLD.user_id) THEN
      RAISE EXCEPTION 'Project membership identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.membership_id, NEW.team_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.membership_id, OLD.team_id, OLD.user_id) THEN
      RAISE EXCEPTION 'Team membership identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_project_member_identity_check BEFORE UPDATE ON projects_project_membership
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_membership_identity();
CREATE TRIGGER projects_team_member_identity_check BEFORE UPDATE ON projects_team_membership
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_membership_identity();

CREATE FUNCTION projects_preserve_scope_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Scope identity and creation history are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_project_identity_check BEFORE UPDATE ON projects_project
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_scope_identity();
CREATE TRIGGER projects_team_identity_check BEFORE UPDATE ON projects_team
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_scope_identity();

-- Suggested rollback, only after exporting data and removing dependent integration migrations:
-- DROP TABLE projects_change_fact, projects_activity, projects_resource_bookmark,
--   projects_availability_window, projects_member_availability, projects_invitation,
--   projects_project_membership, projects_project, projects_team_membership, projects_team;
-- DROP FUNCTION projects_require_active_manager(), projects_require_active_captain(),
--   projects_preserve_membership_identity(), projects_preserve_scope_identity();

-- Module proposal: events/migrations/001-events.sql
-- MIGRATION SUGGESTION ONLY. Coordinator applies through the real migration system.
-- PostgreSQL; run as one transaction. No credentials or sample content are included.

CREATE TABLE m03_events (
  id text COLLATE "C" PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL,
  CHECK (body->>'id' = id AND (body->>'revision')::integer = revision),
  CHECK (body->>'publicationStatus' IN ('draft','pending_review','published','archived')),
  CHECK ((body->>'candidateVersion')::integer > 0)
);
CREATE TABLE m03_rule_versions (
  event_id text COLLATE "C" NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  body jsonb NOT NULL,
  PRIMARY KEY (event_id, version),
  FOREIGN KEY (event_id) REFERENCES m03_events(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (body->>'eventId' = event_id AND (body->>'version')::integer = version)
);
CREATE TABLE m03_project_rules (
  id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL,
  event_id text COLLATE "C" GENERATED ALWAYS AS (body->>'eventId') STORED,
  rules_version integer GENERATED ALWAYS AS ((body->>'rulesVersion')::integer) STORED,
  CHECK (body->>'projectId' = id AND (body->>'revision')::integer = revision),
  FOREIGN KEY (event_id, rules_version) REFERENCES m03_rule_versions(event_id, version)
);
CREATE TABLE m03_event_analyses (
  id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL,
  event_id text COLLATE "C" GENERATED ALWAYS AS (body->>'eventId') STORED,
  rules_version integer GENERATED ALWAYS AS ((body->>'rulesVersion')::integer) STORED,
  CHECK (body->>'id' = id AND (body->>'revision')::integer = revision),
  CHECK (body->>'status' IN ('draft','confirmed','superseded')),
  FOREIGN KEY (event_id, rules_version) REFERENCES m03_rule_versions(event_id, version)
);
CREATE INDEX m03_analysis_project_idx ON m03_event_analyses ((body->>'projectId'));
CREATE TABLE m03_analysis_runs (
  id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL,
  analysis_id text GENERATED ALWAYS AS (body->>'analysisId') STORED REFERENCES m03_event_analyses(id),
  CHECK (body->>'id' = id AND (body->>'revision')::integer = revision),
  CHECK (body->>'status' IN ('queued','running','succeeded','failed','cancelled'))
);
CREATE UNIQUE INDEX m03_run_idempotency_idx ON m03_analysis_runs ((body->>'projectId'), (body->>'actorId'), (body->>'idempotencyKey'));
CREATE INDEX m03_run_queue_idx ON m03_analysis_runs ((body->>'status'), (body->>'queuedAt'));
CREATE TABLE m03_event_corrections (
  id text PRIMARY KEY,
  event_id text COLLATE "C" NOT NULL,
  version integer NOT NULL,
  body jsonb NOT NULL,
  FOREIGN KEY (event_id, version) REFERENCES m03_rule_versions(event_id, version)
);
CREATE TABLE m03_events_outbox (
  id text PRIMARY KEY,
  type text NOT NULL,
  aggregate_id text NOT NULL,
  project_id text,
  version integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  body jsonb NOT NULL,
  delivered_at timestamptz
);
CREATE INDEX m03_outbox_pending_idx ON m03_events_outbox(occurred_at, id) WHERE delivered_at IS NULL;

-- Rollback requires a backup and coordinated removal of dependent M02/M05/M06 references.
-- Drop only these m03_* tables in reverse dependency order after export; never cascade
-- into other modules. Historical rules are insert-only through this module's adapter.

-- Module proposal: assessments/sql/001-assessments.sql
-- M04 PostgreSQL migration proposal only. The coordinator reviews and executes it.
-- Requires PostgreSQL JSONB. M02 project/member foreign keys must be mapped to its
-- actual schema by the coordinator; no other module table names are assumed here.
-- Runtime access is through trusted server services, never direct client SQL.
-- Use a separate migration/catalog role; the runtime role should have catalog SELECT
-- and score SELECT/INSERT only. Private aggregate tables must not be public grants.

CREATE TABLE assessments_rubrics (
  id text PRIMARY KEY,
  version integer NOT NULL CHECK (version >= 1),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data @> jsonb_build_object('id', id, 'version', version))
);
COMMENT ON TABLE assessments_rubrics IS 'M04 public versioned scoring rules; insert new IDs for revisions; no personal answers.';
COMMENT ON COLUMN assessments_rubrics.id IS 'Public immutable rubric version ID.';
COMMENT ON COLUMN assessments_rubrics.version IS 'Public rubric version counter; not a member ability rank.';
COMMENT ON COLUMN assessments_rubrics.data IS 'Public rubric criteria, anchors, weights and limitations; immutable after insertion.';

CREATE TABLE assessments_question_sets (
  id text PRIMARY KEY,
  version integer NOT NULL CHECK (version >= 1),
  rubric_version_id text NOT NULL REFERENCES assessments_rubrics(id),
  status text NOT NULL CHECK (status IN ('draft', 'reviewed', 'published', 'retired')),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data @> jsonb_build_object('id', id, 'version', version, 'rubricVersionId', rubric_version_id)),
  UNIQUE (id, rubric_version_id)
);
COMMENT ON TABLE assessments_question_sets IS 'M04 task questions; published bodies are immutable; retire only prevents new attempts.';
COMMENT ON COLUMN assessments_question_sets.id IS 'Public question set version ID.';
COMMENT ON COLUMN assessments_question_sets.version IS 'Public fixed content version counter.';
COMMENT ON COLUMN assessments_question_sets.rubric_version_id IS 'Public rubric version link; must match historical attempt snapshots.';
COMMENT ON COLUMN assessments_question_sets.status IS 'Catalog visibility/lifecycle; only published is eligible for a new attempt; retirement is independent of body.';
COMMENT ON COLUMN assessments_question_sets.data IS 'Task prompts, tools, follow-up cap and limitations; contains no personal responses; status column overrides body status on read.';

CREATE TABLE assessments_attempts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  membership_id text NOT NULL,
  user_id text NOT NULL,
  question_set_id text NOT NULL,
  rubric_version_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'in_progress', 'submitted', 'scoring', 'completed', 'scoring_failed', 'cancelled', 'abandoned')),
  revision integer NOT NULL CHECK (revision >= 1),
  latest_score_id text,
  active_job_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data @> jsonb_build_object(
    'id', id, 'projectId', project_id, 'membershipId', membership_id, 'userId', user_id,
    'questionSetId', question_set_id, 'rubricVersionId', rubric_version_id,
    'status', status, 'revision', revision, 'latestScoreId', latest_score_id, 'activeJobId', active_job_id)),
  FOREIGN KEY (question_set_id, rubric_version_id) REFERENCES assessments_question_sets(id, rubric_version_id),
  UNIQUE (id, project_id, user_id),
  UNIQUE (id, rubric_version_id)
);
CREATE INDEX assessments_attempts_project ON assessments_attempts(project_id, id);
COMMENT ON TABLE assessments_attempts IS 'PRIVATE M04 responses and snapshots. Only author user_id may receive full data; project managers get selected summaries through service filtering.';
COMMENT ON COLUMN assessments_attempts.id IS 'Private attempt identifier; knowing ID never grants access.';
COMMENT ON COLUMN assessments_attempts.project_id IS 'Private project scope; service verifies active M02 ProjectMembership before access.';
COMMENT ON COLUMN assessments_attempts.membership_id IS 'Private M02 ProjectMembership.id, not TeamMembership or user ID.';
COMMENT ON COLUMN assessments_attempts.user_id IS 'Private original author; service author check is mandatory even for project manager.';
COMMENT ON COLUMN assessments_attempts.question_set_id IS 'Fixed public catalog reference; retirement does not invalidate historical answers.';
COMMENT ON COLUMN assessments_attempts.rubric_version_id IS 'Fixed public rubric reference used to score this attempt.';
COMMENT ON COLUMN assessments_attempts.status IS 'Private workflow state; incomplete/failed does not imply zero ability.';
COMMENT ON COLUMN assessments_attempts.revision IS 'Private aggregate CAS revision, starts at 1 and increases for every mutation including sharing revocation.';
COMMENT ON COLUMN assessments_attempts.latest_score_id IS 'Private latest score link; same-attempt foreign key prevents foreign report disclosure.';
COMMENT ON COLUMN assessments_attempts.active_job_id IS 'Private active scoring job reference; job must belong to same attempt.';
COMMENT ON COLUMN assessments_attempts.created_at IS 'Private author activity timestamp; not included in team summary by default.';
COMMENT ON COLUMN assessments_attempts.updated_at IS 'Private author activity timestamp; used for persistence ordering only.';
COMMENT ON COLUMN assessments_attempts.data IS 'SENSITIVE full author profile, raw answers, work samples, evidence URLs, follow-ups, sharing selections and immutable question/rubric snapshots; never log or send in team API/model input.';

CREATE TABLE assessments_scores (
  id text PRIMARY KEY,
  attempt_id text NOT NULL,
  rubric_version_id text NOT NULL,
  supersedes_score_id text,
  validated_at timestamptz NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data @> jsonb_build_object(
    'id', id, 'attemptId', attempt_id, 'rubricVersionId', rubric_version_id,
    'supersedesScoreId', supersedes_score_id, 'status', 'published')),
  CHECK (supersedes_score_id IS NULL OR supersedes_score_id <> id),
  FOREIGN KEY (attempt_id, rubric_version_id) REFERENCES assessments_attempts(id, rubric_version_id),
  UNIQUE (id, attempt_id),
  FOREIGN KEY (supersedes_score_id, attempt_id) REFERENCES assessments_scores(id, attempt_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX assessments_scores_attempt ON assessments_scores(attempt_id, validated_at, id);
COMMENT ON TABLE assessments_scores IS 'PRIVATE append-only validated scores; corrections insert a new row and reference the preceding score, never overwrite.';
COMMENT ON COLUMN assessments_scores.id IS 'Private immutable score version ID.';
COMMENT ON COLUMN assessments_scores.attempt_id IS 'Private author attempt; ownership is inherited and must be checked by service.';
COMMENT ON COLUMN assessments_scores.rubric_version_id IS 'Public fixed rule version; FK ensures it is the attempt rubric.';
COMMENT ON COLUMN assessments_scores.supersedes_score_id IS 'Private same-attempt preceding score reference for correction history.';
COMMENT ON COLUMN assessments_scores.validated_at IS 'Private validation instant; does not imply real-world ability verification.';
COMMENT ON COLUMN assessments_scores.data IS 'SENSITIVE full score reasons/evidence references, unverified items, limitations, model/prompt versions and provenance; team sees only explicitly selected criterion/state/score fields.';

CREATE TABLE assessments_scoring_jobs (
  id text PRIMARY KEY,
  attempt_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  input_fingerprint text NOT NULL CHECK (length(input_fingerprint) > 0),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  revision integer NOT NULL CHECK (revision >= 1),
  run_number integer NOT NULL CHECK (run_number >= 1),
  created_at timestamptz NOT NULL,
  result_score_id text,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data @> jsonb_build_object(
    'id', id, 'attemptId', attempt_id, 'projectId', project_id, 'userId', user_id,
    'idempotencyKey', idempotency_key, 'inputFingerprint', input_fingerprint,
    'status', status, 'revision', revision, 'runNumber', run_number, 'resultScoreId', result_score_id)),
  UNIQUE (attempt_id, user_id, idempotency_key),
  UNIQUE (id, attempt_id),
  FOREIGN KEY (attempt_id, project_id, user_id) REFERENCES assessments_attempts(id, project_id, user_id),
  FOREIGN KEY (result_score_id, attempt_id) REFERENCES assessments_scores(id, attempt_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX assessments_scoring_jobs_queue ON assessments_scoring_jobs(status, created_at) WHERE status = 'queued';
COMMENT ON TABLE assessments_scoring_jobs IS 'PRIVATE durable scoring runs; scoped idempotency prevents duplicate dispatch; workers need separate trusted authorization.';
COMMENT ON COLUMN assessments_scoring_jobs.id IS 'Private scoring job ID; not client authentication.';
COMMENT ON COLUMN assessments_scoring_jobs.attempt_id IS 'Private target attempt; always same project/author as row metadata.';
COMMENT ON COLUMN assessments_scoring_jobs.project_id IS 'Private project scope; prevents cross-project job associations.';
COMMENT ON COLUMN assessments_scoring_jobs.user_id IS 'Private answer author and idempotency actor scope.';
COMMENT ON COLUMN assessments_scoring_jobs.idempotency_key IS 'Private client operation key; unique only within attempt and author, never shared across users.';
COMMENT ON COLUMN assessments_scoring_jobs.input_fingerprint IS 'Private input fingerprint; service rejects key reuse with a different fingerprint; must not contain raw answers.';
COMMENT ON COLUMN assessments_scoring_jobs.status IS 'Private external run state; queued/running never mean score completed.';
COMMENT ON COLUMN assessments_scoring_jobs.revision IS 'Private job CAS revision; starts at 1.';
COMMENT ON COLUMN assessments_scoring_jobs.run_number IS 'Private per-attempt attempt number used to enforce retry limits in service.';
COMMENT ON COLUMN assessments_scoring_jobs.created_at IS 'Private dispatch instant; provider calls run outside the database transaction.';
COMMENT ON COLUMN assessments_scoring_jobs.result_score_id IS 'Private same-attempt result reference; null when no validated published result exists.';
COMMENT ON COLUMN assessments_scoring_jobs.data IS 'Private durable execution metadata, duration and safe failure category; excludes provider secrets/responses and raw answers.';

ALTER TABLE assessments_attempts ADD CONSTRAINT assessments_attempt_latest_score
  FOREIGN KEY (latest_score_id, id) REFERENCES assessments_scores(id, attempt_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE assessments_attempts ADD CONSTRAINT assessments_attempt_active_job
  FOREIGN KEY (active_job_id, id) REFERENCES assessments_scoring_jobs(id, attempt_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE assessments_assignment_versions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  base_version_id text,
  status text NOT NULL CHECK (status IN ('draft', 'needs_changes', 'ready', 'applied', 'superseded')),
  revision integer NOT NULL CHECK (revision >= 1),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data @> jsonb_build_object(
    'id', id, 'projectId', project_id, 'baseVersionId', base_version_id,
    'status', status, 'revision', revision, 'createdBy', created_by)
    AND data -> 'inputSnapshot' @> jsonb_build_object('projectId', project_id)),
  CHECK (base_version_id IS NULL OR base_version_id <> id),
  UNIQUE (id, project_id),
  FOREIGN KEY (base_version_id, project_id) REFERENCES assessments_assignment_versions(id, project_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX assessments_assignment_project ON assessments_assignment_versions(project_id, created_at);
COMMENT ON TABLE assessments_assignment_versions IS 'PRIVATE project assignments; active project managers may edit/apply through service; applied task facts remain versioned.';
COMMENT ON COLUMN assessments_assignment_versions.id IS 'Private assignment version ID; does not grant project access.';
COMMENT ON COLUMN assessments_assignment_versions.project_id IS 'Private project scope; manager authorization uses active M02 ProjectMembership.';
COMMENT ON COLUMN assessments_assignment_versions.base_version_id IS 'Private same-project baseline for visible differences and concurrency checks.';
COMMENT ON COLUMN assessments_assignment_versions.status IS 'Private draft/application state; ready means structurally valid, never schedule feasibility.';
COMMENT ON COLUMN assessments_assignment_versions.revision IS 'Private draft CAS revision; starts at 1; applied content may only be superseded.';
COMMENT ON COLUMN assessments_assignment_versions.created_by IS 'Private actor user ID for audit; never an alternative permission role.';
COMMENT ON COLUMN assessments_assignment_versions.created_at IS 'Private creation/audit instant.';
COMMENT ON COLUMN assessments_assignment_versions.updated_at IS 'Private last revision instant.';
COMMENT ON COLUMN assessments_assignment_versions.data IS 'Private project task facts, manager audit, member/availability/requirement snapshot and shared-summary IDs/revisions; contains no raw answers or full personal scores.';

CREATE TABLE assessments_assignment_heads (
  project_id text PRIMARY KEY,
  version_id text,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK ((revision = 0 AND version_id IS NULL) OR (revision > 0 AND version_id IS NOT NULL)),
  FOREIGN KEY (version_id, project_id) REFERENCES assessments_assignment_versions(id, project_id) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE assessments_assignment_heads IS 'PRIVATE single active-assignment pointer per project. Insert zero head then SELECT FOR UPDATE serializes application.';
COMMENT ON COLUMN assessments_assignment_heads.project_id IS 'Private project key; exactly one application mutex/head per project.';
COMMENT ON COLUMN assessments_assignment_heads.version_id IS 'Private same-project applied assignment link; null only before first application.';
COMMENT ON COLUMN assessments_assignment_heads.revision IS 'Private pointer CAS revision, initially 0; first application updates to 1.';

CREATE TABLE assessments_outbox (
  event_id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('AssessmentSubmitted', 'AssessmentScoringFailed', 'AssessmentSummaryUpdated', 'AssignmentApplied')),
  aggregate_id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  delivered_at timestamptz
);
CREATE INDEX assessments_outbox_pending ON assessments_outbox(occurred_at, event_id) WHERE delivered_at IS NULL;
COMMENT ON TABLE assessments_outbox IS 'PRIVATE transactional downstream notifications; append with business mutation, deduplicate by event_id and version.';
COMMENT ON COLUMN assessments_outbox.event_id IS 'Private event deduplication ID.';
COMMENT ON COLUMN assessments_outbox.type IS 'Private domain event name; conveys facts rather than model suggestions.';
COMMENT ON COLUMN assessments_outbox.aggregate_id IS 'Private affected attempt/assignment identifier; consumers must reauthorize reads.';
COMMENT ON COLUMN assessments_outbox.project_id IS 'Private tenant/project scope for dispatch.';
COMMENT ON COLUMN assessments_outbox.version IS 'Private aggregate/pointer revision for ordered idempotent consumption.';
COMMENT ON COLUMN assessments_outbox.occurred_at IS 'Private event occurrence instant, independent of delivery.';
COMMENT ON COLUMN assessments_outbox.payload IS 'Only necessary string/number/null IDs and counters; no raw answers, evidence text, personal scores or credentials.';
COMMENT ON COLUMN assessments_outbox.delivered_at IS 'Private delivery acknowledgement, null until dispatcher confirms; consumers may receive duplicates.';

CREATE FUNCTION assessments_reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M04 immutable version: insert a new record' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER assessments_rubric_immutable BEFORE UPDATE OR DELETE ON assessments_rubrics
  FOR EACH ROW EXECUTE FUNCTION assessments_reject_immutable_mutation();
CREATE TRIGGER assessments_score_immutable BEFORE UPDATE OR DELETE ON assessments_scores
  FOR EACH ROW EXECUTE FUNCTION assessments_reject_immutable_mutation();

CREATE FUNCTION assessments_guard_question_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'M04 published question version cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'M04 catalog version identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('published', 'retired') AND
    (NEW.data IS DISTINCT FROM OLD.data OR NEW.rubric_version_id IS DISTINCT FROM OLD.rubric_version_id
     OR (OLD.status = 'published' AND NEW.status NOT IN ('published', 'retired'))
     OR (OLD.status = 'retired' AND NEW.status <> 'retired')) THEN
    RAISE EXCEPTION 'M04 published question body is immutable; retire through status only' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'reviewed') OR
     OLD.status = 'reviewed' AND NEW.status NOT IN ('draft', 'reviewed', 'published') THEN
    RAISE EXCEPTION 'M04 question set requires review before publication' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessments_question_version_guard BEFORE UPDATE OR DELETE ON assessments_question_sets
  FOR EACH ROW EXECUTE FUNCTION assessments_guard_question_version();

CREATE FUNCTION assessments_guard_applied_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('applied', 'superseded') AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'M04 applied assignment facts are versioned' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF OLD.status = 'superseded' OR OLD.status = 'applied' AND (
    NEW.status <> 'superseded' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.base_version_id IS DISTINCT FROM OLD.base_version_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1
    OR (NEW.data - ARRAY['status', 'revision', 'updatedAt']) IS DISTINCT FROM (OLD.data - ARRAY['status', 'revision', 'updatedAt'])) THEN
    RAISE EXCEPTION 'M04 applied task content is immutable; create a new version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessments_applied_assignment_guard BEFORE UPDATE OR DELETE ON assessments_assignment_versions
  FOR EACH ROW EXECUTE FUNCTION assessments_guard_applied_assignment();

-- Rollback is intentionally not executed here. Preserve/private-backup trial data
-- before any rollback; drop head/outbox/job/score/attempt/assignment/catalog tables
-- with foreign-key ordering and then these functions only during a reviewed migration.
-- The append-only triggers protect history during ordinary runtime operations.
-- An approved personal-data deletion policy needs a dedicated audited maintenance
-- path with narrowly scoped privileges; never silently disable guards at runtime.

-- Module proposal: planning/migrations/001-planning.sql
-- M05 migration proposal only. The coordinator reviews and executes migrations.
-- JSONB retains task/plan/progress history; append-only progress and plan lifecycle
-- are enforced by PlanningService. Availability here is an immutable plan input
-- snapshot referencing M02 versions, never a second editable availability table.
-- project_id uses the shared opaque text ID. Add the M02 project FK only after
-- the coordinator confirms that module's authoritative table name and ID type.

CREATE TABLE planning_states (
  project_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  state_json jsonb NOT NULL,
  CHECK (jsonb_typeof(state_json) = 'object'),
  CHECK (state_json ? 'projectId' AND jsonb_typeof(state_json -> 'projectId') = 'string' AND state_json ->> 'projectId' = project_id),
  CHECK (state_json ? 'revision' AND jsonb_typeof(state_json -> 'revision') = 'number' AND (state_json ->> 'revision')::bigint = revision),
  CHECK (state_json ? 'tasksRevision' AND jsonb_typeof(state_json -> 'tasksRevision') = 'number' AND (state_json ->> 'tasksRevision')::bigint >= 0),
  CHECK (state_json ? 'currentPlanVersionId' AND jsonb_typeof(state_json -> 'currentPlanVersionId') IN ('string', 'null')),
  CHECK (state_json ? 'tasks' AND jsonb_typeof(state_json -> 'tasks') = 'array'),
  CHECK (state_json ? 'plans' AND jsonb_typeof(state_json -> 'plans') = 'array'),
  CHECK (state_json ? 'progressUpdates' AND jsonb_typeof(state_json -> 'progressUpdates') = 'array')
);

CREATE TABLE planning_idempotency (
  project_id text NOT NULL REFERENCES planning_states(project_id),
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, scope, idempotency_key)
);

CREATE TABLE planning_outbox (
  event_id text PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('PlanDraftGenerated', 'PlanApplied', 'ProgressUpdated', 'PlanRiskDetected')),
  project_id text NOT NULL REFERENCES planning_states(project_id),
  aggregate_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  occurred_at timestamptz NOT NULL,
  event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
);

CREATE INDEX planning_outbox_unpublished ON planning_outbox(occurred_at, event_id)
  WHERE published_at IS NULL;

-- Outbox dispatch is coordinated outside a planning transaction. Consumers
-- must deduplicate by event_id and revision; no worker is implied by this file.
-- A rollback drops these three M05 tables only after a data backup/export.

-- Module proposal: github/sql/git.sql
-- M06 migration proposal. Coordinator must apply through its migration system.
-- No external credentials are stored here. Private draft/preview contents expire after 24h.
CREATE TABLE github_repository_bindings (
  id text PRIMARY KEY, project_id text NOT NULL UNIQUE, revision integer NOT NULL CHECK (revision>0), payload jsonb NOT NULL,
  CHECK (payload->>'projectId'=project_id), CHECK ((payload->>'revision')::integer=revision)
);
CREATE TABLE github_operations (
  id text PRIMARY KEY, project_id text NOT NULL, actor_id text NOT NULL, idempotency_key text NOT NULL,
  input_hash text NOT NULL, revision integer NOT NULL CHECK (revision>0), payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,actor_id,idempotency_key),
  CHECK (payload->>'projectId'=project_id), CHECK (payload->>'actorId'=actor_id),
  CHECK (payload->>'inputHash'=input_hash), CHECK ((payload->>'revision')::integer=revision)
);
CREATE INDEX github_operations_project ON github_operations(project_id,created_at DESC);
CREATE TABLE github_file_drafts (
  id text PRIMARY KEY, project_id text NOT NULL, actor_id text NOT NULL, payload jsonb NOT NULL,
  bytes integer NOT NULL CHECK (bytes>=0 AND bytes<=6291456), expires_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(payload)='array')
);
CREATE INDEX github_file_drafts_expiry ON github_file_drafts(expires_at);
CREATE INDEX github_file_drafts_project ON github_file_drafts(project_id);
CREATE TABLE github_audit_events (
  id text PRIMARY KEY, event_type text NOT NULL, aggregate_id text NOT NULL, project_id text NOT NULL,
  version integer NOT NULL, actor_id text NOT NULL, details jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_audit_project ON github_audit_events(project_id,occurred_at DESC);
-- Rollback only after coordinated backup: DROP TABLE github_audit_events,github_file_drafts,github_operations,github_repository_bindings;
-- Coordinator should add project/user FK names after its M01/M02 migrations are fixed.

-- Module proposal: github/sql/delivery.sql
-- M06 migration suggestion only. The coordinating session owns actual migration execution.
-- Project/user/event foreign keys should be wired to canonical tables by the coordinator.
CREATE TABLE m06_delivery_verifications (
  id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version = 1),
  repository_commit_sha text CHECK (repository_commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  verifier_id text NOT NULL,
  verified_at timestamptz NOT NULL,
  environment_summary text NOT NULL,
  steps text[] NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'inconclusive')),
  blockers text[] NOT NULL,
  evidence_refs text[] NOT NULL,
  verification_source text NOT NULL CHECK (verification_source = 'user_reported'),
  PRIMARY KEY (id, version),
  CHECK (outcome <> 'passed' OR
    (length(btrim(environment_summary)) > 0 AND cardinality(steps) > 0 AND cardinality(evidence_refs) > 0 AND cardinality(blockers) = 0))
);
CREATE INDEX m06_delivery_verifications_project ON m06_delivery_verifications (project_id, verified_at DESC);

-- Heads are the only mutable submission rows. History snapshots are insert-only.
CREATE TABLE m06_submission_heads (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  UNIQUE (id, project_id)
);
CREATE TABLE m06_submission_versions (
  id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  event_id text NOT NULL,
  stage_id text NOT NULL,
  requirements_version text NOT NULL,
  platform_url text NOT NULL CHECK (platform_url ~ '^https://'),
  submitted_at timestamptz,
  verification_source text NOT NULL CHECK (verification_source = 'user_reported'),
  repository_commit_sha text CHECK (repository_commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  status text NOT NULL CHECK (status IN ('not_submitted', 'reported', 'rejected_or_withdrawn')),
  evidence_refs text[] NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (id, version),
  FOREIGN KEY (id, project_id) REFERENCES m06_submission_heads (id, project_id),
  CHECK (status <> 'reported' OR (submitted_at IS NOT NULL AND cardinality(evidence_refs) > 0)),
  CHECK (status <> 'not_submitted' OR submitted_at IS NULL)
);
CREATE INDEX m06_submission_versions_project ON m06_submission_versions (project_id, recorded_at DESC, id, version DESC);

-- Fact/audit metadata is committed with the corresponding fact/version. No shared schema dependencies.
-- Consumers can deduplicate by id. No evidence refs, upload text or credentials belong in details.
CREATE TABLE m06_delivery_fact_events (
  id text PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('DeliveryValidationRecorded', 'SubmissionRecorded')),
  aggregate_id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL,
  UNIQUE (event_type, aggregate_id, version)
);
CREATE INDEX m06_delivery_fact_events_project ON m06_delivery_fact_events (project_id, occurred_at DESC);

-- Enforce history immutability even if another query accidentally tries to update/delete it.
CREATE FUNCTION m06_reject_delivery_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M06 delivery facts are immutable; append a new fact/version';
END;
$$;
CREATE TRIGGER m06_verifications_immutable BEFORE UPDATE OR DELETE ON m06_delivery_verifications
  FOR EACH ROW EXECUTE FUNCTION m06_reject_delivery_history_mutation();
CREATE TRIGGER m06_submission_versions_immutable BEFORE UPDATE OR DELETE ON m06_submission_versions
  FOR EACH ROW EXECUTE FUNCTION m06_reject_delivery_history_mutation();
CREATE TRIGGER m06_delivery_fact_events_immutable BEFORE UPDATE OR DELETE ON m06_delivery_fact_events
  FOR EACH ROW EXECUTE FUNCTION m06_reject_delivery_history_mutation();

-- Rollback: archive/export private facts first, then remove these tables/functions in dependency order.
-- Any user-data erasure workflow needs a separately authorized migration or privileged maintenance path.

-- Module proposal: retrospectives/migrations/001_retrospectives.sql
-- M07 migration suggestion only. The coordinator executes it with the shared pool.
-- M06 owns delivery verification / submission facts; this schema stores references.
-- User/project foreign keys are wired by the coordinator after their table names settle.

CREATE TABLE m07_documents (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('retrospective', 'experience_card', 'reuse_draft', 'generation_job')),
  project_id text NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 200),
  owner_id text NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 200),
  scope text NOT NULL CHECK (scope IN ('personal', 'project')),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  CHECK (body ?& ARRAY['id', 'kind', 'projectId', 'ownerId', 'scope', 'revision', 'createdAt', 'updatedAt', 'status']),
  CHECK (body @> jsonb_build_object('id', id, 'kind', kind, 'projectId', project_id, 'ownerId', owner_id, 'scope', scope, 'revision', revision)),
  CHECK (((body->>'createdAt')::timestamptz = created_at AND (body->>'updatedAt')::timestamptz = updated_at) IS TRUE),
  CHECK ((
    (kind = 'retrospective' AND body->>'status' IN ('draft', 'generating', 'review_required', 'confirmed'))
    OR (kind = 'experience_card' AND body->>'status' IN ('draft', 'confirmed', 'outdated', 'archived'))
    OR (kind = 'reuse_draft' AND scope = 'personal' AND body->>'status' = 'draft')
    OR (kind = 'generation_job' AND body->>'status' IN ('queued', 'running', 'succeeded', 'failed'))
  ) IS TRUE)
);
CREATE INDEX m07_documents_personal_list ON m07_documents (owner_id, kind, id COLLATE "C") WHERE scope = 'personal';
CREATE INDEX m07_documents_project_list ON m07_documents (project_id, kind, id COLLATE "C") WHERE scope = 'project';
CREATE INDEX m07_generation_jobs_poll ON m07_documents ((body->>'status'), updated_at, id COLLATE "C")
  WHERE kind = 'generation_job' AND body->>'status' IN ('queued', 'running');

CREATE TABLE m07_document_versions (
  document_id text NOT NULL REFERENCES m07_documents(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (document_id, revision),
  CHECK (body ?& ARRAY['id', 'revision']),
  CHECK (body @> jsonb_build_object('id', document_id, 'revision', revision))
);

CREATE TABLE m07_audit_events (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('RetrospectiveConfirmed', 'ExperienceCardConfirmed', 'ExperienceCardVisibilityChanged', 'ExperienceReused', 'DocumentEdited', 'PersonalDocumentDeleted', 'GenerationUpdated')),
  aggregate_id text NOT NULL CHECK (char_length(aggregate_id) BETWEEN 1 AND 200),
  project_id text NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 200),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  occurred_at timestamptz NOT NULL
  -- Intentionally no body/payload column: private answers never enter audit storage.
  -- No aggregate FK: deletion preserves this metadata-only deletion record.
);
CREATE INDEX m07_audit_events_project ON m07_audit_events (project_id, occurred_at, id);

CREATE FUNCTION m07_guard_document_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.project_id <> OLD.project_id
     OR NEW.owner_id <> OLD.owner_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'M07 document identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'M07 document revision must increase exactly once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER m07_document_update_guard BEFORE UPDATE ON m07_documents FOR EACH ROW EXECUTE FUNCTION m07_guard_document_update();

CREATE FUNCTION m07_guard_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'M07 document history is immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM m07_documents WHERE id = OLD.document_id) THEN
    RAISE EXCEPTION 'M07 history may only be deleted with its document';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER m07_document_history_guard BEFORE UPDATE OR DELETE ON m07_document_versions FOR EACH ROW EXECUTE FUNCTION m07_guard_version_mutation();

-- Rollback (after backing up all M07 rows): drop m07_document_versions first,
-- then m07_documents and m07_audit_events, followed by both guard functions.
-- This removes M07 data; it never touches M06 facts. Do not run on trial data blindly.

-- Module proposal: resources/migrations/001-resources.sql
-- Migration suggestion only. The coordinating session reviews/applies this.
-- No candidate data is published by this migration.

CREATE TABLE resource_records (
  id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  working_document jsonb NOT NULL,
  public_document jsonb,
  CHECK (working_document->>'id' = id),
  CHECK ((working_document->>'revision')::integer = revision),
  CHECK ((working_document->>'version')::integer > 0),
  CHECK (working_document->>'publicationStatus' IN ('draft', 'in_review', 'published', 'withdrawn')),
  CHECK (public_document IS NULL OR (public_document->>'id' = id AND public_document->>'publicationStatus' IN ('published', 'withdrawn')))
);
CREATE TABLE resource_revisions (
  resource_id text NOT NULL REFERENCES resource_records(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  working_document jsonb NOT NULL,
  public_document jsonb,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (resource_id, revision)
);
CREATE TABLE resource_bookmarks (
  id text PRIMARY KEY,
  -- M01 owns user lifetime; the coordinator adds the actual User FK once agreed.
  user_id text NOT NULL,
  resource_id text NOT NULL REFERENCES resource_records(id) ON DELETE RESTRICT,
  purpose_note text NOT NULL CHECK (char_length(purpose_note) <= 1000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  UNIQUE (user_id, resource_id)
);
CREATE INDEX resource_published_editorial ON resource_records (((public_document->>'displayOrder')::integer), id)
  WHERE public_document->>'publicationStatus' = 'published';
CREATE INDEX resource_public_type ON resource_records ((public_document->>'type'))
  WHERE public_document->>'publicationStatus' = 'published';
CREATE INDEX resource_public_tags ON resource_records USING gin (public_document jsonb_path_ops)
  WHERE public_document->>'publicationStatus' = 'published';
CREATE INDEX resource_bookmark_owner_page ON resource_bookmarks (user_id, created_at DESC, id);
CREATE TABLE resource_publication_operations (
  operation_id text PRIMARY KEY,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE TABLE resource_notifications (
  id text PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('ResourcePublished', 'ResourceWithdrawn')),
  resource_id text NOT NULL REFERENCES resource_records(id) ON DELETE RESTRICT,
  resource_version integer NOT NULL CHECK (resource_version > 0),
  occurred_at timestamptz NOT NULL,
  acknowledged_at timestamptz
);

-- Recovery: back up all five tables before destructive rollback.
-- Rollback order (ONLY after backup / explicit coordinating-session decision):
-- DROP TABLE resource_notifications; DROP TABLE resource_publication_operations;
-- DROP TABLE resource_bookmarks; DROP TABLE resource_revisions; DROP TABLE resource_records;
-- Removing resources must not silently erase M02/M05 historical references.

-- Module proposal: operations/sql/source-runs.sql
-- Migration suggestion only. Main session applies this with the real database.
-- Source configs contain no credentials, fetched content, or public content entities.
CREATE TABLE IF NOT EXISTS operations_source_configs (
  id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('proposed','verifying','enabled','rejected','paused','degraded')),
  data jsonb NOT NULL,
  next_eligible_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((jsonb_typeof(data)='object') IS TRUE),
  CHECK ((data->>'id'=id AND (data->>'revision')::integer=revision AND data->>'status'=status) IS TRUE),
  CHECK ((data->>'credentialPolicy'='none') IS TRUE)
);

CREATE TABLE IF NOT EXISTS operations_execution_runs (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('crawl','analysis')),
  source_config_id text NOT NULL REFERENCES operations_source_configs(id),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('queued','running','review_ready','succeeded','failed','cancelled')),
  fingerprint text NOT NULL,
  data jsonb NOT NULL,
  available_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(id,kind),
  CHECK ((jsonb_typeof(data)='object') IS TRUE),
  CHECK ((data->>'id'=id AND data->>'kind'=kind AND data->>'sourceConfigId'=source_config_id AND (data->>'revision')::integer=revision AND data->>'status'=status) IS TRUE),
  CHECK (((data->>'maxAttempts')::integer BETWEEN 1 AND 3) IS TRUE),
  CHECK (((data->>'attempt')::integer BETWEEN 0 AND (data->>'maxAttempts')::integer) IS TRUE),
  CHECK (((data->>'timeoutMs')::integer BETWEEN 1000 AND 600000) IS TRUE),
  CHECK ((status='running')=(lease_expires_at IS NOT NULL)),
  CHECK (kind='analysis' OR status <> 'succeeded'),
  CHECK (kind='crawl' OR status <> 'review_ready')
);
-- Prevent duplicate active source execution even if a caller bypasses service locking.
CREATE UNIQUE INDEX IF NOT EXISTS operations_one_active_crawl
  ON operations_execution_runs(source_config_id) WHERE kind='crawl' AND status IN ('queued','running');
CREATE INDEX IF NOT EXISTS operations_runs_reclaim
  ON operations_execution_runs(lease_expires_at,id) WHERE status='running';
CREATE INDEX IF NOT EXISTS operations_analysis_reuse
  ON operations_execution_runs(source_config_id,fingerprint,created_at DESC) WHERE kind='analysis';

-- Each request key stays bound even when an unchanged hash reuses a prior run.
CREATE TABLE IF NOT EXISTS operations_execution_requests (
  actor_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('crawl','analysis')),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  run_id text NOT NULL,
  FOREIGN KEY(run_id,kind) REFERENCES operations_execution_runs(id,kind),
  PRIMARY KEY (actor_id,kind,idempotency_key)
);

CREATE TABLE IF NOT EXISTS operations_execution_audit (
  id text PRIMARY KEY,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','worker')),
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  reason text NOT NULL CHECK (length(reason)>0),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_execution_audit_entity
  ON operations_execution_audit(entity_id,occurred_at,id);
-- Retention policy is still required for candidates/logs; this stores only reference IDs
-- and safe categorical failures. Reversal: stop endpoints, export needed run/audit
-- history, then remove these tables in FK order. Never drop M03 evidence snapshots.

-- Module proposal: operations/sql/event-reviews.sql
-- M08 proposal only. Coordinator combines/applies migrations; M03 supplies same-transaction content ports.
CREATE TABLE IF NOT EXISTS operations_event_reviews (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  candidate_id text NOT NULL UNIQUE,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending','changes_requested','approved','rejected','published')),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CHECK ((payload->>'id' = id AND payload->>'eventId' = event_id AND payload->>'candidateId' = candidate_id) IS TRUE),
  CHECK (((payload->>'revision')::integer = revision) IS TRUE),
  CHECK ((payload->>'status' = status) IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_event_reviews_queue ON operations_event_reviews(status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS operations_event_review_audit (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  review_id text REFERENCES operations_event_reviews(id),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK ((jsonb_typeof(payload) = 'object') IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_event_review_audit_event ON operations_event_review_audit(event_id,occurred_at);
-- Application audit writes are append-only; deploy role should lack UPDATE/DELETE on audit tables.
-- Rollback on a disposable empty installation: drop audit then reviews. For saved review data,
-- back up tables and retain M03 published rule snapshots; never cascade-drop Event/Project content.

-- Module proposal: operations/sql/resource-reviews.sql
-- Suggested migration; coordinator executes after composing M09 publication port.
-- No Resource body, category or bookmark store is created here.
CREATE TABLE IF NOT EXISTS operations_resource_reviews (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  resource_revision integer NOT NULL CHECK (resource_revision > 0),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending','changes_requested','approved','rejected','published')),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (resource_id, resource_revision),
  CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CHECK ((payload->>'id' = id AND payload->>'resourceId' = resource_id) IS TRUE),
  CHECK (((payload->>'resourceRevision')::integer = resource_revision AND (payload->>'revision')::integer = revision) IS TRUE),
  CHECK ((payload->>'status' = status) IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_resource_reviews_queue
  ON operations_resource_reviews (status, updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS operations_resource_review_audit (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  review_id text REFERENCES operations_resource_reviews(id),
  actor_id text NOT NULL,
  operation_id text,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK ((jsonb_typeof(payload) = 'object') IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS operations_resource_withdrawal_idempotency
  ON operations_resource_review_audit (actor_id, operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operations_resource_review_audit_history
  ON operations_resource_review_audit (resource_id, occurred_at DESC);
-- Runtime website role: SELECT/INSERT audit, no UPDATE/DELETE audit. Worker role:
-- no privileges on these tables, no privileges on M09 publication tables/port.
-- Publication+audit MUST be committed together through one DatabasePort tx;
-- do not wire a remote publish API into this synchronous transaction contract.

-- Module proposal: operations/sql/corrections.sql
-- Suggested migration only. Includes public-content references, no project copies.
CREATE TABLE IF NOT EXISTS operations_corrections (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('received','triaging','confirmed','needs_more_info','dismissed','resolved')),
  updated_at timestamptz NOT NULL,
  original jsonb NOT NULL CHECK ((jsonb_typeof(original) = 'object') IS TRUE),
  state jsonb NOT NULL,
  CHECK ((jsonb_typeof(state) = 'object') IS TRUE),
  CHECK ((state->>'id' = id AND (state->>'revision')::integer = revision AND state->>'status' = status) IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_corrections_owner
  ON operations_corrections (owner_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS operations_corrections_queue
  ON operations_corrections (status, updated_at ASC, id ASC);
CREATE TABLE IF NOT EXISTS operations_correction_transitions (
  id text PRIMARY KEY,
  correction_id text NOT NULL REFERENCES operations_corrections(id),
  revision integer NOT NULL CHECK (revision > 1),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  UNIQUE (correction_id, revision)
);
CREATE OR REPLACE FUNCTION operations_correction_original_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original IS DISTINCT FROM OLD.original OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'original correction submission is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS operations_correction_original_immutable_trigger ON operations_corrections;
CREATE TRIGGER operations_correction_original_immutable_trigger
BEFORE UPDATE ON operations_corrections FOR EACH ROW
EXECUTE FUNCTION operations_correction_original_immutable();
-- Runtime role gets SELECT/INSERT on transitions, no UPDATE/DELETE. Worker gets
-- no access here. Retention/deletion policy must be wired separately by admin.
-- Responses are station status records only; this migration sends no messages.
