-- Suggestion only. Root chooses the next migration number and applies it.
CREATE TABLE document_draft_publications (
  owner_id text NOT NULL,
  project_id text NOT NULL,
  attempt_id text NOT NULL,
  slot_key text NOT NULL,
  document_id text,
  target_document_id text,
  source_draft_revision integer NOT NULL CHECK (source_draft_revision > 0),
  content_revision integer NOT NULL CHECK (content_revision > 0),
  body text NOT NULL CHECK (length(body) <= 20000),
  base_document_revision integer CHECK (base_document_revision > 0),
  status text NOT NULL CHECK (status IN ('pending','unknown','succeeded','failed')),
  result_document_id text,
  result_document_revision integer CHECK (result_document_revision > 0),
  cleared boolean,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  PRIMARY KEY (owner_id,project_id,attempt_id),
  CHECK ((status='succeeded' AND result_document_id IS NOT NULL AND result_document_revision IS NOT NULL AND cleared IS NOT NULL AND finished_at IS NOT NULL)
    OR (status IN ('pending','unknown','failed') AND result_document_id IS NULL AND result_document_revision IS NULL AND cleared IS NULL)),
  CHECK ((document_id IS NULL AND slot_key='new') OR (document_id IS NOT NULL AND slot_key='document:'||document_id))
);
CREATE TABLE document_drafts (
  owner_id text NOT NULL,
  project_id text NOT NULL,
  slot_key text NOT NULL,
  document_id text,
  revision integer NOT NULL CHECK (revision > 0),
  content_revision integer NOT NULL CHECK (content_revision > 0),
  body text CHECK (length(body) <= 20000),
  base_document_revision integer CHECK (base_document_revision > 0),
  published_document_id text,
  publication_id text,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id,project_id,slot_key),
  FOREIGN KEY (owner_id,project_id,publication_id) REFERENCES document_draft_publications(owner_id,project_id,attempt_id),
  CHECK ((document_id IS NULL AND slot_key='new') OR (document_id IS NOT NULL AND slot_key='document:'||document_id)),
  CHECK ((body IS NULL AND deleted_at IS NOT NULL) OR (body IS NOT NULL AND deleted_at IS NULL))
);
CREATE INDEX document_drafts_owner_space_updated ON document_drafts(owner_id,project_id,updated_at DESC);
