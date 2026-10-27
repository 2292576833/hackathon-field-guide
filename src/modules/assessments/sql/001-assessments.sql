-- M04 PostgreSQL migration proposal only. The coordinator reviews and executes it.
-- Requires PostgreSQL JSONB. M02 project/member foreign keys must be mapped to its
-- actual schema by the coordinator; no other module table names are assumed here.
-- Runtime access is through trusted server services, never direct client SQL.
-- Use a separate migration/catalog role; the runtime role should have catalog SELECT
-- and score SELECT/INSERT only. Private aggregate tables must not be public grants.
BEGIN;

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

COMMIT;

-- Rollback is intentionally not executed here. Preserve/private-backup trial data
-- before any rollback; drop head/outbox/job/score/attempt/assignment/catalog tables
-- with foreign-key ordering and then these functions only during a reviewed migration.
-- The append-only triggers protect history during ordinary runtime operations.
-- An approved personal-data deletion policy needs a dedicated audited maintenance
-- path with narrowly scoped privileges; never silently disable guards at runtime.
