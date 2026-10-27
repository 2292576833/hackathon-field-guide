CREATE TABLE backend_worker_heartbeats (
  worker_id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('ai','source','discovery')),
  status text NOT NULL CHECK(status IN ('idle','running','failed','stopped')),
  last_seen_at timestamptz NOT NULL, last_completed_at timestamptz, error_code text
);
CREATE INDEX backend_worker_heartbeats_recent ON backend_worker_heartbeats(kind,last_seen_at DESC);
