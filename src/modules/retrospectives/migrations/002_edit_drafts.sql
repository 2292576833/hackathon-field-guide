-- Incremental M07 migration suggestion. Only the coordinator executes migrations.
-- These are private editing buffers, never Retrospective/publication/AI states.
-- Existing m07_documents, confirmation events and M06 delivery facts are untouched.
BEGIN;

-- Retained roots serialize absent-row creation and delete/recreate with CAS.
CREATE TABLE m07_edit_draft_roots (
  owner_id text NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 200),
  project_id text NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 200),
  document_key text NOT NULL CHECK (char_length(document_key) BETWEEN 0 AND 200),
  PRIMARY KEY (owner_id, project_id, document_key)
);

CREATE TABLE m07_edit_drafts (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  owner_id text NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 200),
  project_id text NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 200),
  document_key text NOT NULL,
  document_id text NULL CHECK (document_id IS NULL OR char_length(document_id) BETWEEN 1 AND 200),
  base_document_revision bigint NOT NULL CHECK (base_document_revision BETWEEN 0 AND 9007199254740990),
  requested_scope text NOT NULL CHECK (requested_scope IN ('personal', 'project')),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  UNIQUE (owner_id, project_id, document_key),
  FOREIGN KEY (owner_id, project_id, document_key) REFERENCES m07_edit_draft_roots(owner_id, project_id, document_key),
  CHECK (document_key = COALESCE(document_id, '')),
  CHECK ((document_id IS NULL AND base_document_revision = 0) OR (document_id IS NOT NULL AND base_document_revision > 0)),
  CHECK (body ?& ARRAY['kind','id','ownerId','projectId','documentId','baseDocumentRevision','visibility','requestedScope','draftContent','revision','createdAt','updatedAt']),
  CHECK (body @> jsonb_build_object('kind','retrospective_edit_draft','id',id,'ownerId',owner_id,'projectId',project_id,'documentId',document_id,'baseDocumentRevision',base_document_revision,'visibility','personal','requestedScope',requested_scope,'revision',revision)),
  CHECK (((body->>'createdAt')::timestamptz = created_at AND (body->>'updatedAt')::timestamptz = updated_at) IS TRUE),
  CHECK (jsonb_typeof(body->'draftContent') = 'object')
);
CREATE INDEX m07_edit_drafts_owner_list ON m07_edit_drafts(owner_id, id COLLATE "C");
CREATE INDEX m07_edit_drafts_owner_project ON m07_edit_drafts(owner_id, project_id, id COLLATE "C");

-- No content/snapshots are copied to receipts. Deleted draft IDs remain as
-- metadata so identical unknown-response retries cannot resurrect deleted text.
CREATE TABLE m07_edit_draft_mutations (
  owner_id text NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 200),
  mutation_id text NOT NULL CHECK (char_length(mutation_id) BETWEEN 1 AND 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  draft_id text NULL CHECK (draft_id IS NULL OR char_length(draft_id) BETWEEN 1 AND 200),
  accepted_revision bigint NULL CHECK (accepted_revision BETWEEN 1 AND 9007199254740990),
  PRIMARY KEY (owner_id, mutation_id),
  CHECK ((draft_id IS NULL) = (accepted_revision IS NULL))
);

CREATE FUNCTION m07_guard_edit_draft_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.project_id <> OLD.project_id
     OR NEW.document_key <> OLD.document_key OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'M07 edit draft identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'M07 edit draft revision must increase exactly once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER m07_edit_draft_update_guard BEFORE UPDATE ON m07_edit_drafts FOR EACH ROW EXECUTE FUNCTION m07_guard_edit_draft_update();

COMMIT;

-- Roots/receipts hold account-owned identifiers/hash metadata only; an M01
-- account erasure policy must remove those rows explicitly along with drafts.
-- No source-document foreign key: losing project/source access cannot remove
-- the owner's right to read/export/delete their already typed private text.
