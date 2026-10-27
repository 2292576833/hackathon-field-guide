-- MIGRATION SUGGESTION ONLY. Coordinator applies through the real migration system.
-- PostgreSQL; run as one transaction. No credentials or sample content are included.
BEGIN;
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
COMMIT;
-- Rollback requires a backup and coordinated removal of dependent M02/M05/M06 references.
-- Drop only these m03_* tables in reverse dependency order after export; never cascade
-- into other modules. Historical rules are insert-only through this module's adapter.
