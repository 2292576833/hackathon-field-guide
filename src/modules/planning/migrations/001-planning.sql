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
