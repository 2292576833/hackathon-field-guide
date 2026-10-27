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
