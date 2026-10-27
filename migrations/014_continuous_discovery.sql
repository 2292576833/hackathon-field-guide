-- Proposal only: coordinator applies a NEW migration; never rewrite applied migrations.
CREATE TABLE IF NOT EXISTS operations_discovery_state (
  id text PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), paused boolean NOT NULL DEFAULT false,
  next_eligible_at timestamptz, lease_token text, lease_expires_at timestamptz, worker_id text,
  quota_day text NOT NULL CHECK (quota_day ~ '^\d{4}-\d{2}-\d{2}$'),
  search_calls integer NOT NULL DEFAULT 0 CHECK(search_calls >= 0), model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls >= 0),
  estimated_cost_micros bigint NOT NULL DEFAULT 0 CHECK(estimated_cost_micros >= 0), currency text NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','CNY')),
  reservation jsonb, last_completed_at timestamptz, last_error_code text,
  CHECK (((lease_token IS NULL AND lease_expires_at IS NULL AND reservation IS NULL) OR
    (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND reservation IS NOT NULL AND jsonb_typeof(reservation)='object')) IS TRUE)
);
CREATE TABLE IF NOT EXISTS operations_discovery_urls (
  scheduler_id text NOT NULL REFERENCES operations_discovery_state(id), canonical_url text NOT NULL,
  last_attempt_at timestamptz NOT NULL, cycle_token text NOT NULL, content_hash text, candidate_id text,
  last_completed_at timestamptz, last_error_code text, PRIMARY KEY(scheduler_id,canonical_url)
);
CREATE TABLE IF NOT EXISTS operations_discovery_control_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, scheduler_id text NOT NULL REFERENCES operations_discovery_state(id),
  actor_id text NOT NULL, revision integer NOT NULL CHECK(revision > 0), paused boolean NOT NULL, occurred_at timestamptz NOT NULL
);
