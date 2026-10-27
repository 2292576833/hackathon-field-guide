-- Operational timing is separate from immutable paid-call accounting.
-- A UUID cycle receipt makes summary updates idempotent after retries/restarts.
CREATE TABLE operations_discovery_coverage_cycles (
  scheduler_id text NOT NULL CHECK (scheduler_id = 'event-discovery'),
  attempt_id text NOT NULL CHECK (attempt_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
  quota_day text NOT NULL CHECK (quota_day ~ '^\d{4}-\d{2}-\d{2}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK (completed_at >= started_at),
  report_status text NOT NULL CHECK (report_status IN ('completed', 'failed', 'cancelled')),
  search_calls integer NOT NULL CHECK (search_calls >= 0),
  fetched_pages integer NOT NULL CHECK (fetched_pages >= 0),
  saved_cards integer NOT NULL CHECK (saved_cards >= 0),
  active_ms bigint NOT NULL CHECK (active_ms >= 0),
  PRIMARY KEY (scheduler_id, attempt_id)
);
CREATE TABLE operations_discovery_coverage (
  scheduler_id text NOT NULL CHECK (scheduler_id = 'event-discovery'),
  quota_day text NOT NULL CHECK (quota_day ~ '^\d{4}-\d{2}-\d{2}$'),
  first_started_at timestamptz NOT NULL,
  last_completed_at timestamptz NOT NULL CHECK (last_completed_at >= first_started_at),
  cycles integer NOT NULL CHECK (cycles >= 0),
  search_calls integer NOT NULL CHECK (search_calls >= 0),
  fetched_pages integer NOT NULL CHECK (fetched_pages >= 0),
  saved_cards integer NOT NULL CHECK (saved_cards >= 0),
  active_ms bigint NOT NULL CHECK (active_ms >= 0),
  PRIMARY KEY (scheduler_id, quota_day)
);
