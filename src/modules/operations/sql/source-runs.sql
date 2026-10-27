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
