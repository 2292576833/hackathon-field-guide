-- Paid native search attempts are fenced before sending and survive restarts.
CREATE TABLE operations_discovery_search_attempts (
  scheduler_id text NOT NULL REFERENCES operations_discovery_state(id),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  last_attempt_at timestamptz NOT NULL,
  cycle_token text NOT NULL,
  last_error_code text,
  PRIMARY KEY(scheduler_id, request_hash)
);
-- Explicit operator activation advances only the schedule. Quotas and unresolved
-- paid search/model markers are preserved. Reusing an activation is a no-op.
CREATE TABLE operations_discovery_activations (
  scheduler_id text NOT NULL REFERENCES operations_discovery_state(id),
  activation_id text NOT NULL,
  actor_id text NOT NULL,
  previous_next_eligible_at timestamptz,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(scheduler_id, activation_id)
);
