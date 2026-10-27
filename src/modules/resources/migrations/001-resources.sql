-- Migration suggestion only. The coordinating session reviews/applies this.
-- No candidate data is published by this migration.
BEGIN;
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
COMMIT;

-- Recovery: back up all five tables before destructive rollback.
-- Rollback order (ONLY after backup / explicit coordinating-session decision):
-- DROP TABLE resource_notifications; DROP TABLE resource_publication_operations;
-- DROP TABLE resource_bookmarks; DROP TABLE resource_revisions; DROP TABLE resource_records;
-- Removing resources must not silently erase M02/M05 historical references.
