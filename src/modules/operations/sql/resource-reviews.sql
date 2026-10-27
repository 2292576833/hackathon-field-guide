-- Suggested migration; coordinator executes after composing M09 publication port.
-- No Resource body, category or bookmark store is created here.
CREATE TABLE IF NOT EXISTS operations_resource_reviews (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  resource_revision integer NOT NULL CHECK (resource_revision > 0),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending','changes_requested','approved','rejected','published')),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (resource_id, resource_revision),
  CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CHECK ((payload->>'id' = id AND payload->>'resourceId' = resource_id) IS TRUE),
  CHECK (((payload->>'resourceRevision')::integer = resource_revision AND (payload->>'revision')::integer = revision) IS TRUE),
  CHECK ((payload->>'status' = status) IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_resource_reviews_queue
  ON operations_resource_reviews (status, updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS operations_resource_review_audit (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  review_id text REFERENCES operations_resource_reviews(id),
  actor_id text NOT NULL,
  operation_id text,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK ((jsonb_typeof(payload) = 'object') IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS operations_resource_withdrawal_idempotency
  ON operations_resource_review_audit (actor_id, operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operations_resource_review_audit_history
  ON operations_resource_review_audit (resource_id, occurred_at DESC);
-- Runtime website role: SELECT/INSERT audit, no UPDATE/DELETE audit. Worker role:
-- no privileges on these tables, no privileges on M09 publication tables/port.
-- Publication+audit MUST be committed together through one DatabasePort tx;
-- do not wire a remote publish API into this synchronous transaction contract.
