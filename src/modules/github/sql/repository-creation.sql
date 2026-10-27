-- SQL proposal only; the coordinator owns actual migrations and foreign-key integration.
CREATE TABLE github_repository_creation_operations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id, idempotency_key),
  CHECK (payload->>'status' IN ('preview','creating','created','blocked','unknown')),
  CHECK (payload->>'autoInit' = 'true'),
  CHECK ((payload->>'revision')::integer = revision),
  CHECK (payload->>'projectId' = project_id AND payload->>'userId' = user_id AND payload->>'id' = id),
  CHECK (NOT (payload ?| ARRAY['token','accessToken','refreshToken','credential','clientSecret']))
);
CREATE INDEX github_repository_creation_project ON github_repository_creation_operations (project_id, user_id, created_at DESC);
CREATE TABLE github_repository_creation_audit (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES github_repository_creation_operations(id),
  project_id text NOT NULL,
  user_id text NOT NULL,
  revision integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('RepositoryCreated','RepositoryCreationUpdated')),
  details jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, revision)
);
-- Audit is append-only; production role should have INSERT/SELECT and no UPDATE/DELETE permission.
-- Rollback requires preserving private operation/audit history before dropping audit then operations.
