-- M07 migration suggestion only. The coordinator executes it with the shared pool.
-- M06 owns delivery verification / submission facts; this schema stores references.
-- User/project foreign keys are wired by the coordinator after their table names settle.
BEGIN;

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

COMMIT;

-- Rollback (after backing up all M07 rows): drop m07_document_versions first,
-- then m07_documents and m07_audit_events, followed by both guard functions.
-- This removes M07 data; it never touches M06 facts. Do not run on trial data blindly.
